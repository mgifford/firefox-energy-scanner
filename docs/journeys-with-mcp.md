# Writing journeys with Playwright MCP

A journey is a benchmark workload: a user task with named measurement boundaries, run
the same way every time. [Playwright MCP](https://playwright.dev/docs/getting-started-mcp)
lets an AI assistant drive a browser from the page's accessibility tree. That makes it a
good way to **explore** a site and draft the steps of a task with semantic locators.

It is for authoring only. **Journeys run without a model**: the benchmark loop never
calls MCP. A model's choices vary from run to run, and the MCP server's own work would be
measured with the page's.

## 1. Set up the MCP server for exploration

`examples/mcp/playwright-mcp.json` configures it as follows:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--browser=firefox", "--isolated", "--caps=testing", "--codegen=typescript", "--output-dir=.mcp-output"]
    }
  }
}
```

- `--browser=firefox`: the browser the benchmark measures, so the page behaves the same.
- `--isolated`: a fresh, in-memory profile. Nothing persists between sessions and
  nothing leaks into a journey.
- `--caps=testing`: adds `browser_generate_locator` (a role-based locator for an element)
  and the `browser_verify_*` tools, which become the journey's checks.
- `--codegen=typescript`: each action comes back as Playwright code to copy.
- `--output-dir=.mcp-output`: keep it out of version control.

Keep these off:

- **`--save-session` and `--storage-state`**: they write or read cookies and tokens.
- **Any tool that runs arbitrary code** (`browser_run_code_unsafe`, where enabled). It
  is equivalent to running code on your machine.

`--allowed-origins` and `--blocked-origins` limit where the browser goes, but they are
**not a security boundary**. Explore only sites you are permitted to test.

## 2. Explore the task

Ask the assistant to do the task one step at a time, for example:

> Open https://example.org/events, filter by the "Ottawa" location, and open the first
> event. Use role-based locators.

MCP acts on the accessibility snapshot, so its locators are usually `getByRole`,
`getByLabel` and `getByText`. Where it falls back to a CSS selector, ask for
`browser_generate_locator` on that element, and for `browser_verify_element_visible` or
`browser_verify_text_visible` after each step, which become the checks.

**Never give credentials to the assistant.** Anything typed into the conversation is in
the model's context and its logs. For a task behind a login, explore it on a development
site with a throwaway account, or explore up to the login and write that part of
`setup()` by hand from environment variables.

## 3. Turn the code into a journey

Copy the generated steps into a `defineJourney()` file, following
`examples/journeys/home-idle.journey.js`:

```js
import { defineJourney } from '../../dist/core/journey.js';

export default defineJourney({
  name: 'events-filter',
  async setup({ page, baseUrl, env }) {
    // Outside the measured region. Secrets come from the environment only.
    if (env.SITE_USER) {
      await page.goto(new URL('/user/login', baseUrl).toString());
      await page.getByLabel('Username').fill(env.SITE_USER);
      await page.getByLabel('Password').fill(env.SITE_PASSWORD ?? '');
      await page.getByRole('button', { name: 'Log in' }).click();
      await page.waitForURL(/\/user\//);
    }
  },
  async run({ page, measure, url }) {
    await measure('open-events', async () => {
      await page.goto(url('/events'));
      await page.getByRole('heading', { name: 'Events' }).waitFor();
    });
    await measure('filter', async () => {
      await page.getByLabel('Location').selectOption('Ottawa');
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.getByRole('list', { name: 'Results' }).waitFor();
    });
  },
});
```

The rules, which `web-energy journey-check` looks for:

| Rule | Why |
| --- | --- |
| `defineJourney()` with `measure()` blocks | Each part of the task is a named measurement boundary; a Playwright test file is not a journey. |
| Setup in `setup()` | A login measured as part of the task would be counted in its energy. |
| Semantic locators | Roles, labels and visible text follow what people use, and survive markup changes. XPath is an error; CSS and position-based locators are warnings. |
| Explicit checks | `waitFor()`, `waitForURL()` or `expect()` after each step. A journey that silently fails measures the wrong thing. |
| No fixed waits | `waitForTimeout` only for an intentional idle window, named as one (`measure('idle', …)`, or a comment saying "intentional idle"). |
| No credentials or session data | Secrets come from `env` in `setup()`. Never a literal, a storage state file or cookies in the file. |
| Isolation | The runner gives each run its own browser and page; opening more makes runs depend on each other. |

## 4. Check it, then run it without MCP

```bash
node dist/cli/index.js journey-check journeys/events-filter.journey.js
node dist/cli/index.js journey journeys/events-filter.journey.js --url https://example.org --runs 10
```

`journey-check` exits 1 on any error. Commit the journey next to the experiments that use
it, so a result can always be traced to the exact workload that produced it.

## 5. Use it

- A/B between two builds: `compare --a … --b … --journey journeys/events-filter.journey.js`.
- An experiment on one change: `journey: journeys/events-filter.journey.js` in the spec
  (see [experiments.md](experiments.md)).
