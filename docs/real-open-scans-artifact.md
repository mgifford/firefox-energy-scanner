# Real Open Scans artifact: issue 391

The optional accessibility join was run against a real artifact, not a
fixture, on 18 November 2026.

## Source

| Field | Value |
| --- | --- |
| Issue | [mgifford/open-scans#391](https://github.com/mgifford/open-scans/issues/391) |
| Scan | `2026-11-17T19-12-18-987Z` (latest accessibility-context comment) |
| Artifact | `accessibility-context.json` |
| SHA-256 | `5ab3f8ab569ff2f1be280720ea94faa3bf561667f11cdefd537743220b89d468` |
| Size | 6.4 MB |
| Schema | `a11y-accessibility-context/1` |
| Site | `https://huggingface.co` |
| Observations | 5,486 over 20 pages |
| Engines | `accesslint` 2,682; `axe` 2,441; `semantica11y` 362; `reflowRisk` 1 |
| Viewport | 1,024 × 768, tablet landscape; Firefox |

The other issue in the queue, #394, is performance-only and has no
`accessibility-context.json`; it cannot exercise this join.

## FES result

The FES crawl used the artifact's exact 20 page URLs as `--also-file`, so the
page join could be complete rather than a sample.

| Field | Value |
| --- | --- |
| Browser | Chromium structural seam, `--no-energy` |
| Pages | 20 |
| Families | 3 |
| Component types / instances / resources | 31 / 360 / 665 |
| Result | `results/hf-open-scans/crawl-2026-11-18T19-50-23-245Z.json` |
| Result SHA-256 | `cdd973591108af403e112bad613fbd30d3d5ef580880bea1c900759a0a064d9a` |

It is structural discovery, not a Firefox energy measurement.

## Join

```bash
node dist/cli/index.js report results/hf-open-scans/crawl-2026-11-18T19-50-23-245Z.json \
  --accessibility-context results/open-scans-391-accessibility-context.json
```

| Result | Count |
| --- | --- |
| Observations | 5,486 |
| Matched to a measured page | **5,486 (100%)** |
| Exact CSS component matches | **8 occurrences / 4 unique observations** |
| Page-level only | 5,478 |
| HTML-only, page-level | 362 |
| Unmatched pages | 0 |
| Sidecar | `results/hf-open-scans/crawl-…accessibility-context.json` (7.6 MB, SHA-256 `98b0d302f1724e70d3d2441e7f81f6ba777125b32e32346dfefa09ad983439bf`) |
| HTML | 4.7 MB |

The 8 component matches are duplicated records of four observations: three
unique navigation landmarks and one `main` landmark. They are exact CSS text
matches; they are not ownership claims.

### By engine

| Engine | Selector type | Joined as |
| --- | --- | --- |
| AccessLint | CSS (inferred) | page-level; exact CSS where text matched |
| axe | CSS (inferred) | page-level; exact CSS where text matched |
| Semantica11y | HTML-only | page-level; 362 records stay visible |
| reflowRisk | unknown | page-level; never compared |

## What the real artifact changed

1. **Null container fields are valid.** The first run failed validation because
   real observations write `container.element: null`. The input and join
   schemas now allow null `category`, `label`, `element`, `basis`, `confidence`
   and the explicit component-id fields. A trimmed real-artifact fixture and
   regression test cover it.
2. **Explicit Open Scans component ids are preserved, not used.** The real
   artifact carries `componentId`, `componentTypeId` and `componentLabel`; they
   are null on the matched records and are Open Scans ids, not FES ids. FES
   displays them if present but never matches on them or on a label.
3. **The report needed a summary.** 5,486 rows is too much to scan cold, so the
   HTML section now starts with a per-page table: observations, component
   matches, page-level, HTML-only and engines, before the occurrence table.
4. **The selector gap is measurable.** Only 8 of 5,486 observations (0.15%)
   matched a component by exact selector. Ancestor matching would require the
   actual DOM or a published selector type; the artifact has neither. This is
   the expected conservative result, not a failure.

## Limits

- Open Scans and FES are different runs, browsers and viewports (Open Scans
  1,024 × 768 tablet; FES defaults to its desktop viewport). Only the page URL
  is a reliable join key at page level; the DOM and generated selectors can
  differ.
- A page-level match is not component attribution. The 8 exact matches are not
  ownership and show no energy.
- The artifact carries no energy, performance or WCAG conformance claim; the
  join adds none.
- Duplicate observations are preserved, not deduplicated.
- The sidecar and report are large (7.6 MB / 4.7 MB); the per-page summary is
  the entry point, with the full table for audit.
- No `selectorType` field; `reflowRisk` stays unknown. No ancestor/descendant
  matching is attempted without DOM validation.

## Ready?

**Yes, for page-level accessibility evidence and conservative exact-CSS
component matches.** The real artifact loads, validates, joins all 20 pages,
keeps HTML-only and unknown-selector evidence visible, and produces a usable
per-page summary.

**Not yet, for broad component attribution.** That needs either a published
`selectorType` plus DOM-validated ancestor matching, or an explicit shared
component id. Until then, 99.85% of this real artifact remains page-level, and
that is the honest result.
