# Site patterns: recurring findings across pages

A crawl can find the same kind of problem on many pages. `patterns` groups those findings by
the identity the component graph recorded, and shows both directions:

- **component type → pages, families, resources, findings**
- **resource → component types, pages, families, findings**

It is a view of observations, not a score. It adds no energy figure and does not merge two
implementations because they share a role, a class name or a Lighthouse audit title.

## What counts as one pattern

A pattern is a finding `kind` plus its target identity:

| Target | Identity | Example |
| --- | --- | --- |
| component | the graph's component **type** (signature + tag + role) | one shared navigation on 18 pages is one pattern |
| resource | the graph's resource id (host + path, query values removed) | one shared script is one pattern with several component edges |
| page | one page id | a page-level finding stays per page |
| unattributed | the reason the finding could not be attributed | no component is invented |

A script used by two component types is **one resource pattern with two component edges**, not
one copy assigned wholly to each. Two navigation components with different structure are two
types and two patterns even when both are `role=navigation`.

## Output

`SitePatterns` (in `result.patterns`):

- `patterns[]`: rank, finding kind and title, target, strongest evidence class, pages,
  families, instances, representative page/selector, contributing finding ids, resource ids,
  component type ids, `energy: "not-measured"` and limitations;
- `components[]`: type identity, confidence, container flag, pages, families, instances,
  resources, findings and a representative instance;
- `resources[]`: key, host, kind, third-party flag, scope, pages, families, component types
  and findings;
- `pages`, `families`, and method `site-patterns/1`.

Ranking is evidence strength first (direct observations and direct nodes, then trace,
resource association, cross-page correlation, structural), then pages, then instances. The
keys are shown; they are not added into a score.

## Commands and reports

```bash
node dist/cli/index.js patterns results/crawl-….json            # summary
node dist/cli/index.js patterns results/crawl-….json --json     # the full view
node dist/cli/index.js patterns results/crawl-….json --write    # store it and regenerate the HTML
```

`measure`, `crawl` and `diagnose` attach the view automatically. The HTML report gets a
_Site patterns_ section with tables for recurring findings, components and resources. The
tables are semantic, work without JavaScript, and carry the limitations as text.

## What the first fixture shows

The synthetic fixture in `tests/patterns.test.ts` has:

- a shared `component:site-nav` finding on six pages in two families → **one** pattern;
- a different `landmark:navigation` with the same finding kind → a **separate** pattern;
- a chart finding on one page → separate;
- one shared script loaded by both navigation types → one resource pattern with two component
  edges;
- two page-level findings of the same kind on two pages → two page patterns.

The real fixture site's structural scan has only the hero animation, so `patterns` reports one
pattern; a shared navigation issue needs Lighthouse or trace evidence before it can appear.
That is the same boundary as the investigation queue: structure is not a performance finding.

## Limitations

- Patterns describe the measured sample. A count is never extrapolated to the whole site.
- A repeated finding can reflect shared templates, a common third party, or coincidence; it
  is not proof of a shared implementation, cause or cost.
- Confidence is the graph type's confidence, not a causal confidence.
- No per-component, per-script or per-element energy. A controlled experiment is still the
  only way to test an energy difference.
- The view does not merge distinct issue mechanisms with the same Lighthouse audit title, and
  it does not split one issue across page counts.
