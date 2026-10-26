import type { BenchmarkResult, StepResult } from '../core/types.js';
import { summarize, spearman, resolution, type Summary } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import { energyCarbon, formatMicrograms, type GridIntensity } from '../core/carbon.js';
import { groupByStep, failedSteps } from './csv.js';
import { readableFailure } from '../core/failures.js';
import { lighthouseSection } from './lighthouse-html.js';
import { cruxSection } from './crux-html.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const num = (v: number | undefined, digits = 2): string =>
  v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/**
 * Static, accessible HTML report.
 *
 * No JavaScript framework and no client-side scripting. Distributions are
 * rendered as data tables rather than canvas charts, so the data is available
 * to screen readers and to anyone copying it out.
 */
export function toHtml(result: BenchmarkResult): string {
  const byStep = groupByStep(result.scenarios);
  const failed = failedSteps(result.scenarios);
  const env = result.environment;
  const grid: GridIntensity | undefined = result.gridIntensity;

  const stepRows = [...byStep.entries()].map(([step, runs]) => {
    const energy = summarize(
      runs.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined),
    );
    const raw = summarize(
      runs.map((r) => r.energy?.raw.totalJoules).filter((v): v is number => v !== undefined),
    );
    const duration = summarize(runs.map((r) => r.timing.durationMs));
    const bytes = summarize(runs.map((r) => r.network?.transferBytes ?? Number.NaN));
    const co2 = summarize(runs.map((r) => r.co2?.estimatedGrams ?? Number.NaN));
    // Class C inherits the resolution of the energy it derives from. A step
    // below its own spread gets no carbon figure, because the medians there
    // are noise and are frequently negative.
    const resolvedEnergy = resolution(
      runs.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined),
    );
    const carbon =
      grid && energy.count > 0 && resolvedEnergy.resolved
        ? energyCarbon(joulesToMilliwattHours(energy.median), grid).micrograms
        : undefined;
    return { step, runs, energy, raw, duration, bytes, co2, carbon };
  });

  // One sample has no spread: its IQR is 0 by construction, which reads as
  // "perfectly stable" when it means "not estimated". crawl visits each page
  // once, so this is the common case there.
  const singleVisit = stepRows.some((r) => r.energy.count === 1);

  const energyValues = result.scenarios
    .filter((s) => !s.warmup && s.valid && s.energy?.incrementalJoules !== undefined)
    .map((s) => ({
      energy: s.energy!.incrementalJoules!,
      bytes: s.network?.transferBytes ?? Number.NaN,
      requests: s.network?.requests ?? Number.NaN,
      duration: s.timing.durationMs,
      co2: s.co2?.estimatedGrams ?? Number.NaN,
    }));

  const corr = (key: 'bytes' | 'requests' | 'duration' | 'co2'): number => {
    const pairs = energyValues.filter((v) => Number.isFinite(v[key]));
    return spearman(pairs.map((p) => p[key]), pairs.map((p) => p.energy));
  };

  const hasEnergy = stepRows.some((r) => r.energy.count > 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web energy benchmark — ${esc(result.target?.label ?? result.target?.url ?? result.session.id)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --muted:#555; --line:#d0d0d0; --accent:#0b5fff; --warn:#8a5300; --warnbg:#fff6e5; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --bg:#141414; --muted:#aaa; --line:#3a3a3a; --accent:#7aa7ff; --warn:#ffcf80; --warnbg:#3a2c10; }
  }
  body { font: 16px/1.55 system-ui, sans-serif; color: var(--fg); background: var(--bg);
         margin: 0 auto; max-width: 68rem; padding: 2rem 1rem; }
  h1,h2,h3 { line-height: 1.25; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  caption { text-align: left; font-weight: 600; padding-bottom: .5rem; }
  th, td { border: 1px solid var(--line); padding: .45rem .6rem; text-align: right; }
  th[scope="row"], td:first-child, th:first-child { text-align: left; }
  thead th { background: color-mix(in srgb, var(--fg) 8%, transparent); }
  .note { color: var(--muted); font-size: .92rem; }
  .warning { background: var(--warnbg); border-left: 4px solid var(--warn); padding: .75rem 1rem; margin: 1rem 0; }
  .boundary { border: 1px solid var(--line); border-left: 4px solid var(--accent); padding: 1rem; margin: 1.5rem 0; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
  dl.meta dt { color: var(--muted); }
  .scroll { overflow-x: auto; }
  code { font-size: .9em; }
</style>
</head>
<body>
<h1>Web energy benchmark</h1>
<p class="note">
  Session <code>${esc(result.session.id)}</code>, mode <code>${esc(result.session.mode)}</code>,
  generated ${esc(env.timestamp)}.
</p>

<section class="boundary" aria-labelledby="boundary-h">
  <h2 id="boundary-h">What these numbers mean</h2>
  <p>
    This report contains <strong>three different classes of sustainability indicator</strong>.
    They have different system boundaries and different units, and they are not interchangeable.
    The first two are always present. The third appears only when a grid intensity was declared.
  </p>
  <dl>
    <dt><strong>A. Modelled CO2e (CO2.js)</strong></dt>
    <dd>Estimated emissions derived from transferred bytes and model assumptions. Not a measurement.</dd>
    <dt><strong>B. Observed client energy (Firefox power counters)</strong></dt>
    <dd>
      Energy drawn by Firefox processes on this client machine during the workload.
      Scope is the browser's processes — not the display, not the server, and not the network.
    </dd>
    <dt><strong>C. Grid-derived carbon (from B, not from A)</strong></dt>
    <dd>
      Carbon implied by the electricity measured in B, at a grid intensity declared by the
      operator. It is derived from observed energy and carries that assumption with it.
      It is <strong>not</strong> a conversion of the CO2.js estimate, and the CO2.js estimate is
      never converted into it.
    </dd>
  </dl>
  <p>
    The measurement boundary is the <strong>client machine only</strong>. These results do not
    measure server, PHP, database, data-centre, or whole-Internet energy, and they are not a
    total carbon figure for the site.
  </p>
</section>

${
  result.warnings.length
    ? `<section aria-labelledby="warn-h"><h2 id="warn-h">Warnings</h2>${result.warnings
        .map((w) => `<p class="warning">${esc(w)}</p>`)
        .join('')}</section>`
    : ''
}

<section aria-labelledby="summary-h">
  <h2 id="summary-h">Per-step summary</h2>
  <p class="note">
    Median is the headline statistic. Warmup runs are excluded.
    ${hasEnergy ? 'Energy is incremental: measured energy minus the idle baseline estimate.' : 'No energy values were captured in this session.'}
    ${
      grid
        ? 'Client-energy CO2e is derived from that incremental energy at the declared grid intensity, and is left blank where the energy is below the resolution of this setup.'
        : ''
    }
    ${
      singleVisit
        ? 'Where a page was visited once, its spread cannot be estimated, so the IQR is shown as — rather than 0. With a single visit the resolution check has no spread to compare against, so treat that energy, and any carbon derived from it, as indicative: repeat the page with measure --runs before quoting either.'
        : ''
    }
  </p>
  <div class="scroll">
  <table>
    <caption>Measured steps (n = number of non-warmup runs)</caption>
    <thead>
      <tr>
        <th scope="col">Step</th><th scope="col">n</th>
        <th scope="col">Duration median (ms)</th>
        <th scope="col">Transfer median (KB)</th>
        <th scope="col">CO2.js median (mg)</th>
        <th scope="col">Incremental energy median (mWh)</th>
        <th scope="col">Energy IQR (mWh)</th>
        ${grid ? '<th scope="col">Client-energy CO2e (µg)</th>' : ''}
      </tr>
    </thead>
    <tbody>
      ${stepRows
        .map(
          (r) => `<tr>
        <th scope="row">${esc(r.step)}</th>
        <td>${r.duration.count}</td>
        <td>${num(r.duration.median, 0)}</td>
        <td>${num(r.bytes.median / 1024, 1)}</td>
        <td>${num(r.co2.median * 1000, 3)}</td>
        <td>${r.energy.count ? num(joulesToMilliwattHours(r.energy.median), 3) : '—'}</td>
        <td>${r.energy.count > 1 ? num(joulesToMilliwattHours(r.energy.iqr), 3) : '—'}</td>
        ${grid ? `<td>${formatMicrograms(r.carbon)}</td>` : ''}
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>
  </div>
</section>

${
  failed.length
    ? `<section aria-labelledby="failed-h">
  <h2 id="failed-h">Not measured</h2>
  <p class="note">No measured run of these steps succeeded, so they are left out of every table above.</p>
  <ul>${failed
    .map((f) => `<li><strong>${esc(f.step)}</strong><br>${esc(readableFailure(f.reason))}</li>`)
    .join('')}</ul>
</section>`
    : ''
}

<section aria-labelledby="compare-h">
  <h2 id="compare-h">Modelled CO2e versus observed energy</h2>
  <p class="note">
    Presented side by side in their own units. These columns are deliberately
    <strong>not</strong> summed or converted into one another.
  </p>
  <div class="scroll">
  <table>
    <caption>Model and measurement, per step</caption>
    <thead>
      <tr>
        <th scope="col">Step</th>
        <th scope="col">Transfer (KB)</th>
        <th scope="col">CO2.js total (mg)</th>
        <th scope="col">CO2.js device segment (mg)</th>
        <th scope="col">Observed energy (mWh)</th>
      </tr>
    </thead>
    <tbody>
      ${stepRows
        .map((r) => {
          const device = summarize(
            r.runs.map((x) => x.co2?.consumerDeviceGrams ?? Number.NaN),
          );
          return `<tr>
        <th scope="row">${esc(r.step)}</th>
        <td>${num(r.bytes.median / 1024, 1)}</td>
        <td>${num(r.co2.median * 1000, 3)}</td>
        <td>${device.count ? num(device.median * 1000, 3) : '—'}</td>
        <td>${r.energy.count ? num(joulesToMilliwattHours(r.energy.median), 3) : '—'}</td>
      </tr>`;
        })
        .join('')}
    </tbody>
  </table>
  </div>
  ${
    hasEnergy && energyValues.length >= 3
      ? `<table>
    <caption>Spearman rank correlation with observed incremental energy (n = ${energyValues.length} runs)</caption>
    <thead><tr><th scope="col">Variable</th><th scope="col">ρ</th></tr></thead>
    <tbody>
      <tr><th scope="row">Transferred bytes</th><td>${num(corr('bytes'), 3)}</td></tr>
      <tr><th scope="row">Request count</th><td>${num(corr('requests'), 3)}</td></tr>
      <tr><th scope="row">Step duration</th><td>${num(corr('duration'), 3)}</td></tr>
      <tr><th scope="row">CO2.js estimate</th><td>${num(corr('co2'), 3)}</td></tr>
    </tbody>
  </table>
  <p class="note">
    Spearman is used because these relationships are monotonic rather than
    necessarily linear, and the data is not assumed to be normally distributed.
  </p>`
      : '<p class="note">Not enough measured runs to report correlations.</p>'
  }
</section>

${
  grid
    ? `<section aria-labelledby="class-c-h">
  <h2 id="class-c-h">Carbon derived from observed energy</h2>
  <p>
    The <strong>Client-energy CO2e</strong> column is Class C. It multiplies the incremental
    client energy in this session by a declared grid carbon intensity, and by nothing else.
  </p>
  <p><code>µg CO2e = incremental energy (mWh) × grid intensity (gCO2e/kWh)</code></p>
  <p class="note">
    The two factors of one million cancel: a milliwatt-hour is one millionth of a
    kilowatt-hour, and a gram is one million micrograms. The conversion is a single
    multiplication, not a missing unit step.
  </p>
  <dl class="meta">
    <dt>Grid intensity</dt><dd>${esc(grid.gramsPerKwh)} gCO2e/kWh</dd>
    ${grid.zone ? `<dt>Zone</dt><dd>${esc(grid.zoneName ? `${grid.zoneName} (${grid.zone})` : grid.zone)}</dd>` : ''}
    <dt>Intensity kind</dt><dd>${esc(grid.kind)}</dd>
    ${grid.year !== undefined ? `<dt>Reference year</dt><dd>${esc(grid.year)}</dd>` : ''}
    <dt>Source</dt><dd>${esc(grid.source)}</dd>
  </dl>
  <div class="warning">
    <p>
      This figure is <strong>not comparable</strong> with the CO2.js column and does not replace
      it. CO2.js models datacentre, network and a generic device from transferred bytes. Class C
      derives carbon from the electricity one browser actually drew. They answer different
      questions and commonly differ by orders of magnitude.
    </p>
    <p>
      Steps whose incremental energy is smaller than its own run-to-run spread are shown as
      <code>—</code>. At that point the energy is indistinguishable from noise, and the median can
      be negative, which would produce a negative emission. A grid intensity is an assumption
      about where the machine was plugged in, not an observation, and an annual average is
      neither a marginal nor a real-time figure.
    </p>
  </div>
</section>`
    : ''
}

<section aria-labelledby="dist-h">
  <h2 id="dist-h">Distributions</h2>
  <p class="note">Full descriptive statistics, given as a table rather than a chart image.</p>
  <div class="scroll">
  <table>
    <caption>Incremental energy per step (mWh)</caption>
    <thead>
      <tr>
        <th scope="col">Step</th><th scope="col">n</th><th scope="col">min</th>
        <th scope="col">p25</th><th scope="col">median</th><th scope="col">p75</th>
        <th scope="col">p95</th><th scope="col">max</th><th scope="col">sd</th>
      </tr>
    </thead>
    <tbody>
      ${stepRows
        .filter((r) => r.energy.count > 0)
        .map((r) => {
          const m = (v: number) => num(joulesToMilliwattHours(v), 3);
          const s: Summary = r.energy;
          return `<tr><th scope="row">${esc(r.step)}</th><td>${s.count}</td>
            <td>${m(s.min)}</td><td>${m(s.p25)}</td><td>${m(s.median)}</td>
            <td>${m(s.p75)}</td><td>${m(s.p95)}</td><td>${m(s.max)}</td><td>${m(s.stdDev)}</td></tr>`;
        })
        .join('') || '<tr><td colspan="9">No energy data.</td></tr>'}
    </tbody>
  </table>
  </div>
</section>

${cruxSection(result.crux, result.lighthouse)}

${lighthouseSection(result.lighthouse)}

<section aria-labelledby="env-h">
  <h2 id="env-h">Environment</h2>
  <dl class="meta">
    <dt>OS</dt><dd>${esc(env.os)} ${esc(env.osVersion)} (${esc(env.architecture)})</dd>
    <dt>CPU count</dt><dd>${esc(env.cpuCount)}</dd>
    <dt>Firefox</dt><dd>${esc(env.firefoxVersion ?? 'unknown')}</dd>
    <dt>Playwright</dt><dd>${esc(env.playwrightVersion ?? 'unknown')}</dd>
    <dt>CO2.js</dt><dd>${esc(env.co2jsVersion ?? 'unknown')}</dd>
    <dt>Energy adapter</dt><dd>${esc(env.energyAdapter)}</dd>
    <dt>Browser mode</dt><dd>${env.headed ? 'headed' : 'headless'}</dd>
    <dt>Viewport</dt><dd>${esc(env.viewport.width)}×${esc(env.viewport.height)}</dd>
    <dt>Power source</dt><dd>${env.onBattery === undefined ? 'unknown' : env.onBattery ? 'battery' : 'AC'}</dd>
    <dt>Low Power Mode</dt><dd>${env.lowPowerMode === undefined ? 'unknown' : env.lowPowerMode ? 'ON — CPU throttled, energy suppressed' : 'off'}</dd>
  </dl>
  ${
    env.lowPowerMode || env.onBattery
      ? `<p class="warning">
      These measurements were taken
      ${env.onBattery ? 'on <strong>battery power</strong>' : ''}
      ${env.onBattery && env.lowPowerMode ? ' with ' : ''}
      ${env.lowPowerMode ? '<strong>Low Power Mode enabled</strong>' : ''}.
      Both change CPU and power-management behaviour. Compare these results only
      against runs made under the same conditions.
    </p>`
      : ''
  }
</section>

<section aria-labelledby="method-h">
  <h2 id="method-h">Methodology</h2>
  <p>
    Energy is attributed to a step by <strong>time window</strong>: the harness records
    wall-clock boundaries and integrates Firefox's power counters over that range.
    Any concurrent browser activity inside the window is included. Counter samples are
    picowatt-hours, converted with <code>joules = pWh × 1e-12 × 3600</code>.
  </p>
  <p>
    Baseline correction retains all three values — raw measured energy, the estimated idle
    energy, and the incremental difference. Negative incremental values are reported as-is
    and flagged as noisy rather than clamped to zero.
  </p>
  <p>
    Class C is opt-in. It is omitted entirely unless a grid intensity was declared for the
    session, and it is derived from Class B only — the CO2.js estimate is never converted,
    summed or averaged with anything. See <code>docs/methodology.md</code>.
  </p>
</section>
</body>
</html>
`;
}
