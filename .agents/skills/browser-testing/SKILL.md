---
name: browser-testing
description: Methodology for writing and maintaining DorkOS browser tests. Use when writing, running, debugging, or maintaining Playwright browser tests in apps/e2e, when deciding between a browser test and a unit test, or when e2e behavior needs verification.
---

# Browser Testing Methodology

## 1. When to Write a Browser Test vs Unit Test

**Browser test (Playwright):**

- Cross-component flows (sidebar click updates chat panel)
- SSE streaming verification (message send → streaming indicator → response rendered)
- Real API calls through the full stack (client → Express → Agent SDK)
- CSS/layout regressions visible only in a real browser
- Browser-specific behavior (keyboard shortcuts, focus management)

**Unit test (Vitest):**

- Individual component rendering and props
- Hook logic and state transitions
- Service functions and data transformations
- Schema validation (Zod)
- Pure utility functions

**Rule of thumb:** If the behavior spans multiple FSD layers or requires a real server, it's a browser test.

## 2. Page Object Model Patterns

POMs live in `apps/e2e/pages/` and are injected as Playwright fixtures via `fixtures/index.ts`.

Each POM encapsulates locators and interaction methods for one page or component:

```typescript
// apps/e2e/pages/FeaturePage.ts
import type { Page, Locator } from '@playwright/test';

export class FeaturePage {
  readonly page: Page;
  readonly primaryAction: Locator;

  constructor(page: Page) {
    this.page = page;
    this.primaryAction = page.getByRole('button', { name: /action/i });
  }

  async doAction() {
    await this.primaryAction.click();
  }
}
```

Register in fixtures:

```typescript
// apps/e2e/fixtures/index.ts
import { test as base } from '@playwright/test';
import { FeaturePage } from '../pages/FeaturePage';

export const test = base.extend<{ featurePage: FeaturePage }>({
  featurePage: async ({ page }, use) => {
    await use(new FeaturePage(page));
  },
});
```

Test files import from fixtures, never from `@playwright/test` directly:

```typescript
import { test, expect } from '../../fixtures';
```

## 3. Selector Strategy

Priority order:

1. **`getByRole()`** — Best: semantic, resilient to UI changes

   ```typescript
   page.getByRole('button', { name: /send/i });
   page.getByRole('textbox', { name: /message/i });
   page.getByRole('tab', { name: /settings/i });
   ```

2. **`data-testid`** — Good: stable contract between test and implementation

   ```typescript
   page.locator('[data-testid="chat-panel"]');
   page.locator('[data-testid="message-item"][data-role="assistant"]');
   ```

3. **CSS class** — Last resort: fragile, breaks on styling changes. Avoid unless no other option.

## 4. Wait Strategy

**Never** use `page.waitForTimeout()` or `setTimeout`. These are flaky and slow.

Instead:

- **Element visibility**: `locator.waitFor({ state: 'visible' })`
- **Element disappearance**: `locator.waitFor({ state: 'hidden' })`
- **Streaming responses**: Wait for inference indicator lifecycle
  ```typescript
  await page
    .locator('[data-testid="inference-indicator-streaming"]')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {});
  await page
    .locator('[data-testid="inference-indicator-streaming"]')
    .waitFor({ state: 'hidden', timeout: 60_000 });
  ```
- **Navigation**: `await expect(page).toHaveURL(/session=/)`
- **API calls**: `await page.waitForResponse(resp => resp.url().includes('/api/sessions'))`

## 5. Test Tagging

- **`@smoke`** — Critical path tests, no SDK dependency, fast (<5s)
- **`@integration`** — SDK-dependent tests, require `ANTHROPIC_API_KEY`, slower (10-60s)

Add tags to `test.describe()` titles:

```typescript
test.describe('Feature — Description @smoke', () => { ... });
```

Run by tag: `npx playwright test --grep @smoke`

## 6. Debugging Methodology

1. **Reproduce**: Run the failing test with `PWDEBUG=1` or `--trace on`
2. **Snapshot**: Use Playwright MCP `browser_snapshot` to capture the current accessibility tree
3. **Compare**: Check if expected elements still exist with expected attributes
4. **Classify**: Is it a TEST bug or CODE bug?
   - **TEST bug**: Selector changed, timing issue, new UI pattern → update POM/spec
   - **CODE bug**: Feature regression, broken logic → fix source code
5. **Fix**: If test bug, update the POM/spec. If code bug, fix the source and ask the user first

## 7. Manifest Management

`apps/e2e/manifest.json` is automatically updated by the custom reporter (`apps/e2e/reporters/manifest-reporter.ts`) after each run. It is **gitignored** (DOR-726) — every run rewrites its run-stats fields, so it regenerates from nothing rather than staying tracked. `apps/e2e/manifest-curated.json` is the tracked half: just `relatedCode`/`explorationNotes`, which the reporter merges back into `manifest.json` on every write, so curating a test survives a `manifest.json` that starts from scratch. Edit the curated file by hand when you set either field for a test; don't hand-edit `manifest.json`, the next run overwrites it.

- Test entries keyed by spec filename (e.g., `send-message`)
- `specFile`/`feature` refresh from every run that saw the file, so a spec that moves directories is never left pointing at a path that no longer exists
- Run history capped at 100 entries
- `/browsertest report` reads this file for health dashboards
- `/browsertest:maintain` uses `relatedCode` + `lastRun` for stale detection

