/**
 * Reading a Chromium performance trace: what the renderer's main thread did,
 * in two windows (the page load, then an idle period), and what it can be
 * tied to: script URLs and functions, DOM nodes (by backend node id, resolved
 * to node paths by the caller), requests and event dispatches.
 *
 * Pure: it takes the trace events and a node-path lookup, so it is tested
 * with synthetic events. Event names and fields are those Chromium emits in
 * the devtools.timeline categories (checked against the installed build).
 *
 * This is diagnosis in Chromium, under tracing overhead: milliseconds here
 * are Chromium main-thread time, never Firefox energy. Work that names no
 * script or node is reported as unattributed, not shared out.
 */

export interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  cat?: string;
  id?: string | number;
  args?: Record<string, unknown>;
}

export interface ScriptWork {
  url: string;
  ms: number;
  calls: number;
  /** Most expensive function, when the trace names one. */
  topFunction?: { name: string; line?: number; ms: number };
}

export interface PhaseSummary {
  durationMs: number;
  /** Main-thread time by kind of work, ms. */
  mainThread: { scriptMs: number; styleMs: number; layoutMs: number; paintMs: number; otherMs: number; busyMs: number };
  /** Script time with no URL (inline, eval, or automation tooling), ms. Not attributed. */
  unattributedScriptMs: number;
  scripts: ScriptWork[];
  longTasks: { startMs: number; durationMs: number; urls: string[] }[];
  /** Layout forced from inside script: read after write. */
  forcedLayouts: { ms: number; url?: string; functionName?: string; line?: number }[];
  style: { count: number; elements: number; ms: number };
  layout: { count: number; ms: number; maxDirtyObjects: number; roots: { path?: string; nodeName?: string; count: number }[] };
  paint: { count: number; ms: number; nodes: { path?: string; nodeName?: string; count: number }[] };
  animationFrames: { fired: number; ms: number; perSecond: number; sources: { url: string; line?: number; count: number }[] };
  timers: { fired: number; perSecond: number; sources: { url: string; line?: number; timeoutMs?: number; singleShot?: boolean; count: number }[] };
  /** CSS and Web Animations that ran in the window, by node. */
  animations: { name: string; path?: string; nodeName?: string }[];
  requests: { url: string; resourceType?: string }[];
  /** Event dispatches with their handlers' script time. */
  events: { type: string; count: number; ms: number; handlerUrls: string[] }[];
}

export interface TraceAnalysis {
  load: PhaseSummary;
  idle?: PhaseSummary;
  /** Interaction chains: an event's origin, the script that ran, and what it caused. */
  interactions: Interaction[];
  /** Main-thread time in other renderers (iframes in other processes), ms. */
  otherRenderersMs: number;
  /** Frames rendered in other processes (cross-site iframes), with their own work. */
  frames: SubframeWork[];
}

/** A cross-site iframe in its own renderer: what it did during load and while the page sat idle. */
export interface SubframeWork {
  /** The frame's document URL, as it committed. */
  url: string;
  loadBusyMs: number;
  idle?: { busyMs: number; scripts: ScriptWork[]; timers: PhaseSummary['timers']; animationFrames: PhaseSummary['animationFrames']; requests: PhaseSummary['requests'] };
}

export interface Interaction {
  type: string;
  startMs: number;
  /** The handler: the script that ran inside the dispatch. */
  execution: { url: string; functionName?: string; line?: number; ms: number }[];
  /** What it made the browser do afterwards, until the next idle gap. */
  affected: { styleElements: number; layoutDirtyObjects: number; layoutRoots: string[]; paintNodes: string[]; ms: number };
}

type PathOf = (backendNodeId: number) => string | undefined;

const ms = (us: number | undefined) => (us ?? 0) / 1000;
const data = (e: TraceEvent) => (e.args?.['data'] ?? {}) as Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

const SCRIPT = new Set(['EvaluateScript', 'FunctionCall', 'v8.compile', 'v8.compileModule', 'v8.evaluateModule', 'TimerFire', 'FireAnimationFrame', 'FireIdleCallback', 'EventDispatch', 'V8.Execute']);
const STYLE = new Set(['UpdateLayoutTree', 'RecalculateStyles']);
const LAYOUT = new Set(['Layout']);
const PAINT = new Set(['Paint', 'PrePaint', 'Layerize', 'PaintImage', 'Commit', 'Decode Image', 'ImageDecodeTask']);

