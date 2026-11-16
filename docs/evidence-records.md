# Evidence records: findings for development issues

Every experiment writes an **evidence record**: what was observed, why the component was
tested, what the controlled comparison showed, and what to investigate next, with
everything needed to repeat it. It is written three ways:

- `result.finding` in the experiment's JSON, schema
  [`energy-finding/1`](../schema/energy-finding.schema.json), for import into other tools;
- `<result>.finding.md` beside the result’s JSON (`compare-….finding.md`), a Markdown issue draft, plain text only;
- a **Finding** section at the top of the HTML report.

## Four parts, never merged

| Part | What it holds | What it never holds |
| --- | --- | --- |
| **1. Observed activity** | What was measured or seen: the interval from a `diagnose` run (with `--evidence`), the same run's browser activity, what the removal found, whether script work carried on | a cause |
| **2. Suspected cause** | Why the component was tested: its evidence classes, or the investigation queue item | proof |
| **3. Experimentally supported outcome** | What the interleaved comparison showed, step by step, with a status and a confidence | a figure for the component's own energy |
| **4. Recommended production change** | What to investigate next: optimise, defer, redesign, replace, or remove | "remove it" on this evidence alone |

### Outcome status

| Status | When |
| --- | --- |
| `reduction-shown` | an attributable step was lower with the change, beyond both sides' spread, and the change kept what people use |
| `reduction-not-like-for-like` | lower, but the change broke a check or took away headings, landmarks, controls or live regions |
| `increase-shown` | higher with the change |
| `no-difference-shown` | within the run-to-run spread. Not proof of no effect |
| `below-resolution` | a side is below what this setup resolves |
| `not-measured` | no energy on this machine. Time and transfer are still there |
| `intervention-failed` | the change did not take effect or did not hold (refused, or the page put the component back). **Never read as "no saving"** |

**Confidence** is `confirmatory` only with at least 10 runs per side, a negative control
that did not move, equal valid runs on both sides, and (for removals) the same page state
at every checkpoint. Otherwise it is `indicative`, and the statement says why, or `none`.
An experiment with no negative-control step (a pre-load removal, for example) cannot show
that the sides were alike before the change, so it is `indicative` too.

A negative-control step (the load step of a post-load removal) is reported, but it never
counts as a saving.

### Recommendations

A reduction is a reason to look for a production change that keeps what the component is
for while doing less work. Removal is listed last, and every record carries the caution:
the experiment shows what the component costs in this scenario, not that it should go.
When the component's scripts kept working after its markup was removed, the record says to
look at those scripts' timers and loops, not only the markup.

## Making one

```bash
# During the experiment (written automatically)
web-energy experiment https://example.org/ --kind remove --selector '.hero' \
  --runs 10 --warmups 2 --assert-role main --evidence diagnose-….json --release v2.3.1

# For a stored experiment result, older ones included
web-energy finding results/compare-….json --evidence results/diagnose-….json --write
```

`--evidence` takes a `diagnose` result. When one of its intervals names the same selector,
that interval's measurement, browser activity, evidence classes and scripts become the
observed activity and source files. Without it, the source files are "unknown".

`--release` labels the build measured (a tag, a commit) in the protocol and the record.

## What the record holds besides

- **Experiment**: kind, mode (post-load or pre-load), workload, seed, interleaved order,
  runs per side, warm-ups, the spec, and the **exact command** that repeats it (seed
  included).
- **Measurement environment**: Firefox and Playwright versions, OS and version,
  architecture, CPU and machine model, memory, viewport, headed, battery and Low Power
  Mode, energy adapter and scope, tier, cache mode, idle baseline, profiler features and
  interval, network conditions, build label, design.
- **Accessibility and functionality**: checks on both sides, accessibility structure that
  changed, content the removal took away, and whether the saving is like-for-like.
  Unchanged counts do not show a page works as before; a person should check.
- **Limitations**: the experiment's own, as listed in its report.
- **Artifacts**: the JSON, HTML, CSV and issue-draft file names, and the profiling result.
- **Topics** and `wsg`: plain tags (`animation`, `idle-work`, `timers-and-loops`,
  `scripts-and-third-parties`, …) for mapping to the
  [W3C Web Sustainability Guidelines](https://www.w3.org/TR/web-sustainability-guidelines/)
  in the system that imports the record. No guideline or success criterion is asserted:
  `wsg.mapping` is always `not-asserted`. That mapping is a judgement for the importing
  system, not for this tool.

## Schemas

`npm run schema` writes `schema/component-graph.schema.json`,
`schema/energy-timeline.schema.json` and `schema/energy-finding.schema.json` from the zod
schemas in `src/model/`. Tests keep the files in step with the code, and every result is
checked against them before it is written; a problem becomes a warning in the result.

The schemas enforce the rules, not only the shapes: a bin without a sample has null
energy, never zero; an unmeasured step carries no energy figure; a failed intervention
compares nothing and claims no confidence; removal is never the only recommendation.
