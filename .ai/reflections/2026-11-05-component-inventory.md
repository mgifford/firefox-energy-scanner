# 2026-11-05 — component inventory and performance evidence (component diagnosis, PR 2 of 4)

**Task:** Record component occurrences per page, group them across pages, and tie
Lighthouse's Chromium-trace findings to them without claiming per-component energy.

**Changed:** `src/collect/page-anatomy.ts` (instances), `src/lighthouse/evidence.ts` (new),
`src/lighthouse/summary.ts`, `src/analysis/components.ts` (new), `src/drupal/twig-debug.ts`,
`src/report/{components-csv,components-html,html,index-builder}.ts`, `src/cli/index.ts`,
workflows, docs.

**Evidence:** a real Lighthouse 13 run in Chromium against a fixture: its node paths
equal the ones page-anatomy records (`1,HTML,1,BODY,1,MAIN,0,DIV…`); the dry run tied
the non-composited animation and unsized image to the annotated carousel. `npm test`.
The cross-browser match (Firefox paths, Chrome findings) is the new CI job.

**Worked:** reading Lighthouse's own `getNodePath` and copying its format exactly.

**Cost time:** 60 identical teasers filling the instance budget; a query-stripping page
key copying one page's evidence to `?page=2`.

**Next:** PR 3, the visual investigation report (queue, overlays).