/** The renderer main thread of the page: the CrRendererMain with the most work. */
export function mainThreadOf(events: TraceEvent[]): { pid: number; tid: number } | undefined {
  const mains = events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && (e.args?.['name'] as string) === 'CrRendererMain');
  let best: { pid: number; tid: number; busy: number } | undefined;
  for (const m of mains) {
    const busy = events.filter((e) => e.pid === m.pid && e.tid === m.tid && e.ph === 'X' && e.name === 'RunTask').reduce((t, e) => t + (e.dur ?? 0), 0);
    if (!best || busy > best.busy) best = { pid: m.pid, tid: m.tid, busy };
  }
  return best ? { pid: best.pid, tid: best.tid } : undefined;
}

function topBy<T>(list: T[], key: (x: T) => number, n: number): T[] {
  return [...list].sort((a, b) => key(b) - key(a)).slice(0, n);
}

/** Summarise one window [from, to) in trace microseconds. */
export function summarisePhase(events: TraceEvent[], from: number, to: number, pathOf: PathOf): PhaseSummary {
  const inWindow = events.filter((e) => e.ts >= from && e.ts < to);
  const complete = inWindow.filter((e) => e.ph === 'X');
  // Time by kind: only top-level tasks count towards busy, to avoid double counting nesting.
  const tasks = complete.filter((e) => e.name === 'RunTask');
  const busyMs = tasks.reduce((t, e) => t + ms(e.dur), 0);
  const sumOf = (set: Set<string>) => complete.filter((e) => set.has(e.name)).reduce((t, e) => t + ms(e.dur), 0);
  // Script time: outermost script events only (a FunctionCall inside EvaluateScript counts once).
  const scripts = complete.filter((e) => SCRIPT.has(e.name));
  const outermost = scripts.filter((e) => !scripts.some((p) => p !== e && p.ts <= e.ts && p.ts + (p.dur ?? 0) >= e.ts + (e.dur ?? 0) && (p.dur ?? 0) > (e.dur ?? 0)));
  const scriptMs = outermost.reduce((t, e) => t + ms(e.dur), 0);
  const styleMs = sumOf(STYLE);
  const layoutMs = sumOf(LAYOUT);
  const paintMs = sumOf(PAINT);

  // Script work by URL, from the events that name one.
  const byUrl = new Map<string, { ms: number; calls: number; fns: Map<string, { ms: number; line?: number }> }>();
  let unattributedScriptMs = 0;
  for (const e of outermost) {
    let d = data(e);
    let url = str(d['url']) ?? str((d['stackTrace'] as { url?: string }[] | undefined)?.[0]?.url);
    // A callback event (an animation frame, a timer) names no URL itself;
    // the longest script call inside it does.
    if (!url) {
      const inner = scripts
        .filter((s) => s !== e && s.ts >= e.ts && s.ts + (s.dur ?? 0) <= e.ts + (e.dur ?? 0) && str(data(s)['url']))
        .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))[0];
      if (inner) {
        d = data(inner);
        url = str(d['url']);
      }
    }
    if (!url) {
      unattributedScriptMs += ms(e.dur);
      continue;
    }
    const w = byUrl.get(url) ?? { ms: 0, calls: 0, fns: new Map() };
    w.ms += ms(e.dur);
    w.calls++;
    const fn = str(d['functionName']);
    if (fn) {
      const f = w.fns.get(fn) ?? { ms: 0, line: num(d['lineNumber']) };
      f.ms += ms(e.dur);
      w.fns.set(fn, f);
    }
    byUrl.set(url, w);
  }
  const scriptWork: ScriptWork[] = topBy(
    [...byUrl].map(([url, w]) => {
      const top = topBy([...w.fns], ([, f]) => f.ms, 1)[0];
      return { url, ms: round(w.ms), calls: w.calls, ...(top ? { topFunction: { name: top[0], ...(top[1].line !== undefined ? { line: top[1].line } : {}), ms: round(top[1].ms) } } : {}) };
    }),
    (x) => x.ms,
    10,
  );

  // Long tasks: over 50 ms, with the script URLs inside them.
  const longTasks = topBy(
    tasks
      .filter((t) => ms(t.dur) > 50)
      .map((t) => ({
        startMs: round(ms(t.ts - from)),
        durationMs: round(ms(t.dur)),
        urls: [...new Set(scripts.filter((s) => s.ts >= t.ts && s.ts < t.ts + (t.dur ?? 0)).map((s) => str(data(s)['url'])).filter((u): u is string => !!u))],
      })),
    (x) => x.durationMs,
    10,
  );

  // Forced layout: a Layout inside a script event on the same thread.
  const forcedLayouts = complete
    .filter((e) => e.name === 'Layout')
    .flatMap((l) => {
      const parent = scripts.find((s) => s.ts <= l.ts && s.ts + (s.dur ?? 0) >= l.ts + (l.dur ?? 0));
      if (!parent) return [];
      const d = data(parent);
      const url = str(d['url']);
      const fn = str(d['functionName']);
      const line = num(d['lineNumber']);
      return [{ ms: round(ms(l.dur)), ...(url ? { url } : {}), ...(fn ? { functionName: fn } : {}), ...(line !== undefined ? { line } : {}) }];
    });

  const styleEvents = complete.filter((e) => STYLE.has(e.name));
  const elements = styleEvents.reduce((t, e) => t + (num(e.args?.['elementCount']) ?? 0), 0);

  const layoutEvents = complete.filter((e) => LAYOUT.has(e.name));
  const roots = new Map<string, { path?: string; nodeName?: string; count: number }>();
  let maxDirty = 0;
  for (const l of layoutEvents) {
    maxDirty = Math.max(maxDirty, num((l.args?.['beginData'] as Record<string, unknown> | undefined)?.['dirtyObjects']) ?? 0);
    for (const r of ((l.args?.['endData'] as { layoutRoots?: { nodeId?: number; nodeName?: string }[] } | undefined)?.layoutRoots ?? [])) {
      const path = r.nodeId !== undefined ? pathOf(r.nodeId) : undefined;
      const key = path ?? r.nodeName ?? '?';
      const x = roots.get(key) ?? { ...(path ? { path } : {}), ...(r.nodeName ? { nodeName: r.nodeName } : {}), count: 0 };
      x.count++;
      roots.set(key, x);
    }
  }

  const paintEvents = complete.filter((e) => e.name === 'Paint');
  const paintNodes = new Map<string, { path?: string; nodeName?: string; count: number }>();
  for (const p of paintEvents) {
    const d = data(p);
    const id = num(d['nodeId']);
    const path = id !== undefined ? pathOf(id) : undefined;
    const name = str(d['nodeName']);
    const key = path ?? name ?? '?';
    const x = paintNodes.get(key) ?? { ...(path ? { path } : {}), ...(name ? { nodeName: name } : {}), count: 0 };
    x.count++;
    paintNodes.set(key, x);
  }

  const seconds = Math.max(0.001, ms(to - from) / 1000);
  // Animation frames: fired callbacks, with where they were requested from.
  const fired = complete.filter((e) => e.name === 'FireAnimationFrame');
  const rafSources = new Map<string, { url: string; line?: number; count: number }>();
  for (const r of inWindow.filter((e) => e.name === 'RequestAnimationFrame')) {
    const f = (data(r)['stackTrace'] as { url?: string; lineNumber?: number }[] | undefined)?.[0];
    const url = str(f?.url);
    if (!url) continue;
    const k = `${url}:${f?.lineNumber ?? ''}`;
    const x = rafSources.get(k) ?? { url, ...(f?.lineNumber !== undefined ? { line: f.lineNumber } : {}), count: 0 };
    x.count++;
    rafSources.set(k, x);
  }

  // Timers: fired in the window, with where they were installed (anywhere in the trace).
  const installs = new Map<string, { url?: string; line?: number; timeoutMs?: number; singleShot?: boolean }>();
  for (const t of events.filter((e) => e.name === 'TimerInstall')) {
    const d = data(t);
    const f = (d['stackTrace'] as { url?: string; lineNumber?: number }[] | undefined)?.[0];
    installs.set(String(d['timerId']), { ...(str(f?.url) ? { url: f!.url } : {}), ...(f?.lineNumber !== undefined ? { line: f.lineNumber } : {}), ...(num(d['timeout']) !== undefined ? { timeoutMs: num(d['timeout']) } : {}), ...(typeof d['singleShot'] === 'boolean' ? { singleShot: d['singleShot'] as boolean } : {}) });
  }
  const timerFires = complete.filter((e) => e.name === 'TimerFire');
  const timerSources = new Map<string, { url: string; line?: number; timeoutMs?: number; singleShot?: boolean; count: number }>();
  for (const t of timerFires) {
    const inst = installs.get(String(data(t)['timerId']));
    const url = inst?.url ?? str(data(t)['url']) ?? '(unknown)';
    const k = `${url}:${inst?.line ?? ''}`;
    const x = timerSources.get(k) ?? { url, ...(inst?.line !== undefined ? { line: inst.line } : {}), ...(inst?.timeoutMs !== undefined ? { timeoutMs: inst.timeoutMs } : {}), ...(inst?.singleShot !== undefined ? { singleShot: inst.singleShot } : {}), count: 0 };
    x.count++;
    timerSources.set(k, x);
  }

  // Animations running in the window: begun before it ends, not ended before it starts.
  const animations = new Map<string, { name: string; path?: string; nodeName?: string }>();
  const ended = new Map<string, number>();
  for (const a of events.filter((e) => e.name === 'Animation' && e.ph === 'e')) ended.set(String(a.id), Math.min(ended.get(String(a.id)) ?? Infinity, a.ts));
  for (const a of events.filter((e) => e.name === 'Animation' && e.ph === 'b' && e.ts < to && (ended.get(String(e.id)) ?? Infinity) > from)) {
    const d = data(a);
    if (str(d['state']) && d['state'] !== 'running') continue;
    const id = num(d['nodeId']);
    const path = id !== undefined ? pathOf(id) : undefined;
    const name = str(d['displayName']) ?? str(d['name']) ?? 'animation';
    animations.set(`${name}|${path ?? d['nodeName']}`, { name, ...(path ? { path } : {}), ...(str(d['nodeName']) ? { nodeName: str(d['nodeName']) } : {}) });
  }

  const requests = inWindow
    .filter((e) => e.name === 'ResourceSendRequest')
    .map((e) => ({ url: str(data(e)['url']) ?? '', ...(str(data(e)['resourceType']) ? { resourceType: str(data(e)['resourceType']) } : {}) }))
    // The browser fetches the favicon itself; that is not the page's work.
    .filter((r) => r.url && !(r.resourceType === 'Other' && /^https?:\/\/[^/]+\/favicon\.ico$/.test(r.url)));

  const dispatches = complete.filter((e) => e.name === 'EventDispatch');
  const eventTypes = new Map<string, { count: number; ms: number; urls: Set<string> }>();
  for (const d of dispatches) {
    const type = str(data(d)['type']) ?? '?';
    const x = eventTypes.get(type) ?? { count: 0, ms: 0, urls: new Set<string>() };
    x.count++;
    x.ms += ms(d.dur);
    for (const s of scripts.filter((s) => s !== d && s.ts >= d.ts && s.ts < d.ts + (d.dur ?? 0))) {
      const u = str(data(s)['url']);
      if (u) x.urls.add(u);
    }
    eventTypes.set(type, x);
  }

  return {
    durationMs: round(ms(to - from)),
    mainThread: { scriptMs: round(scriptMs), styleMs: round(styleMs), layoutMs: round(layoutMs), paintMs: round(paintMs), otherMs: round(Math.max(0, busyMs - scriptMs - styleMs - layoutMs - paintMs)), busyMs: round(busyMs) },
    unattributedScriptMs: round(unattributedScriptMs),
    scripts: scriptWork,
    longTasks,
    forcedLayouts: topBy(forcedLayouts, (x) => x.ms, 10),
    style: { count: styleEvents.length, elements, ms: round(styleMs) },
    layout: { count: layoutEvents.length, ms: round(layoutMs), maxDirtyObjects: maxDirty, roots: topBy([...roots.values()], (x) => x.count, 8) },
    paint: { count: paintEvents.length, ms: round(paintEvents.reduce((t, e) => t + ms(e.dur), 0)), nodes: topBy([...paintNodes.values()], (x) => x.count, 8) },
    animationFrames: { fired: fired.length, ms: round(fired.reduce((t, e) => t + ms(e.dur), 0)), perSecond: round(fired.length / seconds), sources: topBy([...rafSources.values()], (x) => x.count, 5) },
    timers: { fired: timerFires.length, perSecond: round(timerFires.length / seconds), sources: topBy([...timerSources.values()], (x) => x.count, 5) },
    animations: [...animations.values()].slice(0, 20),
    requests: requests.slice(0, 30),
    events: topBy(
      [...eventTypes].filter(([t]) => !['pagehide', 'visibilitychange', 'unload', 'beforeunload', 'pageshow', 'readystatechange', 'DOMContentLoaded', 'load'].includes(t)).map(([type, x]) => ({ type, count: x.count, ms: round(x.ms), handlerUrls: [...x.urls] })),
      (x) => x.ms,
      10,
    ),
  };
}

