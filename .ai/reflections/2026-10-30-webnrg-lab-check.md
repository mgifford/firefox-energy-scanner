# 2026-10-30 — webNRG lab figures beside the scan, reused before requested

**Task:** Add Green Coding's webNRG as an option locally and by default in hosted scans,
through the gateway co2-runner uses.

**Changed:** `src/webnrg/`, `src/report/webnrg-html.ts`, `src/cli/args.ts`,
`src/cli/index.ts`, `scan-request.yml`, `webnrg-check.yml`, `docs/webnrg.md`, TDR-012.

**Evidence:** `npm test` → all pass, including 17 in `tests/webnrg.test.ts` against
GMT-shaped fixtures. The live round trip is unverified here: green-coding.io is blocked
in this session.

**Worked:** reading webNRG's own front end; the 30-day reuse lives there, not in the
gateway as co2-runner's ADR says.

**Cost time:** `--crux` was missing from the value-less flags, the same bug as
`--lighthouse`. `tests/args.test.ts` now derives the list from the source.

**Next:** run the webNRG live check (maintainer adds the label); tell Green Coding.
