# Energy spikes and component isolation: audit, plan and status

The brief (an implementation specification with three prototypes: a DOM-removal function,
a script binning a saved profile, and a proposed experiment spec) asked for a way to go
from "this page costs energy" to "this component's work is worth changing, and here is the
evidence". This records what already existed, what was built, and what still needs physical
hardware. Decisions are in [decision-record.md](decision-record.md), TDR-021 to TDR-023.

## Phase 0: what already existed, and was reused

| Capability | Where | Used for |
| --- | --- | --- |
| Interleaved, seeded A/B runs, a fresh browser per run, warm-ups per side | `src/experiments/experiment.ts`, `src/core/stats.ts` | every new experiment kind |
| Variants installed in setup, symmetric interception, a probe after the workload, `applied` gating | `src/experiments/variants.ts` | `remove`, `remove-before-load` |
| Verdicts: not measured, below resolution, within spread, lower, higher; indicative under 10 runs | `summarizeExperiment` | unchanged, plus step roles |
| Semantic assertions and accessibility structure on both sides | `checkAssertions`, `probeVariant` | extended (controls, form controls, live regions) |
| Gecko power counters per process, scope selection, window integration | `src/energy/gecko-profile.ts` | the timeline's samples |
| CPU-time categories from a profile | `src/energy/attribution.ts` | per-interval categories |
| Diagnostic profiling with stack sampling, kept apart from benchmarks | `diagnose`, `profile` | `diagnose` rebuilt on the shared runner |
| Chromium traces: load and idle phases, rAF, timers, long tasks, animations, iframes | `src/trace/` | cross-run leads |
| Component graph: stable ids, owned counts, resources, evidence classes, schema | `src/model/graph.ts` | leads to components |
| Investigation queue and experiment specs from it | `src/analysis/investigation.ts`, `from-queue.ts` | `--from … --kind remove` |
| Static accessible HTML, JSON, CSV; validation before writing | `src/report/`, `writeOutputs` | new sections and files |

## Gaps found, and what was built

| Gap | Built |
| --- | --- |
| `hide` was the only way to take a component out, and it keeps the markup and scripts | `remove` (post-load detach) and `remove-before-load` (browser-parser rewrite), with refusal checks, nested matches, verification, re-insertion detection, script-activity counts, removed-content inventory, like-for-like |
| Energy was only a total per step | the energy timeline (`src/energy/timeline.ts`): bins, phases, resolution, gaps, validity |
| No way to find when power was high | interval detection (`src/energy/spikes.ts`), robust threshold, recorded settings |
| Profile markers and stacks were not read against time | same-run Gecko evidence per interval (`src/energy/gecko-evidence.ts`) |
| No path from a time to a component | leads with evidence classes (`src/energy/spike-analysis.ts`) |
| No view of any of it | the report's Energy timeline section and component explorer (`src/report/timeline-html.ts`) |
| No exportable finding | the evidence record and issue draft (`src/report/evidence-record.ts`), schemas in `schema/` |
| The protocol was partly implicit | `experiment.protocol`, per-step sample counts, comparability checks |

Prototypes from the brief: the DOM-removal function became `checkpointInPage`, with
re-insertion watching, content inventory and an atomic refusal; the profile-binning script
became `web-energy timeline`, without its fixed 0.1 W floor and with measured resolution;
the proposed spec (`kind: detach-after-load`) is now accepted as `kind: remove`
(`examples/experiments/hero-carousel-remove.yaml`).

## Phase status

| Phase | Status |
| --- | --- |
| 1. Post-load removal | done; tested in the browser (Chromium here, Firefox in CI) and through the CLI |
| 1. Pre-load removal | done; tested in the browser and through the CLI |
| 2. Timeline and intervals | done; tested with synthetic profiles of known energy |
| 2. Correlation with browser activity | done for same-run Gecko markers, stacks and categories, and cross-run Chromium traces; tested with synthetic profiles and the fixture site's real traces |
| 3. Leads to the component graph | done; tested on the fixture site's recorded graph |
| 4. Report views | done: timeline, tables, interval details, explorer with screenshot, experiment commands, finding |
| 5. Methodology | protocol recorded; comparability and negative control checked; diagnostic and benchmark runs kept apart |
| 6. Evidence records | done, with JSON Schemas and an issue draft |
| 7. Tests and docs | unit, browser and end-to-end tests; docs listed below |

Deferred, deliberately:

- **Removal inside a custom journey.** It needs a defined checkpoint in the journey; refused
  with an explanation for now.
- **Shadow DOM and other frames.** Selectors match the top document only, and say so.
- **Per-run timelines in experiment reports.** `--timeline` records every run; the report
  draws the first run of each side, and the CSVs hold the rest.
- **Previous experiments** are linked by hand (`report --with`), not discovered.

## What was validated, and what still needs physical hardware

Validated without energy hardware (no figures were made up to get here):

- every pure function: binning, resolution, gaps, phases, interval detection, evidence
  reading, linking, records and schemas (synthetic profiles of stated energy);