/** Interaction chains: a user event, the script it ran, and the work it caused until the next 100 ms gap. */
export function interactionsIn(events: TraceEvent[], from: number, to: number, pathOf: PathOf): Interaction[] {
  const complete = events.filter((e) => e.ph === 'X' && e.ts >= from && e.ts < to);
  const userTypes = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'input', 'change', 'submit', 'touchstart', 'touchend']);
  const dispatches = complete.filter((e) => e.name === 'EventDispatch' && userTypes.has(str(data(e)['type']) ?? '')).sort((a, b) => a.ts - b.ts);
  // One gesture fires several events (pointerdown, mousedown, pointerup, click):
  // dispatches within 300 ms of one another are one interaction.
  const groups: TraceEvent[][] = [];
  for (const d of dispatches) {
    const last = groups.at(-1);
    if (last && d.ts - (last.at(-1)!.ts + (last.at(-1)!.dur ?? 0)) < 300_000) last.push(d);
    else groups.push([d]);
  }
  const out: Interaction[] = [];
  for (const group of groups) {
    const start = group[0]!.ts;
    const end = Math.max(...group.map((d) => d.ts + (d.dur ?? 0)));
    const execution = complete
      .filter((s) => (s.name === 'FunctionCall' || s.name === 'EvaluateScript') && group.some((d) => s.ts >= d.ts && s.ts < d.ts + (d.dur ?? 0)) && str(data(s)['url']))
      .map((s) => ({ url: str(data(s)['url'])!, ...(str(data(s)['functionName']) ? { functionName: str(data(s)['functionName']) } : {}), ...(num(data(s)['lineNumber']) !== undefined ? { line: num(data(s)['lineNumber']) } : {}), ms: round(ms(s.dur)) }));
    // What followed: work until a gap of 100 ms with nothing on the thread.
    let horizon = end;
    for (const e of complete.filter((x) => x.ts >= start).sort((x, y) => x.ts - y.ts)) {
      if (e.ts > horizon + 100_000) break;
      horizon = Math.max(horizon, e.ts + (e.dur ?? 0));
    }
    const window = complete.filter((e) => e.ts >= start && e.ts <= horizon);
    const styleElements = window.filter((e) => STYLE.has(e.name)).reduce((t, e) => t + (num(e.args?.['elementCount']) ?? 0), 0);
    const layouts = window.filter((e) => e.name === 'Layout');
    const roots = new Set<string>();
    for (const l of layouts) {
      for (const r of ((l.args?.['endData'] as { layoutRoots?: { nodeId?: number; nodeName?: string }[] } | undefined)?.layoutRoots ?? [])) {
        const p = r.nodeId !== undefined ? pathOf(r.nodeId) : undefined;
        if (p ?? r.nodeName) roots.add(p ?? r.nodeName!);
      }
    }
    const paints = new Set<string>();
    for (const p of window.filter((e) => e.name === 'Paint')) {
      const id = num(data(p)['nodeId']);
      const path = id !== undefined ? pathOf(id) : undefined;
      if (path ?? str(data(p)['nodeName'])) paints.add(path ?? str(data(p)['nodeName'])!);
    }
    const types = [...new Set(group.map((d) => str(data(d)['type'])!))];
    out.push({
      type: types.includes('click') ? 'click' : types.includes('input') ? 'input' : types.includes('keydown') ? 'keydown' : types[0]!,
      startMs: round(ms(start - from)),
      execution,
      affected: {
        styleElements,
        layoutDirtyObjects: Math.max(0, ...layouts.map((l) => num((l.args?.['beginData'] as Record<string, unknown> | undefined)?.['dirtyObjects']) ?? 0)),
        layoutRoots: [...roots].slice(0, 5),
        paintNodes: [...paints].slice(0, 5),
        ms: round(ms(horizon - start)),
      },
    });
  }
  return out.filter((i) => i.execution.length || i.affected.layoutDirtyObjects || i.affected.styleElements).slice(0, 10);
}

