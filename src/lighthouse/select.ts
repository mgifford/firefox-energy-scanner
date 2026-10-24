import type { StepResult } from '../core/types.js';
import { failedSteps, groupByStep } from '../report/csv.js';
import { isNotAPage } from '../core/failures.js';
import { median } from '../core/stats.js';

/**
 * Choose which URLs Lighthouse should visit after a Firefox run.
 *
 * Never URLs that Firefox found to be file downloads: Lighthouse cannot audit
 * a PDF, and launching Chrome to be told so is wasted work.
 *
 * With `top`, the `top` heaviest pages by median transfer: Lighthouse takes
 * tens of seconds per page, so it goes where the bytes are. Without it, every
 * requested URL in measure mode (a crawl always uses a limit, default 10).
 */
export function pickLighthouseUrls(
  steps: StepResult[],
  requested: string[],
  mode: 'measure' | 'crawl',
  top: number | undefined,
): { urls: string[]; skipped: string[] } {
  const notPages = new Set(
    failedSteps(steps)
      .filter((f) => isNotAPage(f.reason))
      .map((f) => f.step),
  );
  const skipped = mode === 'measure' ? requested.filter((u) => notPages.has(u)) : [...notPages];

  if (mode === 'measure' && top === undefined) {
    return { urls: requested.filter((u) => !notPages.has(u)), skipped };
  }

  const ranked = [...groupByStep(steps)]
    .map(([step, runs]) => ({
      step,
      bytes: median(runs.map((r) => r.network?.transferBytes ?? 0)),
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .map((x) => x.step);
  return { urls: ranked.slice(0, Math.max(0, top ?? 10)), skipped };
}
