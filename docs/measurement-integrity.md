# Measurement integrity: Phase 0 audit

Recorded 16 November 2026 (America/Toronto) while starting the site-wide
performance investigation. This records what was checked, with actual results,
not agent-reported success. It is an audit of the starting point, not a claim
that any new energy measurement has been made.

## Repository and branch

| Item | Value |
| --- | --- |
| Repository | `mgifford/firefox-energy-scanner` |
| Branch | `claude/energy-profiling-isolation-l9wx5h` |
| HEAD at the audit | `25ca6d5` (`Keep the idle window's mean beside the median in the result`) |
| `main` | `d1aa05e` (`Merge pull request #50 from mgifford/scan-results`) |
| Position | 13 commits ahead of `main`, 0 behind |
| Working tree | clean (no uncommitted work to preserve) |
| Open pull requests | none (`gh pr list --state open` returned `[]`) |

The branch was not merged, rebased or force-pushed. The Phase 0 changes are
additive commits on top of `25ca6d5`.

## What was run

| Check | Result |
| --- | --- |
| `npm ci` | 156 packages installed, 0 vulnerabilities |
| `npm run build` | pass |
| `npm test` (typecheck + Vitest) | 816 passed, 19 skipped; 49 of 50 test files passed |
| `WEB_ENERGY_TEST_ENGINE=chromium npm test` | **849 passed**, 53 test files; browser tests run in Chromium for structure only |
| Firefox browser tests (3 suites in `tests/browser/dom-removal.test.ts`) | **failed to start**: `beforeAll` timed out while launching Playwright Firefox |
| `WEB_ENERGY_TEST_ENGINE=chromium FIXTURE_PORT=18086 node tests/e2e/remove-e2e.mjs` | **all checks passed**; the same suite on 8086 exits 2 with the new clear `EADDRINUSE` message and does not kill the listener |
| One headless Firefox `experiment` against the running fixture | did not complete: Playwright Firefox could not start under the agent sandbox |

The browser failure is environmental, not a product assertion failure. Firefox
prints `sandbox initialization failed: Operation not permitted` when launched
from this agent session; its own sandbox cannot initialise inside the harness
sandbox. The same suite must be run from the maintainer's terminal or CI, where
Firefox can launch. The 19 skipped tests are the browser cases; no unit test
was skipped to hide a failure.

## Fixture ports

`tests/fixtures/site/server.mjs` now:

- reports an occupied port as an error naming the port and the `lsof` command,
  instead of crashing with an unhandled `error` event;
- supports `port: 0` and returns the OS-assigned port in `site.port`;
- never stops or takes over an existing listener.

The three CLI e2e scripts read `FIXTURE_PORT` (defaults 8086, 8082, 8084) and
print the clear action before exiting 2. `tests/fixture-server.test.ts` starts a
server on an ephemeral port, asks for the same port again, and checks both the
error and that the first server still answers.

## Stored energy results

Two M2 results are the historical evidence for the chart work:

| File | SHA-256 |
| --- | --- |
| `results/compare-2026-11-16T22-09-09-684Z.json` (post-load removal) | `7d033e43d7ac8466cef896d84f9ef277e6ee7e0415766918db7fc7865c592645` |
| `results/compare-2026-11-16T22-25-00-360Z.json` (pre-load removal) | `017b996d2ecc3a46f65ff0700dfbfd5bca1b3ec4b9e6bd13fd23d9a8ecf09835` |

Both were recorded before `b6f5132`, so their per-run baseline is the idle
window's **mean**, not the median: 93.0 / 92.6 mW and 91.7 / 90.4 mW. Their
incremental energy is therefore not comparable with a run made after the median
change, and it cannot be recomputed from the stored files, which hold the
baseline's power and not its bins. `finding` re-reads the verdict and basis
without `--write`; the scenarios are not changed by interpretation.

The two result files are local, ignored scratch output (`/results/`). An earlier
interpretation pass used `finding --write` on them, which replaced the derived
`finding` field and regenerated the HTML/CSV; it did not change the per-run
scenarios. From this audit on, stored measurements are re-read **without**
`--write`, and any generated interpretation goes to a separate file.

## Claims

- Both stored experiments are **one session on one machine**. Their statistical
  verdict is a within-session claim; `replication.status` is
  `not-replicated`. Neither is independent evidence of a production saving.
- The post-load idle difference was within the run-to-run spread; the pre-load
  idle difference was lower on window energy but had no negative control. The
  finding now reports `indicative` for the latter.
- Missing energy is never zero. The stored post-load load step is
  `below-resolution`; the pre-load incremental basis could not be read because
  the mean baseline exceeded the step's draw.
- CO2.js figures in the results are modelled transfer emissions, not measured
  browser energy, and are not combined with it.

## Controls

- `tests/experiments.test.ts` adds an A/A check: identical run distributions
  (rotated, 20 ways) never report `lower` or `higher`.
- `tests/evidence-record.test.ts` adds a moved-negative-control check: a control
  that moves makes the finding `indicative` and says so.
- `tests/evidence-record.test.ts` requires a finding to carry
  `replication.status: not-replicated` (or `not-assessed` when there is nothing
  to replicate), and the Markdown/HTML say so.

## Phase 1: attribution

The graph now carries optional `relations` (see [component-graph.md](component-graph.md)) and
each instance carries the `domIds` of elements inside it. A diagnostic run reads the loaded
scripts' sources after the measured windows (same-origin, first 24, 256 KB each, 2 s per
fetch) and stores `scriptReferences`. The graph then records:

- `resource-used-on-page` and `declares-resource` for scripts that were inspected;
- `suspected-association` when a script's source names an id inside a component but the
  script was not on the stack in this result;
- `script-observed-with-component` when that static reference and a same-run Firefox stack
  hit both hold. The edge is a relationship, not ownership.

On the fixture, a Chromium `diagnose` of `/articles/d` recorded
`{ kind: "id", value: "chart" }` for `/js/chart.js`, kept `/js/chart.js` as a page resource
and a `declares-resource` edge from `landmark:main`, and added a **low-confidence
`suspected-association`** to `component:live-chart`. It did not add an observed edge, because
Chromium does not produce the Firefox power profile. The synthetic same-run stack test adds
the `script-observed-with-component` edge at medium confidence; the Firefox `diagnose` run
that produces the real one is **pending Firefox**.

The Chromium run also exposed and fixed a graph defect: for a load+idle run, the graph took
the idle step's (empty) network instead of the load step's, so every page resource was lost.
The graph now uses the same scenario's load network for the page.

Tests: `tests/script-references.test.ts` (static scanner: references, dynamic-selector
misses, bounds), `tests/relations.test.ts` (chart edge, unrelated script, shared script,
container ambiguity, cross-origin/inline exclusion, stable ids), and the new
`tests/browser/dom-removal.test.ts` case, which passes in Chromium.

## Still pending

- Firefox browser tests and CLI e2e (including the real same-run stack edge) on a
  host where Playwright Firefox can launch (maintainer terminal or CI).
- The quiet-device median-baseline re-run of the two chart experiments, with
  null/A-A and negative controls.
- Real-site candidate import, selective diagnostics and the later phases. None
  of those is started here.