/**
 * Analyse a trace: the load window [navStart, loadEnd), then the idle window
 * [idleStart, idleEnd) when given. Times are trace microseconds.
 */
export function analyseTrace(
  events: TraceEvent[],
  windows: { navStart: number; loadEnd: number; idleStart?: number; idleEnd?: number },
  pathOf: PathOf = () => undefined,
): TraceAnalysis | undefined {
  const main = mainThreadOf(events);
  if (!main) return undefined;
  // The page's renderer only: an iframe in another process is summarised on its own (frames).
  const ON_ANY_THREAD = new Set(['TimerInstall', 'RequestAnimationFrame', 'ResourceSendRequest', 'Animation']);
  const mine = events.filter((e) => e.pid === main.pid && (e.tid === main.tid || ON_ANY_THREAD.has(e.name)));
  const other = events.filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.pid !== main.pid && events.some((m) => m.ph === 'M' && m.name === 'thread_name' && m.pid === e.pid && m.tid === e.tid && m.args?.['name'] === 'CrRendererMain'));
  const end = windows.idleEnd ?? windows.loadEnd;
  return {
    load: summarisePhase(mine, windows.navStart, windows.loadEnd, pathOf),
    ...(windows.idleStart !== undefined && windows.idleEnd !== undefined ? { idle: summarisePhase(mine, windows.idleStart, windows.idleEnd, pathOf) } : {}),
    interactions: interactionsIn(mine, windows.navStart, end, pathOf),
    otherRenderersMs: round(other.filter((e) => e.ts >= windows.navStart && e.ts < end).reduce((t, e) => t + ms(e.dur), 0)),
    frames: subframesIn(events, main.pid, windows),
  };
}

