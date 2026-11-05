import type { PoolClient } from 'pg';
import type { ByokSelection } from "@inkspect/core/lib/byok/service";
import type { ReviewIdentityInput } from "@inkspect/core/lib/review-identity";
import type { EngineScope } from "./engine-http-policy";
import type { EngineJob } from "./engine-store";
import type { HostConfig } from "./engine-contract";
import type { Worker } from "./repository-store";
import type { ProviderCredential } from "./engine-credentials";

export interface FixPolicy {
  managedMode: string;
  commitCoAuthor?: string;
  provider(claims: EngineScope): Promise<ByokSelection | null>;
  reserve(input: ReviewIdentityInput & { repositoryName?: string }, host: HostConfig): Promise<unknown>;
  attach(input: ReviewIdentityInput, jobId: string, tx: PoolClient): Promise<void>;
  credential(job: EngineJob): Promise<ProviderCredential | undefined>;
  revalidate(job: EngineJob): Promise<void>;
  managedFix?: (job: EngineJob, worker: Worker, source: EngineJob, token: string, signal: AbortSignal,
    authorize: (verification: any) => Promise<string>, published: (oid: string) => Promise<void>) => Promise<{ report: any; events: any[] }>;
}
