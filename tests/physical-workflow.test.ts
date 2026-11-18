import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, { 'runs-on'?: string | string[]; environment?: string; steps?: { run?: string }[] }>;
}

const doc = parseYaml(readFileSync('.github/workflows/physical-experiment.yml', 'utf8')) as Workflow;

describe('the manual physical experiment workflow', () => {
  it('is dispatch-only and cannot run on pull requests or pushes', () => {
    expect(doc.on?.workflow_dispatch).toBeTruthy();
    expect(doc.on?.pull_request).toBeUndefined();
    expect(doc.on?.push).toBeUndefined();
    const inputs = (doc.on?.workflow_dispatch as { inputs?: Record<string, { type?: string; options?: string[] }> }).inputs;
    expect(inputs?.spec?.type).toBe('choice');
    expect(inputs?.spec?.options?.every((p) => p.startsWith('examples/experiments/') && p.endsWith('.yaml'))).toBe(true);
    expect(inputs?.confirm?.type).toBe('string');
  });

  it('targets the dedicated physical runner and requires the approval environment', () => {
    expect(doc.jobs?.physical?.['runs-on']).toEqual(['self-hosted', 'macOS', 'ARM64', 'firefox-energy']);
    expect(doc.jobs?.physical?.environment).toBe('physical-energy');
  });

  it('runs only a committed spec, never a crawl or arbitrary URL', () => {
    const scripts = (doc.jobs?.physical?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(scripts).toContain('node dist/cli/index.js experiment --spec "$SPEC"');
    expect(scripts).not.toMatch(/--url|crawl|--also|--accessibility-context/);
    expect(scripts).toContain('examples/experiments/*.yaml');
    expect(scripts).toContain('RUN PHYSICAL EXPERIMENT');
  });
});
