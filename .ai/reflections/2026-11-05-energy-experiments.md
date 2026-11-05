# 2026-11-05 — energy experiments and MCP-authored journeys (component diagnosis, PR 4 of 4)

**Task:** Measure whether a change reduces client energy, as a difference between two
scenarios only; author journeys with Playwright MCP without putting a model in the loop.

**Changed:** `src/experiments/{variants,experiment,from-queue,journey-lint}.ts` (new),
`src/report/{experiment-html,experiment-csv}.ts` (new), `src/core/runner.ts` (setup and
teardown now run), `src/cli/{index,args}.ts`, `src/analysis/{investigation,remediation}.ts`,
examples, the components e2e, docs.

**Evidence:** every variant exercised in Chromium against a fixture (route rewriting,
reduced motion, blocking, probes); `npm test`; the Firefox experiment is in CI.

**Worked:** making the baseline go through the same interception, so the measured
difference cannot be the interception.

**Cost time:** finding that journey `setup()` had never been called: documented in the
README, used by the Drupal example, silently skipped.

**Next:** run an experiment from a real queue item on an energy-measuring machine.
