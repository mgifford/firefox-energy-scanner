/**
 * Since the last scan: what changed between two scans of the same site.
 *
 * The seeded sample means a re-scan visits the same pages while the sitemap
 * is unchanged, so pages can be compared one to one. Crawls visit each page
 * once, so every difference here is indicative: no significance is claimed,
 * and energy is compared only when both scans measured it and resolved it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkResult, StepResult } from '../core/types.js';
import { median, resolution } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import { pageKey, siteOf } from '../collect/urls.js';
import { pagesOf } from './families.js';

export interface PageChange {
  url: string;
  transferBytes?: [number, number];
  domNodes?: [number, number];
  requests?: [number, number];
}

export interface HistoryReport {
  /** The earlier result file and when it ran. */
  previous: { file: string; timestamp: string };
  /** Pages measured in both scans. */
  pagesInBoth: number;
  pagesOnlyNow: number;
  pagesOnlyBefore: number;
  /** Medians over the pages in both scans: [before, now]. */
  medians: { transferBytes?: [number, number]; domNodes?: [number, number]; requests?: [number, number] };
  /** The pages that changed most, by transfer or elements. */
  largestChanges: PageChange[];
  families?: [number, number];
  components?: { appeared: string[]; gone: string[]; newSignals: { signature: string; signal: string }[] };
  /** Energy only when both scans measured it and resolved it. */
  energy: { comparable: boolean; medianMwh?: [number, number]; note: string };
  limitations: string[];
}

const pairOf = (a: number[], b: number[]): [number, number] | undefined => (a.length && b.length ? [median(a), median(b)] : undefined);

function byPage(r: BenchmarkResult): Map<string, StepResult> {
  // Queries kept: ?page=2 is another page.
  return new Map(pagesOf(r.scenarios).map((s) => [pageKey(s.url!, { queryStrategy: 'keep' }), s]));
}

function energyOf(r: BenchmarkResult): number[] {
  return r.scenarios
    .filter((s) => !s.warmup && s.valid && s.energy?.incrementalJoules !== undefined)
    .map((s) => joulesToMilliwattHours(s.energy!.incrementalJoules!));
}

