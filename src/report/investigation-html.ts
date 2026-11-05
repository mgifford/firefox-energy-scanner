import type { BenchmarkResult, StepResult } from '../core/types.js';
import type { InvestigationItem, InvestigationQueue } from '../analysis/investigation.js';
import type { HistoryReport } from '../analysis/history.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const link = (url: string, text = url) => (/^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname + u.search;
    return p.length > 40 ? `…${p.slice(-39)}` : p;
  } catch {
    return url;
  }
}

const kb = (b: number) => (b < 1024 ? `${Math.round(b)} B` : `${Math.round(b / 1024)} KB`);

const EVIDENCE: Record<InvestigationItem['evidence'], string> = {
  'structure-and-lighthouse': 'structure and Lighthouse',
  lighthouse: 'Lighthouse',
  structure: 'structure',
};

function workload(i: InvestigationItem): string {
  const w = i.workload;
  const parts = [
    w.elements !== undefined ? `${w.elements} elements${w.shareOfPage !== undefined ? ` (${Math.round(w.shareOfPage * 100)}%)` : ''}` : '',
    w.endlessAnimations ? `${w.endlessAnimations} endless animation${w.endlessAnimations === 1 ? '' : 's'}` : '',
    w.chromiumMainThreadMs ? `${w.chromiumMainThreadMs} ms Chromium main thread` : '',
    w.transferBytes ? `${kb(w.transferBytes)} loaded` : '',
  ].filter(Boolean);
  return parts.length ? parts.map(esc).join('<br>') : '—';
}

function itemDetails(i: InvestigationItem): string {
  return `<details id="q-${esc(i.id)}">
    <summary>${i.rank}. ${esc(i.title)}</summary>
    <p><strong>Why it is here:</strong></p>
    <ul>${i.because.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    ${
      i.where.length
        ? `<p><strong>Where:</strong></p><ul>${i.where
            .map(
              (w) =>
                `<li>${link(w.page, shortPath(w.page))}${w.selector ? ` <code>${esc(w.selector)}</code>` : ''}` +
                `${w.rect ? `, ${w.rect.y.toLocaleString('en')} px down${w.belowFold ? ' (below the first screen)' : ''}` : ''}</li>`,
            )
            .join('')}</ul>`
        : ''
    }
    ${i.remediation
      .map(
        (r) => `<div class="remedy">
      <p><strong>${esc(r.title)}.</strong> ${esc(r.action)}</p>
      <p class="note"><strong>Why:</strong> ${esc(r.rationale)}</p>
      <p class="note"><strong>Check it:</strong> ${esc(r.verify)}</p>
    </div>`,
      )
      .join('')}
    ${i.audits.length ? `<p class="note">Lighthouse audits: ${i.audits.map((a) => `<code>${esc(a)}</code>`).join(', ')}.</p>` : ''}
  </details>`;
}

/** Map scale: a 1440 px wide page is drawn 288 px wide, and at most 720 px tall. */
const SCALE = 0.2;
const MAX_DOC_HEIGHT = 3600;

/**
 * A page map: the page outline, the first screen, and a numbered box for each
 * queued component on it, drawn from recorded positions. Decorative: the list
 * beside it gives the same positions as text, with links.
 */
