import { setTimeout } from 'node:timers/promises';
import { refreshOne } from "./metadata";
import { refreshOneGitHubPermission } from "./github-permissions";
import { closeDatabases } from "./database";
import { backgroundHealth } from "./background-health";
import { captureError, installDiagnostics } from "@inkspect/core/lib/diagnostics/server";
installDiagnostics();
const closeHealth = backgroundHealth('metadata');
const abort = new AbortController();
let draining = false;
for (const signal of ['SIGTERM','SIGINT','SIGUSR2'] as const) process.once(signal, () => { draining = true; });
while (!draining) {
  try { await refreshOneGitHubPermission(abort.signal); }
  catch (error) { captureError('metadata.github_permissions', error); }
  try { if (await refreshOne(abort.signal)) continue; }
  catch (error) { captureError('metadata.database_unavailable', error); }
  try { await setTimeout(2000, undefined, { signal: abort.signal }); } catch { break; }
}
closeHealth();
await closeDatabases();
