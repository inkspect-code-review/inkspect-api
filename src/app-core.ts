import { organizationAccess } from "@inkspect/core/lib/organization-access";
import { handleMembers, handleInvitation } from "@inkspect/core/lib/member-routes";
import { githubWebhook } from "./github-webhook";
import { reviewSettings } from "./review-settings";
import { githubInstallationAccess, githubPermissions } from "./github-permissions";
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { handleKnowledge } from "@inkspect/core/lib/knowledge-store";
import { reviewJSON, reviewFailure } from "@inkspect/core/lib/review-access";
import { observeRoute } from "@inkspect/core/lib/diagnostics/http";
import { captureError } from "@inkspect/core/lib/diagnostics/server";
import { repositories } from "./repositories";
import { database } from "./database";
import type { Auth } from "@inkspect/core/lib/github";
import type { MembershipService } from "@inkspect/core/lib/membership-service";
type AuthHandler = (request: Request, auth: Auth) => Promise<Response>;
export type ApiEdition = {
  auth: () => Auth;
  membership: MembershipService;
  reviews: AuthHandler;
  byok: AuthHandler;
  chat: AuthHandler;
  usage: (organization: string, query: URLSearchParams) => Promise<unknown>;
  realtime: { authorize: AuthHandler; test: AuthHandler };
  extensions?: Record<string, (request: Request) => Promise<Response>>;
};
export function createApplication(options: { origin: string; edition: ApiEdition; repositories?: typeof repositories }) {
  const app = new Hono();
  const { edition } = options;
  const auth = edition.auth;
  const allowed = new URL(options.origin).origin;
  app.use('*', secureHeaders());
  app.use('/api/*', cors({ origin: allowed, credentials: true, allowMethods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowHeaders: ['Content-Type'], exposeHeaders: ['X-Inkspect-Request-Id','Server-Timing'], maxAge: 600 }));
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && origin !== allowed) return c.json({ error: 'This origin is not allowed.' }, 403);
    const started = performance.now();
    c.header('Cache-Control','private, no-store');
    await next();
    c.header('Server-Timing', `api;dur=${(performance.now()-started).toFixed(1)}`);
  });
  app.get('/health', c => c.json({ status: 'ok', service: 'inkspect-api', version: process.env.INKSPECT_VERSION }));
  app.get('/ready', async c => { try { await database().query('SELECT 1'); return c.json({status:'ready'}); } catch { return c.json({status:'unavailable'},503); } });
  // The login/callback endpoints stay at the existing app origin. Both servers
  // validate the same Better Auth sessions directly against PostgreSQL.
  const mount = (path: string, handler: (request: Request) => Promise<Response>) => app.all(path, c => observeRoute(handler)(c.req.raw));
  mount('/api/webhooks/github', githubWebhook);
  mount('/api/review-settings', req => {
    const view = new URL(req.url).searchParams.get('view');
    if (view === 'github-permissions') return githubPermissions(req, auth());
    if (view === 'github-access') return githubInstallationAccess(req, auth());
    return reviewSettings(req, auth());
  });
  mount('/api/repositories', req => (options.repositories ?? repositories)(req, auth()));
  mount('/api/reviews', req => edition.reviews(req, auth()));
  mount('/api/byok', req => edition.byok(req, auth()));
  mount('/api/knowledge', req => handleKnowledge(req, auth()));
  mount('/api/workspace-chat', req => edition.chat(req, auth()));
  mount('/api/members', req => handleMembers(req,auth(),edition.membership));
  mount('/api/invitation', req => handleInvitation(req,auth(),edition.membership));
  mount('/api/realtime/auth', req => edition.realtime.authorize(req, auth()));
  mount('/api/realtime/test', req => edition.realtime.test(req, auth()));
  mount('/api/usage', async req => { try { if(req.method !== 'GET')return reviewJSON({error:'Method not allowed.'},405);const access=await organizationAccess(req,auth());return reviewJSON(await edition.usage(access.organizationId,new URL(req.url).searchParams)); } catch(error) {return reviewFailure(error);} });
  for (const [path, handler] of Object.entries(edition.extensions ?? {})) mount(path, handler);
  app.notFound(c => c.json({error:'Not found.'},404));
  app.onError((error,c) => { captureError('api.request_failed',error,{path:new URL(c.req.url).pathname}); return c.json({error:'The API is temporarily unavailable. Please retry.'},503); });
  return app;
}
