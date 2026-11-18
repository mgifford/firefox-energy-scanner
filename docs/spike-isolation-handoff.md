# Handoff: energy spikes and component isolation

State as of commit `b6f5132` on branch `claude/energy-profiling-isolation-l9wx5h`
(9 commits ahead of `main`; no pull request opened). Read this first, then
[spike-isolation-audit.md](spike-isolation-audit.md) (gap analysis, phase status,
hardware runs) and TDR-021 to TDR-024 in [decision-record.md](decision-record.md).

## What is built (all phases of the brief)

| Area | Files | Commands |
| --- | --- | --- |
| Post-load DOM removal (`--kind remove`): refusal checks, nested matches, verification, re-insertion watch, script-activity counts, removed-content inventory, load step as negative control | `src/experiments/dom-removal.ts`, `variants.ts`, `experiment.ts` | `experiment <url> --kind remove --selector <css>` |
| Pre-load removal (`--kind remove-before-load`) with the browser's own parser, symmetric snapshot | `src/experiments/preload-removal.ts` | `--kind remove-before-load` |
| Energy timeline (bins, phases, resolution, gaps) | `src/energy/timeline.ts` | `diagnose`, `--timeline`, `timeline <profile.json>` |
| Interval ("spike") detection, robust threshold, recorded settings | `src/energy/spikes.ts` | `--spike-*` flags |
| Same-run Gecko evidence: markers by process, covered time, script frames, CPU categories | `src/energy/gecko-evidence.ts` | `timeline --describe` |
| Per-process energy (Apple Silicon), process roles | `src/energy/gecko-profile.ts` | |
| Leads: interval → scripts → component graph, evidence classes, unattributed list | `src/energy/spike-analysis.ts` | |
| Report: timeline chart + tables, interval details, component explorer, finding section | `src/report/timeline-html.ts`, `experiment-html.ts` | `report <json> [--with <exp.json>]` |
| Evidence record + Markdown issue draft, four separate parts | `src/report/evidence-record.ts` | `finding <exp.json> [--evidence <diag.json>] [--write]` |
| JSON Schemas (timeline, finding) | `src/model/records-schema.ts`, `schema/*.json` | `npm run schema` |
| Outside-interference detection (navigation away, trusted input), reachability preflight | `src/collect/interference.ts` | |
| Idle baseline = median of its window's bins; window-energy cross-check and basis per step | `src/core/baseline.ts`, `experiment.ts` (`summarizeExperiment`, `refreshDifferences`) | |

Docs: `docs/energy-spikes.md`, `docs/experiments.md`, `docs/evidence-records.md`,
`docs/limitations.md`, README.

## Tests

- `npm test`: 831 passing (50 files), including browser tests in `tests/browser/`
  (Firefox if installed, else Chromium via `findChromium`, else skipped).
- E2E: `tests/e2e/remove-e2e.mjs` (removal, pre-load, refusals, re-insertion,
  self-navigating page, unreachable site), plus the existing fixture, trace and crawl
  e2e scripts. In CI (`.github/workflows/test.yml`, e2e job) they run in Firefox.
  **CI results for this branch have not been checked.**
- Where Playwright's Firefox cannot be downloaded (the cloud container this was built
  in), `WEB_ENERGY_TEST_ENGINE=chromium` runs CLI e2e in Chromium, structure only (no
  energy, no `--public-only`; every result says so). The fixture e2e needs
  `127.0.0.1 site.test www.site.test thirdparty.test looks-public.example.com` in
  `/etc/hosts`.

## Hardware runs so far (Apple M2, Firefox 153, the maintainer's Mac)

1. `doctor`: per-process energy works (417 samples in 1.5 s).
2. `diagnose` on example.org, then `/articles/d` of the fixture site: exposed and fixed
   summed marker durations, Firefox's own work mixed with the page's, warm-up intervals
   unlabelled, label frames read as scripts, and a headed window being clicked and
   scrolled during runs (now detected).