/** Compare a result with an earlier one of the same site. */
export function compareWithPrevious(current: BenchmarkResult, previous: BenchmarkResult, previousFile: string): HistoryReport {
  const now = byPage(current);
  const before = byPage(previous);
  const both = [...now.keys()].filter((k) => before.has(k)).sort();

  const series = (k: 'transferBytes' | 'domNodes' | 'requests', m: Map<string, StepResult>) =>
    both.flatMap((p) => {
      const s = m.get(p)!;
      const v = k === 'domNodes' ? s.anatomy?.domNodes : s.network?.[k];
      return v === undefined ? [] : [v];
    });
  const medians: HistoryReport['medians'] = {};
  for (const k of ['transferBytes', 'domNodes', 'requests'] as const) {
    const pair = pairOf(series(k, before), series(k, now));
    if (pair) medians[k] = pair;
  }

  const changes: (PageChange & { size: number })[] = both.map((p) => {
    const a = before.get(p)!;
    const b = now.get(p)!;
    const t: [number, number] | undefined = a.network && b.network ? [a.network.transferBytes, b.network.transferBytes] : undefined;
    const d: [number, number] | undefined = a.anatomy && b.anatomy ? [a.anatomy.domNodes, b.anatomy.domNodes] : undefined;
    const r: [number, number] | undefined = a.network && b.network ? [a.network.requests, b.network.requests] : undefined;
    const rel = (x?: [number, number]) => (x && x[0] > 0 ? Math.abs(x[1] - x[0]) / x[0] : 0);
    return { url: b.url!, ...(t ? { transferBytes: t } : {}), ...(d ? { domNodes: d } : {}), ...(r ? { requests: r } : {}), size: Math.max(rel(t), rel(d)) };
  });
  const largestChanges = changes
    .filter((c) => c.size >= 0.1)
    .sort((x, y) => y.size - x.size || (x.url < y.url ? -1 : 1))
    .slice(0, 5)
    .map(({ size: _size, ...c }) => c);

  let components: HistoryReport['components'];
  if (current.components && previous.components) {
    const was = new Map(previous.components.components.map((c) => [c.id, c]));
    const is = new Map(current.components.components.map((c) => [c.id, c]));
    const newSignals: { signature: string; signal: string }[] = [];
    // Lighthouse signals compare only when both scans ran it.
    const bothLighthouse = previous.components.lighthousePages > 0 && current.components.lighthousePages > 0;
    for (const [id, c] of is) {
      const old = was.get(id);
      if (!old || c.kind !== 'component') continue;
      // A signal's wording carries counts; compare what it is about.
      const kinds = (list: string[]) => new Set(list.map((s) => s.replace(/\d+(\.\d+)?/g, '#')));
      const oldKinds = kinds(old.signals);
      for (const s of c.signals) {
        if (!bothLighthouse && s.startsWith('Lighthouse')) continue;
        if (!oldKinds.has(s.replace(/\d+(\.\d+)?/g, '#'))) newSignals.push({ signature: c.signature, signal: s });
      }
    }
    components = {
      appeared: [...is.values()].filter((c) => !was.has(c.id) && c.kind === 'component').map((c) => c.signature).slice(0, 10),
      gone: [...was.values()].filter((c) => !is.has(c.id) && c.kind === 'component').map((c) => c.signature).slice(0, 10),
      newSignals: newSignals.slice(0, 10),
    };
  }

  const ea = energyOf(previous);
  const eb = energyOf(current);
  const ra = resolution(ea);
  const rb = resolution(eb);
  const comparable = ea.length > 0 && eb.length > 0 && ra.resolved && rb.resolved && previous.environment.os === current.environment.os;
  const energy: HistoryReport['energy'] = comparable
    ? { comparable, medianMwh: [ra.median, rb.median], note: 'Indicative: single visits per page, and the machine and conditions may differ between scans.' }
    : {
        comparable: false,
        note:
          ea.length === 0 || eb.length === 0
            ? 'Not comparable: energy was not measured in one or both scans.'
            : !ra.resolved || !rb.resolved
              ? 'Not comparable: energy was below the resolution of the setup in one or both scans.'
              : 'Not comparable: the scans ran on different operating systems.',
      };

  return {
    previous: { file: previousFile, timestamp: previous.session.startedAt },
    pagesInBoth: both.length,
    pagesOnlyNow: [...now.keys()].filter((k) => !before.has(k)).length,
    pagesOnlyBefore: [...before.keys()].filter((k) => !now.has(k)).length,
    medians,
    largestChanges,
    ...(current.families && previous.families ? { families: [previous.families.families.length, current.families.families.length] as [number, number] } : {}),
    ...(components ? { components } : {}),
    energy,
    limitations: [
      ...(current.sampling?.order && previous.sampling && previous.sampling.method !== 'links' && previous.sampling.order !== current.sampling.order
        ? ['The previous scan drew its sample in an older order, which reshuffled whenever the sitemap changed. This scan orders pages by URL hash, so few pages are in both this time; later scans will keep most of theirs.']
        : []),
      'Each page was visited once in each scan, so these differences are indicative. No significance is claimed.',
      'Transfer and elements change with content as well as code: a new article or banner moves them as much as a template change.',
    ],
  };
}

/**
 * The most recent earlier result of the same mode and site in a directory.
 * Uses the directory's index.json when there is one, so only the matching
 * file is read; otherwise reads the newest result files, at most 30, by the
 * timestamp in their names, and stops at the first match.
 */
export async function findPrevious(dir: string, current: BenchmarkResult): Promise<{ file: string; result: BenchmarkResult } | undefined> {
  const site = siteOf(current.target?.url ?? '');
  if (!site) return undefined;
  const read = async (name: string) => {
    try {
      return JSON.parse(await readFile(join(dir, name), 'utf8')) as BenchmarkResult;
    } catch {
      return undefined;
    }
  };
  const matches = (r: BenchmarkResult | undefined): r is BenchmarkResult =>
    !!r &&
    r.session?.id !== current.session.id &&
    r.session?.mode === current.session.mode &&
    (r.session?.startedAt ?? '') < current.session.startedAt &&
    siteOf(r.target?.url ?? '') === site;

  try {
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as {
      entries?: { file: string; mode: string; timestamp: string; target?: string }[];
    };
    const entry = (index.entries ?? [])
      .filter((e) => e.mode === current.session.mode && siteOf(e.target ?? '') === site && e.timestamp < current.session.startedAt)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    if (entry) {
      const r = await read(entry.file);
      if (matches(r)) return { file: entry.file, result: r };
    }
  } catch {
    /* no index: read the files */
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const prefix = `${current.session.mode}-`;
  for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort().reverse().slice(0, 30)) {
    const r = await read(name);
    if (matches(r)) return { file: name, result: r };
  }
  return undefined;
}
