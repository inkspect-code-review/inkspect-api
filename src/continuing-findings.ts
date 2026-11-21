import type { FindingThread } from './pull-request-github';

// Compare the issue and the proposed repair separately. Verification steps and
// the bot's footer are often identical across unrelated findings.
function sections(body: string) {
  const match = /^\*\*[^\n]*? · (.+?)\*\*\n\n([\s\S]+?)\n\n\*\*Suggested fix\*\*\n([\s\S]+?)\n\n\*\*Verification\*\*/.exec(body);
  return match && { title: match[1], reason: match[2], fix: match[3] };
}

const common = new Set('about after along also before both check code could from into need should that their then these this update using when while with would'.split(' '));
function words(text: string) {
  return new Set((text.toLowerCase().replaceAll('\\', '').match(/[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/gu) ?? [])
    .filter(word => word.length >= 3 && !common.has(word)));
}
function overlap(a: string, b: string) {
  const left = words(a), right = words(b);
  const shared = [...left].filter(word => right.has(word)).length;
  return { shared, fraction: shared / Math.max(1, Math.min(left.size, right.size)) };
}

export function sameIssue(before: string, now: string) {
  if (before === now) return true;
  const a = sections(before), b = sections(now);
  if (!a || !b) return false;
  const title = overlap(a.title, b.title);
  const reason = overlap(a.reason, b.reason);
  const fix = overlap(a.fix, b.fix);
  if (a.title === b.title && (a.reason === b.reason || a.fix === b.fix)) return true;
  return title.shared >= 1 && reason.shared >= 4 && reason.fraction >= 0.4 && fix.shared >= 3 && fix.fraction >= 0.4;
}

export function originalThread(threads: FindingThread[], job: string, finding: { id: string; location: { path: string; start_line: number } }, body: string) {
  // GitHub maps surviving lines to their current position after a push/rebase.
  return threads.find(thread => !thread.outdated && thread.job !== job && thread.path === finding.location.path &&
    thread.line === finding.location.start_line && (thread.finding === finding.id || sameIssue(thread.body, body)));
}

type SummaryFinding = { id: string; title: string };
type Receipt = { id?: number; continued?: number };

// Version 1 engine summaries render finding sections in report order and may
// omit a suffix to fit GitHub. Keep unrecognized prose and all unlinked details.
export function linkedFindingSummary(report: string, findings: SummaryFinding[], deliveries: Record<string, Receipt>, pullUrl: string) {
  const link = (finding: SummaryFinding, id: number) => {
    const title = finding.title.slice(0, 500).replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()<>~|@!#&]/g, ch => '&#' + ch.charCodeAt(0) + ';');
    return `- [${title}](${pullUrl}#discussion_r${id})`;
  };
  const linked = new Set<string>();
  let index = 0;
  const block = /^#### [^\n]+\n\nLocation: [^\n]+\n\n\*\*Reason:\*\* [^\n]*\n\n\*\*Suggested fix:\*\* [^\n]*\n\n\*\*Verification:\*\* [^\n]*\n\n/gm;
  let summary = report.replace(block, original => {
    const finding = findings[index++];
    const delivery = finding && deliveries[finding.id];
    if (!delivery || (!delivery.id && !delivery.continued)) return original;
    linked.add(finding.id);
    return delivery.continued ? '' : link(finding, delivery.id!) + '\n\n';
  }).replace(/### Findings\n\n(?=>|\[View the full report|---)/, '');
  for (const continued of [false, true]) {
    const rows = findings.filter(f => continued ? deliveries[f.id]?.continued : deliveries[f.id]?.id && !linked.has(f.id));
    if (!rows.length) continue;
    summary += continued ? `\n\n### Still present from earlier reviews (${rows.length})` : '\n\n### Inline findings';
    for (const f of rows) {
      const entry = '\n' + link(f, (deliveries[f.id].continued ?? deliveries[f.id].id)!);
      if (Buffer.byteLength(summary + entry) > 64000) break;
      summary += entry;
    }
  }
  return summary;
}