function pageMap(step: StepResult, items: InvestigationItem[], viewport: { width: number; height: number }, n: number): string {
  const instances = step.anatomy?.structure?.instances ?? [];
  const placed = items
    .flatMap((i) => {
      const at = i.kind === 'component' || i.kind === 'region' ? instances.find((x) => x.signature === i.title) : undefined;
      return at ? [{ i, at }] : [];
    });
  if (!placed.length) return '';
  const width = Math.max(viewport.width, ...instances.map((x) => x.rect.x + x.rect.width));
  const docHeight = Math.max(viewport.height, ...instances.map((x) => x.rect.y + x.rect.height));
  const shown = Math.min(docHeight, MAX_DOC_HEIGHT);
  const w = Math.round(width * SCALE);
  const h = Math.round(shown * SCALE);
  // Largest first, so smaller boxes are drawn on top; number tags that would
  // sit on one another move along to the right.
  const tags: { x: number; y: number; w: number }[] = [];
  const labels: string[] = [];
  const boxes = [...placed]
    .sort((a, b) => b.at.rect.width * b.at.rect.height - a.at.rect.width * a.at.rect.height || a.i.rank - b.i.rank)
    .map(({ i, at }) => {
      const r = at.rect;
      if (r.y > shown) return '';
      const x = Math.round(r.x * SCALE);
      const y = Math.round(r.y * SCALE);
      const bw = Math.max(4, Math.round(r.width * SCALE));
      const bh = Math.max(4, Math.min(h - y, Math.round(r.height * SCALE)));
      const tw = String(i.rank).length * 7 + 8;
      let tx = x;
      while (tags.some((t) => Math.abs(t.y - y) < 15 && tx < t.x + t.w && tx + tw > t.x)) tx += tw + 2;
      tags.push({ x: tx, y, w: tw });
      // Tags go in a later layer, so no box covers another's number.
      labels.push(`<rect class="tag" x="${tx}" y="${y}" width="${tw}" height="15"></rect><text x="${tx + 4}" y="${y + 11}">${i.rank}</text>`);
      return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}"></rect>`;
    })
    .join('');
  const id = `map-${n}`;
  return `<figure class="page-map" aria-labelledby="${id}">
    <svg aria-hidden="true" focusable="false" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect class="page" x="0" y="0" width="${w}" height="${h}"></rect>
      <g class="item">${boxes}</g>
      <line class="fold" x1="0" y1="${Math.round(viewport.height * SCALE)}" x2="${w}" y2="${Math.round(viewport.height * SCALE)}"></line>
      <g class="item">${labels.join('')}</g>
    </svg>
    <figcaption id="${id}">${link(step.url!, shortPath(step.url!))}: the dashed line is the end of the first screen${docHeight > shown ? `; the map shows the top ${shown.toLocaleString('en')} of ${docHeight.toLocaleString('en')} px` : ''}.</figcaption>
    <ol class="map-list">${placed
      .map(
        ({ i, at }) =>
          `<li value="${i.rank}"><a href="#q-${esc(i.id)}">${esc(i.title)}</a>: ${at.rect.y.toLocaleString('en')} px down, ` +
          `${at.rect.width}×${at.rect.height} px${at.belowFold ? ', below the first screen' : ''}</li>`,
      )
      .join('')}</ol>
  </figure>`;
}

/** Up to four page maps: the representative page of each of the largest families, or the first pages. */
function pageMaps(result: BenchmarkResult, queue: InvestigationQueue): string {
  const viewport = result.environment.viewport ?? { width: 1440, height: 900 };
  const steps = new Map(result.scenarios.filter((s) => s.valid && !s.warmup && s.url && s.anatomy?.structure?.instances).map((s) => [s.url!, s]));
  const pages = (result.families?.families.map((f) => f.representative) ?? [...steps.keys()]).filter((u) => steps.has(u)).slice(0, 4);
  const maps = pages.map((u, n) => pageMap(steps.get(u)!, queue.items, viewport, n)).filter(Boolean);
  return maps.length
    ? `<h3>Where they are</h3>
  <p class="note">Each map is a page drawn from the positions recorded in Firefox, ${Math.round(SCALE * 100)}% of its size, with numbered boxes for queued components. The list under each map gives the same positions.</p>
  <div class="maps">${maps.join('')}</div>`
    : '';
}

/**
 * Investigate first: the queue, its order stated, each item with its
 * evidence, where to find it, what to do and how to check it.
 */
