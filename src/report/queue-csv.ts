import type { BenchmarkResult } from '../core/types.js';

/**
 * The investigation queue as rows, for a spreadsheet or a ticket tracker.
 * Each sort key has its own column, so the order can be checked or redone.
 */
const COLUMNS = [
  'rank', 'kind', 'id', 'title', 'evidence', 'because', 'pages', 'of_pages', 'families',
  'elements', 'share_of_page', 'endless_animations', 'chromium_main_thread_ms', 'transfer_bytes',
  'remedies', 'verify', 'confidence', 'example_page', 'example_selector', 'lighthouse_audits',
] as const;

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function queueCsv(result: BenchmarkResult): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const i of result.investigation?.items ?? []) {
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      rank: i.rank,
      kind: i.kind,
      id: i.id,
      title: i.title,
      evidence: i.evidence,
      because: i.because.join('; '),
      pages: i.reach.pages,
      of_pages: i.reach.of,
      families: i.reach.families,
      elements: i.workload.elements,
      share_of_page: i.workload.shareOfPage,
      endless_animations: i.workload.endlessAnimations,
      chromium_main_thread_ms: i.workload.chromiumMainThreadMs,
      transfer_bytes: i.workload.transferBytes,
      remedies: i.remediation.map((r) => r.title).join('; '),
      verify: i.remediation[0]?.verify,
      confidence: i.confidence,
      example_page: i.where[0]?.page,
      example_selector: i.where[0]?.selector,
      lighthouse_audits: i.audits.join(' '),
    };
    lines.push(COLUMNS.map((k) => cell(row[k])).join(','));
  }
  return lines.join('\n') + '\n';
}
