/**
 * Static checks for a journey file, as written by hand or from Playwright
 * MCP's generated code. A journey is a benchmark workload: it must run the
 * same way every time, without a model in the loop, and keep its secrets out
 * of the file.
 *
 * Errors make a journey unfit to benchmark; warnings are worth fixing. The
 * checks read the source text, so they are heuristics: they catch the usual
 * mistakes, and say what they looked for.
 */

export interface JourneyIssue {
  level: 'error' | 'warning';
  rule: string;
  line?: number;
  message: string;
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

function each(src: string, re: RegExp, fn: (m: RegExpExecArray, line: number) => void) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = g.exec(src); m; m = g.exec(src)) fn(m, lineOf(src, m.index));
}

export function checkJourneySource(src: string): JourneyIssue[] {
  const issues: JourneyIssue[] = [];
  const lines = src.split('\n');

  if (!/defineJourney\s*\(/.test(src)) {
    issues.push({ level: 'error', rule: 'define-journey', message: 'The default export must come from defineJourney(); Playwright test files (test(…)) are not journeys. Move the steps into run().' });
  }
  if (/from\s+['"]@playwright\/test['"]|\btest\s*\(\s*['"`]/.test(src)) {
    issues.push({ level: 'error', rule: 'not-a-test', message: 'This is a Playwright test, not a journey: copy its steps into a defineJourney() run(), inside measure() blocks.' });
  }
  if (!/\bmeasure\s*\(\s*['"`]/.test(src)) {
    issues.push({ level: 'error', rule: 'measurement-boundary', message: 'No measure(\'name\', …) block: nothing would be measured. Wrap each part of the task to measure.' });
  }

  // Sleeps: only an intentional idle window, named as one.
  each(src, /\bwaitForTimeout\s*\(/, (_m, line) => {
    const text = lines[line - 1] ?? '';
    const context = lines.slice(Math.max(0, line - 4), line).join('\n');
    if (!/idle/i.test(text) && !/measure\s*\(\s*['"`][^'"`]*idle/i.test(context) && !/intentional idle/i.test(context)) {
      issues.push({ level: 'error', rule: 'no-sleep', line, message: 'A fixed wait that is not an idle window. Wait for a condition (an element, a URL, a response) instead, or measure it as idle inside measure(\'idle…\') with a comment saying so.' });
    }
  });
  each(src, /\bpage\.pause\s*\(/, (_m, line) => issues.push({ level: 'error', rule: 'no-pause', line, message: 'page.pause() opens the inspector and stops the run.' }));

  // Locators: by role, label or text, not by markup.
  each(src, /\.(locator|\$|\$\$|waitForSelector)\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/, (m, line) => {
    const sel = m[2] ?? m[3] ?? m[4] ?? '';
    if (/^(xpath=|\/\/)/.test(sel)) {
      issues.push({ level: 'error', rule: 'semantic-locators', line, message: `XPath locator "${sel}": use getByRole, getByLabel or getByText.` });
    } else if (!/^(role=|text=|internal:role|internal:label|internal:text)/.test(sel)) {
      issues.push({ level: 'warning', rule: 'semantic-locators', line, message: `CSS locator "${sel.slice(0, 60)}": prefer getByRole, getByLabel or getByText, which follow what people see and survive markup changes.` });
    }
  });
  each(src, /nth-child|:nth\(|\.nth\(\s*\d+\s*\)/, (_m, line) =>
    issues.push({ level: 'warning', rule: 'semantic-locators', line, message: 'A position-based locator: it breaks when content changes order.' }),
  );

  // Assertions: the workload must show it did what it says.
  if (!/\bexpect\s*\(|\.waitFor\s*\(|\bwaitForURL\s*\(|\bassert\b|toBeVisible|throw new Error/.test(src)) {
    issues.push({ level: 'warning', rule: 'assertions', message: 'No explicit check that the task succeeded (expect(), locator.waitFor(), page.waitForURL() or a thrown error). A journey that silently fails measures the wrong thing.' });
  }

  // Secrets: from the environment, never in the file.
  each(src, /\b(password|passwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*['"`][^'"`]{3,}['"`]/i, (_m, line) =>
    issues.push({ level: 'error', rule: 'no-credentials', line, message: 'A credential written into the file. Read it from the environment (env.MY_PASSWORD) in setup().' }),
  );
  each(src, /getByLabel\(\s*['"`][^'"`]*pass[^'"`]*['"`][^)]*\)\s*\.fill\(\s*['"`]/i, (_m, line) =>
    issues.push({ level: 'error', rule: 'no-credentials', line, message: 'A password typed from a literal. Use env.… in setup().' }),
  );
  each(src, /storageState|\.auth\/|cookies\s*:\s*\[/, (_m, line) =>
    issues.push({ level: 'warning', rule: 'no-session-data', line, message: 'Session state in the journey. Log in during setup() from environment variables; never commit a storage state file.' }),
  );
  // Logins belong in setup, outside the measured region.
  if (/getByLabel\([^)]*(pass|user|e-?mail)/i.test(src) && !/\bsetup\s*\(|async\s+setup\b|setup\s*:/.test(src)) {
    issues.push({ level: 'warning', rule: 'setup-boundary', message: 'Login steps outside setup(): they would be measured as part of the task.' });
  }
  // Isolation: nothing from a previous run or another tab.
  each(src, /\b(context\.newPage|browser\.newContext|launchPersistentContext)\b/, (_m, line) =>
    issues.push({ level: 'warning', rule: 'isolation', line, message: 'The runner gives each run its own browser and page; opening more makes runs depend on each other.' }),
  );

  return issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
