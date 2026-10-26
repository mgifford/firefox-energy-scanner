# Lessons

Durable notes for working in this repository. Read this when you start.

These are not a changelog. A lesson earns a place here only after it has cost
someone a wrong turn, and it must carry evidence: a file, a test, or a command.
Reflections are written per task in `reflections/`; this file is the distilled
subset. Do not rewrite it as a side effect of a task — add a reflection instead,
and promote a lesson deliberately.

Rollups live in `weekly/` and `monthly/` when they exist.

## 2026-10-26

- **A JSON data file cannot be imported here.** `module: "ES2022"` rejects
  `import data from './x.json' with { type: 'json' }` with TS2823. Ship generated
  data as a `.ts` module instead. Evidence: `tsconfig.json`,
  `src/core/grid-zones.ts`.

- **`µg CO2e = mWh × gCO2e/kWh` is complete, not a missing unit step.** 1 mWh is
  1e-6 kWh and 1 g is 1e6 µg, so the factors cancel. It reads like a bug until the
  derivation is written down. Evidence: `src/core/carbon.ts`, `docs/methodology.md`.

- **Gate every derived energy figure on `resolution()`.** It needs `median > 0`
  and `|median| ≥ IQR`. Lightweight pages routinely fail it and their medians can
  be negative, so an ungated figure becomes a negative emission. Evidence:
  `src/core/stats.ts`, `tests/carbon.test.ts`.

- **CSV stays a raw, signed export; reports stay gated.** Clamping in storage
  would hide the rule and make it unauditable. Evidence:
  `deriveCo2Micrograms` in `src/report/csv.ts` versus `toHtml` in
  `src/report/html.ts`.

- **A national grid average is not a local one.** Canada reads 185 gCO2e/kWh
  against an Ontario grid roughly an order of magnitude lower. Refuse
  subnational codes rather than approximate them. Evidence:
  `src/core/grid-zones.ts`, `docs/limitations.md`.

- **Resolve CLI assumptions before launching Firefox.** A typo in `--grid-zone`
  must fail in under a second, not after a ten-minute measurement. Evidence:
  the `gridFromConfig` call sites in `src/cli/index.ts`.

- **Never add CO2.js to observed-energy carbon.** `consumerDeviceCO2e` and
  Class C both describe the client device. Evidence: `docs/methodology.md`,
  TDR-009 in `docs/decision-record.md`.

- **Expect conflicts in `src/core/config.ts` and `src/cli/index.ts`.** Every
  feature adds a block to `configSchema` and a section to `USAGE`, so those two
  files conflict even when the work is unrelated. Rebase onto `main` before
  opening a PR rather than after. Evidence: the rebase onto `97b38cf` collided
  only in `config.ts` (network guard) and `index-builder.ts` (failure helper).