export function investigationSection(result: BenchmarkResult): string {
  const queue = result.investigation;
  if (!queue || !queue.items.length) return '';
  return `<section aria-labelledby="investigate-h">
  <h2 id="investigate-h">Investigate first</h2>
  <p>What to look at, in order. The order is a sort on these keys, one after another, each shown in its own column. It is <strong>not a score</strong>, and nothing in it is an energy figure:</p>
  <ol class="note">${queue.order.map((o) => `<li>${esc(o)}</li>`).join('')}</ol>
  <div class="scroll"><table class="families">
    <caption>Investigation queue</caption>
    <thead><tr><th scope="col">#</th><th scope="col" class="text">What</th><th scope="col" class="text">Evidence</th><th scope="col">Pages</th>
      <th scope="col" class="text">Workload</th><th scope="col" class="text">Remedy</th><th scope="col" class="text">Confidence</th></tr></thead>
    <tbody>${queue.items
      .map(
        (i) => `<tr><td>${i.rank}</td><th scope="row"><a href="#q-${esc(i.id)}">${esc(i.kind === 'page' || i.kind === 'script' ? shortPath(i.title) : i.title)}</a><br><span class="note">${esc(i.kind)}</span></th>
      <td class="text">${esc(EVIDENCE[i.evidence])}</td><td>${i.reach.pages} of ${i.reach.of}</td>
      <td class="text">${workload(i)}</td><td class="text">${i.remediation.length ? esc(i.remediation[0]!.title) : '—'}</td><td class="text">${esc(i.confidence)}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
  ${pageMaps(result, queue)}
  ${queue.items.map(itemDetails).join('\n')}
  <ul class="note">${queue.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}

const pair = (p: [number, number] | undefined, f: (n: number) => string) => (p ? `${f(p[0])} → ${f(p[1])}` : '—');

/** Since the last scan of this site. */
export function historySection(history: HistoryReport | undefined): string {
  if (!history) return '';
  const h = history;
  const n = (v: number) => Math.round(v).toLocaleString('en');
  return `<section aria-labelledby="history-h">
  <h2 id="history-h">Since the last scan</h2>
  <p>Compared with <code>${esc(h.previous.file)}</code> (${esc(h.previous.timestamp.slice(0, 10))}): ${h.pagesInBoth} page${h.pagesInBoth === 1 ? '' : 's'} measured in both,
  ${h.pagesOnlyNow} only now, ${h.pagesOnlyBefore} only then.</p>
  <div class="scroll"><table>
    <caption>Medians over the pages in both scans (before → now)</caption>
    <thead><tr><th scope="col">Measure</th><th scope="col">Before → now</th></tr></thead>
    <tbody>
      <tr><th scope="row">Transfer</th><td>${pair(h.medians.transferBytes, kb)}</td></tr>
      <tr><th scope="row">Elements</th><td>${pair(h.medians.domNodes, n)}</td></tr>
      <tr><th scope="row">Requests</th><td>${pair(h.medians.requests, n)}</td></tr>
      ${h.families ? `<tr><th scope="row">Page families</th><td>${h.families[0]} → ${h.families[1]}</td></tr>` : ''}
      <tr><th scope="row">Observed energy, median</th><td>${h.energy.medianMwh ? `${h.energy.medianMwh[0].toFixed(3)} → ${h.energy.medianMwh[1].toFixed(3)} mWh` : 'not comparable'}</td></tr>
    </tbody>
  </table></div>
  <p class="note">${esc(h.energy.note)}</p>
  ${
    h.largestChanges.length
      ? `<p>Pages that changed most:</p><ul>${h.largestChanges
          .map(
            (c) =>
              `<li>${link(c.url, shortPath(c.url))}: ${[
                c.transferBytes ? `transfer ${pair(c.transferBytes, kb)}` : '',
                c.domNodes ? `elements ${pair(c.domNodes, n)}` : '',
              ]
                .filter(Boolean)
                .join(', ')}</li>`,
          )
          .join('')}</ul>`
      : ''
  }
  ${
    h.components && (h.components.appeared.length || h.components.gone.length || h.components.newSignals.length)
      ? `<p>Components:</p><ul>
      ${h.components.appeared.length ? `<li>New: ${h.components.appeared.map((s) => `<code>${esc(s)}</code>`).join(', ')}</li>` : ''}
      ${h.components.gone.length ? `<li>Gone: ${h.components.gone.map((s) => `<code>${esc(s)}</code>`).join(', ')}</li>` : ''}
      ${h.components.newSignals.map((s) => `<li><code>${esc(s.signature)}</code>: ${esc(s.signal)}</li>`).join('')}
    </ul>`
      : ''
  }
  <ul class="note">${h.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}
