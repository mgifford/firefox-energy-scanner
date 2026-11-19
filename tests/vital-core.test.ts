import { describe, it, expect } from 'vitest';
import { stringify as toYaml, parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import {
  loadVitalDocument,
  parseVitalDocument,
  selectVitalCandidate,
  specFromVitalCandidate,
  VitalHandoffError,
} from '../src/experiments/vital-core.js';
import { parseSpec } from '../src/experiments/experiment.js';

const SNAPSHOT = 'tests/fixtures/vital/snapshot.json';
const STANDALONE = 'tests/fixtures/vital/investigation.json';
const source = { label: SNAPSHOT, sha256: 'a'.repeat(64) };

describe('the Vital Core handoff', () => {
  it('maps a third-party resource to a block-hosts spec on the inventory’s example page', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    const { spec, reason } = specFromVitalCandidate(doc, 'third-party-resource:https://cdn.example.net/widget.js');
    expect(spec).toMatchObject({
      kind: 'block',
      hosts: ['cdn.example.net'],
      url: 'https://example.gov/a',
      runs: 10,
      warmups: 2,
      assertions: [{ role: 'main' }],
    });
    expect(spec.urls).toBeUndefined();
    expect(spec.selector).toBeUndefined();
    expect(spec.note).toMatch(/Vital Core candidate/);
    expect(spec.note).toMatch(/sha256 [a-f0-9]{64}/);
    expect(spec.note).toMatch(/upper bound/i);
    expect(reason).toMatch(/block host cdn\.example\.net/);
    expect(parseSpec(spec)).toEqual(spec);
    expect(parseSpec(spec).note).toMatch(/Vital Core candidate/);
    expect(toYaml(spec)).toContain('note:');
  });

  it('maps render-blocking and shared resources to block-urls specs, preserving the exact URL', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    for (const [id, url, page] of [
      ['render-blocking:https://example.gov/css/site.css', 'https://example.gov/css/site.css', 'https://example.gov/b'],
      ['shared-resource:https://example.gov/js/shared.js', 'https://example.gov/js/shared.js', 'https://example.gov/c'],
    ] as const) {
      const { spec } = specFromVitalCandidate(doc, id);
      expect(spec).toMatchObject({ kind: 'block', urls: [url], url: page });
      expect(spec.hosts).toBeUndefined();
      expect(spec.selector).toBeUndefined();
    }
  });

  it('maps a published component selector to the least destructive component experiment', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    const { spec } = specFromVitalCandidate(doc, 'component:hero');
    expect(spec).toMatchObject({ kind: 'hide', selector: '[data-component-id="hero"]', url: 'https://example.gov/d' });
    expect(spec.note).toMatch(/least destructive|hide/i);
  });

  it('accepts a standalone performance-investigation/1 document with its own page', async () => {
    const doc = await loadVitalDocument(STANDALONE);
    expect(doc.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    const { spec } = specFromVitalCandidate(doc, 'third-party-resource:https://cdn.example.net/widget.js');
    expect(spec).toMatchObject({ kind: 'block', hosts: ['cdn.example.net'], url: 'https://example.gov/standalone' });
  });

  it('fails clearly on an unknown candidate ID', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    expect(() => selectVitalCandidate(doc, 'not-a-candidate')).toThrow(/No Vital Core candidate/);
  });

  it('fails clearly when no representative page can be found', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    expect(() => specFromVitalCandidate(doc, 'render-blocking:https://example.gov/no-example.js')).toThrow(/no representative page URL/);
  });

  it('rejects page-only candidates with a compatibility reason, not an invented selector', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    for (const id of [
      'slow-page:example',
      'page-family:example',
      'regression:example',
      'lighthouse-recommendation:unused-css',
    ]) {
      expect(() => specFromVitalCandidate(doc, id)).toThrow(/no compatible Firefox experiment/);
      expect(() => specFromVitalCandidate(doc, id)).toThrow(/machine-readable experiment field/);
    }
  });

  it('rejects an unsupported category', async () => {
    const doc = await loadVitalDocument(SNAPSHOT);
    expect(() => specFromVitalCandidate(doc, 'future:unknown')).toThrow(/Unsupported Vital Core category/);
  });

  it('rejects a malformed document before producing a spec', () => {
    expect(() => parseVitalDocument({}, source)).toThrow(/neither a Vital Core snapshot/);
    expect(() => parseVitalDocument({ performance: { investigations: { candidates: [] } } }, source)).toThrow(/schema/);
    expect(() => parseVitalDocument({ candidates: [] }, source)).toThrow(/no schema_version/);
    expect(() =>
      parseVitalDocument({ performance: { investigations: { schema_version: 'performance-investigation/2', candidates: [] } } }, source),
    ).toThrow(/Unsupported/);
    expect(() =>
      parseVitalDocument({ performance: { investigations: { schema_version: 'performance-investigation/1', candidates: [] } } }, source),
    ).toThrow(/no candidates/);
  });

  it('keeps the committed real candidate specs valid', () => {
    for (const [file, host] of [
      ['examples/experiments/vital-cms-driver-js-block.yaml', 'jsdelivr.net'],
      ['examples/experiments/vital-medicaid-gtag-block.yaml', 'googletagmanager.com'],
    ] as const) {
      const spec = parseSpec(parseYaml(readFileSync(file, 'utf8')));
      expect(spec).toMatchObject({ kind: 'block', hosts: [host], runs: 10, warmups: 2 });
      expect(spec.note).toMatch(/Vital Core candidate third-party-resource/);
      expect(spec.note).toMatch(/sha256 [a-f0-9]{64}/);
    }
  });

  it('reports an unsafe selector instead of placing it in a page', () => {
    const doc = parseVitalDocument(
      {
        performance: {
          investigations: {
            schema_version: 'performance-investigation/1',
            candidates: [
              {
                id: 'component:unsafe',
                category: 'shared-expensive-resource',
                page: { url: 'https://example.gov/x' },
                subject: { selector: 'body { display: none }' },
              },
            ],
          },
        },
      },
      source,
    );
    expect(() => specFromVitalCandidate(doc, 'component:unsafe')).toThrow(VitalHandoffError);
    expect(() => specFromVitalCandidate(doc, 'component:unsafe')).toThrow(/unsafe selector/);
  });
});
