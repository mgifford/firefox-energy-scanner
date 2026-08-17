import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import ts from 'typescript';

/**
 * Static checks on the inline scripts embedded in GitHub workflows.
 *
 * These scripts only ever execute on a runner, so a typo in one is invisible
 * locally and costs a full CI round trip to discover. Two such bugs shipped
 * before this existed: a `for...of` over an HTMLCollection that would not
 * compile, and a reference to an undefined `result` variable that failed the
 * comment step after a successful scan.
 *
 * The checks are deliberately simple — syntax, and identifiers that are used
 * without ever being declared — because that is the class of mistake that
 * actually occurred.
 */

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: { script?: string };
  run?: string;
}

interface Workflow {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

const WORKFLOWS = [
  '.github/workflows/scan-request.yml',
  '.github/workflows/deploy-pages.yml',
];

function githubScriptSteps(): { workflow: string; step: string; script: string }[] {
  const found: { workflow: string; step: string; script: string }[] = [];
  for (const path of WORKFLOWS) {
    let doc: Workflow;
    try {
      doc = parseYaml(readFileSync(path, 'utf8')) as Workflow;
    } catch {
      continue;
    }
    for (const [, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/github-script') && step.with?.script) {
          found.push({
            workflow: path,
            step: step.name ?? '(unnamed)',
            script: step.with.script,
          });
        }
      }
    }
  }
  return found;
}

/** Replace `${{ ... }}` with a string literal so the script can be parsed. */
function substituteExpressions(script: string): string {
  return script.replace(/\$\{\{[^}]*\}\}/g, 'EXPR');
}

describe('workflow github-script steps', () => {
  const steps = githubScriptSteps();

  it('finds the scripts to check', () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  it.each(steps.map((s) => [s.step, s] as const))(
    'parses as valid JavaScript: %s',
    (_name, entry) => {
      const source = substituteExpressions(entry.script);
      // github-script wraps the body in an async function, so top-level await
      // is legal there but not in a bare script. Wrap it the same way.
      expect(() => new Function(`return (async () => {\n${source}\n})`)).not.toThrow();
    },
  );

  /**
   * Regression: the comment step referenced `result.scenarios`, but the
   * variable holding the parsed index is called `entry`. Nothing local caught
   * it, and the step failed only after a full scan had completed.
   *
   * Uses the TypeScript compiler rather than regexes: hand-rolled identifier
   * matching produced false positives on arrow-function parameters, and
   * chasing those with more regexes is a losing game against the grammar.
   */
  it.each(steps.map((s) => [s.step, s] as const))(
    'declares every local identifier it uses: %s',
    (_name, entry) => {
      const source = substituteExpressions(entry.script);
      const sf = ts.createSourceFile('script.js', source, ts.ScriptTarget.ES2022, true);

      // Identifiers provided by the github-script runtime or the JS globals.
      const provided = new Set([
        'github', 'context', 'core', 'io', 'exec', 'fetch', 'require',
        'console', 'process', 'JSON', 'Object', 'Array', 'String', 'Number',
        'Boolean', 'Math', 'Date', 'Error', 'Promise', 'Set', 'Map', 'RegExp',
        'undefined', 'EXPR', 'globalThis', 'Infinity', 'NaN', 'parseInt',
        'parseFloat', 'isNaN', 'Symbol', 'BigInt', 'Buffer', 'URL',
      ]);

      const declared = new Set<string>(provided);
      const used = new Map<string, number>();

      const collectBinding = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
          declared.add(name.text);
        } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
          for (const el of name.elements) {
            if (ts.isBindingElement(el)) collectBinding(el.name);
          }
        }
      };

      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
          collectBinding(node.name);
        }
        if (ts.isFunctionDeclaration(node) && node.name) declared.add(node.name.text);
        if (ts.isCatchClause(node) && node.variableDeclaration) {
          collectBinding(node.variableDeclaration.name);
        }

        // Record identifier reads, skipping property names and object keys.
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          const isPropertyAccess =
            parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
          const isPropertyName =
            parent && ts.isPropertyAssignment(parent) && parent.name === node;
          const isShorthandKey = parent && ts.isShorthandPropertyAssignment(parent);
          if (!isPropertyAccess && !isPropertyName && !isShorthandKey) {
            used.set(node.text, (used.get(node.text) ?? 0) + 1);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

      const undeclared = [...used.keys()].filter((name) => !declared.has(name)).sort();
      expect(undeclared).toEqual([]);
    },
  );
});
