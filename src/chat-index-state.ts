import { eligibility, storedIndex, latestIndex, type Worker } from "./repository-store";

export async function chatIndexRequirement(worker: Worker, store = { storedIndex, latestIndex, eligibility }) {
  if (await store.storedIndex(worker)) return null;
  const latest = await store.latestIndex(worker);
  const state = latest && ["queued", "running"].includes(latest.status) ? "indexing" : latest?.status === "failed" ? "index_failed" : "not_indexed";
  return { kind: "index_required" as const, tenant_id: worker.organization_id, repository_id: String(worker.repository_id), state, can_index: state !== "indexing" && store.eligibility(worker).allowed };
}
