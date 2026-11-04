import type { Pool } from "pg";
import type { ReviewLifecycle } from "@inkspect/core/lib/review-lifecycle";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { engineJobId } from "@inkspect/core/lib/review-identity";
import { storedReviewModels } from "@inkspect/core/lib/review-models";
import { selfHostedProviders } from "./provider-store";
import { selfHostedReviews, type ReviewReceipt } from "./review-store";

export function selfHostedReviewLifecycle(pool: Pool, models = storedReviewModels): ReviewLifecycle {
  const providers = selfHostedProviders(pool), executions = selfHostedReviews(pool);
  return {
    async start(access, body, claims, send) {
      if (access.organizationId !== claims.tenant || access.userId !== claims.subject) throw new ReviewError(403, "Review scope mismatch.");
      const policy = await send("/github/repositories", "GET", undefined, claims);
      if (policy.edition !== "self-hosted" || !policy.repositories?.some((repo: { id: number }) => repo.id === claims.repository)) throw new ReviewError(503, "Configure a self-hosted review service for this instance.");
      const byok = await providers.forReview(access.organizationId, access.userId);
      if (byok) {
        if (!policy.byok_available) throw new ReviewError(503, "Provider key decryption is not configured on the review engine.");
        if (body.model_id) throw new ReviewError(400, "Choose your organization model in Settings.");
        body = { ...body, byok };
      } else {
        const catalog = await models(claims, pool);
        if (!catalog.models.some(model => model.id === (body.model_id || catalog.default_model_id) && model.available)) throw new ReviewError(400, "This model is unavailable. Refresh the model list.");
      }
      const input = { organization: claims.tenant, user: claims.subject, repository: claims.repository, connection: claims.connection, installation: claims.installation, body };
      const row = await executions.reserve(input);
      try {
        const result = row.job_id ? await send(`/jobs/${row.job_id}`, "GET", undefined, claims) : await send("/github/reviews", "POST", body, claims);
        if (result?.job?.id !== engineJobId(row.request_id)) throw new ReviewError(502, "Review service returned a mismatched run.");
        await executions.attach(input, result.job.id);
        await executions.settle(access.organizationId, result);
        return result;
      } catch (error) {
        // Lost responses and unavailable services retain the original identity.
        // A rejection cannot release a concurrently attached engine job.
        if (error instanceof ReviewError && [400, 403, 404, 409, 429].includes(error.status)) await executions.reject(input);
        throw error;
      }
    },
    async settle(organization, value) {
      const result = value as { reviews?: ReviewReceipt[]; job?: ReviewReceipt["job"] } | null;
      const receipts = Array.isArray(result?.reviews) ? result.reviews : result?.job ? [result as ReviewReceipt] : [];
      for (const receipt of receipts) await executions.settle(organization, receipt);
    },
  };
}
