# 2026-10-26 — Grid-derived carbon from observed energy

**Task:** Add an opt-in third indicator: carbon implied by measured client energy at a
declared grid intensity, leaving CO2.js unconvertible.

**Changed:** `src/core/carbon.ts`, generated `src/core/grid-zones.ts` (213 countries),
`--grid-*` flags, HTML/CSV/index columns, the docs, `tests/carbon.test.ts`.

**Evidence:** `npm test` → 429 passed across 25 files after rebasing onto `main`;
`npm run build` clean. Real run `measure-2026-10-26T08-02-06-600Z.json`: incremental
−0.042 mWh against IQR 0.023, so unresolved and the column prints `—`, while CSV keeps
−6.638 µg. Same run: CO2.js 18.748 mg versus ~25 µg from gross energy at 400 g/kWh,
~750× apart. `--grid-zone ZZ-top` exits before Firefox launches.

**Worked:** gating the derived column on `resolution()` instead of clamping; one
multiplication once the unit factors cancel.

**Cost time:** deciding the data-file format late; JSON imports do not work here.

**Next:** measure a CPU-heavy page with `--grid-zone CA` and confirm the column resolves.
