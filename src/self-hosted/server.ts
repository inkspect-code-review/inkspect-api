import { serve } from '@hono/node-server';
import { createSelfHostedApp } from "./app";
import { closeDatabases } from "../database";
import { applicationPool } from "@inkspect/core/lib/application-database";
import { installDiagnostics } from "@inkspect/core/lib/diagnostics/server";

installDiagnostics();
const origin = process.env.BETTER_AUTH_URL;
if (!origin) throw new Error('BETTER_AUTH_URL is required');
const port = Number(process.env.PORT || 3003);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid API port');
const pool = applicationPool();
const app = createSelfHostedApp({ origin, pool });
const server = serve({ fetch: app.fetch, hostname: process.env.API_HOST || '127.0.0.1', port }, () => console.log(JSON.stringify({ event: 'api.ready', edition: 'self-hosted', port })));
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await Promise.all([closeDatabases(), pool.end()]); process.exit(0); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
