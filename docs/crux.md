# CrUX field data (optional)

The Chrome UX Report (CrUX) is Google's record of what **real Chrome users**
experienced on a public origin or URL. It is the only indicator in this project that
describes the live site rather than a lab run or a model.

It is optional, it is read-only, and it never replaces Lighthouse.

## What it adds

For the origin (or, with `--crux-url`, a single URL):

- the **75th percentile** of Core Web Vitals as measured on real devices:
  Largest Contentful Paint, Interaction to Next Paint, Cumulative Layout Shift
- First Contentful Paint and Time to First Byte where CrUX holds them
- the **share of page views in each band** — good, needs improvement, poor
- the **28-day collection window** the figures describe

## A fourth indicator, with its own boundary

| | Engine | What it is |
|---|---|---|
| CO2.js | none | modelled emissions from transferred bytes |
| Observed energy | Firefox | power counters on the client machine |
| Lighthouse | Chromium | one lab load under simulated throttling |
| **CrUX** | **Google** | **real Chrome users over a trailing 28-day window** |

Four different populations. None of them converts into another, and this tool will not
average, sum or reconcile them. Every field figure is printed with its scope, form
factor and window attached, because a p75 with no window is a number without a claim.

## What it cannot do

- **It cannot verify a fix made today.** The window is 28 days wide, so a change
  deployed this morning is a rounding error inside it. Use Lighthouse, or a local
  `measure` run, to see a change take effect.
- **It has no data for most URLs you care about while working.** Previews, staging
  sites, authenticated pages and low-traffic pages are usually absent. That is a
  normal answer, reported as `no data`, not an error.
- **An origin record covers the whole site.** It cannot tell you that one template or
  one shared asset regressed.
- **It is Chrome only**, and it is aggregated by Google, so you cannot see the
  distribution yourself — only the p75 and the three band shares.

## Running it

```bash
# Field data on its own — no browser, no measurement, one API call
node dist/cli/index.js crux https://example.com/

# Ask about one URL instead of its origin
node dist/cli/index.js crux https://example.com/pricing --crux-url

# One form factor instead of all of them combined
node dist/cli/index.js crux https://example.com/ --crux-form-factor phone

# Alongside a Firefox measurement; the report gains a field-data section
node dist/cli/index.js measure https://example.com/ --lighthouse --crux
```

`--crux` also works on `crawl`. It is not queried by `journey`, `compare` or `matrix`;
those cover many pages or many runs at once, and an origin-level field record cannot be
attributed to a single step. `report` does not query anything, but it re-renders a
`crux` block already saved in a result file.

## The API key

CrUX needs a Chrome UX Report API key. Enable the API in a Google Cloud project and
create a key:

<https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com>

Then either set `CRUX_API_KEY` or pass `--crux-key`:

```bash
export CRUX_API_KEY='…'
node dist/cli/index.js crux https://example.com/
```

The environment variable is preferred: a key given as a flag is visible in your shell
history and in the process list. The key is never written into a result file, a report
or an error message.

The key is resolved **before** Firefox launches, so a missing key fails in a second
rather than after a ten-minute run.

## One call per run

Without `--crux-url`, one query covers the whole origin. That is one request per run,
no matter how many pages were measured. Per-page field data is deliberately not
fetched: most pages of a site have no CrUX record of their own, and a crawler would
spend dozens of requests to find that out.

If `measure` is given URLs on more than one origin, only the first origin is queried.

## Privacy

The query leaves this machine and carries the URL or origin to Google. Two rules follow:

- Targets that are **local, private or development** (`localhost`, `10.x`, `192.168.x`,
  `.test`, `.local`, bare host names) are refused before anything is sent. CrUX has no
  data for them anyway, and they describe infrastructure you should not hand to a third
  party.
- **No key in any error.** An API failure reports the HTTP status and the API's own
  message, never the request URL, which carries `?key=`.

## Field against lab

When both indicators cover **one** URL, the report adds a small comparison table: LCP,
FCP and CLS from CrUX beside the same metrics from the median Lighthouse run.

It is not a validation of either side. The field column is the 75th percentile of real
users over 28 days; the lab column is one synthetic load. They disagree for ordinary
reasons — slower devices, wider networks, a different browser engine — and the
disagreement is the interesting part.

**Interaction to Next Paint has no lab counterpart here.** Lighthouse reports Total
Blocking Time. TBT is a proxy for responsiveness, not INP, so it is not shown in the INP
row. On a crawl with several pages the comparison is omitted: a single origin-level
record cannot be paired with a per-page lab table.

## Verification status

The client, parsing, formatting and report rendering are covered by tests against a
recorded-shape fixture (`tests/crux.test.ts`). The first call against the live API is
outstanding because it needs a key that the maintainer supplies:

- [ ] `crux https://<a site with traffic>/` returns a record; window and p75 look sane
- [ ] `--crux-form-factor phone` returns a phone-only record
- [ ] `--crux-url` on a page with almost no traffic returns `no data`, exit code 0
- [ ] an invalid key reports `HTTP 400/403` and not the key itself
- [ ] `measure … --crux` writes `crux` into the JSON result and renders the section

Tracked as the remaining work on this feature; nothing above changes the design.

## Why not PageSpeed Insights

PSI wraps CrUX **and** a cloud Lighthouse run. Using it as the entry point would mean
uploading a URL to Google to get a Lighthouse result this project already produces
locally, in a browser it controls, with the same version pinned. It is also the part of
PSI that leaks the most: a private target still fails, and the lab half is redundant.
The CrUX API is one POST with no new dependency.
