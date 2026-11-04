-- Self-hosted message fields and idempotency indexes.
ALTER TABLE "chatMessage" ADD COLUMN IF NOT EXISTS sources text NOT NULL DEFAULT '[]';
ALTER TABLE "chatMessage" ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE "chatMessage" ADD COLUMN IF NOT EXISTS "clientRequestId" text;
ALTER TABLE "chatMessage" ADD COLUMN IF NOT EXISTS "replyToId" text;
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_client_request ON "chatMessage"("clientRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS chat_message_reply_to ON "chatMessage"("replyToId");
