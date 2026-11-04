import type { Pool } from "pg";
import { createChatReplyService, type ChatGenerationOptions } from "@inkspect/core/lib/chat-ai";
import { selfHostedChatLedger } from "./chat-ledger";

export function createSelfHostedChatReply(pool: Pool, options: ChatGenerationOptions = {}) {
  return createChatReplyService(selfHostedChatLedger(pool), options);
}
