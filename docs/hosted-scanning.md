# Hosted scanning

Site: **<https://mgifford.github.io/firefox-energy-scanner/>**

Scans are requested through the GitHub issue queue and run in GitHub Actions, with
results published back to the static site. The pattern follows
[open-scans](https://github.com/mgifford/open-scans).

## Requesting a scan

Either use the web form (which pre-fills a GitHub issue — you still review and submit
it yourself), or open an issue titled `SCAN: <description>` using the
*Energy scan request* template.

## Runner selection matters

Firefox power counters exist only on Apple Silicon and Windows 11. This was verified on
GitHub-hosted runners rather than assumed (workflow run 31907018340):

| Runner | `uname -m` | Power counters | Power source |
|---|---|---|---|
| `macos-latest` | `arm64` | **yes** | AC |
| `ubuntu-latest` | `x86_64` | no | n/a |

So:

- **macOS runner** — energy + network + CO2e. Slower and consumes more Actions minutes.
- **Linux runner** — network + CO2e + timing only. Faster and cheaper.

A Linux scan is labelled "no energy data" on the site and in the issue comment. It never
silently omits the energy column, because an absent number and an unmeasured one mean
different things.

## What hosted results are good for

Hosted runners are shared, multi-tenant virtual machines with no thermal control and no
guarantee about neighbouring workloads. They are appropriate for:

- capability and smoke testing,
- network, request-count and CO2.js metrics (which do not depend on machine state),
- rough, indicative energy comparisons.

They are **not** appropriate for the A/B regression work this project exists to support.
That needs a dedicated machine — ideally one on AC power with Low Power Mode off. A
self-hosted Apple Silicon runner would serve that purpose.

## Safety model

Issue bodies are untrusted public input, so:

- **Only public `http(s)` URLs are accepted.** Localhost, RFC1918 ranges, link-local,
  multicast, `0.0.0.0`, `.local`/`.internal`, and dotless hostnames are all rejected.
  The scanner cannot be used to probe internal networks. 24 tests cover this guard.
- **Least privilege.** The parsing job holds only `contents: read`. Write access to
  contents and issues is granted per job, only where needed.
- **No shell interpolation of user input.** URLs travel via an environment variable and
  are passed to the CLI as `argv`, so a hostile issue body cannot inject a command.
- **Limits.** 20 URLs and 30 runs per request, with a 45-minute scan timeout.
- **Invalid requests get an explanation**, not a silent failure.

## What gets published

Result JSON is committed to `site/results/` and indexed into `results/index.json`.

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
