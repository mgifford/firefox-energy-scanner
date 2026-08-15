# firefox-energy-scanner

Measure **observed client-side browser energy** and **modelled CO2e** for websites and
authenticated application interfaces, using Playwright, Firefox, and CO2.js.

Built for a specific research question: *does a change to a web application alter the
energy a browser spends on it, even when the transferred bytes stay roughly the same?*

## The short version of why this exists

Two pages measured with this tool, on the same machine, minutes apart:

| Page | Transfer | CO2.js estimate | Observed client energy |
|---|---|---|---|
| static text | 436 B | 0.065 mg | ~0 mWh |
| same size, busy JS | 678 B | 0.100 mg | **1.010 mWh** |

A bytes-based model rates these as near-equivalent. The browser spends roughly **two
orders of magnitude** more energy on one of them. Transferred bytes are not a proxy for
client energy, which is the whole premise of the project.

## Two metrics, two boundaries, never merged

This tool deliberately reports two different classes of indicator and never adds them
together or converts one into the other:

- **Modelled CO2e** — CO2.js, estimated from transferred bytes and model assumptions.
  Covers datacentre, network, and device segments. Not a measurement.
- **Observed client energy** — Firefox's power counters, in joules/mWh. Covers the
  energy drawn by Firefox's processes on the machine running the test.

The measurement boundary is the **client machine**. Results say nothing about server,
PHP, database, or data-centre energy, and are not a total carbon figure for a site.

## Requirements

- Node.js 20+
- macOS on Apple Silicon, or Windows 11, for energy measurement
  (elsewhere the tool still runs and reports timing, bytes, and CO2.js — but no energy)

Energy measurement needs **no elevated privileges**.

## Install

```bash
npm install
npx playwright install firefox
npm run build
```

## Check your environment first

```bash
node dist/cli/index.js doctor
```

`doctor` verifies Node, Playwright, Firefox, and adapter availability, and warns about
conditions that invalidate comparisons — most importantly running on **battery**, which
changes power management behaviour.

## Commands

```bash
web-energy doctor
web-energy measure <url...>
web-energy crawl <url> --include '^/admin' --max-pages 50
web-energy journey examples/drupal-admin-basic.js --url https://example.com
web-energy baseline
web-energy compare --a <url> --b <url> --journey <file>
web-energy report results/<file>.json
web-energy profile --journey <file>
```

### measure

Measure one or more URLs directly.

```bash
node dist/cli/index.js measure https://example.com --runs 10 --warmups 3
```

### journey — the mode to use for regressions

Deterministic scripted user tasks with explicitly named measurement boundaries.
Authentication happens in `setup()`, outside the measured region.

```js
export default defineJourney({
  name: 'drupal-admin-content-filter',
  async setup({ page, baseUrl, env }) {
    await loginDrupal(page, { baseUrl, ...readDrupalCredentials(env) });
  },
  async run({ page, measure, url }) {
    await measure('open-content', async () => {
      await page.goto(url('/admin/content'));
    });
    await measure('filter-content', async () => {
      await page.getByLabel('Title').fill('test');
      await page.getByRole('button', { name: /filter/i }).click();
    });
  },
});
```

### crawl — for discovery, not regression

Crawls visit different pages under different conditions, which makes them a poor basis
for A/B comparison. Use them to find what to measure, then write a journey.

### compare

Runs are **interleaved** (`A B B A …`) from a stored seed, so drift in thermal state,
network, or server cache is not confounded with the target being tested.

```bash
node dist/cli/index.js compare \
  --a https://baseline.tugboatqa.com --label-a core-head \
  --b https://patch.tugboatqa.com   --label-b issue-12345 \
  --journey examples/drupal-admin-basic.js \
  --warmups 10 --runs 30
```

## Drupal

Credentials come from the environment and are never logged, never written to results,
and never placed in a URL. Copy `.env.example` to `.env`.

```
DRUPAL_BASE_URL
DRUPAL_USERNAME
DRUPAL_PASSWORD
```

Tugboat previews are treated as ordinary remote HTTPS targets; no Tugboat API access is
required.

## Output

JSON is canonical and always retains raw per-run measurements — summaries never replace
them. CSV and a static, accessible HTML report (no JS framework, tables rather than
canvas charts) are generated alongside.

## Documentation

- [docs/decision-record.md](docs/decision-record.md) — what was verified, and how
- [docs/methodology.md](docs/methodology.md) — boundaries and what the numbers mean
- [docs/energy-measurement.md](docs/energy-measurement.md) — how energy is captured
- [docs/limitations.md](docs/limitations.md) — confounders and known limits

## Licence

AGPL-3.0-or-later.
