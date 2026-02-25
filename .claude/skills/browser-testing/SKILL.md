---
name: browser-testing
description: Methodology for writing and maintaining DorkOS browser tests
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
   page.getByRole('button', { name: /send/i })
   page.getByRole('textbox', { name: /message/i })
   page.getByRole('tab', { name: /settings/i })
   ```

2. **`data-testid`** — Good: stable contract between test and implementation
   ```typescript
   page.locator('[data-testid="chat-panel"]')
   page.locator('[data-testid="message-item"][data-role="assistant"]')
   ```

3. **CSS class** — Last resort: fragile, breaks on styling changes. Avoid unless no other option.

## 4. Wait Strategy

**Never** use `page.waitForTimeout()` or `setTimeout`. These are flaky and slow.

Instead:

- **Element visibility**: `locator.waitFor({ state: 'visible' })`
- **Element disappearance**: `locator.waitFor({ state: 'hidden' })`
- **Streaming responses**: Wait for inference indicator lifecycle
  ```typescript
  await page.locator('[data-testid="inference-indicator-streaming"]')
    .waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  await page.locator('[data-testid="inference-indicator-streaming"]')
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

`apps/e2e/manifest.json` is automatically updated by the custom reporter after each run.

- Test entries keyed by spec filename (e.g., `send-message`)
- Feature derived from first directory in test path (e.g., `chat`)
- Run history capped at 100 entries
- `/browsertest report` reads this file for health dashboards
- `/browsertest:maintain` uses `relatedCode` + `lastRun` for stale detection

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