**`description` is derived, not curated — never hand-edit it.** It is a join of the file's own test titles, kept in sync automatically: **never** touched by a filtered run (`-g`, `--shard`, `.only`), because that view is partial and would collapse the description to whatever titles the filter happened to match. A full, unfiltered run only refreshes it when `E2E_REFRESH_MANIFEST=1` is set (the `e2e` package script sets it; CI's sharded runs never qualify) — so renaming a test's title is enough, but only a run that both opts in and sees the whole file will pick the rename up. Curated, hand-written context — selectors, timing quirks, gotchas specific to a test — belongs in `explorationNotes`, which the reporter never touches.

## 8. DorkOS-Specific Patterns

**SSE stream testing:** DorkOS uses Server-Sent Events for real-time updates. Test by sending a message and waiting for the inference indicator lifecycle (visible → hidden). The indicator has three testids: `inference-indicator-streaming`, `inference-indicator-waiting`, `inference-indicator-complete`.

**Session URL state:** Sessions are tracked via `?session=` URL parameter. After creating a new session, verify the URL updates: `await expect(page).toHaveURL(/session=/)`.

**Multi-panel layout:** The app has a sidebar + main panel layout. Some interactions affect both panels (e.g., clicking a session in sidebar updates chat panel). Test these cross-panel flows with browser tests, not unit tests.

**Settings dialog:** Opens as a modal overlay. Use `Escape` key or click-outside to close. The dialog has `data-testid="settings-dialog"`.

**Feature-Sliced Design alignment:** Test directories mirror FSD features: `tests/chat/`, `tests/session-list/`, `tests/settings/`, `tests/pulse/`, etc.

## 9. Learning Methodology

This section guides the exploration phase of test creation — the "learn by doing" loop that discovers selectors and timing through real interaction rather than guessing.

### What to Observe During Navigation

At each snapshot, look for:

- **Element hierarchy**: parent containers, list structures, nested components
- **State transitions**: loading spinners, skeleton screens, empty states → populated states
- **Conditional rendering**: elements that appear only after an action (modals, toasts, dropdowns)
- **Keyboard accessibility**: focus order, aria-expanded, aria-selected attributes
- **Dynamic IDs**: elements with generated IDs or keys that change between runs

### Evaluating Selectors at Each Snapshot

For every element you plan to interact with or assert against:

1. **First choice — `getByRole()`**: Check the element's role and accessible name in the snapshot. Prefer `{ name: /pattern/i }` for resilience.
2. **Second choice — `data-testid`**: If the role is generic (div, span) or the name is dynamic, check for a testid attribute.
3. **Third choice — `getByText()`**: Only for static, stable text content. Never for timestamps, counts, or user-generated content.
4. **Avoid**: CSS classes, XPath, nth-child — these break on any styling or layout change.

### When to Stop Exploring

- You have observed every state transition the test description requires
- You have confirmed selectors for all elements you will interact with or assert
- You have identified the timing characteristics (immediate render vs async load) of each assertion target
- **Stop here** — do not explore adjacent features or "nice to have" flows

### Handling DorkOS Dynamic Content

- **SSE streams**: Messages arrive via Server-Sent Events. The inference indicator (`data-testid="inference-indicator-streaming"`) signals when streaming is active. Always wait for it to reach `hidden` before asserting message content.
- **Optimistic updates**: Some UI updates appear before server confirmation. Re-locate elements after mutations rather than holding stale references.
- **Session side effects**: Creating or switching sessions triggers URL changes, sidebar re-renders, and SSE reconnections. Allow these to settle before proceeding.

### Building on Previous Knowledge

Before writing a new test:

1. **Read `GOTCHAS.md`** — avoid repeating known mistakes.
2. **Check `explorationNotes`** in `manifest.json` for related tests — reuse timing strategies and selector patterns.
3. **Review existing POMs** — extend them rather than creating parallel locator definitions for the same elements.

## 10. Mock Browser Tests (TestModeRuntime)

For browser tests that don't need real Claude API responses, use the `chromium-mock` Playwright project. This runs against a server started with `DORKOS_TEST_RUNTIME=true`, which registers `TestModeRuntime` instead of `ClaudeCodeRuntime`.

**Before each test**, configure the scenario via the control API:

```typescript
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
await request.post(`http://localhost:${MOCK_PORT}/api/test/scenario`, {
  data: { name: 'simple-text' }, // or 'tool-call', 'todo-write', 'error'
});
```

**Reset between tests** with `POST /api/test/reset` to return to the default scenario.

Mock tests import from `@playwright/test` directly (not fixtures) and use `ChatPage` from `pages/ChatPage.ts`. They live in `tests/chat-mock.spec.ts` and are matched by `testMatch: ['**/chat-mock.spec.ts']` in the `chromium-mock` project config.

The mock Vite client runs on port 4248 (proxying to the mock server on 4243), keeping it clear of the cockpit leg's own pair (4245 API / 4244 Vite, `DORKOS_COCKPIT_PORT` / `DORKOS_COCKPIT_VITE_PORT`). Every leg keeps its data in a throwaway `DORK_HOME` under `/tmp`, keyed by its port and deleted before every boot, so no run reads or writes the dev data directory or a real `~/.dork` (DOR-1223).
