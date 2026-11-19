# Session log: 18–19 November 2026

A closeout record of the work completed, what the evidence actually shows, and
what remains open. It is a log, not a new claims register.

## Merged work

| PR | What it did |
| --- | --- |
| #51 | Isolation/attribution foundation and median idle baseline |
| #52 | Single-candidate Vital Core handoff |
| #53 | Site patterns grouped by component type/resource |
| #54 | Optional Open Scans accessibility context join |
| #55 | P0 hardware evidence and usable-measurement wording |
| #56 | Bounded public-site pilot and the TGWf structural run |
| #57 | Real #391 accessibility artifact joined to FES |
| #58 | Bounded candidate queue with policy/provenance |
| #59 | Published `selectorType`/`reportUrl` support |
| #60 | Report site map and run/viewport labels |
| #61 | Dispatch-only physical experiment workflow |
| #62 | Opt-in DOM-validated accessibility ancestors |
| #63 | Same-viewport gate for DOM matching |
| #64 | Honest ancestor-report wording |
| #65 | Real Medicaid.gov Vital candidate spec |

## Evidence worth keeping

### Baseline

The 18 November post-load run used the median-of-bins baseline on hardware:
**0.933 / 0.932 mW**, against window means of **101.6 / 102.6 mW**. The
median rule is doing what it was meant to do. The run itself was under Low
Power Mode on battery, so it is not the clean final A/B.

### Real stack edge

The Firefox `diagnose` on the fixture confirmed `chart.js` →
`component:live-chart`, `profiler-correlation`, medium confidence, `supported`,
with 21 stack samples in the 11.49 s idle interval. The real same-run stack
edge is no longer pending.

### TGWf structural pilot

20 pages, 4 families, 9 patterns, 3 Chromium traces:

- shared `smush-lazy-load.min.js` on 20/20 pages: timer 2.4/s idle, long task,
  forced layout, **no component loads it**;
- `class:posts-wrapper` animation on `/news/`;
- 17-page dominant family spanning 13 URL patterns;
- Lighthouse failed on all 10 selected URLs (`Connection closed.`).

The block experiment stopped at run 2 on a 30 s page-load timeout. The
pause-animations intervention found no `div.posts-wrapper`, failed `role=main`
on both sides, and saw outside scroll events. **Neither produced usable energy
evidence.** Do not report them as a saving or a null energy result.

### Real Open Scans artifact

#391: 5,486 observations, 20 pages, axe/AccessLint/Semantica11y/reflowRisk.
All 5,486 matched a page; 8 exact CSS component matches; 5,478 page-level.
The artifact exposed null `container.element`, now accepted and regression
tested. The opt-in DOM pass with `--dom-allow-different-viewport` associated
4,838 observations, but the source was 1024×768 against FES 1440×900: all low
confidence, mostly structural wrappers. The default same-viewport gate leaves
this artifact at the 8 exact matches. That is the honest state.

## Lessons

1. **Real artifacts are the schema test.** The 6.4 MB #391 file found a null
   container field that synthetic fixtures missed.
2. **Page-level matching is reliable; component attribution is not.** The real
   artifact reached 100% page matching and 0.15% exact component matching.
3. **“Nearest component ancestor” is not automatically useful.** Generic
   wrappers (`class:relative`, `class:not-prose`) absorb observations. The
   owned-node filter and the same-viewport gate are necessary, not polish.
4. **Viewport and run are part of the evidence.** A cross-viewport ancestor is
   an association, not a component mapping. Keep the label visible.
5. **A public site is not a stable experiment.** TGWf block/pause runs failed
   for page/timing/selector reasons; use the local fixture for controlled
   energy experiments and the public site for discovery.
6. **Never merge accessibility, performance, carbon and energy into a score.**
   The reports and queue keep their own sources, units and boundaries.
7. **CI browser tests can flake.** The test job timed out in Chromium twice and
   passed on rerun; do not weaken the assertions to hide it.
8. **Do not open an upstream issue without a clean reproduction.** The TGWf
   findings are trace observations on the website’s plugin/theme, not CO2.js
   and not a measured effect.

## Still open

- P0: clean post-load and pre-load removal runs with Low Power Mode off/on
  power; null/A-A; independent replication.
- A same-viewport Open Scans artifact at 1440×900 (with `selectorType` and
  `reportUrl` when available), then FES DOM validation.
- Energy pairing across a real energy result and same-viewport accessibility
  artifact.
- GitHub settings: `physical-energy` environment with reviewers and a runner
  carrying the `firefox-energy` label. The repository currently shows only
  `github-pages` and no such runner.
- TGWf/WordPress/theme upstream note after a clean diagnose/experiment; not
  CO2.js.
- Optional evaluation aids (GreenFrame, Sitespeed/CO2.js, agent-browser) remain
  separate evaluation work in TODO.

## Current honest statement

FES can discover, attribute, queue and report evidence, and it now refuses to
present cross-viewport ancestor guesses as confident component mappings. The
decisive clean energy effect and the same-viewport broad mapping are still
measurements to be made, not code to be added.
