import { createHash } from 'node:crypto';
import type { EngineJob } from "./engine-store";
import { modelUsage } from "./engine-model-usage";

export const FIX_VERIFICATION_FAILED = 'fix.verification_failed';
export const FIX_NO_SAFE_REPAIR = 'fix.no_safe_repair';
export const MAX_FIX_ATTEMPTS = 3;
export const MAX_FIX_MODEL_CALLS = MAX_FIX_ATTEMPTS * 2;
export const FIX_VERIFICATION_MESSAGE = 'The independent verification could not confirm that every finding was fixed safely. No commit was sent.';

export function candidateHash(run: string, head: string, source: string, files: {path:string;content:string}[]) {
  const hash = createHash('sha256');
  for (const value of [run, head, source, ...files.flatMap(f => [f.path, f.content])]) {
    const bytes = Buffer.from(value), length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length)); hash.update(length); hash.update(bytes);
  }
  return hash.digest('hex');
}

export function validateFixVerification(value: any, files: {path:string;content:string}[], job: EngineJob, source: EngineJob, events: any[]) {
  const fail = () => { throw new Error(FIX_VERIFICATION_MESSAGE); };
  const receipt = value?.verification;
  const cli=receipt?.version===3;
  const digest = candidateHash(job.id, job.snapshot.head, source.id, files);
  const findings = source.report?.findings;
  if (!Array.isArray(findings) || !findings.length || findings.some(f => typeof f.id !== 'string' || !f.id)) return fail();
  const ids = new Set(findings.map(f => f.id));
  if (ids.size !== findings.length || (!cli && receipt?.version !== 2) || receipt.status !== 'passed'
    || !Number.isInteger(receipt.attempts) || receipt.attempts < 1 || receipt.attempts > MAX_FIX_ATTEMPTS
    || receipt.run_id !== job.id || receipt.head !== job.snapshot.head || receipt.source_review !== source.id
    || receipt.candidate_sha256 !== digest || !Array.isArray(receipt.findings) || receipt.findings.length !== ids.size) return fail();
  const seen = new Set<string>();
  for (const finding of receipt.findings) {
    if (!ids.has(finding?.id) || seen.has(finding.id) || finding.status !== 'resolved'
      || !Array.isArray(finding.evidence) || !finding.evidence.length || finding.evidence.length > 10) return fail();
    seen.add(finding.id);
    for (const location of finding.evidence) {
      const file = files.find(f => f.path === location?.path);
      // Rust str::lines() does not count a trailing newline as another line.
      const lines = file?.content ? file.content.split('\n').length - (file.content.endsWith('\n') ? 1 : 0) : 0;
      if (!file || !Number.isSafeInteger(location.start_line) || !Number.isSafeInteger(location.end_line)
        || location.start_line < 1 || location.end_line < location.start_line || location.end_line > lines) return fail();
    }
  }
  if(cli) {
    if(!modelUsage(events,51)||events.some(e=>['engine.failed','journal.unavailable','runner.failed'].includes(e.kind)))return fail();
    const starts=events.filter(e=>e.kind==='model.started');
    if(!starts.some(e=>e.phase==='claude_generation')||starts.some(e=>!['claude_generation','fix_verification'].includes(e.phase)||!Number.isInteger(e.attempt)||e.attempt<1||e.attempt>receipt.attempts))return fail();
    const verdicts=events.filter(e=>e.kind==='fix.verification.passed');
    const last=verdicts[0];
    if(verdicts.length!==1||last.attempt!==receipt.attempts||last.candidate_sha256!==digest
      ||events.filter(e=>e.kind==='model.started'&&e.phase==='fix_verification'&&e.attempt===receipt.attempts).length!==1
      ||events.filter(e=>e.kind==='fix.verification.started'&&e.attempt===receipt.attempts&&e.candidate_sha256===digest).length!==1
      ||events.filter(e=>['fix.tests.passed','fix.checks.completed'].includes(e.kind)&&e.attempt===receipt.attempts&&e.candidate_sha256===digest).length!==1)return fail();
    return {version:3,status:'passed',attempts:receipt.attempts,candidate_sha256:digest,findings:ids.size};
  }
  if (modelUsage(events, MAX_FIX_MODEL_CALLS)?.calls !== receipt.attempts * 2 || events.some(e => e.kind === 'engine.failed')) return fail();
  const stages = events.filter(e => ['model.started','fix.verification.started','fix.verification.rejected','fix.verification.passed'].includes(e.kind));
  if (stages.length !== receipt.attempts * 4) return fail();
  const candidates = new Set<string>();
  for (let attempt = 1; attempt <= receipt.attempts; attempt++) {
    const [generation, begin, verifier, verdict] = stages.slice((attempt-1)*4, attempt*4);
    if ([generation,begin,verifier,verdict].some(e => e.attempt !== attempt)
      || generation.kind !== 'model.started' || generation.phase !== 'generation'
      || begin.kind !== 'fix.verification.started' || !/^[a-f0-9]{64}$/.test(begin.candidate_sha256 || '')
      || verifier.kind !== 'model.started' || verifier.phase !== 'fix_verification'
      || verdict.kind !== (attempt === receipt.attempts ? 'fix.verification.passed' : 'fix.verification.rejected')
      || verdict.candidate_sha256 !== begin.candidate_sha256 || candidates.has(begin.candidate_sha256)) return fail();
    candidates.add(begin.candidate_sha256);
    if (attempt === receipt.attempts && verdict.candidate_sha256 !== digest) return fail();
  }
  return {version:2, status:'passed', attempts:receipt.attempts, candidate_sha256:digest, findings:ids.size};
}
