# Optional Open Scans accessibility evidence

FES can load an Open Scans **accessibility context** and show its observations
beside a result's pages and component instances. It is optional, read-only and
never runs an accessibility scan.

It does **not** add accessibility engines, a second component graph, a combined
accessibility/performance/energy score, an Open Scans API call, or a WCAG
conformance claim.

## Get the artifact from Open Scans

Open Scans writes, per issue/scan:

```text
reports/issues/issue-<n>/<timestamp>/accessibility-context.json
```

Schema: `a11y-accessibility-context/1`
(<https://github.com/mgifford/open-scans/blob/main/scanner/schemas/a11y-accessibility-context.schema.json>).

Older FOSDEM/Hugging Face reports predate the artifact; use a new Open Scans
scan or a fixture. FES does not fetch it from the network.

## Run the join

After a FES result exists (measure, crawl or diagnose):

```bash
node dist/cli/index.js report results/crawl-….json \
  --accessibility-context path/to/accessibility-context.json
```

This writes:

- `results/crawl-….accessibility-context.json` — `fes-accessibility-join/1`;
- a _Related accessibility evidence_ section in the regenerated HTML.

The measured result JSON is not rewritten. The sidecar is the artifact; run
`report` again with the context to render the section again.

Without the option, FES behaves exactly as before. If a result already carries
a stored join, `report` renders it again without another context file.

## How matching works

1. **Page** — `observation.pageUrl` is matched with FES's own `pageKey` (the
   graph's normalization, including its explicit `www`/scheme handling). A page
   not in the measured sample is kept as **unmatched**, with the Open Scans URL.
2. **Exact component** — when the selector language is confidently **CSS** and
   the selector text matches a recorded component instance **exactly**. That
   gives `basis: exact-selector`, `confidence: medium`; it is a text match, not
   ownership.
3. **Opt-in DOM ancestor** — with `--validate-dom`, FES opens the FES page at
   the FES viewport, resolves a single CSS/XPath element, and walks to the
   nearest recorded component ancestor with at least `--dom-min-own-nodes`
   owned nodes. This gives `basis: ancestor-selector`, `domValidated: true`
   and low confidence when the Open Scans and FES viewports differ. Structural
   class heuristics are included by default but are guesses, not ownership;
   `--dom-semantic-only` excludes them.
4. **Everything else stays page-level and visible**:
   - `locatorSource: html` → HTML-only;
   - no selector → no selector;
   - XPath → page-level unless `--validate-dom` resolves it;
   - unknown engine → selector language unknown;
   - no exact or DOM-validated match → page-level;
   - several elements or instances → ambiguous.
4. **Labels are never identity.** A container label such as "Navigation" is
   displayed, but it is not used to choose a component.
5. **Container candidates are never promoted.** Every observation keeps
   `ownershipEstablished: false`.

### Selector type and report URL

When an observation publishes `selectorType`, FES **uses it first** and records
`match.selectorTypeSource: "published"`. The value is not guessed from the
engine. If it is absent — as in older artifacts — FES falls back to engine
inference and records `selectorTypeSource: "inferred"`:

| Engine | Fallback treated as |
| --- | --- |
| axe, AccessLint, Alfa, QualWeb, HTMLCS, IBM, WAVE | CSS |
| Equal Access | XPath |
| Semantica11y / `locatorSource: html` | HTML-only |
| anything else | unknown → no selector comparison |

The expected additive fields are:

```json
"selectorType": "css" | "xpath" | "html",
"reportUrl": "https://…/report.html"
```

`scan.reportUrl` is preferred for the source link; `scan.issueUrl` is the
fallback. A published `selectorType` removes the CSS/XPath ambiguity. It does
not, by itself, validate ancestor/descendant relationships; the optional
`--validate-dom` pass does that in a real DOM.

### Opt-in DOM validation

```bash
node dist/cli/index.js report results/crawl-….json \
  --accessibility-context accessibility-context.json \
  --validate-dom --dom-max-observations 5000
```

- Opens each matched FES page once in Chromium at the FES viewport.
- **Requires the source and FES viewports to be the same** by default. If they differ or the source viewport is unknown, no ancestor is assigned; `--dom-allow-different-viewport` opts into the explicitly low-confidence broad association.
- Resolves only a selector that matches exactly one element.
- Walks to the nearest recorded component ancestor with at least
  `--dom-min-own-nodes` owned nodes (default 2), so page containers and
  utility wrappers are skipped.
- Includes structural class heuristics by default; `--dom-semantic-only`
  restricts to semantic/explicit components.
- Records `domValidated`, the source/FES viewport match, and confidence. A
  same-viewport match is `medium`; an explicitly allowed different viewport is
  `low`.
- Leaves page-load failures, ambiguous selectors and observations over the cap
  visible as page-level, with a reason.
- Is opt-in; ordinary joins remain browser-free.

### Other contract gaps

- There is no explicit FES component id on either side. `patternId` is an Open
  Scans pattern, not a FES component; `container.label` is a candidate, not an
  identity. FES therefore never matches by label or pattern id.
- `scan.reportUrl` is preferred when published; `scan.issueUrl` remains the
  fallback.
- The context has one record per occurrence, which FES preserves; duplicate
  `observationId` values are not deduplicated.

## Real artifact check

Issue #391's real 5,486-observation, 20-page artifact was joined to a FES crawl
of the same 20 URLs: all 5,486 matched a page, 8 occurrences (4 unique) matched a
component by exact CSS selector, 5,478 stayed page-level and 362 HTML-only
records remained visible. The real artifact also exposed a null
`container.element` validation bug, now fixed. See
[real-open-scans-artifact.md](real-open-scans-artifact.md). Issue #394 is
performance-only and has no accessibility context.

## Artifact

`fes-accessibility-join/1`:

- `sourceContext` — source schema, generation/scan metadata, issue link, site,
  summary, category labels and the source's own limitations;
- `matches` — observations matched to a measured page; `component` present only
  for an exact CSS match;
- `unmatched` — observations whose page is not in the measured sample;
- `summary` — observations, page/component/page-level/unmatched counts, and
  counts by match basis and engine;
- `limitations` — the inference, ancestor, ownership and evidence boundaries.

Published JSON Schema: [`schema/fes-accessibility-join.schema.json`](../schema/fes-accessibility-join.schema.json).

## Evidence boundaries

- Accessibility evidence is not energy evidence. No energy figure is added,
  inferred or changed.
- No WCAG conformance claim: an observation is one engine's finding on one
  occurrence.
- No component ownership: a selector match is a way to find related evidence,
  not proof that a component caused the finding.
- No combined score and no ordering of components by accessibility severity.
- The source's `container` is a candidate, not an implementation identity.

## Security and privacy

The context is untrusted input. FES reads a local file only (no URL loading),
caps it at 10 MB / 20,000 observations, validates the fields it uses, escapes
every string in HTML, and never executes content from it. It adds no live API,
MCP or model call to ordinary scans.
