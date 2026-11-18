# Report navigation

Every HTML report now opens with the investigation queue and then a **Site
map** that connects:

```text
site → families → pages → component types and resources → evidence
```

It is navigation, not another score. Counts describe the measured sample only.

## What the map contains

- **Families** — pages, representative, component types, resources and finding
  counts. Every family opens a detail block with its pages and component-type
  links.
- **Pages** — family, component-type links, script links, finding count and
  links to the Site patterns and investigation sections. Each page has an
  anchor.
- **Component types** — method, identification/confidence, pages, families,
  finding count and resource count. Each type has an anchor and links back to
  its pages and families.
- **Resources** — kind, pages, families, the component types that load it and
  finding count. A resource with no loader says so. Each resource has an
  anchor, and the reverse link goes to its component types and families.
- **What the counts mean** — a source/unit/boundary table:
  - graph and family counts are measured-sample counts;
  - findings keep their own evidence class (structure, Lighthouse, Chromium
    trace), never energy;
  - energy is not shown in the map; where measured it remains in its own
    finding/timeline section, same machine and run, never per element;
  - accessibility remains optional Open Scans evidence, not energy and not a
    WCAG conformance claim.

All anchors and reverse links are ordinary HTML. No JavaScript is required.

## Run and viewport context

The map states the FES run mode, session id, start time, viewport and energy
tier. The **Related accessibility evidence** section now states:

- the source scan viewport, when published;
- the FES run viewport;
- whether they are **same**, **different** or **unknown**.

A different viewport is not hidden. Page URLs are matched; exact CSS component
matches are text matches and are not DOM-validated across viewports. A published
`selectorType` is labelled `published`; an engine fallback is labelled
`inferred`.

The candidate queue's pairing key (`siteOrigin|pageKey|widthxheight`) uses the
same context for later run/viewport-aware joins.

## Limits

- The map is a navigation index, not a claim that a family, component or
  resource caused anything.
- Counts are measured pages only; no whole-site prevalence.
- Family grouping can still be broad; the map does not hide that.
- Script/resource links show relationships the graph recorded; they are not
  ownership.
- Accessibility is page-level unless an exact CSS component match exists; the
  run/viewport label is a warning, not a correction.
- No combined accessibility/performance/energy/carbon score.

## Still pending

- A manual `workflow_dispatch` operation path that cannot crawl or trigger the
  physical runner, with the physical runner isolated from untrusted PRs.
- Broader accessibility component mapping: DOM-validated ancestor matching or
  an explicit shared component id.
