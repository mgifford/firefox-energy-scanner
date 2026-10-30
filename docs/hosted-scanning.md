# Hosted scanning

Site: **<https://mgifford.github.io/firefox-energy-scanner/>**

Scans are requested through the GitHub issue queue and run in GitHub Actions, with
results published back to the static site. The pattern follows
[open-scans](https://github.com/mgifford/open-scans).

## Requesting a scan

Use the web form (it pre-fills a GitHub issue that you review and submit), or open an
issue titled `SCAN: <description>` with the *Scan request* template.

**Quickest:** an issue titled `SCAN:` and the address, with nothing else, for example
`SCAN: ottawa.ca`. A bare domain gets `https://`, several addresses can be separated by
commas, and everything else takes its default. The comment notes that the URL came from
the title.

**Only the URLs are required.** Everything else has a default:

| Field | Default | |
|---|---|---|
| URLs | — | One URL crawls its site; several URLs scan exactly those (up to 200). Comma-separated works too, and `ottawa.ca` means `https://ottawa.ca`. |
| Lighthouse | Performance, the 10 heaviest pages | Or every page, all four categories, or off. One run per page. See [lighthouse.md](lighthouse.md). |
| Viewport | Desktop, 1280×800 | Desktop-width viewports use Lighthouse's desktop profile; narrower ones its mobile profile. |
| What to scan | Auto | Force a list scan of a single URL, or a crawl from the first of several. |
| Maximum pages to crawl | 50 | Crawls only; up to 200. |
| Where to run | Auto | The repository's energy-measuring machine if one is set up, otherwise GitHub's cloud. |

**Crawling** follows links on the same site. A leading `www.` and the scheme do not
matter, and redirects are followed as a browser follows them: a crawl of `france.fr`
covers `www.france.fr`, and each page is visited once whichever spelling links to it.
Links to files (PDF, Office documents, images, media) are skipped.

**Runs.** GitHub's cloud cannot measure energy, so there each page is visited once,
cold — repeating a page only matters for resolving energy. On an energy-measuring
machine each page gets 2 warmups and 10 measured runs, reduced for long lists so the
scan fits the 90-minute budget.

Requests written with the older form (scan mode, measurement type, runs per URL) still
work. A pasted list is always scanned as a list, even if the old form said crawl.

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

Different issues never block or cancel each other. For the **same** issue, the newest
trigger wins: reopening and adding `rescan`, or reopening and then saving an edit, are
two triggers seconds apart, so the later one cancels the run still in progress and scans
the issue as it now reads. The earlier "Scan started" comment is updated rather than
left without a result.

### More than 200 URLs

A list scan covers the first 200 URLs. Any beyond that — and any line that is not a
public `http(s)` URL — are listed under **Not scanned** in the results comment, with
the reason, rather than rejecting the whole request. A request is only rejected when
nothing in it can be scanned.

## GitHub-hosted runners cannot measure energy

**No GitHub-hosted runner can produce energy data**, and no configuration changes that.
This is measured: the [Energy probe](../.github/workflows/energy-probe.yml) workflow runs
Firefox with its power profiler on every hosted machine type and counts real samples.
Its run on 24 October 2026:

| Runner | Virtual machine | Linux RAPL | Firefox power | Verdict |
|---|---|---|---|---|
| `macos-latest` (Apple Silicon) | yes, Apple Virtualization | n/a | 0 samples (`Process Power` counter present) | cannot |
| `macos-15-intel` | yes, Apple Virtualization | n/a | 0 samples, no counters | cannot |
| `ubuntu-latest` (x64) | yes, Azure | none, `perf_event_paranoid` 0 | 0 samples, no counters | cannot |
| `ubuntu-24.04-arm` | yes, Azure | none, `perf_event_paranoid` 0 | 0 samples, no counters | cannot |
| `windows-latest` (x64) | yes, Azure | n/a | 0 samples, no counters | cannot |
| `windows-11-arm` | (not reported) | n/a | 0 samples, no counters | cannot |

The blocker is virtualisation, not the datacentre. On macOS, Firefox reads energy via
`task_info(TASK_POWER_INFO_V2)`, which the SoC's power manager feeds, and a guest VM
has no such hardware. On Linux and Windows, Firefox reads the CPU's RAPL counters,
which Azure VMs do not expose. Re-run the probe from the Actions tab at any time.

A *physical* machine works: a physical Apple Silicon Mac (per-process), or a bare-metal
Linux or Windows 11 PC (whole CPU package). Run the scanner on it directly, or register
it for this repository so issue scans use it:

1. Register it as a self-hosted runner ([self-hosted-runner.md](self-hosted-runner.md)).
2. Set the repository variable **`ENERGY_RUNNER`** to its labels, comma-separated, e.g.
   `self-hosted,macOS,ARM64` (Settings → Secrets and variables → Actions → Variables).

With `ENERGY_RUNNER` set, "Where to run: Auto" sends scans to that machine, and they
wait for it if it is busy or offline. Without it, scans run in GitHub's cloud and the
results comment says so. (GitHub's own workflow token cannot list runners, so the
repository has to say which machine to use.)

Results from the cloud read **not measured** in the energy column rather than omitting
it, because an absent number and an unmeasured one mean different things.

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
  carrier-grade NAT, multicast, `0.0.0.0`, IPv6 local ranges, local-development names
  (`*.ddev.site`, `*.lndo.site`, `.local`, `.test`, `nip.io` …) and dotless hostnames are
  rejected when the request is read, so the requester hears about it straight away.
- **And only public addresses are reached while the scan runs.** Checking the URL is not
  enough: a public name can resolve to a private address, a page can redirect to one or
  load resources from one, and a name can change its answer between lookups. So scans run
  with `--public-only`: every connection Firefox and Lighthouse's Chrome make goes through
  a guard ([`src/collect/network-guard.ts`](../src/collect/network-guard.ts)) that looks
  the name up once, refuses it if any address is private, and connects to the address it
  checked. WebRTC and HTTP/3 (UDP) are off. Refused pages are reported as _blocked_ and
  never measured; refused resources are listed in the step's warnings. This is what makes
  a runner on a home network safe to open to the public.
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

Results are reviewed before they are published. Nothing is pushed to `main` by the
workflow:

- Each scan commits its result files to **one long-lived branch, `scan-results`**.
- **One pull request** from that branch collects every scan until it is merged. Its
  description lists the issue behind each result. The scan's own comment links to it.
- **Merging publishes.** The merge is a push to `main`, which runs the Pages deploy; that
  rebuilds `results/index.json` from the result files and publishes the site.
- After a merge, the next scan resets `scan-results` to `main` and opens a fresh pull
  request, so there is never more than one results branch or results pull request. If a
  results pull request is closed without merging, its results stay on the branch and
  roll into the next one.

The workflow needs **Settings → Actions → General → Workflow permissions → Allow GitHub
Actions to create and approve pull requests** to open that pull request. If it is off, the
results are still pushed to the branch and the scan comment links to a page where you can
open the pull request yourself.

The index is not tracked in git, because concurrent scans each rewrote it. Build it
locally with
`node dist/cli/index.js build-index --dir site/results --out site/results/index.json`.

**One third party.** Unless the repository variable `WEBNRG` is `off`, each scan sends up
to three of its page URLs to Green Coding's [webNRG](https://website-tester.green-coding.io/)
for a lab energy figure, and webNRG publishes every result on metrics.green-coding.io. A
page webNRG measured in the last 30 days is reused instead. See
[webnrg.md](webnrg.md).

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
