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

function sameIssue(before: string, now: string) {
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
  return threads.find(thread => thread.job !== job && thread.path === finding.location.path &&
    thread.line === finding.location.start_line && (thread.finding === finding.id || sameIssue(thread.body, body)));
}

export function continuingSummary(report: string, findings: { title: string; thread: number }[], pullUrl: string) {
  if (!findings.length) return report;
  let summary = report + '\n\n### Still present from earlier reviews (' + findings.length + ')';
  for (const [index, finding] of findings.entries()) {
    const label = finding.title.slice(0, 200).replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()<>~|@!#&]/g, char => '&#' + char.charCodeAt(0) + ';');
    const entry = `\n- [${label}](${pullUrl}#discussion_r${finding.thread})`;
    if (Buffer.byteLength(summary + entry) > 64000) return summary + `\n- Plus ${findings.length - index} more continuing findings.`;
    summary += entry;
  }
  return summary;
}
