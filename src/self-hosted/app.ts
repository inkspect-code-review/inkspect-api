import { createApplication } from "../app-core";
import type { Auth } from "@inkspect/core/lib/github";
import { applicationPool } from "@inkspect/core/lib/application-database";
import { getSelfHostedAuth } from "@inkspect/core/self-hosted/auth-runtime";
import { selfHostedMembership } from "./membership-service";
import { selfHostedProviders } from "./provider-store";
import { selfHostedReviewLifecycle } from "./review-lifecycle";
import { selfHostedUsageHistory } from "./usage-history";
import { createSelfHostedChatReply } from "./chat-ai";
import { handleReviews } from "@inkspect/core/lib/review-routes";
import { handleByokSettings } from "@inkspect/core/lib/byok/routes";
import { handleWorkspaceChat } from "@inkspect/core/lib/chat-store";
import { engineRequest } from "@inkspect/core/lib/engine-client";
import { storedReviewModels } from "@inkspect/core/lib/review-models";
import { authorizeRealtime, publishRealtimeTest } from "@inkspect/core/lib/realtime";

export function createSelfHostedApp(options: { origin: string; pool?: ReturnType<typeof applicationPool>; auth?: () => Auth }) {
  const pool = options.pool ?? applicationPool();
  const providers = selfHostedProviders(pool);
  const lifecycle = selfHostedReviewLifecycle(pool);
  const reply = createSelfHostedChatReply(pool);
  return createApplication({ origin: options.origin, edition: {
    auth: options.auth ?? getSelfHostedAuth,
    membership: selfHostedMembership(pool),
    reviews: (request, auth) => handleReviews(request, auth, engineRequest, lifecycle, scope => storedReviewModels(scope, pool), providers.state),
    byok: (request, auth) => handleByokSettings(request, auth, providers),
    chat: (request, auth) => handleWorkspaceChat(request, auth, reply),
    usage: (organization, query) => selfHostedUsageHistory(pool, organization, query),
    realtime: { authorize: authorizeRealtime, test: publishRealtimeTest },
  } });
}
