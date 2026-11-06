# The component graph

`result.graph` is the canonical model of a scan: pages, component types and instances,
resources and findings, each with a stable id, linked by reference. The schema is
`component-graph/1`, in [`schema/component-graph.schema.json`](../schema/component-graph.schema.json),
which is generated from `src/model/schema.ts` (`npm run schema`). Every result is
checked against it before it is written.

The graph is derived from what the scan stored. `web-energy graph <result.json>`
rebuilds it for any result, older ones included.

## Entities

| Entity | Id | What it is |
| --- | --- | --- |
| Page | `pg-…` (hash of the URL) | A measured page, with its family, fingerprint, why it was sampled, DOM size, transfer and requests, and the elements no component owns |
| Component type | `ct-…` (hash of signature, tag and role) | A reusable component: a navigation on 50 pages is one type |
| Component instance | `ci-…` (hash of page, type and occurrence) | One occurrence on one page, with its parent, children, owned and inclusive counts, and the resources it loads |
| Resource | `rs-…` (hash of its identity) | A file the pages load, with the pages, families and instances that load it, and its scope |
| Finding | `fd-…` | Something to look at, with an explicit attribution target, evidence class and energy status |
| Source | `firefox-dom`, `firefox-network`, `lighthouse`, … | Where figures came from: browser, version, time, method and boundary |

Each metric names its unit, source and scope; the source entry gives the browser,
version and time. A plain number in the graph has the unit and source its field's
description states (for example `transferBytes`, bytes from `firefox-network`).

## Identity

- **A type is a signature with its element and role.** Two different elements that share
  a class name (`class:usa-accordion` on a `<div>` and on a `<ul>`) are two types. A type
  records what instances were matched on (`matchedBy`), its identification level and
  confidence, and how many structural variants its instances show:
  - **explicit** (Level A): annotations such as `data-component-id`, custom elements and
    framework roots, and CMS block classes;
  - **semantic** (Level B): landmarks;
  - **structural** (Level C): a class name;
  - **inferred** (Level D): a structural match whose kind (carousel, accordion, navigation
    menu, chart, media player, embed and so on) is guessed from its name and contents, and
    labelled as a guess. A dialog is never inferred from a class name alone, and no
    framework identity is ever invented.
- **An instance is a type's occurrence on a page**, numbered in document order, so the
  same page in another scan gives the same id.
- **A resource is its host and path**, keeping query values that name the asset (`?id=…`,
  a version) and dropping those that vary per page or per hit: a page URL passed along, a
  timestamp, or a third-party beacon's query. One script on every page is one resource.

## Owned and inclusive counts

Every element belongs to its **nearest component**, itself included. A component's owned
counts (elements, images, eager offscreen images, videos, autoplaying videos, iframes,
canvases, animations) never overlap with another's. Owned counts plus the page's unowned
remainder add up to the elements in `<body>`. Inclusive counts, everything inside, are
kept beside them and are never added up.

A **container** is a type that owns 5% or less of what it holds (and holds at least 50
elements): a page wrapper, a header around a navigation. Containers are not credited
with their contents. The investigation queue lists a container only for a Lighthouse
finding that landed on it directly.

Results made before owned counts were recorded (schema version 1) are migrated by
subtracting recorded children from each instance. Those counts are estimates, and the
graph says so. Unrecorded descendants (beyond 24 occurrences per page) stay in the parent.

## Resources and their scope

| Scope | Meaning |
| --- | --- |
| `site-wide` | Loaded on at least 80% of the measured pages (and at least 2) |
| `family-wide` | Loaded on at least 80% of one page family's pages |
| `shared` | Loaded on 2 or more pages otherwise |
| `page-unique` | Loaded on one measured page |

`loadedBy` lists the instances whose own elements (an `<img>`, `<script src>`, `<video>`
or `<iframe>`) load it. Scripts and stylesheets in the document head, and resources
loaded by script, have no loader: they are page-level, and their reach is the evidence.
That is how a 3.5 MB icon library on every page becomes visible even though no
component owns it.

## Findings: the evidence contract

Each finding has:

- `target`: the most specific thing it can be tied to (an `instance`, a `resource`, the
  `page`), or `unattributed`, with a `reason`;
- `evidenceClass`:
  - `direct-observation` (seen in the page by Firefox);
  - `direct-node` (a Lighthouse finding on a DOM node);
  - `resource-association`;
  - `trace-supported` (Chromium trace evidence);
  - `cross-page-correlation`;
  - `structural-heuristic` (a size threshold, a reason to look and not a cause);
- `role`: `finding` (a problem) or `context` (such as the LCP element, which ranks nothing);
- `evidence`: the source and a reference back into the result;
- `metric`, with unit, source and scope;
- `energy`: `{ status: "not-measured", measuredWorkloadDeltaMwh: null }` until a
  controlled experiment measures a workload difference. The schema refuses a number for
  "not measured", so an absent measurement is never a zero.

## Reports and files

- **JSON:** `graph`. The older `families`, `components` and `investigation` fields are
  views of the same data, kept for existing readers.
- **CSV:** `<result>.resources.csv`, one row per resource.
- **HTML report:** a _Resources_ section listing what nearly every page loads, what a
  family loads, and the heaviest things only one page loads. The components table marks
  containers and shows owned elements. With `--trace`, a _Chromium traces_ section lists
  the work on each traced page and what each observation is tied to.

## Lighthouse and trace findings

Lighthouse findings about one file (unused JavaScript and CSS, render-blocking requests,
cache lifetimes, font display, duplicated modules) are tied to that resource. This
happens only when Firefox recorded the file on the same page; otherwise they stay
unattributed, with the reason. The longest request chain is a property of the page.
Chromium trace findings follow the rules in [tracing.md](tracing.md).

## Commands

```bash
node dist/cli/index.js graph results/crawl-….json            # summary and schema check
node dist/cli/index.js graph results/crawl-….json --json     # the graph
node dist/cli/index.js graph results/crawl-….json --write    # store it, regenerate the report
```

## Limitations

- Up to 24 occurrences are recorded per page. Smaller repeated components beyond that are
  counted, but not placed.
- Resources loaded by script are page-level, even when one component's script loads them.
  A trace (`--trace`) ties idle requests, timers and animation frames to the scripts
  behind them, but it does not yet credit the resources a script loads to the component
  that owns the script.
- Owned counts follow DOM nesting. A component that affects another's rendering, for
  example by script, is not linked by this; that needs trace evidence.
