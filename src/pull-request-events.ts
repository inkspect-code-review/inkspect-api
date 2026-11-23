import { randomUUID } from 'node:crypto';
import { database } from "./database";
import { unified } from 'unified';
import remarkParse from 'remark-parse';

const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export type PullEvent = { installation: number; repository: number; fullName: string; number: number; mergedAt?: string;
  message?: { id: number; kind: 'issue' | 'inline'; sender: string; intent: 'review' | 'explain'; replyTo?: number; note?: string } };

// Notes stay well inside the engine's 2000-byte review-note bound.
export const NOTE_BYTES = 1500;
// Phrases that only ask for another review add no context of their own.
const REQUEST_ONLY = /^(?:(?:please|pls|lütfen|lutfen)\s+)?(?:re-?review|review(?:\s+(?:again|this|it|please))?|(?:tekrar|yeniden)\s+(?:incele|review|bak)|incele)(?:\s+(?:please|pls|lütfen|lutfen))?[\s.!?]*$/iu;
// Thanks and acknowledgments addressed to the App never start a paid review.
const ACKNOWLEDGMENT = new Set(['thanks', 'thank', 'you', 'thx', 'ty', 'much', 'so', 'very', 'a', 'lot', 'great', 'nice', 'good', 'awesome',
  'perfect', 'cool', 'job', 'work', 'ok', 'okay', 'süper', 'super', 'harika', 'güzel', 'guzel', 'teşekkürler', 'tesekkurler', 'teşekkür',
  'tesekkur', 'ederim', 'sağol', 'sagol', 'sağ', 'sag', 'ol', 'eyvallah', 'tamam', 'çok', 'cok']);
const acknowledgment = (text: string) => {
  const words = text.toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.every(word => ACKNOWLEDGMENT.has(word));
};

// The GitHub App's login comes from its slug; GitHub shows it as @slug or @slug[bot].
export function appLogin(slug = process.env.GITHUB_APP_SLUG) {
  const name = (slug || '').trim().replace(/^"(.*)"$/, '$1').toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(name) ? name : 'inkspectsi';
}
// Removal also takes punctuation attached to the mention, as in "@app: check X".
const mention = (login: string, flags = 'iu', suffix = '') => new RegExp(`(?<![\\p{L}\\p{N}_.\\-])@${login}(?:\\[bot\\])?(?![\\p{L}\\p{N}_\\-])${suffix}`, flags);
const commentParser = unified().use(remarkParse);
function addressedProse(body: string) {
  const parts: string[] = [];
  const visit = (node: any) => {
    if (['blockquote', 'code', 'inlineCode', 'html', 'link', 'linkReference', 'image', 'imageReference', 'definition'].includes(node.type)) return;
    if (node.type === 'text') {
      // Keep source escapes: a literal \@ in Markdown is not a bot mention.
      parts.push(body.slice(node.position.start.offset, node.position.end.offset).replace(/\\@/g, ' '));
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(commentParser.parse(body));
  return parts.join('\n');
}
function boundBytes(text: string, limit: number) {
  if (Buffer.byteLength(text) <= limit) return text;
  let out = '';
  for (const char of text) { if (Buffer.byteLength(out + char) > limit - 3) break; out += char; }
  return out.trimEnd() + '…';
}

// A comment addressed to the App asks for a review when it carries any text
// besides the mention; that text becomes the note. A bare mention gets help.
// Quotes, HTML comments and code are never treated as addressing the App.
export function addressedRequest(body: string, login = appLogin()): { addressed: boolean; review: boolean; note?: string } {
  const own = body.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
  const prose = addressedProse(body);
  if (!mention(login).test(prose)) return { addressed: false, review: false };
  // Lone surrogates become U+FFFD so the note is valid UTF-8 for the engine.
  const text = own.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD').replace(mention(login, 'giu', '[,:;]?'), ' ')
    .replace(/[\p{Cc}]/gu, c => c === '\n' || c === '\t' ? c : ' ')
    .replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ +([,.;:!?])/g, '$1')
    .trim();
  if (!text) return { addressed: true, review: false };
  if (acknowledgment(text)) return { addressed: false, review: false };
  if (REQUEST_ONLY.test(text)) return { addressed: true, review: true };
  return { addressed: true, review: true, note: boundBytes(text, NOTE_BYTES) };
}

// Webhook content only wakes trusted database bindings. Never use payload URLs,
// repository text, or the sender as a billing identity or engine configuration.
export function parsePullEvent(event: string, data: any): PullEvent | null {
  if (!data || !positive(data.installation?.id) || !positive(data.repository?.id) ||
      typeof data.repository.full_name !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.repository.full_name)) return null;
  let number: unknown;
  let message: PullEvent['message'];
  if (event === 'pull_request') {
    if (!['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited', 'closed', 'converted_to_draft'].includes(data.action)) return null;
    number = data.number;
    if (data.pull_request?.number !== number || data.pull_request?.base?.repo?.id !== data.repository.id) return null;
  } else if (event === 'issue_comment' || event === 'pull_request_review_comment') {
    if (data.action !== 'created' || data.sender?.type !== 'User' || data.comment?.user?.type !== 'User' ||
        !positive(data.comment?.id) || typeof data.comment.body !== 'string' || data.comment.user.login !== data.sender.login ||
        typeof data.sender.login !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(data.sender.login)) return null;
    const body = data.comment.body.slice(0, 8000);
    const request = addressedRequest(body);
    // Human conversations, including replies to our findings, are not commands
    // unless this comment explicitly addresses the App in its own prose.
    if (!request.addressed) return null;
    if (event === 'issue_comment' && !data.issue?.pull_request) return null;
    number = event === 'issue_comment' ? data.issue.number : data.pull_request?.number;
    // An inline note keeps the commented location so "this line" stays meaningful.
    const where = event === 'pull_request_review_comment' && typeof data.comment.path === 'string' && /^[^\p{Cc}]{1,300}$/u.test(data.comment.path)
      ? `${data.comment.path}${positive(data.comment.line) ? `:${data.comment.line}` : ''}: ` : '';
    const note = request.note ? boundBytes(where + request.note, NOTE_BYTES) : undefined;
    message = { id: data.comment.id, kind: event === 'issue_comment' ? 'issue' : 'inline', sender: data.sender.login,
      intent: request.review ? 'review' : 'explain', ...(positive(data.comment.in_reply_to_id) ? { replyTo: data.comment.in_reply_to_id } : {}),
      ...(note ? { note } : {}) };
  } else return null;
  if (!positive(number) || number > 2147483647) return null;
  const pull = data.pull_request;
  const mergedAt = event === 'pull_request' && data.action === 'closed' && pull.merged === true &&
    typeof data.repository.default_branch === 'string' && pull.base.ref === data.repository.default_branch &&
    typeof pull.merged_at === 'string' && Number.isFinite(Date.parse(pull.merged_at))
    ? new Date(pull.merged_at).toISOString() : undefined;
  return { ...(mergedAt ? { mergedAt } : {}), installation: data.installation.id, repository: data.repository.id, fullName: data.repository.full_name, number, message };
}

