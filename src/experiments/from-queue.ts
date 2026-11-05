/**
 * An experiment for an item of a result's investigation queue: the remedy's
 * experiment kind, scoped to the item's selector or hosts, on the page where
 * it was found. The spec is returned, not run, so it can be saved, read and
 * versioned before anything is measured.
 */

import type { BenchmarkResult } from '../core/types.js';
import type { ExperimentSpec } from './experiment.js';
import { parseSpec } from './experiment.js';
import { safeSelector } from './variants.js';

export function specFromQueue(result: BenchmarkResult, rank: number): { spec: ExperimentSpec; note: string } {
  const item = result.investigation?.items.find((i) => i.rank === rank);
  if (!item) throw new Error(`No item ${rank} in this result's investigation queue.`);
  const where = item.where[0];
  if (!where) throw new Error(`Item ${rank} has no page to run on.`);
  const remedy = item.remediation.find((r) => r.experiment);
  if (!remedy) throw new Error(`No experiment fits item ${rank} (${item.title}). Write one with --kind, or a spec file.`);
  const record = result.components?.components.find((c) => c.id === item.id);
  const selector = safeSelector(where.selector);
  const name = `${remedy.id}-${item.id}`.slice(0, 80);
  const base = { name, url: where.page, idle_ms: 10_000, assertions: [] as ExperimentSpec['assertions'] };

  let spec: unknown;
  let note: string;
  switch (remedy.experiment) {
    case 'animation':
      spec = { ...base, kind: 'pause-animations', ...(selector ? { selector } : {}) };
      note = `Pause CSS animations in ${selector ?? 'the page'}, for "${remedy.title}".`;
      break;
    case 'reduced-motion':
      spec = { ...base, kind: 'reduced-motion' };
      note = 'Turn on prefers-reduced-motion.';
      break;
    case 'lazy-loading':
      spec = { ...base, kind: 'lazy-images', keep_eager: 2 };
      note = 'Lazy-load the page’s images after the first two (page-wide: the attribute is added before the page is parsed, where selectors cannot be matched).';
      break;
    case 'autoplay':
      spec = { ...base, kind: 'no-autoplay' };
      note = 'Remove autoplay from the page’s videos.';
      break;
    case 'facade':
      if (record?.thirdPartyHosts.length) {
        spec = { ...base, kind: 'block', hosts: record.thirdPartyHosts };
        note = `Refuse requests to ${record.thirdPartyHosts.join(', ')}: what the embed costs, as an upper bound for a facade.`;
      } else if (selector) {
        spec = { ...base, kind: 'hide', selector };
        note = `Hide ${selector}: an upper bound for loading the embed on interaction.`;
      } else throw new Error(`Item ${rank} has no third-party host or selector to experiment on.`);
      break;
    case 'pagination':
      if (!selector) throw new Error(`Item ${rank} has no selector to experiment on.`);
      spec = { ...base, kind: 'hide', selector };
      note = `Hide ${selector}: an upper bound for rendering fewer elements there.`;
      break;
    case 'script': {
      const urls =
        item.kind === 'script'
          ? [item.url ?? item.title].filter((u) => /^https?:\/\//.test(u))
          : (record?.resources.filter((r) => r.kind === 'script').map((r) => r.url) ?? []);
      if (!urls.length) throw new Error(`Item ${rank} has no script URL to refuse.`);
      spec = { ...base, kind: 'block', urls };
      note = `Refuse ${urls.length === 1 ? urls[0] : `${urls.length} scripts`}: what the script costs, as an upper bound for deferring it. Check the page still works.`;
      break;
    }
    default:
      throw new Error(`No experiment fits item ${rank}.`);
  }
  return { spec: parseSpec(spec), note };
}
