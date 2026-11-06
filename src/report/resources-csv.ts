import type { ComponentGraph } from '../model/graph.js';

/** One row per resource of the graph: where it is loaded, by what, and how much it weighs. */
const COLUMNS = ['resource_id', 'key', 'host', 'kind', 'third_party', 'scope', 'pages', 'families', 'transfer_bytes_median', 'transfer_bytes_max', 'loaded_by_instances'] as const;

function cell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function resourcesCsv(graph: ComponentGraph): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const r of graph.resources) {
    const row: Record<(typeof COLUMNS)[number], unknown> = {
      resource_id: r.id,
      key: r.key,
      host: r.host,
      kind: r.kind,
      third_party: r.thirdParty,
      scope: r.scope,
      pages: r.pages,
      families: r.families.join(' '),
      transfer_bytes_median: r.transferBytes.median,
      transfer_bytes_max: r.transferBytes.max,
      loaded_by_instances: r.loadedBy.length,
    };
    lines.push(COLUMNS.map((k) => cell(row[k])).join(','));
  }
  return lines.join('\n') + '\n';
}
