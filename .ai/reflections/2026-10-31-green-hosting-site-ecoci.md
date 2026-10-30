# 2026-10-31 — green hosting per domain, webNRG on the site, Eco CI, Node 24

**Task:** Turn on green hosting, show webNRG on the site, estimate each scan's own
energy; then fix Node 20 warnings and title-only requests (#21, #22).

**Changed:** `src/core/co2.ts`, `src/core/runner.ts`, `site/app.js`, `site/style.css`,
`src/cli/issue-parser.ts`, all workflows, docs.

**Evidence:** `npm test` → 490 passed. Chromium render of the site: webNRG table, no
page scroll at 390 px, table regions reachable and scrollable by keyboard.

**Worked:** reading the installed CO2.js: in its ES-module build `hosting` is the check
function, so `hosting.check()` had thrown, silently, on every call.

**Cost time:** assuming an API's shape from its CommonJS build.

**Next:** re-run #21 and #22 after merge (edit the title, or add `rescan`); maintainer.
