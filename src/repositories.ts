import { indexFreshness } from "./index-freshness";
import type { Auth, Repository } from "@inkspect/core/lib/github";
import { readReviewJSON, reviewAccess, ReviewError, reviewJSON } from "@inkspect/core/lib/review-access";
import { admitIndex, repositoryStars, setRepositoryStar } from "@inkspect/core/lib/repository-store";
import { reviewChannel } from "@inkspect/core/lib/realtime";
import { captureError } from "@inkspect/core/lib/diagnostics/server";
import { cancelIndex, eligibility, enqueueIndex, latestIndex, repositoryIndexCoverage, workerFor, preparingRepository } from "./repository-store";
const defaults = { indexFreshness, admitIndex, repositoryStars, setRepositoryStar, cancelIndex, enqueueIndex, latestIndex, workerFor };
export async function repositories(request: Request, auth: Auth, store: typeof defaults & { repositoryIndexCoverage?: typeof repositoryIndexCoverage } = defaults) {
  const action = new URL(request.url).searchParams.get('action') || 'list';
  let stage = 'access';
  try {
    const access = await reviewAccess(request, auth);
    const url = new URL(request.url);
    stage = ['list', 'index-coverage', 'stars', 'star', 'detail', 'index', 'analyze', 'cancel'].includes(action) ? action : 'unknown_action';
    const channel = reviewChannel(access.organizationId);
    if (request.method === 'GET' && action === 'list') {
      const all = [...new Map(access.connections.flatMap(c => JSON.parse(c.repositories) as Repository[]).map(repo => [repo.id, repo])).values()];
      return reviewJSON({ repositories: all, realtime_channel: channel });
    }
    if (request.method === 'GET' && action === 'index-coverage') {
      const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').map(Number))];
      if (ids.length > 20 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new ReviewError(400, 'Choose up to 20 repositories.');
      const allowed = new Map<number, typeof access.connections[number]>();
      for (const connection of access.connections) {
        for (const repo of JSON.parse(connection.repositories) as Repository[]) {
          if (!allowed.has(repo.id)) allowed.set(repo.id, connection);
        }
      }
      const scopes = ids.flatMap(id => {
        const connection = allowed.get(id);
        return connection ? [{ repository_id: String(id), connection_id: connection.id, installation_id: connection.installationId }] : [];
      });
      const coverage = await (store.repositoryIndexCoverage ?? repositoryIndexCoverage)(access.organizationId, scopes);
      return reviewJSON({ coverage });
    }
    if (request.method === 'GET' && action === 'stars') return reviewJSON({ stars: await store.repositoryStars(access.organizationId, access.userId), realtime_channel: channel });
    const repository = Number(url.searchParams.get('repository'));
    if (!Number.isSafeInteger(repository) || repository < 1) throw new ReviewError(400, 'Choose a repository.');
    const connection = access.connections.find(c => (JSON.parse(c.repositories) as Repository[]).some(repo => repo.id === repository));
    if (!connection) throw new ReviewError(403, 'This repository is not connected to this workspace.');
    if (request.method === 'POST' && action === 'star') {
      const body = await readReviewJSON(request);
      if (typeof body.starred !== 'boolean') throw new ReviewError(400, 'Choose a star preference.');
      await store.setRepositoryStar(access.organizationId, access.userId, repository, body.starred);
      return reviewJSON({ starred: body.starred });
    }
    const worker = await store.workerFor(access.organizationId, repository, connection.id, connection.installationId);
    if (request.method === 'GET' && action === 'detail') {
      const index = worker ? await store.latestIndex(worker) : null;
      let freshness = { up_to_date: false, check_failed: false };
      if (worker && index && url.searchParams.get('checkFreshness') === '1' && !['queued', 'running'].includes(index.status)) {
        try { freshness = { ...freshness, ...await store.indexFreshness(worker, request.signal) }; }
        catch { freshness.check_failed = true; }
      }
      return reviewJSON({ index, eligibility: eligibility(worker), freshness, realtime_channel: channel });
    }
    if (request.method !== 'POST' || !['index','analyze','cancel'].includes(action)) throw new ReviewError(405, 'Method not allowed.');
    if (!worker) throw new ReviewError(503, preparingRepository);
    const body = await readReviewJSON(request);
    if (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.requestId)) throw new ReviewError(400, 'Invalid index request.');
    if (action === 'cancel') return reviewJSON({ index: await store.cancelIndex(worker, body.requestId) });
    if (worker?.access_error === 'revoked' || worker?.access_error === 'access_unavailable') throw new ReviewError(403, 'Repository access is unavailable. Check the GitHub integration.');
    if (action === 'index') {
      const check = eligibility(worker);
      if (!check.allowed) return reviewJSON({ error: check.reason, eligibility: check }, check.support_required ? 409 : 503);
      const current = await store.latestIndex(worker);
      if (!current || !['queued', 'running'].includes(current.status)) {
        const freshness = await store.indexFreshness(worker, request.signal, true);
        if (freshness.up_to_date) return reviewJSON({ index: current, freshness });
      }
    }
    await store.admitIndex(access.organizationId, access.userId, String(repository), body.requestId);
    return reviewJSON({ index: await store.enqueueIndex(worker, body.requestId, access.userId, action === 'analyze') }, 202);
  } catch (error) {
    if (!(error instanceof ReviewError)) captureError('repositories.unavailable', error, { stage });
    return reviewJSON({ error: error instanceof ReviewError ? error.message : 'Repository data is temporarily unavailable. Please retry.' }, error instanceof ReviewError ? error.status : 503);
  }
}
