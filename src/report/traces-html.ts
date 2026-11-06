import type { ComponentGraph, GraphFinding } from '../model/graph.js';
import type { TraceRecord } from '../trace/run.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const msText = (n: number) => `${Math.round(n).toLocaleString('en')} ms`;
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a trace finding was tied to, in words. */
function targetText(f: GraphFinding, graph: ComponentGraph): string {
  const t = f.target;
  if (t.type === 'instance') {
    const inst = graph.instances.find((i) => i.id === t.id);
    const type = inst && graph.types.find((x) => x.id === inst.type);
    return type ? `Component <code>${esc(type.signature)}</code><br><span class="note">${esc(inst!.selector)}</span>` : esc(t.id);
  }
  if (t.type === 'resource') {
    const r = graph.resources.find((x) => x.id === t.id);
    return r ? `Resource <code>${esc(r.key)}</code>${r.thirdParty ? ' <span class="note">(third party)</span>' : ''}` : esc(t.id);
  }
  if (t.type === 'page') return `The page itself${t.reason ? `<br><span class="note">${esc(t.reason)}</span>` : ''}`;
  return `<strong>Unattributed</strong><br><span class="note">${esc(t.reason)}</span>`;
}

/**
 * Chromium traces: what ran on each traced page during load and while it sat
 * idle, and what each observation was tied to. Main-thread time in one
 * Chromium run, never energy, and never combined with Firefox's figures.
 */
export function tracesSection(traces: TraceRecord[] | undefined, graph: ComponentGraph | undefined): string {
  if (!traces?.length) return '';
  const done = traces.filter((t) => t.analysis);
  const skipped = traces.filter((t) => !t.analysis);
  // Paths alone when every traced page is on one origin: full URLs crowd a narrow screen.
  const origins = new Set(traces.map((t) => originOf(t.url)));
  const origin = origins.size === 1 ? [...origins][0] : undefined;
  const where = (url: string) => (origin && originOf(url) === origin ? url.slice(origin.length) || '/' : url);
  const idleSecs = Math.round((traces[0]!.idleMs ?? 0) / 1000);
  const rows = done
    .map((t) => {
      const a = t.analysis!;
      const idle = a.idle;
      const running = idle
        ? [
            idle.animationFrames.fired ? `${idle.animationFrames.perSecond} animation frames a second` : '',
            idle.timers.fired ? plural(idle.timers.fired, 'timer callback') : '',
            idle.animations.length ? plural(idle.animations.length, 'running animation') : '',
            idle.requests.length ? plural(idle.requests.length, 'request') : '',
            ...(a.frames ?? []).filter((f) => f.idle && (f.idle.timers.fired || f.idle.animationFrames.fired || f.idle.busyMs >= 1)).map((f) => `an iframe (${esc(new URL(f.url).host)}) working in its own process`),
          ].filter(Boolean)
        : [];
      return `<tr><th scope="row"><code>${esc(where(t.url))}</code></th>
        <td><span class="nowrap">${Math.round(a.load.mainThread.busyMs).toLocaleString('en')} of</span> <span class="nowrap">${msText(a.load.durationMs)}</span></td>
        <td>${a.load.longTasks.length}</td>
        <td>${idle ? msText(idle.mainThread.busyMs) : '—'}</td>
        <td class="text">${running.length ? running.join('; ') : 'Nothing'}</td></tr>`;
    })
    .join('');

  const findings = (graph?.findings ?? []).filter((f) => f.kind.startsWith('trace:'));
  const pageUrl = (id: string) => where(graph?.pages.find((p) => p.id === id)?.url ?? '');
  const unattributed = findings.filter((f) => f.target.type === 'unattributed').length;
  const findingRows = findings
    .map(
      (f) => `<tr><th scope="row">${esc(f.title)}</th><td class="text"><code>${esc(pageUrl(f.page))}</code></td>
        <td class="text">${targetText(f, graph!)}</td><td class="text">${esc(f.evidence[0]?.detail ?? '')}</td></tr>`,
    )
    .join('');

  return `<section aria-labelledby="traces-h">
  <h2 id="traces-h">Chromium traces</h2>
  <p>${plural(done.length, 'page')}${origin ? ` of <code>${esc(origin)}</code>` : ''} traced in ${esc(done[0]?.browser ?? traces[0]!.browser)}, once each: the load, then ${idleSecs} s with the page left alone.
  A trace says which scripts ran and what was restyled, laid out and painted. It is main-thread time in one Chromium run: it is not energy,
  and it is not combined with Firefox's measurements.</p>
  ${
    rows
      ? `<div class="scroll"><table class="families">
    <caption>Main-thread work on each traced page</caption>
    <thead><tr><th scope="col" class="text">Page</th><th scope="col">Load: busy, of its length</th><th scope="col">Long tasks in load</th><th scope="col">Idle: busy, of ${idleSecs} s</th><th scope="col" class="text">Still running while idle</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
      : ''
  }
  ${
    findingRows
      ? `<div class="scroll"><table class="families">
    <caption>What the traces show, and what each observation is tied to${unattributed ? ` (${unattributed} unattributed)` : ''}</caption>
    <thead><tr><th scope="col" class="text">Observation</th><th scope="col" class="text">Page</th><th scope="col" class="text">Tied to</th><th scope="col" class="text">Evidence</th></tr></thead>
    <tbody>${findingRows}</tbody></table></div>`
      : done.length
        ? '<p>The traces show no work worth raising: no long tasks, and nothing kept running while the pages sat idle.</p>'
        : ''
  }
  ${skipped.length ? `<p>Not analysed:</p><ul>${skipped.map((t) => `<li><code>${esc(where(t.url))}</code>: ${esc(t.skipped)}</li>`).join('')}</ul>` : ''}
  <p class="note">A component or resource is named only where the trace itself names it: an animated element at the same position in the document,
  or a script, timer or animation frame whose file this scan recorded on the page. Everything else is marked unattributed, with the reason.</p>
</section>`;
}
