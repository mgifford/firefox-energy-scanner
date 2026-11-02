# 2026-10-31 — one URL means a seeded sitemap sample, open-scans style

**Task:** Make `SCAN: https://canada.ca` give a sampling of pages, as open-scans does,
with the same simple instructions.

**Changed:** `src/collect/sitemap.ts`, `src/collect/crawler.ts`, `src/cli/issue-parser.ts`,
the scan workflow, form and site, docs, TDR-013.

**Evidence:** `npm test` → all pass; `tests/sitemap.test.ts` caught `.css` counted as a
page, the same flaw as open-scans 367. The e2e adds a sitemap-only page behind a
bare-domain redirect.

**Worked:** reading the other tool's code and its real output before copying its rules.

**Cost time:** nothing notable.

**Next:** merge #23, then edit #22's title to re-run it; maintainer.
