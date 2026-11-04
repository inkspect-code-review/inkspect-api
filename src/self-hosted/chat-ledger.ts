import type { Pool, PoolClient } from "pg";
import type { ChatLedger, ChatReplyInput } from "@inkspect/core/lib/chat-ai";
import { AIError, type AIReply } from "@inkspect/core/lib/bedrock";

// Persist execution/measurement separately from Cloud credit accounting.
export function selfHostedChatLedger(pool: Pool): ChatLedger {
  async function transaction<T>(input: ChatReplyInput, run: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      if (!(await tx.query('SELECT id FROM organization WHERE id=$1 FOR UPDATE', [input.organizationId])).rowCount) throw new AIError(403, "Chat access denied.");
      if (!(await tx.query('SELECT 1 FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE', [input.organizationId, input.userId])).rowCount) throw new AIError(403, "Chat access denied.");
      if (!(await tx.query('SELECT 1 FROM "chatConversation" WHERE id=$1 AND "organizationId"=$2 AND "userId"=$3', [input.conversationId, input.organizationId, input.userId])).rowCount) throw new AIError(403, "Chat access denied.");
      const result = await run(tx); await tx.query("COMMIT"); return result;
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  async function measurement(input: ChatReplyInput, operation: string, reply: AIReply | undefined, calls: number) {
    await transaction(input, async tx => {
      // Only measured usage, never prompt, response content or commercial markup.
      const data = reply ? { model: reply.model, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, totalTokens: reply.totalTokens, cachedInputTokens: reply.cacheReadInputTokens, cacheWriteInputTokens: reply.cacheWriteInputTokens, durationMs: reply.durationMs, providerCostNanoUSD: reply.chargedNanoUSD } : {};
      await tx.query("INSERT INTO workspace_chat_usage(organization_id,operation_id,user_id,message_id,calls,measurement) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,operation_id) DO NOTHING", [input.organizationId, `${operation}:${input.messageId}`, input.userId, input.messageId, calls, data]);
    });
  }
  return {
    begin: (input, model) => transaction(input, async tx => {
      const prior = (await tx.query("SELECT * FROM workspace_chat_turn WHERE message_id=$1", [input.messageId])).rows[0];
      if (prior) {
        if (prior.organization_id !== input.organizationId || prior.user_id !== input.userId || prior.conversation_id !== input.conversationId) throw new AIError(403, "Chat access denied.");
        if (prior.state === "done") {
          if (prior.result) return prior.result as AIReply;
          throw new AIError(409, "This reply is already saved. Reopen the conversation to read it.");
        }
        throw new AIError(409, "This request has already started. Reopen the conversation before sending a new question.");
      }
      await tx.query("INSERT INTO workspace_chat_turn(message_id,organization_id,user_id,conversation_id,model) VALUES($1,$2,$3,$4,$5)", [input.messageId, input.organizationId, input.userId, input.conversationId, model]);
      return null;
    }),
    check: input => transaction(input, async tx => {
      const row = (await tx.query("SELECT state,redacted FROM workspace_chat_turn WHERE message_id=$1 AND organization_id=$2 AND user_id=$3 AND conversation_id=$4", [input.messageId, input.organizationId, input.userId, input.conversationId])).rows[0];
      if (!row || row.state !== "pending" || row.redacted) throw new AIError(409, "This question is no longer active.");
    }),
    routing: (input, route, usage) => measurement(input, "route", usage, usage || !route ? 1 : 0),
    title: (input, usage) => measurement(input, "title", usage, 1),
    failed: async (input, _model, calledModel) => {
      // Record unknown provider outcomes without retrying or claiming zero cost.
      await measurement(input, "answer", undefined, calledModel ? 1 : 0);
      await pool.query("UPDATE workspace_chat_turn SET state='failed' WHERE message_id=$1 AND organization_id=$2 AND user_id=$3 AND state='pending'", [input.messageId, input.organizationId, input.userId]);
    },
    complete: async (input, reply, calledModel) => {
      await measurement(input, "answer", reply, calledModel ? 1 : 0);
      await transaction(input, async tx => {
        await tx.query("UPDATE workspace_chat_turn SET state='done',result=CASE WHEN redacted THEN NULL ELSE $4::jsonb END WHERE message_id=$1 AND organization_id=$2 AND user_id=$3 AND state='pending'", [input.messageId, input.organizationId, input.userId, reply]);
      });
    },
    delivered: async id => { await pool.query("UPDATE workspace_chat_turn SET result=NULL WHERE message_id=$1 AND state='done'", [id]); },
    deleteConversation: async (organization, conversation) => { await pool.query("UPDATE workspace_chat_turn SET redacted=true,result=NULL WHERE organization_id=$1 AND conversation_id=$2", [organization, conversation]); },
  };
}
