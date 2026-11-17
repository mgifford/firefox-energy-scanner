import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectPowerUnits, selectPowerUnits } from '../src/energy/gecko-profile.js';
import { buildTimeline } from '../src/energy/timeline.js';
import { detectSpikes } from '../src/energy/spikes.js';
import { linkSpikes, type ComponentLead, type TimelineAnalysis } from '../src/energy/spike-analysis.js';
import { timelineSection, commandFor } from '../src/report/timeline-html.js';
import { timelineCsv } from '../src/report/timeline-csv.js';
import { toHtml } from '../src/report/html.js';
import { buildFamilies } from '../src/analysis/families.js';
import { buildGraph } from '../src/model/graph.js';
import { validateTimelineAnalysis } from '../src/model/records-schema.js';
import type { BenchmarkResult } from '../src/core/types.js';

const T0 = 1_700_000_000_000;
const pwh = (j: number) => j / 3.6e-9;
/** A synthetic timeline: 1 W, with 3 W in idle from 6 s to 7.5 s, and a gap. Structure, not a measurement. */
function analysis(): TimelineAnalysis {
  const rows: number[][] = [];
  for (let t = 10; t <= 14_000; t += 10) {
    if (t > 12_000 && t <= 12_500) continue;
    const w = t > 6_000 && t <= 7_500 ? 3 : 1 + (((Math.ceil(t / 250) - 1) % 4) - 1.5) * 0.013;
    rows.push([t, pwh(w * 0.01)]);
  }
  const profile = { meta: { startTime: T0 }, counters: [{ name: 'Process Power', category: 'power', samples: { schema: { time: 0, count: 1 }, data: rows } }] };
  const t = buildTimeline(selectPowerUnits(collectPowerUnits(profile)), [
    { label: '__baseline__', startedAt: T0, endedAt: T0 + 4_000 },
    { label: 'run:0:load', startedAt: T0 + 4_500, endedAt: T0 + 5_500, actionEndedAt: T0 + 5_000 },
    { label: 'run:0:idle', startedAt: T0 + 5_500, endedAt: T0 + 14_000 },
  ], { binMs: 250, scenario: 'diagnose' })!;
  return { timeline: t, spikes: detectSpikes(t), page: 'http://www.site.test:8082/spinner' };
}

const fixture = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  r.families = buildFamilies(r.scenarios);
  r.traces = JSON.parse(readFileSync('tests/fixtures/fixture-site-traces.json', 'utf8'));
  r.graph = buildGraph(r)!;
  return r;
};

