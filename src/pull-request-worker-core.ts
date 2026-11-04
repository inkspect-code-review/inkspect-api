import { setTimeout } from 'node:timers/promises';
import { processPullRequest, type WorkflowServices } from "./pull-request-workflow-core";
import { closeDatabases } from "./database";
import { backgroundHealth } from "./background-health";
import { captureError, installDiagnostics } from "@inkspect/core/lib/diagnostics/server";
export async function runPullRequestWorker(services: WorkflowServices, closeEdition = async () => {}) {
installDiagnostics();
const closeHealth = backgroundHealth('pull-requests');
const abort = new AbortController();
let draining = false;
for (const signal of ['SIGTERM','SIGINT','SIGUSR2'] as const) process.once(signal, () => { draining = true; });
while (!draining) {
  try { if (await processPullRequest(abort.signal, services)) continue; }
  catch (error) { captureError('github.workflow_unavailable', error); }
  try { await setTimeout(2000, undefined, { signal: abort.signal }); } catch { break; }
}
closeHealth();
await closeDatabases();
await closeEdition();
}
