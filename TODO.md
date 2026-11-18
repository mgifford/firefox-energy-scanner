# TODO

Working list, newest first. Evidence rules and boundaries stay in the docs;
this file is the queue, not a second claims register.

## P0 — Real measurements

- [ ] Re-run the post-load chart removal on power with Low Power Mode off.
  The first real run used the median baseline (0.933/0.932 mW vs ~102 mW mean)
  but ran under LPM on battery; its idle difference was within spread.
- [ ] Retry the pre-load chart removal. The first attempt stopped at Run 3/20
  on a 180 s Firefox launch timeout; no result was written.
- [ ] Add a supported null/A-A experiment kind. There is no A/A command yet;
  do not compare two unrelated sessions and call it a control.
- [ ] One independent replication of any promising result. All results are
  currently one session and `not-replicated`.

See the P0 evidence PR: https://github.com/mgifford/firefox-energy-scanner/pull/55

## P1 — One real public-site pilot

Goal: one bounded, real, multi-family public site exercises the full path:
crawl → families → patterns → investigation → one diagnostic → one controlled
experiment, with every step traceable and every null result kept.

- [x] Add a bounded pilot plan/runner:
  `node scripts/public-site-pilot.mjs --url <https://…> --max-pages 20 --confirm-public`.
  It validates a public HTTPS URL, uses Chromium with `--no-energy`, respects
  robots.txt, caps pages/depth, runs Lighthouse and traces, then `patterns` and
  `investigate`. It never runs an experiment.
- [x] Choose and record one public site: `https://www.thegreenwebfoundation.org/`.
- [x] Run the 20-page structural pilot: 4 families, 9 patterns, 3 traces.
  Lighthouse failed on all 10 URLs (`Connection closed.`), so no Lighthouse
  evidence is used. See [docs/pilot-tgwf-2026-11-18.md](docs/pilot-tgwf-2026-11-18.md).
- [x] Review four page families, the recurring patterns and the queue; record
  the broad 17-page family and the resource/component distinction in the note.
- [ ] Pick one representative page and run one Firefox `diagnose` on the quiet
  Mac. Recommended: `/news/`.
- [ ] Pick one component **or resource** lead and run one controlled experiment
  on the quiet Mac. Recommended primary: block the shared smush script on
  `/news/`; component alternative: pause `div.posts-wrapper` animation.
- [ ] Write the post-experiment result: applied/held, checks, medians/spreads,
  confidence, replication, nulls and the next production-like change.

Protocol and commands: [docs/public-site-pilot.md](docs/public-site-pilot.md).

## P1 — A real Open Scans artifact

- [x] Use issue #391's latest real artifact (5,486 observations, 20 pages) and
  crawl the same 20 URLs with FES.
- [x] Join all 5,486: 100% page-level matches, 8 exact-CSS occurrences (4
  unique), 0 unmatched pages, 362 HTML-only and 1 reflowRisk left visible.
- [x] Fix the null `container.element` validator bug; allow nullable container
  fields and preserve explicit Open Scans component ids without using them.
- [x] Add a trimmed real-artifact fixture/regression and a per-page summary to
  the HTML section.
- [ ] Broaden component matching: a published `selectorType` plus DOM-validated
  ancestor/descendant matching, or an explicit shared component id. Exact CSS
  alone is 0.15% of the real artifact.
- [ ] Repeat with an artifact from a site that has both a FES energy result and
  an Open Scans scan of the same run/viewport; this join is page-level only.

See [docs/real-open-scans-artifact.md](docs/real-open-scans-artifact.md).

## Evaluation tools to assess for the pilot

These are **external evaluation aids**, not FES evidence. Do not merge their
numbers into FES energy, do not add a combined score, and do not add any of them
to the ordinary FES runtime or CI measurement path.

### GreenFrame

- https://greenframe.io/
- https://github.com/marmelab/greenframe-cli

Scenario-based energy/carbon estimation. Evaluate for: defining a repeatable
scenario, whether the CLI can run locally, licence, data provenance and whether
its estimate agrees or disagrees with FES. Treat its result as a separate
estimate; it is not the Firefox hardware measurement. No account secrets in the
repository.

### Sitespeed.io and CO2.js

- https://www.thegreenwebfoundation.org/news/sitespeed-io-using-and-contributing-to-co2-js/

Sitespeed performance metrics plus transfer-based CO2 estimation via CO2.js.
Evaluate for: transfer/request cross-check, grid-intensity assumptions, version
and configuration capture. CO2.js is an estimate from bytes, not measured
energy; keep it in its own column and never call it FES energy.

### Vercel agent-browser

- https://github.com/vercel-labs/agent-browser

Agentic browser exploration. Evaluate for: authoring a journey or finding
representative pages/selectors before a human-reviewed run. It is not a
measurement tool: no model or agent may drive a measurement run, no Playwright
MCP in the ordinary runtime, and a human reviews every selector and interaction.
Do not click, scroll or type during a Firefox energy run.

## P2 — Queue and report

- [ ] Bounded candidate queue: budget, page limit, allowlist, dedup, idempotent
  re-import, rejection reasons and provenance; no automatic physical-energy job.
- [ ] Site → family → component → script → evidence navigation, with reverse
  links and each metric's source, window, unit and boundary.
- [ ] Manual `workflow_dispatch` path that cannot crawl or trigger the physical
  runner; physical runner isolated from untrusted PR workflows.

## Upstream

- [ ] Vital Core: machine-readable `experiment` field per candidate.
- [x] FES support for Open Scans' additive `selectorType`
  (`css`/`xpath`/`html`) and `scan.reportUrl`: published values win over engine
  inference and the source is labelled; `reportUrl` is preferred for links.
- [ ] Verify the additive fields on a real Open Scans artifact once published;
  the current #391 artifact predates them.
- [ ] Open Scans: an explicit component id if one is intended for cross-graph
  mapping.

## Not doing

- Per-element or per-script energy.
- A combined accessibility/performance/energy score.
- Automatic Open Scans scans or live API calls in FES.
- Model calls or Playwright MCP in ordinary scans.
