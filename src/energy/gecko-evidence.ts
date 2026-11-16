/**
 * What the same Firefox run's profile shows during an interval: markers
 * (garbage collection, style, layout, paint, refresh ticks, timers, DOM
 * events, network), the scripts on the stack when samples were taken, and
 * CPU time by category.
 *
 * This is the profile the energy came from, on the same clocks, so it can be
 * read against a power interval in time. It is still correlation: work that
 * happened while power was high, not the cause of the power, and never
 * joules for a script. What the profile does not hold is reported as
 * unavailable, not as none: markers need no extra feature, scripts need the
 * profiler's "js" feature (a diagnostic run), CPU time needs "cpu".
 *
 * Read from the raw Gecko profile format that MOZ_PROFILER_SHUTDOWN writes:
 * per-thread `markers` ({schema, data}), `samples`, `stackTable`,
 * `frameTable` and `stringTable`, times in ms from each process's
 * meta.startTime. A field the profile lacks is skipped, not guessed.
 */

import { attributeCpuTime } from './attribution.js';

export type ActivityKind =
  | 'garbage-collection'
  | 'style'
  | 'layout'
  | 'paint'
  | 'composite'
  | 'refresh-tick'
  | 'animation'
  | 'timer'
  | 'dom-event'
  | 'network'
  | 'image'
  | 'script'
  | 'other';

export interface GeckoEvidence {
  source: 'same-run-gecko';
  available: { markers: boolean; stacks: boolean; cpuTime: boolean };
  /** Markers that overlap the interval, by kind of activity. */
  activity: { kind: ActivityKind; count: number; ms: number; names: string[] }[];
  /** Scripts on the stack in samples taken during the interval, by URL and function. */
  scripts: { url: string; functionName?: string; line?: number; samples: number }[];
  /** Network markers during the interval. */
  requests: { url: string; count: number }[];
  domEvents: { type: string; count: number }[];
  /** CPU time by category in the interval, with the share over the whole timeline for comparison. */
  categories: { category: string; cpuMs: number; share: number; sessionShare?: number }[];
  categoryBasis?: 'cpu-time' | 'sample-count';
  notes: string[];
}

interface Table {
  schema: Record<string, number>;
  data: unknown[][];
}
interface Thread {
  name?: string;
  processType?: string;
  markers?: Table;
  samples?: Table;
  stackTable?: Table;
  frameTable?: Table;
  stringTable?: string[];
  stringArray?: string[];
}
interface Node {
  meta?: { startTime: number; categories?: { name: string }[] };
  threads?: Thread[];
  processes?: Node[];
  shared?: { stringArray?: string[] };
}

const KINDS: [ActivityKind, RegExp][] = [
  ['garbage-collection', /^(GC|CC|GCMajor|GCMinor|GCSlice|CCSlice|MinorGC|MajorGC|ForgetSkippable|IdleForgetSkippable|IdleCCSlice|GCInterrupt|CCInterrupt)\b/i],
  ['style', /^(Styles|StyleRecalc|Style computation|RecalcStyle|Stylo)/i],
  ['layout', /^(Reflow|Layout|DOMIntersectionObserver)/i],
  ['composite', /(Composite|Compositor|RenderBackend|Renderer|WR |WebRender|Rasterize)/i],
  ['paint', /^(Paint|DisplayList|FullPaint|PaintTimes|Build ?DisplayList|ContentFullPaint|ContentPaint)/i],
  ['refresh-tick', /RefreshDriverTick|Refresh ?Driver|requestAnimationFrame|Vsync/i],
  ['animation', /CSS ?Animation|CSS ?Transition|^Animation/i],
  ['timer', /setTimeout|setInterval|Timer|TimeoutManager/i],
  ['dom-event', /^DOMEvent|^DOM ?Event/i],
  ['network', /^Load \d+|^Network|HTTP/i],
  ['image', /Image|Decode/i],
  ['script', /^(JS|Script|EvaluateScript|Compile|JSActor|Jank)/i],
];

const TYPE_KINDS: Record<string, ActivityKind> = {
  GCMajor: 'garbage-collection', GCMinor: 'garbage-collection', GCSlice: 'garbage-collection', CC: 'garbage-collection',
  Styles: 'style', Network: 'network', DOMEvent: 'dom-event', CSSAnimation: 'animation', CSSTransition: 'animation',
  Paint: 'paint', CompositorScreenshot: 'composite',
};

