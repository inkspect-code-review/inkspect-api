import type { PoolClient } from 'pg';
import type { EngineClaims } from "@inkspect/core/lib/engine-client";
import type { ReviewIdentityInput } from "@inkspect/core/lib/review-identity";
import type { HostConfig } from "./engine-contract";
import type { Worker } from "./repository-store";

export type EngineScope = Omit<EngineClaims, 'expires'>;
export type RetrievalScope = { organization: string; user: string; repository: string; operation: string };
export interface EngineHttpPolicy {
  configuration(host: HostConfig): Record<string, unknown>;
  admission(input: ReviewIdentityInput): Promise<{ job_id: string | null }>;
  attach(input: ReviewIdentityInput, jobId: string, tx: PoolClient): Promise<void>;
  chatAccess(claims: EngineScope, messageId: unknown): Promise<void>;
  retrieval(events: any[], host: HostConfig, scope: RetrievalScope): Promise<void>;
  fix(worker: Worker, claims: EngineScope, sourceId: string, method: string, host: HostConfig, signal: AbortSignal, retryOf?: string): Promise<{ available: boolean; [key: string]: unknown }>;
  fixPullOpen(worker: Worker, sourceId: string, signal: AbortSignal): Promise<boolean>;
  /** Optional fix request extension; the implementation validates its own fields. */
  fixWithOptions?: (worker: Worker, claims: EngineScope, sourceId: string, method: string, host: HostConfig, signal: AbortSignal, body: Record<string, unknown>) => Promise<{ available: boolean; [key: string]: unknown }>;
}
