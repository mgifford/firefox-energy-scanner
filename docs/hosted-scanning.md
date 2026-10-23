# Hosted scanning

Site: **<https://mgifford.github.io/firefox-energy-scanner/>**

Scans are requested through the GitHub issue queue and run in GitHub Actions, with
results published back to the static site. The pattern follows
[open-scans](https://github.com/mgifford/open-scans).

## Requesting a scan

Hosted runners have no power-measurement hardware, so their energy column reads
**not measured**. Turn on **Lighthouse** in the form to add Chromium lab scores and
performance recommendations; see [lighthouse.md](lighthouse.md).

Either use the web form (which pre-fills a GitHub issue — you still review and submit
it yourself), or open an issue titled `SCAN: <description>` using the
*Energy scan request* template.

### The issue is the run control

Issue state tracks the request, so there is no separate queue to inspect:

| State | Meaning |
|---|---|
| **open** | queued, running, or failed — not yet serviced |
| **closed** | scan completed and results were posted |

When a request is picked up, the workflow comments **Scan started** with a link to the
run. When the scan finishes, it posts the results and **closes the issue**.

Any request can be run again:

| To re-run | Do this |
|---|---|
| a finished (closed) request | **reopen it** — edit the body first to change settings |
| a rejected or failed (open) request | **edit it** — saving the edit runs it again |
| any request, open or closed | add the **`rescan`** label (the workflow removes it again) |

Editing a *closed* request does nothing until it is reopened, so tidying an old issue
never starts a scan by accident.

The two failure paths deliberately leave the issue **open**, because an open issue
means "not yet serviced":

- **invalid request** (no usable URLs, bad include pattern, over budget) — the errors
  are posted as a comment and the scan never starts.
- **failed scan** (target unreachable, timed out) — a comment links the run log.

Each issue has its own queue, so re-running several requests at once queues them all;
none is dropped.

### More than 20 URLs

Measure mode scans the first 20 URLs. Any beyond that — and any line that is not a
public `http(s)` URL — are listed under **Not scanned** in the results comment, with
the reason, rather than rejecting the whole request. A request is only rejected when
nothing in it can be scanned.

## GitHub-hosted runners cannot measure energy

**No GitHub-hosted runner can produce energy data**, and no configuration changes that.

GitHub's macOS runners are virtual machines (`Apple M1 (Virtual)`, `hw.model
VirtualMac2,1`, `kern.hv_vmm_present 1`). Firefox reads energy from the kernel via
`task_info(TASK_POWER_INFO_V2)`, which is ultimately fed by the SoC's power-manager
block — and that hardware is not exposed to a guest VM. `powermetrics` on the same host
fails with `cannot find the IO registry entry for IODeviceTree:/arm-io/pmgr`.

| Host | arm64 | Counter exists | Samples | Energy |
|---|---|---|---|---|
| Physical Apple Silicon | yes | yes | 465 in a 5.7 s probe | **yes** |
| GitHub `macos-latest` | yes | yes | **0** | **no** |
| GitHub `ubuntu-latest` | no | no | n/a | no |
| Self-hosted Apple Silicon | yes | yes | yes | **yes** |

The blocker is virtualisation, not the datacentre. A *physical* Apple Silicon machine
registered as a self-hosted runner measures energy correctly — and is better than a
laptop for it: mains power, stable thermals, no Low Power Mode, no competing user
workload.

So, in practice:

- **Hosted runners** (either OS) — network, CO2e and timing only. Useful, and these
  metrics do not depend on machine state.
- **Self-hosted Apple Silicon** — the full set, including energy.

Results are labelled "no energy data" rather than silently omitting the column, because
an absent number and an unmeasured one mean different things. `doctor` probes for real
samples and fails loudly on a host that cannot measure.

## What hosted results are good for

Hosted runners are shared, multi-tenant virtual machines with no thermal control and no
guarantee about neighbouring workloads. They are appropriate for:

- capability and smoke testing,
- network, request-count and CO2.js metrics (which do not depend on machine state),
- transferred-byte and request-count comparisons between pages or builds.

They are **not** capable of energy measurement at all — see the section above. Any
energy column from a hosted run reads "no energy data".

They are **not** appropriate for the A/B regression work this project exists to support.
That needs a dedicated machine — ideally one on AC power with Low Power Mode off. A
self-hosted Apple Silicon runner would serve that purpose.

## Safety model

Issue bodies are untrusted public input, so:

- **Only public `http(s)` URLs are accepted.** Localhost, RFC1918 ranges, link-local,
  multicast, `0.0.0.0`, `.local`/`.internal`, and dotless hostnames are all rejected.
  The scanner cannot be used to probe internal networks. 24 tests cover this guard.
- **Least privilege.** The parsing job can read contents and comment on issues; write
  access to contents is granted only to the scan job, which needs it to commit results.
- **Issue text is data, never code.** Nothing from the issue is pasted into a script
  with `${{ }}`: values reach scripts through environment variables and `argv`, and a
  test fails the build if a workflow script contains an inline expression. Echoed text
  is flattened to one line and length-limited, workflow outputs use random heredoc
  delimiters, and quoted text in comments cannot @-mention anyone.
- **Limits.** 20 URLs (the rest are listed, not scanned) and 30 runs per request, with
  a 90-minute scanning budget.
- **Invalid requests get an explanation**, not a silent failure.

## What gets published

Result JSON is committed to `site/results/`. After each scan the workflow starts the
Pages deploy, which builds `results/index.json` from those files and publishes the site.
(Commits made by the workflow's own token cannot trigger other workflows, so before this
the site only updated when someone pushed by hand.) The index is not tracked in git:
concurrent scans each rewrote it and conflicted on push. Build it locally with
`node dist/cli/index.js build-index --dir site/results --out site/results/index.json`.

Published results contain no credentials, cookies, session tokens, or hostnames.
Authentication is configured by environment *variable name* only — a result file records
`password_env: DRUPAL_PASSWORD`, never the value. Hostname collection is off by default.

Energy is published **only when it is resolvable**. A scenario whose median incremental
energy is at or below idle, or smaller than its own interquartile range, is rendered as
"not resolved" with the reason attached. Publishing noise as a measurement would be
worse than publishing nothing.

## Accessibility

The site is static HTML with no JavaScript framework. axe-core reports zero violations
across WCAG 2.0, 2.1 and 2.2 at levels A and AA (30 passing checks). Tables carry
`scope` attributes and captions, every form control has a label, there is a skip link,
focus indicators are visible, and the colour palette is defined for both light and dark
schemes.