export function activityKind(name: string, type?: string, category?: string): ActivityKind {
  if (type && TYPE_KINDS[type]) return TYPE_KINDS[type]!;
  for (const [k, re] of KINDS) if (re.test(name)) return k;
  if (category === 'GC / CC') return 'garbage-collection';
  if (category === 'Layout') return 'layout';
  if (category === 'Graphics') return 'paint';
  if (category === 'JavaScript') return 'script';
  if (category === 'Network') return 'network';
  return 'other';
}

/** A JS frame's location: "fn (https://host/a.js:12:3)", or a bare URL with line and column. */
export function parseJsLocation(location: string): { url: string; functionName?: string; line?: number } | undefined {
  const m = /^(?:(.*?) )?\(?((?:https?|file|moz-extension):\/\/[^\s)]+?)(?::(\d+))?(?::(\d+))?\)?$/.exec(location.trim());
  if (!m) return undefined;
  const fn = m[1]?.trim();
  return { url: m[2]!, ...(fn ? { functionName: fn } : {}), ...(m[3] ? { line: Number(m[3]) } : {}) };
}

function strings(thread: Thread, root: Node): string[] {
  return thread.stringTable ?? thread.stringArray ?? root.shared?.stringArray ?? [];
}

function visit(root: Node, fn: (thread: Thread, origin: number, categories: string[]) => void): void {
  const categories = (root.meta?.categories ?? []).map((c) => c.name);
  const walk = (node: Node | undefined) => {
    if (!node?.meta) return;
    for (const t of node.threads ?? []) fn(t, node.meta.startTime, categories);
    for (const p of node.processes ?? []) walk(p);
  };
  walk(root);
}

const top = <T>(m: Map<string, T>, key: (x: T) => number, n: number) => [...m.values()].sort((a, b) => key(b) - key(a)).slice(0, n);

/**
 * Same-run evidence for the window (startEpochMs, endEpochMs]. With a session
 * window, category shares are also given over the whole session, so a
 * category the interval over-represents stands out.
 */
