/**
 * Element and script findings from a Lighthouse report, kept so they can be
 * matched to the components of a page.
 *
 * Lighthouse derives these from a Chromium trace: layout shifts, animations
 * the compositor cannot run, unsized and oversized images, the LCP element,
 * the largest and deepest DOM nodes, long tasks, script CPU time, forced
 * reflows and third parties. That is the trace attribution this tool uses,
 * rather than a second trace pipeline of its own.
 *
 * Boundary: Chromium, under Lighthouse's throttling, on whatever machine ran
 * it. Milliseconds here are Chromium main-thread time, never Firefox energy,
 * and are never converted into joules.
 */

import type { Lhr, LhrAudit } from './summary.js';

/**
 * finding: something Lighthouse reports as a problem (a non-composited
 * animation, a layout shift, a failing audit). context: what it reports
 * either way (the LCP element, the deepest node of a page that passes).
 */
export type EvidenceKind = 'finding' | 'context';

export interface LighthouseNodeEvidence {
  audit: string;
  title: string;
  kind: EvidenceKind;
  /** DevTools node path, as recorded by Lighthouse in Chromium's DOM. */
  path: string;
  selector?: string;
  snippet?: string;
  label?: string;
  /** What Lighthouse says about this element. */
  detail?: string;
  value?: number;
  unit?: 'ms' | 'bytes' | 'score' | 'count';
}

export interface LighthouseScriptEvidence {
  audit: string;
  title: string;
  kind: EvidenceKind;
  /** Script URL, or "Unattributable" when Chromium could not name one. */
  url: string;
  value: number;
  unit: 'ms' | 'bytes';
  detail?: string;
  /** A forced reflow's source location. */
  source?: { url: string; line?: number; column?: number; functionName?: string };
  /** A third party's name, from Lighthouse's entity list. */
  entity?: string;
}

export interface LighthouseEvidence {
  nodes: LighthouseNodeEvidence[];
  scripts: LighthouseScriptEvidence[];
}

/** Audits whose items name elements. */
const NODE_AUDITS = [
  'cls-culprits-insight',
  'layout-shifts',
  'non-composited-animations',
  'lcp-breakdown-insight',
  'lcp-discovery-insight',
  'dom-size-insight',
  'image-delivery-insight',
  'unsized-images',
] as const;

const MAX_NODES = 40;
const MAX_SCRIPTS = 20;
/** Scripts below this much CPU time are left out. */
const MIN_SCRIPT_MS = 50;

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Lighthouse's pass mark; informative and not-applicable audits have no score. */
const failing = (a: LhrAudit | undefined) => typeof a?.score === 'number' && a.score < 0.9;

/**
 * Every row of these audits is a problem in itself, whatever the audit's
 * score (non-composited-animations is informative, yet each row is one).
 * The LCP element is context; DOM-size rows are findings only when the
 * audit fails.
 */
function nodeKind(audit: string, a: LhrAudit): EvidenceKind {
  if (audit.startsWith('lcp-')) return 'context';
  if (audit === 'dom-size-insight') return failing(a) ? 'finding' : 'context';
  return 'finding';
}
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
/** Lighthouse wraps some values as {type:'numeric', value}. */
const numeric = (v: unknown): number | undefined => finite(v) ?? (isObj(v) ? finite(v['value']) : undefined);

function describe(audit: string, item: Obj | undefined): Pick<LighthouseNodeEvidence, 'detail' | 'value' | 'unit'> {
  if (!item) return audit.startsWith('lcp-') ? { detail: 'largest contentful paint element' } : {};
  switch (audit) {
    case 'dom-size-insight': {
      const value = numeric(item['value']);
      return { detail: str(item['statistic']) ?? 'DOM size', ...(value !== undefined ? { value, unit: 'count' as const } : {}) };
    }
    case 'layout-shifts':
    case 'cls-culprits-insight': {
      const value = numeric(item['score']);
      return { detail: 'layout shift', ...(value !== undefined ? { value, unit: 'score' as const } : {}) };
    }
    case 'non-composited-animations': {
      const sub = isObj(item['subItems']) && Array.isArray(item['subItems']['items']) ? (item['subItems']['items'] as unknown[]) : [];
      const reasons = [...new Set(sub.filter(isObj).map((s) => str(s['failureReason'])).filter(Boolean))];
      return { detail: `animation not composited${reasons.length ? `: ${reasons.slice(0, 2).join('; ')}` : ''}` };
    }
    case 'image-delivery-insight': {
      const value = numeric(item['wastedBytes']);
      return { detail: 'image could be delivered smaller', ...(value !== undefined ? { value, unit: 'bytes' as const } : {}) };
    }
    case 'unsized-images':
      return { detail: 'image without width and height' };
    default:
      return audit.startsWith('lcp-') ? { detail: 'largest contentful paint element' } : {};
  }
}

function nodeOf(audit: string, a: LhrAudit, node: Obj, item: Obj | undefined): LighthouseNodeEvidence | undefined {
  const path = str(node['path']);
  if (!path) return undefined;
  const selector = str(node['selector']);
  const snippet = str(node['snippet']);
  const label = str(node['nodeLabel']);
  return {
    audit,
    title: a.title,
    kind: nodeKind(audit, a),
    path,
    ...(selector ? { selector } : {}),
    ...(snippet ? { snippet: snippet.slice(0, 160) } : {}),
    ...(label ? { label: label.slice(0, 80) } : {}),
    ...describe(audit, item),
  };
}

