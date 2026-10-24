import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/**
 * The web form pre-fills the issue template by option label. A label that
 * drifts from the template makes GitHub silently fall back to the default
 * option, so the request runs with settings nobody chose.
 */
describe('web form and issue template agree', () => {
  const app = readFileSync('site/app.js', 'utf8');
  const match = /const LABELS = (\{[\s\S]*?\n {2}\});/.exec(app);
  const labels = new Function(`return ${match?.[1]}`)() as Record<string, Record<string, string>>;
  const tpl = parse(readFileSync('.github/ISSUE_TEMPLATE/scan-request.yml', 'utf8')) as {
    body: { id?: string; attributes: { options?: string[] } }[];
  };
  const options = (id: string) => tpl.body.find((b) => b.id === id)?.attributes.options ?? [];

  it('finds the labels in app.js', () => {
    expect(match).not.toBeNull();
  });

  it.each(['lighthouse', 'what', 'where'])('every %s label the form sends is a template option', (id) => {
    expect(Object.values(labels[id]!).sort()).toEqual([...options(id)].sort());
  });

  it('every viewport the form offers is a template option', () => {
    const html = readFileSync('site/index.html', 'utf8');
    const select = /<select id="viewport"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
    const values = [...select.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(options('viewport'));
  });
});