export function geckoEvidence(profile: unknown, startEpochMs: number, endEpochMs: number, session?: { startEpochMs: number; endEpochMs: number }): GeckoEvidence {
  const root = (profile ?? {}) as Node;
  const activity = new Map<ActivityKind, { kind: ActivityKind; count: number; ms: number; names: Set<string> }>();
  const scripts = new Map<string, { url: string; functionName?: string; line?: number; samples: number }>();
  const requests = new Map<string, { url: string; count: number }>();
  const events = new Map<string, { type: string; count: number }>();
  let sawMarkers = false;
  let sawJsFrames = false;

  visit(root, (thread, origin, categories) => {
    const str = strings(thread, root);
    const rs = startEpochMs - origin;
    const re = endEpochMs - origin;
    const mk = thread.markers;
    if (mk?.data?.length) {
      sawMarkers = true;
      const s = mk.schema;
      const iName = s['name'];
      const iStart = s['startTime'] ?? s['time'];
      const iEnd = s['endTime'];
      const iCat = s['category'];
      const iData = s['data'];
      for (const row of mk.data) {
        const start = iStart !== undefined ? (row[iStart] as number | null) : null;
        const end = iEnd !== undefined ? (row[iEnd] as number | null) : null;
        const a = start ?? end;
        const z = end ?? start;
        if (typeof a !== 'number' || typeof z !== 'number' || z < rs || a > re) continue;
        const nameRaw = iName !== undefined ? row[iName] : undefined;
        const name = typeof nameRaw === 'number' ? (str[nameRaw] ?? '') : String(nameRaw ?? '');
        const data = (iData !== undefined ? row[iData] : undefined) as Record<string, unknown> | null | undefined;
        const type = typeof data?.['type'] === 'string' ? (data['type'] as string) : undefined;
        const cat = iCat !== undefined && typeof row[iCat] === 'number' ? categories[row[iCat] as number] : undefined;
        const kind = activityKind(name, type, cat);
        const x = activity.get(kind) ?? { kind, count: 0, ms: 0, names: new Set<string>() };
        x.count++;
        x.ms += Math.max(0, Math.min(z, re) - Math.max(a, rs));
        if (x.names.size < 6 && name) x.names.add(name);
        activity.set(kind, x);
        if (kind === 'network') {
          const uri = typeof data?.['URI'] === 'string' ? (data['URI'] as string) : /^Load \d+: (.*)$/.exec(name)?.[1];
          if (uri) {
            const r = requests.get(uri) ?? { url: uri, count: 0 };
            r.count++;
            requests.set(uri, r);
          }
        }
        if (kind === 'dom-event') {
          const et = typeof data?.['eventType'] === 'string' ? (data['eventType'] as string) : name.replace(/^DOMEvent\s*/i, '') || 'event';
          const e = events.get(et) ?? { type: et, count: 0 };
          e.count++;
          events.set(et, e);
        }
      }
    }

    // Scripts on the stack: walk from the leaf to the first frame that names a URL.
    const smp = thread.samples;
    const st = thread.stackTable;
    const ft = thread.frameTable;
    if (!smp?.data?.length || !st || !ft) return;
    const iTime = smp.schema['time'];
    const iStack = smp.schema['stack'];
    const iPrefix = st.schema['prefix'];
    const iFrame = st.schema['frame'];
    const iLoc = ft.schema['location'];
    const iLine = ft.schema['line'];
    if (iTime === undefined || iStack === undefined || iFrame === undefined || iLoc === undefined) return;
    const cache = new Map<number, ReturnType<typeof parseJsLocation> | null>();
    const jsAt = (stack: number) => {
      if (cache.has(stack)) return cache.get(stack);
      let k: number | null = stack;
      let found: ReturnType<typeof parseJsLocation> | null = null;
      for (let depth = 0; k !== null && k !== undefined && depth < 256; depth++) {
        const row: unknown[] | undefined = st.data[k];
        if (!row) break;
        const frame = ft.data[row[iFrame] as number];
        const loc = frame ? frame[iLoc] : undefined;
        const text = typeof loc === 'number' ? str[loc] : typeof loc === 'string' ? loc : undefined;
        const parsed = text ? parseJsLocation(text) : undefined;
        if (parsed) {
          const line = iLine !== undefined && typeof frame?.[iLine] === 'number' ? (frame[iLine] as number) : parsed.line;
          found = { ...parsed, ...(line !== undefined ? { line } : {}) };
          break;
        }
        k = iPrefix !== undefined ? (row[iPrefix] as number | null) : null;
      }
      cache.set(stack, found);
      return found;
    };
    for (const row of smp.data) {
      const t = row[iTime];
      const stack = row[iStack];
      if (typeof t !== 'number' || t <= rs || t > re || typeof stack !== 'number') continue;
      const js = jsAt(stack);
      if (!js) continue;
      sawJsFrames = true;
      const key = `${js.url}|${js.functionName ?? ''}|${js.line ?? ''}`;
      const x = scripts.get(key) ?? { ...js, samples: 0 };
      x.samples++;
      scripts.set(key, x);
    }
  });

  const cpu = attributeCpuTime(profile, startEpochMs, endEpochMs);
  const whole = session ? attributeCpuTime(profile, session.startEpochMs, session.endEpochMs) : undefined;
  const categories = [...cpu.byCategory]
    .map(([category, ms]) => {
      const share = cpu.totalCpuMs > 0 ? ms / cpu.totalCpuMs : 0;
      const ws = whole && whole.totalCpuMs > 0 ? (whole.byCategory.get(category) ?? 0) / whole.totalCpuMs : undefined;
      return { category, cpuMs: Math.round(ms * 10) / 10, share: Math.round(share * 1000) / 1000, ...(ws !== undefined ? { sessionShare: Math.round(ws * 1000) / 1000 } : {}) };
    })
    .sort((a, b) => b.cpuMs - a.cpuMs);

  const notes: string[] = [];
  if (!sawMarkers) notes.push('The profile holds no markers for this interval, so browser activity (style, layout, paint, GC) is unavailable here, not absent.');
  if (!sawJsFrames) notes.push('No sample in this interval named a script. Script origins need a profile taken with the "js" feature (diagnose takes one); without it they are unavailable, not absent.');
  if (cpu.sampleCount === 0) notes.push('No stack samples in this interval: CPU time by category is unavailable.');
  else if (cpu.basis === 'sample-count') notes.push('CPU time was not recorded (the "cpu" feature), so category shares count samples instead.');

  return {
    source: 'same-run-gecko',
    available: { markers: sawMarkers, stacks: sawJsFrames, cpuTime: cpu.sampleCount > 0 && cpu.basis === 'cpu-time' },
    activity: top(activity, (x) => x.ms + x.count, 12).map((x) => ({ kind: x.kind, count: x.count, ms: Math.round(x.ms * 10) / 10, names: [...x.names] })),
    scripts: top(scripts, (x) => x.samples, 10),
    requests: top(requests, (x) => x.count, 20),
    domEvents: top(events, (x) => x.count, 10),
    categories,
    ...(cpu.sampleCount > 0 ? { categoryBasis: cpu.basis } : {}),
    notes,
  };
}
