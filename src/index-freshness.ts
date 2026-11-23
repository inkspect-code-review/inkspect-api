import type { RepositoryIndexFreshness } from "@inkspect/core/lib/repository-types";
import { EmptyRepository, fetchRepositoryRevision } from "./metadata";
import { lastIndexed, type Worker } from "./repository-store";

// UI polling shares a short-lived HEAD read. Admission always reads GitHub again;
// the engine checks the committed vector-store manifest under its writer lock.
const heads = new Map<string, { revision: string; expires: number }>();
export async function indexFreshness(worker: Worker, signal: AbortSignal, force = false, dependencies = { fetchRepositoryRevision, lastIndexed }): Promise<RepositoryIndexFreshness> {
  const saved = await dependencies.lastIndexed(worker);
  if (!saved?.progress.revision) return { up_to_date: false };
  const key = JSON.stringify([worker.organization_id, worker.repository_id, worker.connection_id, worker.installation_id, worker.full_name, worker.app_id, worker.merge_refresh_due_at ?? null]);
  const cached = heads.get(key);
  let revision = !force && cached && cached.expires > Date.now() ? cached.revision : undefined;
  if (!revision) {
    try { revision = await dependencies.fetchRepositoryRevision(worker, AbortSignal.any([signal, AbortSignal.timeout(15_000)])); }
    catch (error) {
      if (!(error instanceof EmptyRepository)) throw error;
      heads.delete(key);
      // Let the worker record the empty state; it rechecks GitHub on every run.
      return { up_to_date: false };
    }
    if (heads.size >= 500) heads.delete(heads.keys().next().value!);
    heads.set(key, { revision, expires: Date.now() + 30_000 });
  }
  return { up_to_date: saved.progress.revision === revision, revision };
}