3. Experiments on `/articles/d`, live chart, 10 runs a side, `remove` and
   `remove-before-load`: both applied and held; animation frames went on at 60/s after
   the post-load removal and fell to 0 after the pre-load one. **Energy unreadable**:
   every idle step's incremental energy was negative (about −0.24 mWh) because the mean
   idle baseline (about 100 mW, Firefox start-up work) far exceeded its median (about
   1 mW). Fixed in `b6f5132` (TDR-024). The 18 November 2026 post-load run used the
   median baseline on hardware: 0.933/0.932 mW versus a ~102 mW mean. That run was
   under Low Power Mode on battery, so a clean re-run is still pending. See
   [p0-hardware-runs.md](p0-hardware-runs.md).

## Next steps, in order

1. **Re-read the two stored M2 results** with the new rules (no re-run), on the Mac:

   ```zsh
   cd ~/firefox-energy-scanner && git pull && npm run build
   node dist/cli/index.js finding results/compare-2026-11-16T22-09-09-684Z.json --write | sed -n '/## 3/,/## 4/p'
   node dist/cli/index.js finding results/compare-2026-11-16T22-25-00-360Z.json --write | sed -n '/## 3/,/## 4/p'
   ```

   These runs were recorded before `b6f5132`, so they hold the old **mean** baseline
   (about 93 mW) and their incremental energy cannot be recomputed: the stored runs carry
   the baseline's power, not its bins. Expect that figure to be labelled `mean`, and a
   window-energy verdict for idle. Both showed the variant about 0.025 mWh lower on window
   energy; whether that exceeds the spread is the open question. Only the re-run in step 2
   records the median.
2. **Re-run both experiments** with the median baseline (fixture site running in a second
   terminal, Mac untouched, about 16 minutes each), and check incremental energy now
   resolves on its own:

   ```zsh
   node dist/cli/index.js experiment http://127.0.0.1:8086/articles/d --kind remove --selector '[data-component-id="live-chart"]' --idle 10000 --runs 10 --warmups 2 --assert-role main --seed m2-chart
   node dist/cli/index.js experiment http://127.0.0.1:8086/articles/d --kind remove-before-load --selector '[data-component-id="live-chart"]' --idle 10000 --runs 10 --warmups 2 --assert-role main --seed m2-chart-pre
   ```

   Start the fixture site with:
   `cd ~/firefox-energy-scanner && node -e "import('./tests/fixtures/site/server.mjs').then(m => m.startFixtureSite({ port: 8086 }))"`
3. Remaining hardware checks in `spike-isolation-audit.md`: `/lab/ticker` against
   `/lab/polite`, `remove-before-load` on `/lab/static`, a null experiment (identical
   sides should read "no difference shown"), and `diagnose` timelines summing to step
   totals.
4. **Consider**: the idle baseline window starts 5 s after launch (`baseline_settle_ms`)
   while Firefox is still busy; a longer settle, or measuring until the parent process is
   quiet, would also help `measure`/`crawl`. Firefox background requests (for example
   `aus5.mozilla.org` system add-on updates) could be switched off with Firefox prefs, but
   that changes the measured browser, so decide deliberately.
5. Check CI on the branch, then open a pull request if the maintainer asks.

## Deferred on purpose

Removal inside custom journeys (refused with an explanation); selectors in shadow DOM or
other frames; drawing more than the first run per side in experiment reports; automatic
discovery of previous experiments (it is `report --with`).

## Rules from the brief to keep

Never claim per-element energy; a timeline interval is where to look, a lead is what to
test, only an experiment measures a difference. Never read a missing measurement as zero,
or a failed intervention as "no saving". Keep diagnostic profiling (stack sampling) apart
from benchmarks. Chromium traces corroborate by page and phase, never by time. No WSG
guideline numbers asserted. AGPL-3.0-or-later. Do not touch `vital-core`, scheduled scans,
or the webNRG integration.

## Gotchas met

- zsh: lines starting with `#` run as commands (no `interactivecomments`), and an
  unmatched glob aborts the line. Give zsh users comment-free, one-line commands.
- Experiment spec files' `runs`/`warmups` override `--runs`/`--warmups`.
- Leave the fixture site running for the whole session; `^C` stops it.
- Headed Firefox windows take focus; do not use the Mac during runs, or use `--headless`
  (compare headless only with headless).
- Experiment result files are named `compare-…` (the session mode).
