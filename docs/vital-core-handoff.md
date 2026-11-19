# Vital Core investigation handoff

Vital Core publishes **observations and hypotheses**, not experiment
instructions. This handoff turns one of its `performance-investigation/1`
candidates into a Firefox experiment spec **only when the candidate contains a
representative page and a specific resource URL/host or component selector**.
It never runs the experiment itself.

## What was audited

Firefox Energy Scanner: `main` at `34b4615` (the PR #51 merge), current
`ExperimentSpec` and `--from` queue path.

Vital Core: `main` at `6179a92` (audited 17 November 2026), `API.md`, the
performance aggregation in `src/aggregate.js`, and
`src/lib/performance-investigations.js`. Published snapshot:
`https://mgifford.github.io/vital-core/api/v1/www.cms.gov/snapshot.json`
(generated 2026-11-17, 20 candidates).

The audited snapshot is saved locally for this review as
`results/vital-cms-snapshot-2026-11-17.json` (SHA-256
`3db47717ce6d7ce7453d4de1d511cc75f590c5ed5bc760a77c49b71407aae0d1`).
The full snapshot is kept locally for this review (not committed, because it
is 4 MB and repeats many page URLs). The unit fixtures under
`tests/fixtures/vital/` are synthetic; the real candidate below is the
reproducible handoff.

### The real shape

A full snapshot has `performance.investigations`:

```json
{
  "performance": {
    "resources": {
      "schema_version": "performance-resource-inventory/1",
      "pages_with_evidence": 99,
      "resources": [
        { "key": "https://cdn.jsdelivr.net/npm/driver.js@latest/dist/driver.js.iife.js",
          "type": "script", "third_party": true, "origin": "jsdelivr.net",
          "pages": 44, "examples": ["https://www.cms.gov/..."],
          "transfer_bytes": 28212, "render_blocking_pages": 0 }
      ]
    },
    "investigations": {
      "schema_version": "performance-investigation/1",
      "candidates": [
        { "id": "third-party-resource:https://cdn.jsdelivr.net/npm/driver.js@latest/dist/driver.js.iife.js",
          "category": "third-party-resource-concern",
          "resource": { "key": "...", "type": "script", "origin": "jsdelivr.net",
                        "pages": 44, "transfer_bytes": 28212 },
          "evidence": { "source": "performance-resource-inventory/1", "denominator": 99 } }
      ]
    }
  }
}
```

The actual audited CMS snapshot has only two candidate categories:
`potential-render-blocking-resource` and `third-party-resource-concern`.
**All 20 candidates map** from that snapshot: 12 render-blocking URL blocks
and 8 third-party host blocks (several share a host). The implementation also
handles `shared-expensive-resource` and future component-selector candidates.
This is a compatibility check, not a recommendation to run all 20.

**Important:** resource candidates do **not** carry `page.url` or a
machine-readable `experiment` object. Their representative pages are in
`performance.resources.resources[].examples`, matched by the exact
`resource.key`. The adapter uses the first `https:` example and records that
provenance in the spec note. It does not substitute another page.

### What Firefox requires

`ExperimentSpec` requires `name`, `url` and `kind`, plus `hosts`/`urls` for
`block`, or a selector for `hide`/`remove`/`pause-animations`. `idle_ms`,
`assertions`, `runs` and `warmups` make the spec repeatable. A new optional
`note` carries the provenance into the result.

## Mapping

| Vital Core candidate | Result | Why |
| --- | --- | --- |
| `third-party-resource-concern` with `resource.origin` and a page example | `block` with `hosts: [origin]` | exact host; blocks every request to it, an upper bound |
| `potential-render-blocking-resource` with an absolute `resource.key` and page example | `block` with `urls: [key]` | exact URL; script/link only |
| `shared-expensive-resource` with an absolute `resource.key` and page example | `block` with `urls: [key]` | exact URL |
| candidate with `subject.selector`, `selector` or `component.selector` | `hide` (default), or the stated `intervention.kind` (`hide`, `remove`, `remove-before-load`, `pause-animations`) | only a published selector; never fabricated |
| `slow-representative-page` | rejected | page score, no specific intervention |
| `page-family-performance-pattern` | rejected | family, not one testable page/intervention |
| `possible-matched-page-regression` | rejected | score change, no specific intervention |
| `repeated-lighthouse-recommendation` | rejected | aggregate recommendation, no page/resource/selector |
| unknown category | rejected | do not guess |

The generated spec always includes `runs: 10`, `warmups: 2`, `idle_ms: 10000`
and a conservative `assertions: [{ role: main }]` survival check. The note says
that the assertion is a starting point and the spec must be reviewed before
running; a stronger functional assertion should be added when the page's
feature is known.

## Commands

Generate (no browser):

```bash
node dist/cli/index.js experiment \
  --from-vital path/to/snapshot.json \
  --candidate "third-party-resource:https://cdn.jsdelivr.net/npm/driver.js@latest/dist/driver.js.iife.js" \
  --save-spec experiments/vital-driver-js.yaml \
  --dry-run
```

Read the spec, then run it separately:

```bash
node dist/cli/index.js experiment --spec experiments/vital-driver-js.yaml
```

`--from-vital` accepts a saved full `snapshot.json`, a standalone
`performance-investigation/1` document, or an **explicit** `https://` snapshot
URL. It never crawls and never launches a browser. `http://` URLs are refused.
The import command always exits after writing/printing the spec; measurement is
a separate `--spec` command.

## Real candidate reviewed

| Field | Value |
| --- | --- |
| Source | `https://mgifford.github.io/vital-core/api/v1/www.cms.gov/snapshot.json` |
| Candidate | `third-party-resource:https://cdn.jsdelivr.net/npm/driver.js@latest/dist/driver.js.iife.js` |
| Category | `third-party-resource-concern` |
| Page | `https://www.cms.gov/medicare-coverage-database/search.aspx?error=Document+in+Archive&lcdid=38337&ver=10` (first page example for the key) |
| Intervention | block `jsdelivr.net` |
| Spec | [examples/experiments/vital-cms-driver-js-block.yaml](../examples/experiments/vital-cms-driver-js-block.yaml) |

The page is public, has a `<main>` landmark, and loads both
`driver.js@latest/dist/driver.css` and `driver.js.iife.js`. Blocking
`jsdelivr.net` is a host-level upper bound for removing/deferring the driver.js
tour; it can affect other resources from that host. The spec was generated with
`--dry-run` and parsed again with `--spec ... --dry-run`.

A structural smoke test with a temporary one-run copy (`runs: 1`, `warmups: 0`)
and Chromium, **not energy**, confirmed the spec runs:

```text
Applied: yes. 2 requests refused, over all runs.
Checks: baseline passed; variant passed.
load: energy not measured
idle: energy not measured
Finding: not measured (confidence: none).
```

The structural result is kept locally as
`results/vital-cms-driver-js-smoke-structural.json` (SHA-256
`a7d5316e0cd339286b4192dd5c9687b9e3409e430868ef8e42cf0b2c4c6c6bae`).

### Physical run, 18 November 2026

On the Apple M2 with Low Power Mode off and on power:

```text
Applied: yes. 48 requests refused, over all runs.
Checks: baseline passed; variant passed.
load: 0.542 -> 0.531 mWh (IQR 0.026 / 0.009): -0.012, within spread
idle: 0.070 -> 0.073 mWh (IQR 0.018 / 0.030): +0.004, within spread
Finding: no difference shown (confidence: none).
```

The baseline was median-of-bins 1.08 / 1.03 mW (mean 103.2 / 104.5 mW). The
block applied, but it did **not** show an energy reduction on this page and
workload. That is a null result, not proof of no effect. The host block can
remove the driver.js tour; the only assertion is `role=main`, so review the
page behaviour before treating it as production-like. The result is one
session, `not-replicated`, and carries the spec note as `experiment.note`.
See [p0-hardware-runs.md](p0-hardware-runs.md).

Result: `results/compare-2026-11-18T17-10-49-006Z.json`, SHA-256
`9c68c0a3d2dae5284566be07a285bd9a33fa455b4cb3f1672fe21c827fef7662`.


## Second real candidate reviewed

| Field | Value |
| --- | --- |
| Source | Vital Core snapshot for `medicaid.gov` (SHA-256 `c701d615a51b223ba3ed13001c7ba6d06f7214948ecd56e6819f4b9d5aa1c58c`; snapshot not committed) |
| Candidate | `third-party-resource:https://www.googletagmanager.com/gtag/js` |
| Category | `third-party-resource-concern` |
| Page | `https://www.medicaid.gov/medicaid/medicaid-state-plan-amendments?f%5B0%5D=…&page=8` (first page example) |
| Intervention | block `googletagmanager.com` |
| Spec | [examples/experiments/vital-medicaid-gtag-block.yaml](../examples/experiments/vital-medicaid-gtag-block.yaml) |

The page is public (HTTP 200), has a `<main>` landmark, and the spec parses
with 10 measured runs and 2 warm-ups. The snapshot reports 300 sampled pages
and the resource as a third-party concern; it reports **0 bytes** as a transfer
estimate, not measured energy. The spec has not been run on the physical host.
Blocking the host can affect analytics or other resources, so the `role=main`
assertion alone is not a full functional check.

Run it separately on the quiet Mac:

```bash
node dist/cli/index.js experiment --spec examples/experiments/vital-medicaid-gtag-block.yaml
```


### Additional Medicaid candidate

| Field | Value |
| --- | --- |
| Candidate | `third-party-resource:https://cdn.jsdelivr.net/bluebird/3.5.0/bluebird.min.js` |
| Category | `third-party-resource-concern` |
| Page | same Medicaid state-plan amendments page, page 8 |
| Intervention | block `jsdelivr.net` |
| Spec | [examples/experiments/vital-medicaid-bluebird-block.yaml](../examples/experiments/vital-medicaid-bluebird-block.yaml) |
| Smoke | [examples/experiments/vital-medicaid-bluebird-smoke.yaml](../examples/experiments/vital-medicaid-bluebird-smoke.yaml) (1 run, no warm-up; structural only) |

The snapshot reports 280 sampled pages and 46,145 bytes as a transfer estimate
for this resource; neither is measured energy. Blocking `jsdelivr.net` can
affect other resources from that host, and the only assertion is `role=main`;
this is an upper-bound test.

### Two clean full sessions, 19 November 2026

Two separate clean sessions on the Apple M2, both on AC power with Low Power
Mode off: 10 measured runs per side, two warm-ups, 20 interleaved runs per
session. The host block applied consistently in both (108 requests refused),
baseline and variant passed the `role=main` check, but the page lost two
focusable/form controls (352 → 350). That structural change is a functional
risk, not an energy result.

| Session | Load (baseline → variant) | Idle (baseline → variant) | Finding |
| --- | --- | --- | --- |
| 1 | 0.632 → 0.612 mWh, IQR 0.034 / 0.016 | 0.178 → 0.179 mWh, IQR 0.013 / 0.025 | no difference shown |
| 2 | 0.517 → 0.522 mWh, IQR 0.038 / 0.031 | 0.149 → 0.147 mWh, IQR 0.016 / 0.012 | no difference shown |

The point estimates differ between sessions, but in both the difference is
inside the run-to-run spread. This is a **consistent null result for this page,
host block and workload**, not proof that the resource has no energy cost
elsewhere. It is two sessions on the same machine, not independent external
replication. The earlier one-run smoke test reported an indicative 29.8% idle
reduction; that was noise and is not used as evidence.

Results:
- `results/compare-2026-11-19T01-57-46-188Z.json`, SHA-256
  `0592b39362c8431da4294c596a9c21b7d7a3618be5420b6f8a6ee6af9f1c2667`
- `results/compare-2026-11-19T09-54-22-306Z.json`, SHA-256
  `abfb22b23f31c1f5eed48164200b0f2cd7279727b087c8f5f5612a17fa03c98c`

## What Vital Core still needs to publish

- A machine-readable `experiment` field per candidate: `kind`, `selector` /
  `host` / `url`, representative `page.url`, workload (`idle_ms` or journey),
  and functional assertions. Without it, page-family, regression, slow-page and
  Lighthouse-recommendation candidates cannot be tested.
- A representative page URL **on the candidate** (not only in the inventory
  example list), so the handoff does not rely on an example lookup.
- For component candidates, an explicit implementation/component identity and
  selector, with ownership status. The current contract has no selector.
- A clear distinction between a resource being present and a resource being a
  cause; the note preserves Vital Core's own limitations.

## Evidence boundaries

Vital Core Lighthouse scores, Resource Timing observations, CO2.js modelled
carbon/energy and Firefox observed client energy are separate. This handoff
puts only the first three in the spec's provenance note. The experiment result
reports Firefox energy, if any, and never converts Vital Core bytes or scores
into an energy figure. Missing energy remains `not-measured`, never zero.