- the in-page removal code in a real browser, against the fixture site's pages: removal,
  baseline identity, nested matches, every refusal, re-insertion, timers that carry on,
  timers that stop, an animation-frame loop, a CSS animation, an iframe, and controls taken
  away; the pre-load round trip, redirects, files, and components a script recreates;
- the CLI end to end: removal experiments (applied, put back, refused, not like-for-like,
  pre-load) and `diagnose`, with every energy figure reading "not measured";
- the report: rendered and inspected in light and dark modes.

Where this was built, Playwright's Firefox could not be downloaded, so the browser tests
ran in Chromium (`WEB_ENERGY_TEST_ENGINE=chromium`, a test-only seam that refuses energy
and marks every result). CI runs them in Firefox.

### First run on hardware (Apple M2, Firefox 153, 16 November 2026)

`doctor` confirmed per-process energy (417 power samples in 1.5 s). `diagnose` on
example.org produced a timeline (163 bins of 250 ms, a 4 mW idle-baseline reference) and
three intervals. It also showed four defects, now fixed:

- marker durations were summed across overlapping markers and threads (436 s of "script"
  in a 1.25 s interval): now the covered time;
- Firefox's own work (remote settings, its modules, a system add-on update check to
  `aus5.mozilla.org`) was reported as if it were the page's: markers and scripts now carry
  their process, requests that are not the page's are listed apart, and each interval
  gives its energy by process;
- the warm-up run's load ranked first, unlabelled: warm-up intervals are now labelled and
  ranked after the measured run's;
- the page's inline script, and a `[10]` suffix on a script location, were not
  recognised.

The suggested experiment then failed on a placeholder `--evidence` path (and its selector
does not exist on example.org). `--evidence` is now read before anything runs, a refused
removal ends the run at its first checkpoint, and `diagnose` prints a runnable command with
its real result file.

### Second run on hardware (the same M2, the fixture site)

`timeline --describe` on the saved example.org profile confirmed how processes are read:
the root as the parent process (`Parent Process`, `default`), `Web Content` (`tab`) as
the page, `WebExtensions` (also `tab`) as other. It also showed the real script-location
formats (`fn (url:line:col)[source id]`). `diagnose` on `/articles/d` measured energy by
process: the parent process drew 75–80% of each interval's energy (no GPU process, so it
composites the page's frames).

It also showed three more defects, now fixed:

- something clicked links in the headed Firefox window during the run, and the page
  visited `/compute`, `/table`, `/big-list`, `/embed` and `/`; the intervals and the
  captured structure were of those pages. Navigation away and outside input are now
  detected: `diagnose` says so and draws nothing from them, and experiments do not use
  such runs;
- label frames that name a URL (document loads) were read as scripts;
- an interval covering the whole idle window was described like a spike; it is now
  flagged `whole-phase`, continuous work.

The fixture site was stopped while the experiments ran (`ECONNREFUSED`): both commands
now check the address before the first run.

### First experiments on hardware (the same M2, `/articles/d`, 10 runs a side)

Both removal experiments applied and held in every run, and the checks passed on both
sides. The script-activity counts showed the central claim directly: after a **post-load**
removal of the live chart, animation-frame callbacks went on at 60 a second (its loop kept
drawing into a detached canvas); after a **pre-load** removal they fell to 0.

The energy could not be read: every idle step's incremental energy was negative (about
−0.24 mWh), because the idle baseline's mean was inflated by Firefox's own start-up work
(TDR-024). Both experiments showed the variant's idle about 0.025 mWh lower, but as stored
they read "below resolution" and "no difference shown". Now fixed: the baseline is the
median of its window, and steps carry window energy as a cross-check. `web-energy finding
<result.json> --write` re-reads the stored runs' verdicts and basis, but not their
baseline: these runs were measured with the mean and keep it, labelled `mean`. Only a
re-run records the median.

Also fixed from this run: removal summaries counted warm-ups as variant runs; scrolling
in a warm-up stopped leads from the measured run; and a load shorter than a bin was
labelled as time between steps.

Still to do on a physical machine that measures energy (an Apple Silicon Mac is simplest):

1. `npm run energy-check`, to confirm the machine measures energy.
2. `web-energy diagnose` on the fixture site's `/articles/d` and `/lab/ticker`, and on a
   real page: check the timeline's bins add up to the step totals, the resolution the
   counters report, that intervals fall in the idle window where the loops run, and that
   the profile's processes are read correctly (`web-energy timeline <profile> --describe`;
   process names and types were checked against synthetic data, not yet a real profile).
3. `web-energy experiment … --kind remove` on `/lab/ticker` and `/lab/polite`, 10 runs or
   more: whether the idle difference resolves, and whether it is smaller for the ticker,
   whose timer keeps running, than for the polite ticker, whose timer stops.
4. The same with `remove-before-load` on `/lab/static`, for a load-time difference.
5. A null experiment (two identical sides) to confirm it reads "no difference shown".

Record the machine, Firefox version, power state and the results with each run.
