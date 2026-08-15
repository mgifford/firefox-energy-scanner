import { describe, it, expect } from 'vitest';
import {
  normalizeHtml,
  extractAssets,
  hashHtml,
  triage,
  type PayloadFingerprint,
} from '../src/cli/triage.js';

const fp = (over: Partial<PayloadFingerprint> = {}): PayloadFingerprint => ({
  url: 'https://e.com/',
  status: 200,
  htmlBytes: 1000,
  htmlHash: 'aaaa',
  scripts: ['/core.js'],
  styles: ['/base.css'],
  ...over,
});

describe('normalizeHtml', () => {
  it('strips CSRF tokens so two responses can be compared', () => {
    const a = '<a href="/user/logout?token=ABC">out</a>';
    const b = '<a href="/user/logout?token=XYZ">out</a>';
    expect(normalizeHtml(a)).toBe(normalizeHtml(b));
  });

  it('strips form_token and form_build_id', () => {
    const a = '<input name="form_token" value="aaa"><input name="form_build_id" value="bbb">';
    const b = '<input name="form_token" value="ccc"><input name="form_build_id" value="ddd">';
    expect(normalizeHtml(a)).toBe(normalizeHtml(b));
  });

  it('normalises ajaxPageState, which varies per request', () => {
    const a = '{"ajaxPageState":{"theme":"x","libraries":"abc"}}';
    const b = '{"ajaxPageState":{"theme":"y","libraries":"def"}}';
    expect(normalizeHtml(a)).toBe(normalizeHtml(b));
  });

  it('still distinguishes genuinely different markup', () => {
    expect(normalizeHtml('<p>one</p>')).not.toBe(normalizeHtml('<p>two</p>'));
  });
});

describe('extractAssets', () => {
  it('finds scripts and stylesheets', () => {
    const html =
      '<link rel="stylesheet" href="/a.css"><script src="/b.js"></script>';
    const { scripts, styles } = extractAssets(html, 'https://e.com/');
    expect(scripts).toEqual(['/b.js']);
    expect(styles).toEqual(['/a.css']);
  });

  it('drops cache-busting query strings', () => {
    const { scripts } = extractAssets('<script src="/b.js?v=123"></script>', 'https://e.com/');
    expect(scripts).toEqual(['/b.js']);
  });

  it('sorts output so ordering differences do not create false positives', () => {
    const one = extractAssets('<script src="/b.js"></script><script src="/a.js"></script>', 'https://e.com/');
    const two = extractAssets('<script src="/a.js"></script><script src="/b.js"></script>', 'https://e.com/');
    expect(one.scripts).toEqual(two.scripts);
  });

  it('ignores non-stylesheet link tags', () => {
    const { styles } = extractAssets('<link rel="icon" href="/f.ico">', 'https://e.com/');
    expect(styles).toEqual([]);
  });
});

describe('hashHtml', () => {
  it('is stable for equivalent markup', () => {
    expect(hashHtml('<p>x</p>')).toBe(hashHtml('<p>x</p>  '));
  });
});

describe('triage', () => {
  it('reports identical payloads as not worth measuring', () => {
    const v = triage(fp(), fp());
    expect(v.worthMeasuring).toBe(false);
    expect(v.htmlIdentical).toBe(true);
    expect(v.reasons[0]).toMatch(/cannot differ/);
  });

  it('flags an added script as worth measuring', () => {
    const v = triage(fp(), fp({ scripts: ['/core.js', '/extra.js'], htmlHash: 'bbbb' }));
    expect(v.worthMeasuring).toBe(true);
    expect(v.addedScripts).toEqual(['/extra.js']);
    expect(v.scriptsIdentical).toBe(false);
  });

  it('flags a removed stylesheet as worth measuring', () => {
    const v = triage(fp({ styles: ['/base.css', '/extra.css'] }), fp({ htmlHash: 'bbbb' }));
    expect(v.worthMeasuring).toBe(true);
    expect(v.removedStyles).toEqual(['/extra.css']);
  });

  it('flags differing markup even when assets match', () => {
    const v = triage(fp(), fp({ htmlHash: 'bbbb', htmlBytes: 1200 }));
    expect(v.worthMeasuring).toBe(true);
    expect(v.byteDelta).toBe(200);
  });

  /**
   * Two failed fetches are trivially "identical". Reporting that as a
   * confident negative would be actively misleading.
   */
  it('is inconclusive when a target returns a non-2xx status', () => {
    const v = triage(fp({ status: 404, htmlBytes: 0 }), fp({ status: 404, htmlBytes: 0 }));
    expect(v.worthMeasuring).toBe(false);
    expect(v.reasons[0]).toMatch(/^Inconclusive/);
    expect(v.reasons[1]).toMatch(/NOT evidence/);
  });

  it('is inconclusive when a fetch errored', () => {
    const v = triage(fp({ error: 'timeout' }), fp());
    expect(v.reasons[0]).toMatch(/^Inconclusive/);
  });

  it('is inconclusive on an empty body', () => {
    const v = triage(fp({ htmlBytes: 0 }), fp({ htmlBytes: 0 }));
    expect(v.reasons[0]).toMatch(/^Inconclusive/);
  });
});