export async function enqueuePullEvent(event: PullEvent, pool = database()) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const binding = (await tx.query(`SELECT c.id,c."organizationId",coalesce(s.automatic,true) AS automatic FROM "githubConnection" c
      JOIN "githubRepositoryClaim" claim ON claim."organizationId"=c."organizationId" AND claim."repositoryId"=$2
      LEFT JOIN api_review_settings s ON s.organization_id=c."organizationId"
      WHERE c."installationId"=$1
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.repositories::jsonb) r WHERE r->>'id'=$2 AND lower(r->>'fullName')=lower($3))`,
    [String(event.installation), String(event.repository), event.fullName])).rows[0];
    if (!binding) { await tx.query('COMMIT'); return; }
    if (event.mergedAt) {
      await tx.query(`INSERT INTO api_merge_index_refresh(organization_id,repository_id,connection_id,installation_id,merged_at,due_at,request_id)
        VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '1 hour',$6)
        ON CONFLICT(organization_id,repository_id,connection_id,installation_id) DO UPDATE
        SET merged_at=excluded.merged_at,due_at=excluded.due_at,request_id=excluded.request_id
        WHERE excluded.merged_at > api_merge_index_refresh.merged_at`,
        [binding.organizationId,String(event.repository),binding.id,event.installation,event.mergedAt,randomUUID()]);
    }
    if (binding.automatic === false) { await tx.query('COMMIT'); return; }
    const row = (await tx.query(`INSERT INTO api_pull_request_workflow(id,organization_id,repository_id,connection_id,installation_id,number)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,repository_id,connection_id,installation_id,number)
      DO UPDATE SET wake_at=clock_timestamp(),next_run_at=clock_timestamp() RETURNING id`,
    [randomUUID(), binding.organizationId, String(event.repository), binding.id, event.installation, event.number])).rows[0];
    if (event.message) {
      const m = event.message;
      await tx.query(`INSERT INTO api_pull_request_message(workflow_id,comment_id,kind,sender,intent,reply_to,note) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [row.id, m.id, m.kind, m.sender, m.intent, m.replyTo ?? null, m.note ?? null]);
    }
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}
