#!/usr/bin/env node
/**
 * The real webNRG round trip, against green-coding.io:
 *
 *   1. Read a result webNRG already has (no request sent).
 *   2. Look up, and if needed request, a measurement of this project's own
 *      site, then wait for it and read its figures.
 *   3. Look that page up again, which must reuse the run, not request one.
 *
 * Step 2 can use real time on Green Coding's free cluster, so this runs only
 * when asked (the webNRG live check workflow). Results are annotations, so
 * they show on the pull request and can be read through the API.
 *
 * Usage: node tests/e2e/webnrg-live.mjs   (after npm run build)
 */
import { runWebnrg } from '../../dist/webnrg/run.js';

const KNOWN = process.env.WEBNRG_KNOWN_PAGE || 'https://www.green-coding.io';
const OWN = process.env.WEBNRG_OWN_PAGE || 'https://mgifford.github.io/firefox-energy-scanner/';
const WAIT = Number(process.env.WEBNRG_WAIT_MINUTES || 45);

const annotate = (level, message) => {
  const line = message.replace(/\n/g, '%0A');
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=webnrg-live::${line}`);
  else console.log(`${level}: ${message}`);
};
const describe = (p) =>
  `${p.page}: ${p.status}` +
  (p.jobId !== undefined ? ` (job ${p.jobId})` : '') +
  (p.metrics ? ` | ${p.metrics.cpuEnergyMwh?.toFixed(2)} mWh, ${p.metrics.cpuPowerW?.toFixed(2)} W, ` +
    `${p.metrics.transferKb?.toFixed(0)} kB, grades ${p.metrics.renderingGrade}/${p.metrics.transferGrade}` : '') +
  (p.measuredAt ? ` | measured ${p.measuredAt}` : '') +
  (p.statsUrl ? ` | ${p.statsUrl}` : '') +
  (p.error ? ` | ${p.error}` : '');

let failed = false;

// 1. Reading only.
const known = await runWebnrg([KNOWN], { submit: false, waitMinutes: 0 });
const k = known.pages[0];
if (k.status === 'reused' && k.metrics?.cpuEnergyMwh > 0) {
  annotate('notice', `read path works. ${describe(k)}${known.machine ? ` | machine ${known.machine}` : ''}`);
} else if (k.status === 'not-requested') {
  annotate('warning', `no webNRG result for ${KNOWN} in the last 30 days, so the read path was not exercised.`);
} else {
  failed = true;
  annotate('error', `reading an existing result failed. ${describe(k)}`);
}

// 2. Request (only if webNRG has nothing recent) and wait.
const own = await runWebnrg([OWN], {
  submit: true,
  waitMinutes: WAIT,
  pollSeconds: 60,
  onProgress: (m) => console.log(m),
});
const o = own.pages[0];
if ((o.status === 'measured' || o.status === 'reused') && o.metrics?.cpuEnergyMwh > 0) {
  annotate('notice', `${o.status === 'measured' ? 'request path works' : 'reused a recent result, no request needed'}. ${describe(o)}`);
} else if (o.status === 'submitted') {
  annotate('warning', `the gateway accepted the request, but it had not finished after ${WAIT} minutes. ${describe(o)}`);
} else {
  failed = true;
  annotate('error', `requesting a measurement failed. ${describe(o)}`);
}

// 3. The 30-day reuse: once the page has a finished run, a lookup alone must
// find it, spelled the way webNRG stores it (no trailing slash).
if (o.status === 'measured' || o.status === 'reused') {
  const again = await runWebnrg([OWN], { submit: false, waitMinutes: 0 });
  const a = again.pages[0];
  if (a.status === 'reused' && a.runId === o.runId) {
    annotate('notice', `reuse path works: the lookup found run ${a.runId} without a new request.`);
  } else if (a.status === 'reused') {
    annotate('notice', `reuse path works (found a newer run). ${describe(a)}`);
  } else {
    failed = true;
    annotate('error', `the lookup did not find the run just measured. ${describe(a)}`);
  }
}

process.exit(failed ? 1 : 0);
