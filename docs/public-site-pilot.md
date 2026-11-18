# One real public-site pilot

A bounded first pilot of the full path on real public HTML:

```text
crawl → page families → component graph → site patterns → investigation queue
      → one Firefox diagnose → one controlled experiment → a written note
```

The first half is **structural discovery**. It is not a benchmark and measures
no energy. The Firefox diagnose and experiment are separate runs on the quiet
Mac, with diagnostic overhead kept out of the comparison.

## Scope and safety

- One public site, seeded from an `https://` page, with a small `--max-pages`
  (default 20, hard limit 50) and `--max-depth 3`.
- The crawl respects `robots.txt` by default.
- No authentication, forms, purchases, uploads or user data.
- No clicking, scrolling or typing during a measurement run.
- Do not run a public crawl in CI. The runner requires `--confirm-public`.
- The URL guard refuses non-HTTPS, credentials, localhost, private/LAN
  addresses and `.local`/`.test`/`.example`/`.internal` hosts.
- Record the site, seed URL, date, commit, page cap and result path.

## Run the structural pilot

After `npm run build`:

```bash
node scripts/public-site-pilot.mjs \
  --url https://www.example.org/ \
  --max-pages 20 \
  --out results/pilot-example \
  --confirm-public
```

The default per-command timeout is 20 minutes (`--timeout-min 20`). Dry run first; it prints the plan and makes no network request or file:

```bash
node scripts/public-site-pilot.mjs --url https://www.example.org/ --dry-run
```

The runner executes, under `WEB_ENERGY_TEST_ENGINE=chromium`:

```text
crawl <url> --max-pages 20 --max-depth 3 --no-energy --lighthouse --trace --out <dir>
patterns <result> --write
investigate <result> --write
```

and writes `<dir>/pilot.json` with the plan, status, result path and the
limitations. It never runs an experiment.

The Chromium run is a structural test seam: it is **not** a Firefox
measurement, and the result says `energy: not-measured`.

## Review the result

1. Open the HTML report. Look at the family count and the representative pages.
2. Read the **Site patterns** section in both directions:
   - component type → pages, families, resources, findings;
   - resource → component types, pages, findings.
3. Read the **Investigate first** queue. Check:
   - shared findings grouped once, not once per page;
   - different implementations not merged;
   - shared scripts show all implicated components;
   - page-level findings kept per page;
   - no whole-site prevalence is inferred from the sampled pages.
4. Choose one page and one component from that evidence. Record why.
5. On the quiet Mac, run one `diagnose` (diagnostic overhead; not a benchmark)
   and one controlled experiment on the chosen component. Use the existing
   experiment evidence rules; a null result is a result.
6. Write the pilot note: observed facts, evidence class, what is supported,
   what is not, limitations and the next production-like change.

## What success looks like

- At least three page families are represented in the measured sample.
- The recurring-pattern view is useful and does not over-merge distinct
  implementations.
- At least one real component/resource lead is traceable from a page to a
  component or script and back.
- One experiment runs with the change applied and the checks intact; its
  energy result is reported with confidence, replication and nulls.
- Every number names its source, window and unit; accessibility, performance,
  carbon estimates and energy remain separate.

## Evaluation aids (optional, separate columns)

These can help evaluate the pilot, but are not FES evidence and must not be
combined into a score. The links and boundaries are in [TODO.md](../TODO.md).

- **GreenFrame / GreenFrame CLI** — scenario energy/carbon estimate; record
  version and scenario; do not call it hardware energy.
- **Sitespeed.io + CO2.js** — performance metrics and transfer-based CO2
  estimate; record grid intensity and versions; not measured energy.
- **Vercel agent-browser** — exploratory journey/selector authoring; not a
  measurement driver; human review required.

## Stop conditions

Stop and do not report a result if:

- the site's robots/terms forbid the crawl;
- the page needs authentication, a form or a transaction;
- the browser cannot start cleanly or the host is not quiet;
- the change cannot be applied and held;
- the result is within spread but is about to be described as a saving;
- the only evidence for a component is proximity, a label or a score.

## Current status

The runner and dry-run plan are implemented. No public site has been run yet;
choose one, record it, and run a small page cap before the full 20-page pilot.