/** Every element an audit names, with the table row it came from. */
function nodesIn(audit: string, a: LhrAudit): LighthouseNodeEvidence[] {
  const out: LighthouseNodeEvidence[] = [];
  const visit = (x: unknown, row: Obj | undefined) => {
    if (Array.isArray(x)) {
      for (const y of x) visit(y, row);
      return;
    }
    if (!isObj(x)) return;
    if (x['type'] === 'node') {
      const e = nodeOf(audit, a, x, row);
      if (e) out.push(e);
      return;
    }
    if (isObj(x['node']) && x['node']['type'] === 'node') {
      const e = nodeOf(audit, a, x['node'], x);
      if (e) out.push(e);
      return;
    }
    for (const [k, v] of Object.entries(x)) {
      if (k === 'debugData' || k === 'headings' || k === 'subItems') continue;
      if (typeof v === 'object' && v !== null) visit(v, row);
    }
  };
  visit(a.details, undefined);
  return out;
}

function rowsOf(a: LhrAudit | undefined): Obj[] {
  const items = a?.details?.items;
  return Array.isArray(items) ? items.filter(isObj) : [];
}

/** Script work: CPU time per script, long tasks, forced reflows, third parties. */
function scriptsIn(lhr: Lhr): LighthouseScriptEvidence[] {
  const out: LighthouseScriptEvidence[] = [];
  const bootup = lhr.audits['bootup-time'];
  for (const r of rowsOf(bootup)) {
    const url = str(r['url']);
    const total = finite(r['total']);
    if (!url || total === undefined || total < MIN_SCRIPT_MS) continue;
    const scripting = finite(r['scripting']);
    out.push({
      audit: 'bootup-time',
      title: bootup!.title,
      kind: failing(bootup) ? 'finding' : 'context',
      url,
      value: Math.round(total),
      unit: 'ms',
      detail: `CPU time${scripting !== undefined ? `, ${Math.round(scripting)} ms of it evaluating script` : ''}`,
    });
  }

  // Long tasks, summed per URL.
  const tasks = new Map<string, { n: number; ms: number }>();
  for (const r of rowsOf(lhr.audits['long-tasks'])) {
    const url = str(r['url']);
    const ms = finite(r['duration']);
    if (!url || ms === undefined) continue;
    const t = tasks.get(url) ?? { n: 0, ms: 0 };
    t.n++;
    t.ms += ms;
    tasks.set(url, t);
  }
  for (const [url, t] of tasks) {
    out.push({
      audit: 'long-tasks',
      title: lhr.audits['long-tasks']!.title,
      // A long task is over 50 ms by definition: a problem whatever the audit's mode.
      kind: 'finding',
      url,
      value: Math.round(t.ms),
      unit: 'ms',
      detail: `${t.n} long task${t.n === 1 ? '' : 's'}`,
    });
  }

  // Forced reflows: a list holding one table of source locations.
  const reflow = lhr.audits['forced-reflow-insight'];
  const tables = Array.isArray(reflow?.details?.items) ? (reflow!.details!.items as unknown[]).filter(isObj) : [];
  for (const t of tables) {
    for (const r of Array.isArray(t['items']) ? (t['items'] as unknown[]).filter(isObj) : []) {
      const src = isObj(r['source']) ? r['source'] : undefined;
      const url = str(src?.['url']);
      const ms = finite(r['reflowTime']);
      if (!url || ms === undefined) continue;
      const line = finite(src?.['line']);
      const column = finite(src?.['column']);
      const functionName = str(src?.['functionName']);
      out.push({
        audit: 'forced-reflow-insight',
        title: reflow!.title,
        kind: 'finding',
        url,
        value: Math.round(ms),
        unit: 'ms',
        detail: 'forced reflow',
        source: { url, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}), ...(functionName ? { functionName } : {}) },
      });
    }
  }

  // Third parties: their main-thread time, under the first script URL listed.
  const third = lhr.audits['third-parties-insight'];
  for (const r of rowsOf(third)) {
    const entity = isObj(r['entity']) ? str(r['entity']['text']) : str(r['entity']);
    const ms = finite(r['mainThreadTime']);
    if (!entity || ms === undefined || ms < MIN_SCRIPT_MS) continue;
    const sub = isObj(r['subItems']) && Array.isArray(r['subItems']['items']) ? (r['subItems']['items'] as unknown[]).filter(isObj) : [];
    const url = sub.map((s) => str(s['url'])).find(Boolean) ?? entity;
    out.push({ audit: 'third-parties-insight', title: third!.title, kind: failing(third) ? 'finding' : 'context', url, value: Math.round(ms), unit: 'ms', detail: 'third-party main-thread time', entity });
  }

  return out.sort((a, b) => b.value - a.value).slice(0, MAX_SCRIPTS);
}

/** The element and script findings of one Lighthouse report. */
export function extractEvidence(lhr: Lhr): LighthouseEvidence {
  const nodes: LighthouseNodeEvidence[] = [];
  for (const id of NODE_AUDITS) {
    const a = lhr.audits[id];
    if (a?.details) nodes.push(...nodesIn(id, a));
  }
  // The same element can come from two audits; keep each (audit, path) once.
  const seen = new Set<string>();
  const unique = nodes.filter((n) => {
    const k = `${n.audit}\n${n.path}\n${n.detail ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { nodes: unique.slice(0, MAX_NODES), scripts: scriptsIn(lhr) };
}
