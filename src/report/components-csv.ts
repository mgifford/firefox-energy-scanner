import type { BenchmarkResult } from '../core/types.js';

/**
 * One row per recognised component, for a spreadsheet. A separate file from
 * the per-run CSV, whose rows are measurements; these rows are not.
 */
const COLUMNS = [
  'component_id', 'signature', 'kind', 'method', 'confidence',
  'pages', 'reach', 'families', 'occurrences', 'nodes_median', 'nodes_max', 'share_of_page',
  'images', 'eager_offscreen_images', 'videos', 'autoplay_videos', 'iframes', 'canvases',
  'running_animations', 'endless_animations', 'third_party_hosts',
  'lighthouse_findings', 'lighthouse_audits', 'example_page', 'example_selector', 'signals',
] as const;

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  // Leading = + - @ would be read as a formula by spreadsheets.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function componentsCsv(result: BenchmarkResult): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const c of result.components?.components ?? []) {
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      component_id: c.id,
      signature: c.signature,
      kind: c.kind,
      method: c.method,
      confidence: c.confidence,
      pages: c.pages,
      reach: c.reach,
      families: c.families.join(' '),
      occurrences: c.occurrences,
      nodes_median: c.nodes.median,
      nodes_max: c.nodes.max,
      share_of_page: c.shareOfPage,
      images: c.media?.images,
      eager_offscreen_images: c.media?.eagerOffscreenImages,
      videos: c.media?.videos,
      autoplay_videos: c.media?.autoplayVideos,
      iframes: c.media?.iframes,
      canvases: c.media?.canvases,
      running_animations: c.animations?.running,
      endless_animations: c.animations?.infinite,
      third_party_hosts: c.thirdPartyHosts.join(' '),
      lighthouse_findings: c.evidence.length,
      lighthouse_audits: [...new Set(c.evidence.map((e) => e.audit))].join(' '),
      example_page: c.examples[0]?.page,
      example_selector: c.examples[0]?.selector,
      signals: c.signals.join(' '),
    };
    lines.push(COLUMNS.map((k) => cell(row[k])).join(','));
  }
  return lines.join('\n') + '\n';
}