/**
 * Cross-site iframes rendered in their own process. The browser records which
 * process each frame committed in (FrameCommittedInBrowser), so that process's
 * main-thread work can be named by the frame's URL instead of lumped together.
 */
export function subframesIn(events: TraceEvent[], mainPid: number, windows: { navStart: number; loadEnd: number; idleStart?: number; idleEnd?: number }): SubframeWork[] {
  const byPid = new Map<number, string>();
  for (const e of events.filter((x) => x.name === 'FrameCommittedInBrowser')) {
    const d = data(e);
    const pid = num(d['processId']);
    const url = str(d['url']);
    if (pid === undefined || pid === mainPid || !url || d['isOutermostMainFrame'] === true || url.startsWith('about:')) continue;
    if (!byPid.has(pid)) byPid.set(pid, url);
  }
  const out: SubframeWork[] = [];
  for (const [pid, url] of byPid) {
    const thread = events.find((m) => m.ph === 'M' && m.name === 'thread_name' && m.pid === pid && m.args?.['name'] === 'CrRendererMain');
    if (!thread) continue;
    const own = events.filter((e) => e.pid === pid && (e.tid === thread.tid || e.name === 'TimerInstall' || e.name === 'RequestAnimationFrame' || e.name === 'ResourceSendRequest'));
    const busy = (from: number, to: number) => round(own.filter((e) => e.ph === 'X' && e.name === 'RunTask' && e.ts >= from && e.ts < to).reduce((t, e) => t + ms(e.dur), 0));
    const idle = windows.idleStart !== undefined && windows.idleEnd !== undefined ? summarisePhase(own, windows.idleStart, windows.idleEnd, () => undefined) : undefined;
    out.push({
      url,
      loadBusyMs: busy(windows.navStart, windows.loadEnd),
      ...(idle ? { idle: { busyMs: idle.mainThread.busyMs, scripts: idle.scripts.slice(0, 3), timers: idle.timers, animationFrames: idle.animationFrames, requests: idle.requests.slice(0, 10) } } : {}),
    });
  }
  return out.slice(0, 10);
}

const round = (n: number) => Math.round(n * 10) / 10;
