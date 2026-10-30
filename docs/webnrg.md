# webNRG lab check

[webNRG](https://website-tester.green-coding.io/) is Green Coding's website
measurement. It runs on their [Green Metrics Tool](https://github.com/green-coding-solutions/green-metrics-tool)
(GMT) cluster: Playwright **Firefox**, in a container, on a dedicated and calibrated
machine. It gives a second energy figure for a page, measured on hardware that is the
same for every site and every week.

The scanner can reuse or request webNRG figures for a few pages of a scan and show them
beside its own. Hosted scans do this by default.

## What the figure is

| | This scanner | webNRG |
|---|---|---|
| Browser | Playwright Firefox | Playwright Firefox |
| Hardware | your machine, or the repository's energy runner | Green Coding's dedicated machine |
| What is counted | Firefox's own processes (Apple Silicon) or the CPU package (Linux, Intel) | the CPU package (RAPL) |
| Window | each page load, until the page is stable | page load plus 5 s of idle |
| Idle | subtracted | not subtracted; the grade compares against idle |
| Cache | warm, after warm-up runs | warm, through a Squid cache |
| Repeats | several runs, median and spread | one run |

Because the scope, hardware and window all differ, the two figures are **shown side by
side and never added, subtracted or divided**. Each is meaningful against its own history.
co2-runner reached the same rule ([ADR-007](https://github.com/mrchrisadams/co2-runner/blob/main/docs/adrs/adr-007-gmt-cluster-submission.md)).

webNRG also grades each page, A+ to F:

- **Rendering**, in 25% steps above an ideal page: the machine's idle power (2.45 W) for
  5.5 s, 4.68 mWh. Above 2.5 times that is F.
- **Transfer**, on the Sustainable Web Design rating bands, in kB.

The scanner reproduces both grades from webNRG's own code, so they match what webNRG
shows.

## How it works

For each page, in order:

1. **Look up.** If webNRG has a finished run of exactly this URL from the last 30 days,
   reuse it. This is the same rule webNRG's own page applies, and it costs Green Coding
   nothing.
2. **Request.** Otherwise, and only when asked, request a measurement through webNRG's
   gateway (`gateway.green-coding.io/save`), as webNRG's page and
   [co2-runner](https://github.com/mrchrisadams/co2-runner) do.
3. **Collect.** A requested measurement takes 5 to 30 minutes in Green Coding's queue.
   The scanner waits for it if told to, or records the job so it can be collected later.

URLs are spelled as webNRG stores them (no trailing slash), so lookups find earlier runs.

### Third party and public

Requesting a measurement sends the page URL to green-coding.io, and **every webNRG
result is public** on [metrics.green-coding.io](https://metrics.green-coding.io/). Nothing
is sent unless `--webnrg` is given (locally) or the repository leaves it on (hosted).
`--webnrg-lookup-only` reads existing results and sends no request.

### The gateway

The gateway accepts requests from origins on its allowlist. Like co2-runner, the scanner
presents webNRG's own origin, and identifies itself in its `User-Agent`
(`firefox-energy-scanner (+https://github.com/mgifford/firefox-energy-scanner)`) so Green
Coding can tell its requests apart. If Green Coding gives this project an origin or an API
key of its own, set `WEBNRG_ORIGIN` or change `DEFAULT_ORIGIN` in
[`src/webnrg/client.ts`](../src/webnrg/client.ts).

To keep the load on a free, shared service small, a scan checks at most three pages by
default, and reuses any result from the last 30 days.

## Locally

```bash
# With a scan: reuse or request webNRG figures for the first three listed pages
node dist/cli/index.js measure https://example.org/ https://example.org/about --webnrg

# Only reuse what webNRG already has; send nothing
node dist/cli/index.js measure https://example.org/ --webnrg-lookup-only

# Wait up to 30 minutes for requested results (default: do not wait)
node dist/cli/index.js measure https://example.org/ --webnrg --webnrg-wait 30

# Later: collect requested results into the result file
node dist/cli/index.js webnrg-collect results/measure-<time>.json --wait 30

# webNRG on its own, no Firefox run (waits up to 30 minutes by default)
node dist/cli/index.js webnrg https://example.org/ https://example.org/about
```

`--webnrg-top <n>` changes how many pages are checked (default 3, at most 10). In a crawl
they are the heaviest pages found.

The result file gets a `webnrg` section: per page, whether it was reused, measured,
requested or failed, the figures, the grades, and links to webNRG and to the GMT run.
The HTML report shows it as its own section.

## Hosted scans

Every scan reuses or requests webNRG figures for up to three pages. The scan comment
shows them in a **Lab check: webNRG** table. Requested measurements are collected by a
separate, small job on GitHub's cloud, so the energy runner is never kept waiting. It
waits up to 45 minutes and adds a follow-up comment. A request still running after that
stays linked, and a re-scan within 30 days reuses it.

Set the repository variable **`WEBNRG`** (Settings → Secrets and variables → Actions →
Variables) to change this:

| `WEBNRG` | Effect |
|---|---|
| unset | reuse, and request where needed (default) |
| `lookup` | reuse only; send no requests |
| `off` | no webNRG at all |

## Checking it works

The **webNRG live check** workflow runs the real round trip: it reads an existing
result, then looks up or requests a measurement of this project's own site and waits for
it. It runs only when asked, because a request uses cluster time: add the label
`webnrg-live-check` to a pull request, or run the workflow from the Actions tab.
