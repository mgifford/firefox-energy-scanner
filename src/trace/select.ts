import type { StepResult } from '../core/types.js';
import type { FamilyReport } from '../analysis/families.js';
import { pickLighthouseUrls } from '../lighthouse/select.js';

/**
 * Choose the few pages to trace after a Firefox run.
 *
 * In measure mode, the requested URLs in order. In a crawl, one page per
 * family first (each family's representative, largest family first), so the
 * traces cover different templates; then the heaviest remaining pages. Never
 * downloads or pages the network guard refused, as for Lighthouse.
 */
export function pickTraceUrls(
  steps: StepResult[],
  requested: string[],
  mode: 'measure' | 'crawl',
  n: number,
  families?: FamilyReport,
): string[] {
  const { urls: heaviest } = pickLighthouseUrls(steps, requested, mode, mode === 'measure' ? undefined : Number.MAX_SAFE_INTEGER);
  if (mode === 'measure') return heaviest.slice(0, n);
  const usable = new Set(heaviest);
  const out: string[] = [];
  for (const f of families?.families ?? []) {
    if (out.length >= n) break;
    if (usable.has(f.representative) && !out.includes(f.representative)) out.push(f.representative);
  }
  for (const u of heaviest) {
    if (out.length >= n) break;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
