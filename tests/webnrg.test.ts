import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ORIGIN,
  GATEWAY_SAVE_URL,
  USER_AGENT,
  VISIT_PHASE,
  SCROLL_PHASE,
  WEBNRG_FILENAME,
  findRecentRun,
  parsePhaseStats,
  renderingGrade,
  transferGrade,
  webnrgPage,
  type Fetch,
} from '../src/webnrg/client.js';
import { collectWebnrg, runWebnrg } from '../src/webnrg/run.js';
import { webnrgMarkdown } from '../src/webnrg/markdown.js';

/**
 * The webNRG protocol against a fake green-coding.io. Fixture shapes follow
 * GMT's api/scenario_runner.py (/v2/runs columns) and api_helpers.py
 * (phase_stats nesting), the same shapes webNRG's own page reads.
 */

const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-30T12:00:00Z');

/** One /v2/runs row, in GMT's column order. */
function runRow(id: string, page: string, opts: { finished?: boolean; failed?: boolean; created?: string } = {}) {
  return [
    id, `Website Test (${page})`, 'https://github.com/green-coding-solutions/green-metrics-tool', 'main',
    opts.created ?? '2026-10-20T08:00:00Z', 0, WEBNRG_FILENAME, { __GMT_VAR_PAGE__: page, __GMT_VAR_SLEEP__: '5' },
    'Micro Benchmarking - TX1330 M2', 'abc123', opts.finished === false ? null : 1_760_000_000_000_000,
    opts.failed ?? false, 6, null,
  ];
}

const metric = (unit: string, detail: string, runId: string, mean: number) => ({
  type: 'TOTAL',
  unit,
  data: { [detail]: { name: detail, data: { [runId]: { mean, max: mean, min: mean } } } },
});

