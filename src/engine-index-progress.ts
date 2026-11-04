import { readFile } from 'node:fs/promises';
import type { RepositoryIndex } from "@inkspect/core/lib/repository-types";
import { indexLogKey } from "@inkspect/core/lib/repository-activity";

type Progress = RepositoryIndex['progress'];
export type IndexProgress = Pick<Progress, 'stage' | 'scan' | 'chunks' | 'embedded' | 'indexed' | 'logs'>;

export function mergeIndexProgress(previous: Progress, next: Partial<Progress>): Progress {
  const logs = new Map(previous.logs.map(log => [indexLogKey(log), log]));
  for (const log of next.logs ?? []) logs.set(indexLogKey(log), log);
  return { ...previous, ...next, logs: [...logs.values()] };
}

export function indexStage(previous: Progress, stage: string, message: string): Progress {
  return mergeIndexProgress(previous, { stage, logs: [{ key: `progress:${stage}`, at: new Date().toISOString(), message }] });
}

export function needsIndexStats(index: Pick<RepositoryIndex, 'status' | 'progress'>) {
  return ['completed', 'failed'].includes(index.status) && index.progress.indexed && !index.progress.scan?.measured
    && !(index.progress.scan?.total > 0);
}

// The Rust writer renames a complete snapshot atomically. Serialize callbacks
// and flush once after child exit so a late poll can never overwrite completion.
export function watchIndexProgress(file: string, receive: (progress: IndexProgress) => Promise<void>, fail: () => void) {
  let last = '', error: unknown, pending: Promise<void> | undefined;
  async function read() {
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (raw === last) return;
    if (raw.length > 64 * 1024) throw new Error('Oversized index progress');
    const value = JSON.parse(raw);
    if (!['cloning', 'discovering', 'reading', 'embedding', 'publishing', 'summarizing'].includes(value.stage)
      || !value.scan || !['total', 'processed', 'read', 'skipped', 'chunks'].every(k => Number.isSafeInteger(value.scan[k]) && value.scan[k] >= 0)
      || !['chunks', 'embedded'].every(k => Number.isSafeInteger(value[k]) && value[k] >= 0)
      || typeof value.scan.measured !== 'boolean' || typeof value.scan.stage !== 'string'
      || typeof value.indexed !== 'boolean' || !Array.isArray(value.logs) || value.logs.length > 12
      || value.logs.some((log: any) => typeof log.key !== 'string' || !log.key.startsWith('progress:')
        || typeof log.message !== 'string' || log.message.length > 500 || !Number.isSafeInteger(log.at) || log.at < 0 || log.at > 8.64e15)) {
      throw new Error('Invalid index progress');
    }
    await receive({ stage: value.stage, scan: value.scan, chunks: value.chunks, embedded: value.embedded, indexed: value.indexed,
      logs: value.logs.map((log: any) => ({ ...log, at: new Date(log.at).toISOString() })) });
    last = raw;
  }
  const timer = setInterval(() => {
    if (!pending && !error) pending = read().catch(e => { error = e; fail(); }).finally(() => { pending = undefined; });
  }, 500);
  return async () => {
    clearInterval(timer);
    await pending;
    if (error) throw error;
    await read();
  };
}
