import type { ReviewReport } from "@inkspect/core/lib/review-types";

// Operational messages still quote participant text. Review content comes
// exclusively from the engine, including escaping, scores and diagrams.
export const safeText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '@\u200b');

function comment(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 58000) throw new Error('Missing or invalid engine presentation');
  return value;
}

export function reportBody(report: ReviewReport) {
  if (report.presentation?.version !== 1) throw new Error('Unsupported engine presentation');
  return comment(report.presentation.github_summary);
}

export function findingBody(report: ReviewReport, id: string) {
  if (report.presentation?.version !== 1) throw new Error('Unsupported engine presentation');
  return comment(report.presentation.github_findings[id]);
}
