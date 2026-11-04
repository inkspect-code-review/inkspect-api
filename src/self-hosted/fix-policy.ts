import type { Pool } from 'pg';
import { selfHostedReviews } from "./review-store";
import { selfHostedProviders } from "./provider-store";
import { ReviewError } from "@inkspect/core/lib/review-access";
import { byokReady } from "../engine-credentials";
import { selfHostedProviderCredential } from "./engine-policy";
import type { FixPolicy } from "../engine-fix-policy";

export function selfHostedFixPolicy(pool: Pool): FixPolicy {
  const reviews = selfHostedReviews(pool), providers = selfHostedProviders(pool);
  return {
    managedMode: 'self-hosted',
    async provider(claims) {
      const selected = await providers.forReview(claims.tenant, claims.subject);
      if (selected && !byokReady()) throw new ReviewError(503, 'Provider key decryption is not configured on the review engine.');
      return selected;
    },
    reserve: input => reviews.reserve(input),
    attach: (input, id, tx) => reviews.attach(input, id, tx),
    credential: job => selfHostedProviderCredential(pool, job),
    async revalidate(job) {
      await reviews.authorize({ organization: job.organization_id, user: job.subject, repository: Number(job.repository_id),
        connection: job.connection_id, installation: Number(job.installation_id), body: job.request });
    },
  };
}