describe('the timeline in the report', () => {
  const r = fixture();
  const a = analysis();
  a.leads = linkSpikes(r, a, a.page!);
  r.timelines = [a];
  r.capture = { page: a.page!, capturedAt: '2026-11-16T00:00:00Z', selectorMatches: {}, resultFile: 'diagnose-x.json' };
  const html = timelineSection(r);

  it('shows an observed script relationship instead of “no component loads it”', () => {
    const a2 = analysis();
    a2.leads = {
      'spike-1': {
        spike: 'spike-1',
        observed: 'synthetic',
        activity: [],
        components: [],
        scripts: [
          {
            url: 'http://www.site.test:8082/js/chart.js',
            resource: 'rs-chart',
            loadedBy: [],
            functions: [{ name: 'frame', line: 2, samples: 12 }],
            evidence: [{ class: 'profiler-correlation', source: 'same-run-gecko', detail: 'on the stack' }],
            relatedComponents: [
              {
                instance: 'ci-live-chart',
                signature: 'component:live-chart',
                kind: 'script-observed-with-component',
                evidenceClass: 'profiler-correlation',
                confidence: 'medium',
                attributionStatus: 'supported',
              },
            ],
          },
        ],
        unattributed: [],
        caveats: ['Synthetic lead for the rendering test.'],
      },
    };
    expect(validateTimelineAnalysis(a2)).toEqual([]);
    const html = timelineSection({ ...r, timelines: [a2] });
    expect(html).toContain('observed with component:live-chart');
    expect(html).toContain('not ownership');
    expect(html).not.toContain('page-level: no component relationship established');
  });

  it('draws a chart with a text alternative, and the same values in tables, without scripts', () => {
    expect(html).toContain('<h2 id="timeline-h">Energy timeline</h2>');
    expect(html).toMatch(/<figure class="viz" aria-labelledby="tl-chart-0">\s*<svg role="group" aria-labelledby="tl-chart-0"/);
    expect(html).toContain('<caption>Measured steps on the timeline');
    expect(html).toContain('<caption>Intervals of elevated power, by energy above the reference (where to look, not defects)</caption>');
    expect(html).toContain('<caption>Energy and power per 250 ms bin; — is not measured, never zero</caption>');
    expect(html).not.toMatch(/<script|<canvas|onclick=/i);
    // The gap is drawn as a break, and its bins read "—", not 0.
    expect(html).toMatch(/<td>12\.00 s–12\.25 s<\/td><td>0<\/td><td>—<\/td><td>—<\/td>/);
  });

  it('links each interval in the chart to its details, with an accessible name', () => {
    expect(html).toMatch(/<a class="spike" href="#tl0-spike-1" aria-label="Interval 1: 6\.00 s to 7\.50 s, up to 3\.00 W, sustained">/);
    expect(html).toContain('<section id="tl0-spike-1" aria-labelledby="tl0-spike-1-h" class="boundary">');
    expect(html).toContain('<h4 id="tl0-spike-1-h">Interval 1: 6.00 s–7.50 s</h4>');
  });

  it('records the detection method, reference and resolution beside the chart', () => {
    expect(html).toContain('Method <code>robust-threshold-v1</code>, k 3.5');
    expect(html).toContain('Reference: baseline window');
    expect(html).toMatch(/250 ms bins \(asked for 250\)/);
  });

  it('does not treat an unchecked or ambiguous selector as verified', () => {
    expect(html).toContain('Selector not checked against the captured page: not verified.');
    const r2 = fixture();
    const a2 = analysis();
    a2.leads = linkSpikes(r2, a2, a2.page!);
    const spinner = Object.values(a2.leads)[0]!.components.find((c) => c.signature.includes('spinner'))!;
    r2.timelines = [a2];
    r2.capture = { page: a2.page!, capturedAt: 'x', selectorMatches: { [spinner.selector]: 3 } };
    expect(timelineSection(r2)).toContain('Matched 3 elements when the page was captured: ambiguous, not verified.');
  });

  it('offers experiment commands that change nothing on the live site', () => {
    expect(html).toContain('They change nothing on the live site.');
    expect(html).toMatch(/web-energy experiment http:\/\/www\.site\.test:8082\/spinner --kind remove --selector [^\n]+ --evidence diagnose-x\.json/);
    const c = { page: 'http://www.site.test:8082/x', selector: 'div.a', scripts: ['www.site.test/js/a.js', 'cdn.example/b.js'] } as ComponentLead;
    expect(commandFor('block', c)).toBe('web-energy experiment http://www.site.test:8082/x --kind block --block-url http://www.site.test:8082/js/a.js --block-url http://cdn.example/b.js --idle 10000 --runs 10 --warmups 2 --assert-role main');
    expect(commandFor('remove', { ...c, selector: "a[title='x']" })).toContain(`--selector 'a[title='\\''x'\\'']'`);
  });

  it('is part of the full report, and absent when there is no timeline', () => {
    expect(toHtml(r)).toContain('id="timeline-h"');
    expect(toHtml({ ...r, timelines: undefined })).not.toContain('id="timeline-h"');
  });

  it('writes the bins as CSV, with empty cells for what was not measured', () => {
    const csv = timelineCsv(a).trim().split('\n');
    expect(csv[0]).toBe('bin,start_ms,end_ms,samples,energy_j,average_power_w,phase,step,warmup,flags,interval');
    expect(csv.find((l) => l.startsWith('48,'))).toBe('48,12000,12250,0,,,idle,run:0:idle,false,no-samples,');
    expect(csv.some((l) => l.endsWith(',spike-1'))).toBe(true);
  });
});