/** A /v1/phase_stats/single body: 6 mWh, 3.98 W, 812 kB. */
function phaseStats(runId: string, energyUJ = 21_600_000) {
  return {
    success: true,
    data: {
      comparison_case: null,
      data: {
        '[BASELINE]': { hidden: false, data: {} },
        [VISIT_PHASE]: {
          hidden: false,
          data: {
            cpu_energy_rapl_msr_component: metric('uJ', 'Package_0', runId, energyUJ),
            cpu_power_rapl_msr_component: metric('mW', 'Package_0', runId, 3980),
            phase_time_syscall_system: metric('us', '[SYSTEM]', runId, 5_600_000),
            network_total_cgroup_container: metric('Bytes', 'gmt-playwright-nodejs', runId, 812_000),
            network_carbon_formula_global: metric('ugCO2e', '[FORMULA]', runId, 12_000),
            carbon_intensity_elephant_machine: metric('gCO2e/kWh', 'DE', runId, 334),
          },
        },
        [SCROLL_PHASE]: { hidden: false, data: { cpu_power_rapl_msr_component: metric('mW', 'Package_0', runId, 4200) } },
      },
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** A fake green-coding.io: handlers by URL prefix, every call recorded. */
function fakeApi(handlers: [string, (call: Call) => Response | Promise<Response>][]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    const h = handlers.find(([prefix]) => url.startsWith(prefix));
    if (!h) return new Response('no handler', { status: 599 });
    return h[1](call);
  }) as Fetch;
  return { fetch: fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

describe('webnrgPage', () => {
  it('spells URLs the way webNRG stores them', () => {
    expect(webnrgPage('https://a.org/')).toBe('https://a.org');
    expect(webnrgPage('https://a.org/about/')).toBe('https://a.org/about');
    expect(webnrgPage('http://a.org')).toBe('http://a.org');
    expect(webnrgPage('a.org/x')).toBe('https://a.org/x');
  });
});

describe('webNRG grades', () => {
  it('grades rendering energy in 25% steps above the ideal page', () => {
    expect(renderingGrade(4.0)).toBe('A+');
    expect(renderingGrade(4.6788194 * 1.25)).toBe('A');
    expect(renderingGrade(4.6788194 * 1.5)).toBe('B');
    expect(renderingGrade(4.6788194 * 2.25)).toBe('E');
    expect(renderingGrade(4.6788194 * 2.6)).toBe('F');
    expect(renderingGrade(0)).toBeUndefined();
  });

  it('grades transfer on the Sustainable Web Design bands', () => {
    expect(transferGrade(200)).toBe('A+');
    expect(transferGrade(531.15)).toBe('A');
    expect(transferGrade(812)).toBe('B');
    expect(transferGrade(2500)).toBe('F');
  });
});

describe('parsePhaseStats', () => {
  it('reads the visit phase in webNRG units', () => {
    expect(parsePhaseStats(phaseStats(RUN_A), RUN_A)).toEqual({
      cpuEnergyMwh: 6,
      cpuPowerW: 3.98,
      scrollPowerW: 4.2,
      durationS: 5.6,
      transferKb: 812,
      networkCarbonMg: 12,
      carbonIntensityG: 334,
      renderingGrade: 'A',
      transferGrade: 'B',
    });
  });

  it('refuses a run without the visit phase rather than inventing numbers', () => {
    expect(() => parsePhaseStats({ data: { data: {} } }, RUN_A)).toThrow(/no "Visit page/);
  });
});

describe('findRecentRun', () => {
  it('asks for finished webNRG runs of the last 30 days and keeps only an exact match', async () => {
    const api = fakeApi([
      ['https://api.green-coding.io/v2/runs', () => json({
        success: true,
        data: [
          runRow(RUN_B, 'https://a.org/about'), // ILIKE matches the longer URL too
          runRow('33333333-3333-4333-8333-333333333333', 'https://a.org', { finished: false }),
          runRow(RUN_A, 'https://a.org'),
        ],
      })],
    ]);
    const run = await findRecentRun('https://a.org', { fetch: api.fetch, now: NOW });
    expect(run?.runId).toBe(RUN_A);
    const q = new URL(api.calls[0]!.url).searchParams;
    expect(q.get('filename')).toBe(WEBNRG_FILENAME);
    expect(q.get('failed')).toBe('false');
    expect(q.get('usage_scenario_variables')).toBe('https://a.org');
    expect(q.get('start_date')).toBe('2026-09-30');
    expect(api.calls[0]!.headers['user-agent']).toBe(USER_AGENT);
  });

  it('returns nothing on 204', async () => {
    const api = fakeApi([['https://api.green-coding.io/v2/runs', noContent]]);
    expect(await findRecentRun('https://a.org', { fetch: api.fetch, now: NOW })).toBeUndefined();
  });
});

describe('runWebnrg', () => {
  it('reuses a recent run and requests one for a page without', async () => {
    const api = fakeApi([
      ['https://api.green-coding.io/v2/runs?uri=', (c) =>
        new URL(c.url).searchParams.get('usage_scenario_variables') === 'https://a.org'
          ? json({ success: true, data: [runRow(RUN_A, 'https://a.org')] })
          : noContent()],
      [`https://api.green-coding.io/v1/phase_stats/single/${RUN_A}`, () => json(phaseStats(RUN_A))],
      [GATEWAY_SAVE_URL, () => json({ success: true, data: { job_id: 4242 } })],
    ]);
    const summary = await runWebnrg(['https://a.org/', 'https://b.org/page/'], {
      fetch: api.fetch, submit: true, waitMinutes: 0, now: () => NOW,
    });

    expect(summary.machine).toBe('Micro Benchmarking - TX1330 M2');
    const [a, b] = summary.pages;
    expect(a).toMatchObject({ url: 'https://a.org/', page: 'https://a.org', status: 'reused', runId: RUN_A });
    expect(a!.metrics?.cpuEnergyMwh).toBe(6);
    expect(a!.statsUrl).toBe(`https://metrics.green-coding.io/stats.html?id=${RUN_A}`);
    expect(b).toMatchObject({ page: 'https://b.org/page', status: 'submitted', jobId: 4242 });
    expect(b!.detailsUrl).toBe('https://website-tester.green-coding.io/details.html?page=https%3A%2F%2Fb.org%2Fpage');

    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ email: '', page: 'https://b.org/page', mode: 'website', schedule_mode: 'one-off' });
    expect(post.headers.origin).toBe(DEFAULT_ORIGIN);
    expect(post.headers['user-agent']).toBe(USER_AGENT);
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('sends nothing at all for a local or private address', async () => {
    const api = fakeApi([]);
    const summary = await runWebnrg(['http://mysite.ddev.site/', 'http://localhost:8080/', 'http://192.168.1.10/'], {
      fetch: api.fetch, submit: true, waitMinutes: 0, now: () => NOW,
    });
    expect(summary.pages.map((p) => p.status)).toEqual(['failed', 'failed', 'failed']);
    expect(summary.pages[0]!.error).toMatch(/\.ddev\.site.*nothing was sent/);
    expect(api.calls).toEqual([]);
  });

  it('sends nothing in lookup-only mode', async () => {
    const api = fakeApi([['https://api.green-coding.io/v2/runs', noContent]]);
    const summary = await runWebnrg(['https://b.org/'], { fetch: api.fetch, submit: false, waitMinutes: 0, now: () => NOW });
    expect(summary.pages[0]!.status).toBe('not-requested');
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('records a gateway refusal with a hint instead of failing the scan', async () => {
    const api = fakeApi([
      ['https://api.green-coding.io/v2/runs', noContent],
      [GATEWAY_SAVE_URL, () => new Response('Access from not supported site', { status: 403 })],
    ]);
    const summary = await runWebnrg(['https://b.org/'], { fetch: api.fetch, submit: true, waitMinutes: 0, now: () => NOW });
    expect(summary.pages[0]!.status).toBe('failed');
    expect(summary.pages[0]!.error).toMatch(/HTTP 403: Access from not supported site \(the gateway did not accept our origin\)/);
  });

  it('waits for a requested run, through "not yet" answers, until it has figures', async () => {
    let jobPolls = 0;
    let statsPolls = 0;
    let clock = NOW.getTime();
    const api = fakeApi([
      ['https://api.green-coding.io/v2/runs?uri=', noContent],
      [GATEWAY_SAVE_URL, () => json({ data: { job_id: 7 } })],
      ['https://api.green-coding.io/v2/runs?job_id=7', () => {
        jobPolls++;
        if (jobPolls === 1) return noContent(); // queued
        if (jobPolls === 2) return json({ data: [runRow(RUN_B, 'https://b.org', { finished: false })] }); // running
        return json({ data: [runRow(RUN_B, 'https://b.org', { created: '2026-10-30T12:20:00Z' })] });
      }],
      [`https://api.green-coding.io/v1/phase_stats/single/${RUN_B}`, () => (++statsPolls === 1 ? noContent() : json(phaseStats(RUN_B, 36_000_000)))],
    ]);
    const summary = await runWebnrg(['https://b.org/'], {
      fetch: api.fetch, submit: true, waitMinutes: 30, pollSeconds: 60,
      now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
    });
    const b = summary.pages[0]!;
    expect(b.status).toBe('measured');
    expect(b.metrics?.cpuEnergyMwh).toBe(10);
    expect(b.metrics?.renderingGrade).toBe('D');
    expect(b.measuredAt).toBe('2026-10-30T12:20:00Z');
    // Once the run is known, only its figures are polled again.
    expect(jobPolls).toBe(3);
    expect(statsPolls).toBe(2);
  });

  it('stops waiting at the deadline and keeps the job for later', async () => {
    let clock = NOW.getTime();
    const api = fakeApi([
      ['https://api.green-coding.io/v2/runs?uri=', noContent],
      [GATEWAY_SAVE_URL, () => json({ data: { job_id: 8 } })],
      ['https://api.green-coding.io/v2/runs?job_id=8', noContent],
    ]);
    const summary = await runWebnrg(['https://b.org/'], {
      fetch: api.fetch, submit: true, waitMinutes: 5, pollSeconds: 60,
      now: () => new Date(clock), sleep: async (ms) => { clock += ms; },
    });
    expect(summary.pages[0]).toMatchObject({ status: 'submitted', jobId: 8 });
    expect(clock - NOW.getTime()).toBeLessThanOrEqual(5 * 60_000);
  });

  it('reports a run that failed on the cluster', async () => {
    const summary = {
      tool: 'webnrg' as const, boundary: '', phase: VISIT_PHASE, reuseDays: 30,
      pages: [{ url: 'https://b.org/', page: 'https://b.org', status: 'submitted' as const, jobId: 9, detailsUrl: '' }],
    };
    const api = fakeApi([['https://api.green-coding.io/v2/runs?job_id=9', () => json({ data: [runRow(RUN_B, 'https://b.org', { failed: true, finished: false })] })]]);
    await collectWebnrg(summary, { fetch: api.fetch, waitMinutes: 1, sleep: async () => {} });
    expect(summary.pages[0]).toMatchObject({ status: 'failed', runId: RUN_B, error: 'the measurement failed on the cluster' });
  });
});

describe('webnrgMarkdown', () => {
  const base = { tool: 'webnrg' as const, boundary: '', phase: VISIT_PHASE, reuseDays: 30, machine: 'Micro Benchmarking - TX1330 M2' };

  it('shows figures, grades and links for measured pages and a plain status for the rest', () => {
    const md = webnrgMarkdown({
      ...base,
      pages: [
        { url: 'https://a.org/', page: 'https://a.org', status: 'reused', runId: RUN_A, measuredAt: '2026-10-20T08:00:00Z',
          metrics: parsePhaseStats(phaseStats(RUN_A), RUN_A), detailsUrl: 'https://website-tester.green-coding.io/details.html?page=x', statsUrl: 'https://metrics.green-coding.io/stats.html?id=1' },
        { url: 'https://b.org/', page: 'https://b.org', status: 'submitted', jobId: 12, detailsUrl: 'https://website-tester.green-coding.io/details.html?page=y' },
        { url: 'https://c.org/', page: 'https://c.org', status: 'not-requested', detailsUrl: 'https://website-tester.green-coding.io/details.html?page=z' },
      ],
    }, { followUp: true });
    expect(md).toContain('| `https://a.org` | 6.00 mWh | 3.98 W | 812 kB | rendering A, transfer B | 2026-10-20 (reused) |');
    expect(md).toContain('| `https://b.org` | _requested (job 12); results to follow_ |');
    expect(md).toContain('_no webNRG result in the last 30 days_');
    expect(md).toContain('a follow-up comment will add them here');
    expect(md).toMatch(/never added to them or divided by them/);
  });

  it('keeps issue text and third-party errors inside code spans', () => {
    const md = webnrgMarkdown({
      ...base,
      pages: [{ url: 'x', page: 'https://a.org/a|b`c', status: 'failed', error: 'bad\n| injected @someone `x`', detailsUrl: 'd' }],
    });
    const rowLine = md.split('\n').find((l) => l.includes('a.org'))!;
    expect(rowLine).toContain('`https://a.org/a\\|b\'c`');
    expect(rowLine).toContain("`bad \\| injected @someone 'x'`");
    expect(rowLine.split('\n')).toHaveLength(1);
  });
});

describe('webnrgSection (HTML report)', () => {
  it('escapes page text and links only to green-coding.io', async () => {
    const { webnrgSection } = await import('../src/report/webnrg-html.js');
    const html = webnrgSection({
      tool: 'webnrg', boundary: 'Lab run.', phase: VISIT_PHASE, reuseDays: 30,
      pages: [
        { url: 'x', page: 'https://a.org/<b>', status: 'reused', runId: RUN_A, measuredAt: '2026-10-20T08:00:00Z',
          metrics: parsePhaseStats(phaseStats(RUN_A), RUN_A), detailsUrl: 'https://website-tester.green-coding.io/details.html?page=a',
          statsUrl: `https://metrics.green-coding.io/stats.html?id=${RUN_A}` },
        { url: 'y', page: 'https://b.org', status: 'failed', error: '<script>', detailsUrl: 'javascript:alert(1)' },
      ],
    });
    expect(html).toContain(`<a href="https://metrics.green-coding.io/stats.html?id=${RUN_A}">https://a.org/&lt;b&gt;</a>`);
    expect(html).toContain('6.00 mWh');
    expect(html).toContain('failed: &lt;script&gt;');
    expect(html).not.toContain('javascript:');
    expect(webnrgSection(undefined)).toBe('');
  });
});
