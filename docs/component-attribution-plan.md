# Component-level attribution: review and plan

This plan turns the scanner from page-oriented findings into a component-oriented
investigation. It is written against the repository as of `main` at `aacbfa3`, and
checked against the Energy.gov scan (issue #37). Each workstream is a separate PR,
merged in order.

## What already exists

| Capability | Where | Keep |
| --- | --- | --- |
| Firefox energy (Gecko power counters, baseline subtraction, resolution rule) | `src/energy`, `src/core/stats.ts` | as is |
| CO2.js per domain, green hosting | `src/core/co2.ts` | as is |
| Lighthouse 13 in Chromium, element and script evidence | `src/lighthouse` | extended (B) |
| webNRG gateway lookups and requests | `src/webnrg` | extended (E) |
| Seeded and adaptive sitemap sampling | `src/collect/sitemap.ts` | as is |
| Page families (`structure-v1`) | `src/analysis/families.ts` | used by C |
| Component signatures and up to 24 occurrences per page | `src/collect/page-anatomy.ts` | extended (A) |
| Component inventory, investigation queue, history | `src/analysis` | rebuilt on the graph (A, C, D) |
| Experiments, interleaved A/B, `compare`, journeys, `journey-check` | `src/experiments`, `src/cli` | extended (E, G) |
| JSON, CSV and accessible HTML; issue scans; GitHub Pages | `src/report`, `.github`, `site` | extended (F) |

## What the Energy.gov scan shows

- **Nested containers are counted several times.** `dialog-off-canvas-main-canvas` (644
  elements) contains `usa-header` (421), which contains `usa-nav` (408), which contains
  `usa-megamenu` (381). Each record counts everything inside it, so one mega menu is
  reported four times. The wrapper led the queue on "1 iframe, 7 eager images" that
  belong to its descendants.
- **Shared resources are invisible.** About 3.5 MB of every page is five FontAwesome icon
  scripts (`duotone-regular.js` alone is 1 MB), loaded on 47 of 47 pages; Lighthouse's
  "Reduce unused JavaScript" (about 949 KB per page) points the same way. No queue item
  mentions them, because the queue ranks DOM containers, and scripts loaded from
  `<head>` belong to no component.
- **The home page's weight is unique content.** Of its 40.7 MB, 35.3 MB comes from
  resources no other sampled page loads, mostly four images of 11.4, 8.3, 5.2 and
  4.8 MB. That is a page-level, content-and-media finding, not evidence that the home
  page wastes energy (energy was not measured).
- **Type identity is a class name.** Two different elements sharing a class are one
  "component", and nothing records how instances were matched.
- **Resource-level Lighthouse findings are summarised away.** Unused JavaScript, unused
  CSS, render-blocking, cache lifetime and font findings keep only page totals, so they
  cannot be tied to the resource responsible.

## The smallest set of architectural changes

1. **A component graph** (`result.graph`, schema `component-graph/1`), derived from what
   is already collected. It holds pages, component types, component instances (with
   parent and children), resources (with the pages, families and instances that load
   them), and findings with explicit attribution. Everything is referenced by stable
   id; nothing is copied into every object.
2. **Own (exclusive) accounting** recorded in the page, so a container's figures exclude
   its recorded descendants, and the page keeps an "outside any component" remainder.
3. **An evidence contract** for every finding: source, method, unit, scope, browser,
   evidence class, attribution target, and an energy status that is never a zero.
4. **Schema version 2 with migration**: older results are read through `migrate()`, and
   the graph is rebuilt from their stored data, so published reports keep working.
5. **Resource-level evidence** from Lighthouse, and optional Chromium tracing for the
   few pages worth it. Firefox stays the only energy source.
6. **Analyses on the graph**: shared and unique components per family, matched-page
   comparisons (correlation only), shared-dependency root causes, histories across
   scans, and experiments linked back to components.

## Workstreams, in dependency order

| PR | Scope | Acceptance |
| --- | --- | --- |
| **A** Component graph | Types and instances, parent and child, own and inclusive counts, resource graph with scope (site-wide, family, shared, page), findings with attribution, zod schema and published JSON Schema, v1 migration, queue on own facts | On the Energy.gov result: the wrapper is not queued for inherited media; the mega menu owns the header's elements; the FontAwesome scripts appear as site-wide resources. A shared navigation is one type with one instance per page in a fixture. Results validate against the schema. |
| **B** Attribution | Resource, script, page and unattributed findings from Lighthouse; optional `--trace` (Chromium) for long tasks, style, layout, forced layout, paint, timers, animation frames and idle activity, with trace node ids resolved to components; budgets | A Lighthouse finding tied to a resource; a trace finding tied to a component; work with no element listed as unattributed; synthetic-trace unit tests |
| **C** Cross-page | Shared and unique components per family; matched-page comparisons; shared dependencies as root causes, with evidence levels; default ordering as specified, every dimension shown separately | A unique component found on an outlier page; one root cause explaining findings on many pages |
| **D** History | Component, resource and finding lifecycles across scans: new, persistent, resolved, regressed | Repeated fixture scans give stable ids and correct lifecycles |
| **E** Energy validation | Outcome classes (reduction supported, increase supported, inconclusive, invalid, not measured); bootstrap intervals where runs allow; recorded conditions; experiments linked to components; interaction journeys; a webNRG side-by-side for two URLs, labelled as not controlled | A reproducible fixture experiment; a truthful not-measured state on CI; a measured comparison when run on suitable hardware |
| **F** Reporting | Site overview; component explorer with sorting and filtering added as progressive enhancement; page view with highlightable regions; capability statuses and links on the published site | Keyboard, screen reader, forced colours, dark mode, 390 px, no colour-only signals; the full content without scripts |
| **G** Agentic | `discover`: deterministic, accessibility-tree-based drafts of journeys, never destructive and with page text treated as data; `explain`: an evidence brief an LLM may explain but not extend; MCP guidance | Draft journeys pass `journey-check`; a hostile page name cannot become code |

## Fixtures

A static fixture site (`tests/fixtures/site/`) covers the twelve required behaviours:

1. a static light page;
2. a large static DOM;
3. a small page with expensive script;
4. a continuously animated component;
5. an expensive event-driven component;
6. an oversized image;
7. a third-party iframe;
8. a navigation shared across pages;
9. a unique expensive component on one page;
10. nested components with shared resources;
11. a change that improves performance but not measurable energy;
12. an optimisation that saves energy without changing transfer.

Unit tests use synthetic Lighthouse and trace data, labelled as such. CI runs the
fixture site in Firefox (and Chromium for Lighthouse and tracing). It has no energy
hardware, so it asserts the not-measured state. Measured comparisons are documented as a
local run on an Apple Silicon Mac.

## What this environment cannot do

- The reference sites (developer.chrome.com, MDN, w3.org, playwright.dev, green-coding.io,
  energy.gov) are blocked by this session's network policy. Their sources were read
  from public repositories instead: the W3C Web Sustainability Guidelines (Group Note
  Draft, 2026-08-25) and the installed Playwright and Lighthouse packages. Trace event
  names are checked against the installed Chromium.
- No energy hardware: no energy figure is measured in this work. Any figure in a test
  is synthetic and labelled so.
- New real-site scans (other CMSs and frameworks) run as hosted scans once the work is
  on `main`.
