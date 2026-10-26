# 2026-10-26 — A single visit has no energy spread

**Task:** Stop reporting an energy IQR of 0.000 for steps measured only once.

**Changed:** `src/report/html.ts` (IQR cell and note), `tests/carbon.test.ts`,
`docs/limitations.md`, `docs/methodology.md`, TDR-010 in `docs/decision-record.md`.

**Evidence:** A real `w3.org` crawl printed n = 1 on all 34 steps with an IQR of 0.000
throughout, publishing seven Client-energy CO2e figures and blanking 27 only because
their medians were negative. A rendered single-run result now reads
`1 | 0.298 | — | 55.1` with the note present. `npm test` → 432 passed; `npm run build`
clean.

**Worked:** comparing the median-sign column with the `—` column first; that one
comparison located the rule before any code was read.

**Cost time:** nothing notable.

**Next:** decide whether `resolution()` should require n ≥ 2, which would blank the
Class C column on crawls until `crawl` honours `--runs`.
