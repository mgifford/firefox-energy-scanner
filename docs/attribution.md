# Script-to-component attribution

The first Phase 1 question is narrow: on the fixture `/articles/d`, the page runs
`/js/chart.js`, the component inventory finds `component:live-chart`, and the old
`diagnose` printed `(no component loads it)`. Is the relationship knowable, and what can be
said about it without inventing ownership?

## What the page is

```html
<figure data-component-id="live-chart">
  <canvas id="chart" width="600" height="200" aria-label="A chart redrawn every frame"></canvas>
  <figcaption>Live chart</figcaption>
</figure>
<script src="/js/chart.js"></script>
```

```js
const c = document.getElementById('chart');
const g = c.getContext('2d');
function frame() { /* clear, draw a sine wave, requestAnimationFrame(frame) */ }
requestAnimationFrame(frame);
```

The `<script>` is **outside** the figure. The chart component does not declare or load it.
The figure contains the canvas; the script finds that canvas by its id and draws into it.

## What the graph records

For a diagnostic run, `graph.relations` is built from three observations, each with its own
boundary:

| Relation | From → to | Evidence | Confidence |
| --- | --- | --- | --- |
| `resource-used-on-page` | `/articles/d` → `/js/chart.js` | Firefox recorded the transfer | high, page-level |
| `declares-resource` | `landmark:main` → `/js/chart.js` | the `<script>` element is inside `main` | high, owned by the container |
| `suspected-association` | `/js/chart.js` → `live-chart` | the script source names `#chart`, inside the figure; no stack hit in this run | low, suspected |
| `script-observed-with-component` | `/js/chart.js` → `live-chart` | the same, **and** the script was on the same run's Firefox stack during an interval | medium, supported |

The last row is the one the Firefox `diagnose` run is for. The script is still page-level;
the edge says it was observed running with the component, and its source names an element
the component contains. It does not say the component owns the script, that the script
modified the canvas, or that the component used any particular energy.

The graph does **not** add a `script-modifies-component` edge: there is no DOM-write
observation. It does not add an edge to `landmark:main` for the script: when the same id is
contained by a container and a nested component, the most specific recorded component wins,
and a container-only match is marked `suspected`/low.

## How it was checked

```bash
# The static reference and the relation builder, no browser needed
npx vitest run tests/script-references.test.ts tests/relations.test.ts

# The real fixture page in Chromium (structural, no energy)
WEB_ENERGY_TEST_ENGINE=chromium npx vitest run tests/browser/dom-removal.test.ts

# The CLI end to end in Chromium, on an alternate port
WEB_ENERGY_TEST_ENGINE=chromium FIXTURE_PORT=18086 node tests/e2e/remove-e2e.mjs

# A diagnostic run: script sources are read after the measured windows
WEB_ENERGY_TEST_ENGINE=chromium node dist/cli/index.js diagnose \
  http://127.0.0.1:8086/articles/d --idle 2000 --no-screenshot --no-energy --out /tmp/diag-chromium

node -e "const fs=require('fs');const d='/tmp/diag-chromium';const f=fs.readdirSync(d).find(x=>x.endsWith('.json'));const r=JSON.parse(fs.readFileSync(d+'/'+f,'utf8'));console.log(r.scriptReferences.find(x=>x.url.endsWith('/js/chart.js')));console.log(r.graph.relations.filter(x=>x.kind.includes('script')||x.kind.includes('association')))"
```

The Chromium run confirmed `scriptReferences` holds `{ kind: "id", value: "chart" }` for
`chart.js`, that `/js/chart.js` is a page resource and that `landmark:main` declares it, and
that the static reference is a `suspected-association` to `live-chart` — not an observed
stack relation, because Chromium does not produce the Firefox power profile. The Firefox
`diagnose` run is the one that adds the stack-supported edge; it is recorded as **pending
Firefox** in `docs/measurement-integrity.md`.

## Limits

- A reference is not a write. The `script-observed-with-component` edge needs both the
  stack hit and the static DOM reference; neither alone is enough.
- Same-run stack samples do not show which DOM writes happened, or what energy they used.
- Static scanning reads same-origin script text only, first 24 scripts, 256 KB each, 2 s per
  fetch. Cross-origin scripts are marked, never fetched. Minified, templated or dynamically
  built selectors are missed; shadow DOM and frames are outside the top document.
- No source map is read, so a reference is located by the script URL and the element id, not
  by the function or line that wrote it.
- If two components of the same size both contain a referenced id, the most specific one is
  still ambiguous. The graph uses the first in document order; this tie is not yet marked on
  the edge, and should be treated as `suspected` when it matters.
- A component's own script is still not evidence of cost; only an intervention measures a
  difference.
