import type { AIReply } from "@inkspect/core/lib/bedrock";
import type { EngineJob } from "./engine-store";
import type { EngineHttpPolicy } from "./engine-http-policy";
import type { FixPolicy } from "./engine-fix-policy";
import type { ProviderCredential } from "./engine-credentials";
import type { HostConfig } from "./engine-contract";

export interface EngineWorkerPolicy {
  /** Optional edition work, sharing the active generation's capacity and drain lifecycle. */
  background?: () => Promise<void>;
  http: EngineHttpPolicy;
  fix: FixPolicy;
  allowed(job: EngineJob): Promise<{ allowed: boolean }>;
  credential(job: EngineJob): Promise<ProviderCredential | undefined>;
  receipt(job: EngineJob, events: any[]): Record<string, unknown>;
  retrieval(job: EngineJob, events: any[]): Promise<void>;
  settle(job: EngineJob): Promise<void>;
  pending(): Promise<EngineJob[]>;
  checked(job: EngineJob): Promise<void>;
  indexUsage(scope: { organization: string; user: string; repository: string; operation: string }, events: any[], chunks: number, description: AIReply, host: HostConfig): Promise<void>;
}
