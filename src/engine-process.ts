import { engineModelEnvironment } from "@inkspect/core/lib/model-transport";
import type { ProviderCredential } from "./engine-credentials";
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HostConfig } from "./engine-contract";
import type { ReviewReport } from "@inkspect/core/lib/review-types";
import { appLogin } from "./pull-request-events";
import { watchIndexProgress, type IndexProgress } from "./engine-index-progress";

// Run-specific private journals are retained for crash reconciliation. Neither
// credentials nor repository contents are copied into application logs.
export async function runRust(mode: 'review' | 'index' | 'index-stats' | 'context' | 'source' | 'describe' | 'fix' | 'verify-fix', host: HostConfig,
  job: Record<string, unknown>, request: object, token: string, operation: string, signal: AbortSignal, credential?: ProviderCredential,
  onIndexProgress?: (progress: IndexProgress) => Promise<void>, transport?: { endpoint: string; bearerToken: string }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operation)) throw new Error('Invalid operation');
  const directory = resolve(process.env.INKSPECT_RUST_STATE || '/var/lib/inkspect/rust', operation);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([['host.json', host], ['job.json', job], ['request.json', request]].map(([name, data]) =>
    writeFile(join(directory, String(name)), JSON.stringify(data), { mode: 0o600 })));
  const args = mode === 'review' ? ['review'] : ['service', '--mode', mode, '--request', join(directory, 'request.json')];
  args.push('--config', join(directory, 'host.json'), '--job', join(directory, 'job.json'), '--out', join(directory, 'report.json'));
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: '/usr/local/bin:/usr/bin:/bin', INKSPECT_GITHUB_READ_TOKEN: token,
    INKSPECT_EMBEDDING_RATE_DIR: resolve(directory, '..', '.embedding-rate'),
    INKSPECT_USAGE_FILE: join(directory, 'usage.jsonl'), INKSPECT_GITHUB_APP_SLUG: appLogin() };
  if (mode === 'review' || mode === 'fix' || mode === 'verify-fix') env.INKSPECT_REVIEW_CONTEXT_FILE = join(directory, 'model-context.json');
  if (onIndexProgress) env.INKSPECT_INDEX_PROGRESS_FILE = join(directory, 'index-progress.json');
  env.INKSPECT_APP_ORIGIN = process.env.BETTER_AUTH_URL || 'https://app.inkspect.si';
  for (const key of ['TMPDIR', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'INKSPECT_QDRANT_URL', 'INKSPECT_QDRANT_API_KEY']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  if(process.env.INKSPECT_AI_PROVIDER === 'inkspect') {
    for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_BEARER_TOKEN_BEDROCK'])delete env[key];
    Object.assign(env,engineModelEnvironment());
  }
  // App credentials and database secrets never reach the review subprocess.
  if (transport && !credential) {
    const endpoint = new URL(transport.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('Invalid local model transport');
    for (const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_BEARER_TOKEN_BEDROCK']) delete env[key];
    env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = endpoint.origin;
    env.AWS_BEARER_TOKEN_BEDROCK = transport.bearerToken;
    env.AWS_EC2_METADATA_DISABLED = 'true';
  }
  if (credential) env.INKSPECT_BYOK_STDIN = '1';
  const child = spawn(process.env.INKSPECT_RUST_BINARY || '/usr/local/bin/inkspect-engine', args,
    { env, stdio: [credential ? 'pipe' : 'ignore', 'ignore', 'ignore'], detached: true });
  if (credential && child.stdin) {
    const payload = Buffer.from(JSON.stringify(credential));
    child.stdin.on('error', () => { payload.fill(0); });
    child.stdin.end(payload, () => payload.fill(0));
    credential.api_key = '';
  }
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } } };
  let force: NodeJS.Timeout | undefined;
  const cancel = () => { if (force) return; kill(); force = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 5000); };
  const flushProgress = onIndexProgress ? watchIndexProgress(join(directory, 'index-progress.json'), onIndexProgress, cancel) : undefined;
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let timedOut=false;
  const timeout = setTimeout(()=>{timedOut=true;cancel();}, (host.timeout_seconds + 10) * 1000);
  let code: number | null;
  let exitSignal:NodeJS.Signals|null=null;
  try { code = await new Promise<number | null>((yes, no) => { child.once('error', no); child.once('exit', (value,why)=>{exitSignal=why;yes(value);}); }); }
  catch(error) {
    await writeFile(join(directory,'process-failure.json'),JSON.stringify({stage:'spawn',code:typeof (error as NodeJS.ErrnoException).code==='string'?(error as NodeJS.ErrnoException).code:'unknown'}),{mode:0o600,flag:'wx'});
    throw error;
  }
  finally {
    clearTimeout(timeout); if (force) clearTimeout(force); signal.removeEventListener('abort', cancel); kill();
    await flushProgress?.();
  }
  const events = await readJournal(directory);
  if (code !== 0 || signal.aborted || timedOut) {
    await writeFile(join(directory,'process-failure.json'),JSON.stringify({stage:'exit',exit_code:code,signal:exitSignal,timed_out:timedOut,cancelled:signal.aborted}),{mode:0o600,flag:'wx'});
    return { events, report: undefined };
  }
  if ((await stat(join(directory, 'report.json'))).size > 8 * 1024 * 1024) throw new Error('Oversized engine report');
  return { events, report: JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) };
}
export async function readJournal(directory: string) {
  try { return (await readFile(join(directory, 'usage.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

// Upgrade old stored reports through the same Rust renderer. This command is
// offline: no credentials, retrieval, model call, or review billing.
export async function renderStoredReport(report: ReviewReport): Promise<NonNullable<ReviewReport['presentation']>> {
  const root = resolve(process.env.INKSPECT_RUST_STATE || '/var/lib/inkspect/rust');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'render-'));
  try {
    const input = join(directory, 'report.json'), output = join(directory, 'presentation.json');
    await writeFile(input, JSON.stringify(report), { mode: 0o600 });
    await promisify(execFile)(process.env.INKSPECT_RUST_BINARY || '/usr/local/bin/inkspect-engine', ['render', '--report', input, '--out', output], {
      timeout: 15_000, maxBuffer: 4096,
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: '/usr/local/bin:/usr/bin:/bin', INKSPECT_APP_ORIGIN: process.env.BETTER_AUTH_URL || 'https://app.inkspect.si', INKSPECT_GITHUB_APP_SLUG: appLogin() },
    });
    if ((await stat(output)).size > 8 * 1024 * 1024) throw new Error('Oversized engine presentation');
    const presentation = JSON.parse(await readFile(output, 'utf8'));
    if (presentation?.version !== 1 || typeof presentation.markdown !== 'string' || typeof presentation.github_summary !== 'string'
      || typeof presentation.fix_prompt !== 'string' || !presentation.finding_prompts || !presentation.github_findings) throw new Error('Invalid engine presentation');
    return presentation;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
