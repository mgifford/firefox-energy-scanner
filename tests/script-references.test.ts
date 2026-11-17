import { describe, it, expect } from 'vitest';
import { scanScriptReferences } from '../src/collect/script-references.js';

describe('static script references', () => {
  it('finds getElementById and #id selectors once each', () => {
    const refs = scanScriptReferences(
      `const c = document.getElementById('chart'); const d = document.querySelector("#chart"); const e = document.querySelector('.chart');`,
    );
    expect(refs).toEqual([
      { kind: 'id', value: 'chart' },
      { kind: 'selector', value: '.chart' },
    ]);
  });

  it('does not invent a reference from unrelated text or a dynamically built selector', () => {
    expect(scanScriptReferences('const s = "getElementByIdLike"; const id = "chart"; document.getElementById(id);')).toEqual([]);
    expect(scanScriptReferences('const id = "chart"; document.getElementById(id); document.querySelector(`#${id}`);')).toEqual([]);
  });

  it('keeps the scan bounded', () => {
    const refs = scanScriptReferences(Array.from({ length: 100 }, (_, i) => `document.getElementById('id-${i}')`).join(';'));
    expect(refs).toHaveLength(30);
    expect(refs[0]).toEqual({ kind: 'id', value: 'id-0' });
  });
});
