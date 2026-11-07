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

CrUX needs a Chrome UX Report API key. It is free. The API allows 150 queries a minute
per Google Cloud project; a scan makes at most 100 (`--crux-max`, at most 150), paced to
stay under that limit.

### 1. Create the key (once)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project or
   pick one.
2. Enable the **Chrome UX Report API**:
   <https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com>
3. Go to **APIs & Services → Credentials → Create credentials → API key**.
4. Edit the key and **restrict it**. Under *API restrictions*, choose *Restrict key* and
   tick only the Chrome UX Report API. A leaked key can then query CrUX, which is public
   data anyway, and nothing else in the project.

### 2a. Local use: a `.env` file

Copy `.env.example` to `.env` in the folder you run the scanner from, and set the key:

```bash
cp .env.example .env
# then edit .env so it reads: CRUX_API_KEY=your-key
node dist/cli/index.js crux https://www.cms.gov/
```

- `.env` is in `.gitignore`, so it is never committed. `git status` should not list it;
  if it does, stop and check `.gitignore` before you commit anything.
- The CLI reads `.env` at startup. A `CRUX_API_KEY` already set in your shell wins.
- On a Mac you can keep the key in the Keychain instead, and leave `.env` out:

  ```bash
  security add-generic-password -a "$USER" -s crux-api-key -w   # asks for the key
  export CRUX_API_KEY="$(security find-generic-password -a "$USER" -s crux-api-key -w)"
  ```

- Avoid `--crux-key`. It works, but the key then sits in your shell history and in the
  process list, and the CLI warns about it.

### 2b. Hosted scans (GitHub Actions, published to GitHub Pages)

1. In the repository on GitHub: **Settings → Secrets and variables → Actions → New
   repository secret**. Name: `CRUX_API_KEY`. Value: the key.
2. That is all. The scan workflow (`.github/workflows/scan-request.yml`) passes the secret
   to its *Run scan* step only. When it is set, crawls add `--crux --popular` and page
   lists add `--crux --crux-pages`. When it is not set, scans run as before, and the log
   says `CrUX field data: off`.

What protects the key there:

- GitHub masks secrets in workflow logs, and does not give them to workflows run from
  forks.
- Only the *Run scan* step has it. The GitHub Pages deploy never sees it: the published
  results hold field data, which is public, and no key.
- The scanner takes the key out of its own environment at startup, so Firefox, Chromium
  and Lighthouse, which it launches, never inherit it.
- The key travels in the `X-Goog-Api-Key` header, never in a URL, so nothing that logs a
  URL logs the key.

A self-hosted runner, the machine at home that measures energy, gets the secret the same
way, for that step only. Rotate the key in the Google Cloud console if it is ever
exposed, then update the secret or your `.env`.

### What is never written down

The key is never written into a result file, a report, a CSV or an error message. Tests
check that a result, an API error and a network failure do not contain it. The key is
resolved **before** Firefox launches, so a missing key fails in a second rather than
after a ten-minute run.

## Popular pages and per-page field data

`--crux` asks about the whole origin, one query per run. Two options ask about pages:

- `--crux-pages`: field data for **each measured page**, after the browsers have closed.
  The report gains a *Field data for each page* table, with p75 LCP, INP, CLS and TTFB.
- `--popular` (crawls): within each URL section, the sample **prefers pages real Chrome
  users visit**, and it implies `--crux-pages`. Before the draw, the first three
  candidates of each section are checked, round by round so that every section is asked
  about before any section's fourth. Candidates with a URL-level record lead their
  section's draw, still in hash order, so the spread across sections is unchanged and the
  same site gives the same sample.

**What a record means.** CrUX publishes a URL's data only when it had enough real Chrome
page views in 28 days and is public. A record is therefore a sign from real use that
people visit the page, not a guess from its address. **No record** means too little
Chrome traffic, or a page CrUX does not cover. It does not mean nobody uses the page.

Field data describes the live site and real users. It is never combined with this
scan's measurement or Lighthouse's lab figures.

## Privacy

The query leaves this machine and carries the URL or origin to Google. Two rules follow:

- Targets that are **local, private or development** (`localhost`, `10.x`, `192.168.x`,
  `.test`, `.local`, bare host names) are refused before anything is sent. CrUX has no
  data for them anyway, and they describe infrastructure you should not hand to a third
  party.
- **No key in any error.** An API failure reports the HTTP status and the API's own
  message. The key is sent in a header, so no URL carries it.
- **Page URLs go to Google** with `--crux-pages` and `--popular`: the addresses of the
  pages checked, which are public pages of a public site. Local and private addresses
  are never sent.

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
