import { createServer } from 'node:http';
import { database } from "./database";

export function backgroundHealth(service: string) {
  const port = Number(process.env.INKSPECT_HEALTH_PORT);
  if (!port) return () => {};
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid health port');
  const server = createServer(async (req, res) => {
    if (req.url !== '/ready') { res.writeHead(404); res.end(); return; }
    try {
      await database().query('SELECT 1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', service, version: process.env.INKSPECT_VERSION }));
    } catch { res.writeHead(503); res.end(); }
  });
  server.listen(port, '127.0.0.1');
  return () => server.close();
}
