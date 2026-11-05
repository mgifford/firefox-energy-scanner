# 2026-11-05 — investigation report (component diagnosis, PR 3 of 4)

**Task:** An investigation queue with remedies, page maps and history, without a
combined score or any per-component energy.

**Changed:** `src/analysis/{remediation,investigation,history}.ts` (new),
`src/report/{investigation-html,queue-csv}.ts` (new), `src/report/{html,index-builder}.ts`,
`src/cli/{index,args}.ts`, `site/app.js`, the scan workflow, the components e2e, docs.
Also on PR 2: Lighthouse findings told from context.

**Evidence:** dry runs against a real Lighthouse 13 report and Chromium-recorded
anatomy; screenshots in light, dark and forced colours, and at 390 px. `npm test`.

**Worked:** looking at the rendered queue: it showed a passing DOM audit ranking `<nav>`,
which led to the finding/context split.

**Cost time:** SVG layering (fills hiding tags and the fold line in forced colours).

**Next:** PR 4, experiments: journey variants and measured differences.
