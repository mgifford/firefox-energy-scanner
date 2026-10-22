import type { StepResult } from '../core/types.js';
import { failedSteps, groupByStep } from '../report/csv.js';
import { isNotAPage } from '../core/failures.js';
import { median } from '../core/stats.js';

/**
 * Choose which URLs Lighthouse should visit after a Firefox run.
 *
 * Measure mode: every requested URL except those Firefox found to be file
 * downloads — Lighthouse cannot audit a PDF, and launching Chrome to be told
 * so is wasted work.
 *
 * Crawl mode: the `top` heaviest pages by median transfer. A crawl can cover
 * 200 pages and Lighthouse takes tens of seconds per run, so it goes where
 * the bytes are.
 */
export function pickLighthouseUrls(
  steps: StepResult[],
  requested: string[],
  mode: 'measure' | 'crawl',
  top: number,
): { urls: string[]; skipped: string[] } {
  const notPages = new Set(
    failedSteps(steps)
      .filter((f) => isNotAPage(f.reason))
      .map((f) => f.step),
  );

  if (mode === 'measure') {
    return {
      urls: requested.filter((u) => !notPages.has(u)),
      skipped: requested.filter((u) => notPages.has(u)),
    };
  }

  const ranked = [...groupByStep(steps)]
    .map(([step, runs]) => ({
      step,
      bytes: median(runs.map((r) => r.network?.transferBytes ?? 0)),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .map((x) => x.step);
  return { urls: ranked.slice(0, Math.max(0, top)), skipped: [...notPages] };
}
