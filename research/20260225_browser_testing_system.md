---
title: "Browser Testing System — Research Findings"
date: 2026-02-25
type: implementation
status: active
tags: [browser-testing, playwright, e2e, testing, mcp]
feature_slug: browser-testing-system
---

# Browser Testing System — Research Findings

**Date**: 2026-02-25
**Mode**: Deep Research
**Searches performed**: 14
**Topic**: Playwright browser testing best practices for DorkOS monorepo

---

## Research Summary

Playwright is the clear choice for DorkOS browser testing, with first-class support for multi-server webServer config (Vite frontend + Express backend), feature-sliced test organization, fixture-based Page Objects, and a powerful AI integration layer via the `@playwright/mcp` MCP server. The recommended architecture is a dedicated `apps/e2e` workspace inside the monorepo with a feature-mirrored test directory, `test.extend()` fixtures for page objects, and a turbo `e2e` task with `--only` execution to avoid redundant builds.

---

## Key Findings

### 1. Multi-Server webServer Config

Playwright natively supports an **array** of `webServer` entries since v1.24. This is the correct approach for the DorkOS Vite + Express architecture:

```typescript
// apps/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  webServer: [
    {
      command: 'dotenv -- turbo dev --filter=@dorkos/server',
      url: 'http://localhost:6942/api/health',
      name: 'Express API',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
    },
    {
      command: 'dotenv -- turbo dev --filter=@dorkos/client',
      url: 'http://localhost:4241',
      name: 'Vite Client',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
    },
  ],
  use: {
    baseURL: 'http://localhost:4241',
  },
});
```

**Critical**: When `webServer` is an array, `use.baseURL` must always be set explicitly even if only one entry is present.

**`reuseExistingServer: !process.env.CI`** is the canonical pattern:
- Local dev: reuses your already-running `npm run dev` processes, so tests launch instantly
- CI: always spawns fresh servers to prevent state bleed between runs

The `url` property (not `port`) is preferred because Playwright polls with an HTTP GET and checks for any 2xx, 3xx, 400, 401, 402, or 403 response — meaning your health endpoint can return 200 and tests will start as soon as the server is ready.

The `wait` option (regex on stdout) is an alternative to `url` if you don't have a health endpoint: `wait: /ready on port/`.

### 2. Turborepo Integration

Turborepo's official Playwright guide recommends:

- **Separate `apps/e2e` workspace** — gives Playwright its own `package.json`, `playwright.config.ts`, and is independently installable
- **Use `--only` flag** when running e2e in isolation to bypass upstream build steps when you just want to run against an already-running server
- **Cache considerations**: E2e tests should NOT be cached by default — tests exercise real server behavior and caching produces false positives

Recommended `turbo.json` additions:

```json
{
  "tasks": {
    "e2e": {
      "dependsOn": ["^build"],
      "cache": false,
      "passThroughEnv": [
        "PLAYWRIGHT_BROWSERS_PATH",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
        "CI"
      ]
    },
    "e2e:ui": {
      "cache": false,
      "persistent": true
    }
  }
}
```

`passThroughEnv` (not `globalPassThroughEnv`) scopes the Playwright env vars to the e2e task only so they don't cause cache misses in unrelated tasks. Per the MEMORY.md entry on Turbo strict env mode, these vars must be explicitly declared.

**Key vars to pass through for e2e**:
- `PLAYWRIGHT_BROWSERS_PATH` — custom browser install location, irrelevant to cache
- `CI` — controls `reuseExistingServer` behavior
- `DORKOS_PORT` — already in `globalPassThroughEnv`, so available automatically

### 3. Page Object Model — Modern Patterns

The modern recommended approach is **POM via fixtures** (not direct class imports). The two patterns are:

**Pattern A — Direct Class Import (Legacy)**:
```typescript
// every test file
const chatPage = new ChatPage(page);
await chatPage.goto();
```
This works but pollutes test setup with `beforeEach` boilerplate and doesn't compose well.

**Pattern B — Fixture-based POM (Recommended)**:
```typescript
// fixtures.ts
import { test as base } from '@playwright/test';
import { ChatPage } from './pages/ChatPage';

export const test = base.extend<{ chatPage: ChatPage }>({
  chatPage: async ({ page }, use) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto();
    await use(chatPage);
    // teardown runs automatically
  },
});

// chat.spec.ts
import { test } from '../fixtures';
test('sends a message', async ({ chatPage }) => {
  await chatPage.sendMessage('hello');
  await chatPage.expectResponse('hello');
});
```

Benefits of fixture-based POM:
- Zero `beforeEach` boilerplate in test files
- Fixtures compose — `chatPage` can depend on `authSession`
- Teardown is guaranteed even on test failure
- Shared fixture types across the entire test suite via a single `test` import

**When POM is overkill**: Single-purpose tests, smoke checks, one-off exploratory tests. For simple interactions that appear once, inline locators are fine. The POM overhead pays off only when the same page interactions repeat across 3+ test files.

**POM best practices**:
- Use `data-testid` attributes or ARIA roles for locators, never CSS classes (`div.checkout-btn-v3` breaks silently)
- Keep page methods at action/assertion level, not individual click level
- Use `Locator` objects, not element handles (`page.locator()` over `page.$()`)
- Page objects should not contain `expect()` — keep assertions in tests for clarity

### 4. Custom Fixtures

**Fixture scopes**:

| Scope | Created | Ideal for |
|---|---|---|
| `test` (default) | Per test | Page objects, isolated state |
| `worker` | Per worker process | Auth sessions, DB connections |

**Worker-scoped auth pattern** (fastest for authenticated tests):

```typescript
// fixtures/auth.ts
import { test as base, type BrowserContext } from '@playwright/test';

type AuthFixtures = {
  authenticatedContext: BrowserContext;
};

export const test = base.extend<{}, AuthFixtures>({
  authenticatedContext: [
    async ({ browser }, use) => {
      // Runs once per worker — reuses across tests in that worker
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto('/');
      // Perform login...
      await context.storageState({ path: `./playwright/.auth/worker-${test.info().parallelIndex}.json` });
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],
});
```

**Fixture composition** (how to wire page objects together):

```typescript
export const test = base.extend<{
  chatPage: ChatPage;
  sessionSidebar: SessionSidebarPage;
}>({
  chatPage: async ({ page }, use) => {
    await use(new ChatPage(page));
  },
  sessionSidebar: async ({ page, chatPage }, use) => {
    // sessionSidebar depends on chatPage fixture
    await use(new SessionSidebarPage(page, chatPage));
  },
});
```

### 5. Custom Reporters

**Built-in options** (for DorkOS, use both simultaneously):

```typescript
reporter: [
  ['html', { open: 'never' }],   // visual report for CI artifacts
  ['json', { outputFile: 'test-results/results.json' }],
  ['list'],                       // terminal output
],
```

**Custom manifest-updating reporter** — useful for updating `specs/manifest.json` or a test coverage map after runs:

```typescript
// e2e/reporters/manifest-reporter.ts
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';

interface ManifestEntry {
  title: string;
  status: string;
  duration: number;
  feature: string;
}

class ManifestReporter implements Reporter {
  private results: ManifestEntry[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    this.results.push({
      title: test.title,
      status: result.status,
      duration: result.duration,
      // Extract feature from file path: features/chat/chat.spec.ts -> chat
      feature: test.titlePath()[1] ?? 'unknown',
    });
  }

  onEnd(result: FullResult) {
    const outputPath = path.resolve(process.cwd(), 'test-results/manifest.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      JSON.stringify({ status: result.status, tests: this.results }, null, 2)
    );
  }
}

export default ManifestReporter;
```

Register in config:
```typescript
reporter: [
  ['html', { open: 'never' }],
  ['./reporters/manifest-reporter.ts'],
]
```

### 6. Global Setup / Teardown — Two Approaches

**Approach A: `globalSetup` (simple, limited)**

```typescript
// playwright.config.ts
export default defineConfig({
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
});

// global-setup.ts
export default async function globalSetup() {
  // Seed data, set env vars
  process.env.TEST_SESSION_ID = 'mock-session-uuid';
}
```

Limitations: No trace recording, no fixtures available, no retry behavior. Also has a known race condition with `webServer` — `globalSetup` may run before the server is ready.

**Approach B: Project Dependencies (Recommended)**

```typescript
export default defineConfig({
  projects: [
    {
      name: 'setup',
      testMatch: '**/global.setup.ts',
      teardown: 'teardown',
    },
    {
      name: 'teardown',
      testMatch: '**/global.teardown.ts',
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
```

Benefits: Runs after `webServer` is confirmed ready, supports traces and screenshots, can use full Playwright fixtures including `page`. Use `test.skip()` in setup to conditionally skip if already seeded.

**For DorkOS**: No database seeding required (no auth layer). The main global setup concern is:
1. Confirming servers are healthy via the `url` poll (handled automatically by `webServer`)
2. Pre-creating any necessary directories (e.g., `~/.claude/projects/test/` for transcript tests)

### 7. Test Organization Patterns

Three approaches compared for DorkOS:

**Option A — Feature-Mirrored Structure (Recommended)**:
```
apps/e2e/
├── playwright.config.ts
├── fixtures/
│   ├── index.ts           # central re-export of extended test
│   ├── auth.ts
│   └── pages.ts
├── pages/                 # Page Object classes
│   ├── ChatPage.ts
│   ├── SessionSidebarPage.ts
│   ├── PulsePage.ts
│   └── RelayPage.ts
├── tests/
│   ├── chat/
│   │   ├── send-message.spec.ts
│   │   ├── tool-approval.spec.ts
│   │   └── streaming.spec.ts
│   ├── session-list/
│   │   └── session-management.spec.ts
│   ├── pulse/
│   │   └── schedule-crud.spec.ts
│   └── smoke/
│       └── app-loads.spec.ts
└── reporters/
    └── manifest-reporter.ts
```

Pros:
- Mirrors the FSD `features/` layer already established in the client codebase
- Easy to run a feature in isolation: `npx playwright test tests/chat/`
- When a feature is deleted, its tests are findable and deleteable as a unit

Cons:
- Some tests span features (e.g., "create session then send message") — these go in a `flows/` directory

**Option B — Page-Based Structure**:
```
tests/
├── pages/
│   ├── chat-page.spec.ts
│   └── settings-page.spec.ts
```

Pros: Natural for single-page apps with clear URL structure
Cons: Chat page tests mix session management, tool approval, and streaming — hard to split/find

**Option C — Flat with Naming**:
```
tests/
├── chat-send-message.spec.ts
├── chat-tool-approval.spec.ts
├── pulse-schedule-crud.spec.ts
```

Pros: Simple for tiny test suites
Cons: Scales poorly beyond ~20 files; no obvious grouping for `--grep`

**Recommendation**: Option A (feature-mirrored) for DorkOS because the codebase already uses FSD. The cognitive overhead of matching tests to features is zero.

**Tagging strategy** (complementary to directory structure):

```typescript
test('sends a message @smoke @chat', async ({ chatPage }) => {
// ^-- use @tags for cross-cutting concerns, directories for features
```

- `@smoke` — critical path, run on every PR
- `@slow` — long-running tests excluded from quick runs
- `@relay` — requires `DORKOS_RELAY_ENABLED=true`

Run subsets: `npx playwright test --grep @smoke`

### 8. Playwright + Turborepo Integration — Full Config

**`apps/e2e/package.json`**:

```json
{
  "name": "@dorkos/e2e",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "e2e": "playwright test",
    "e2e:ui": "playwright test --ui",
    "e2e:debug": "PWDEBUG=1 playwright test",
    "e2e:headed": "playwright test --headed"
  },
  "devDependencies": {
    "@playwright/test": "^1.51.0"
  }
}
```

**`turbo.json` additions**:

```json
{
  "tasks": {
    "e2e": {
      "dependsOn": ["^build"],
      "cache": false,
      "passThroughEnv": [
        "PLAYWRIGHT_BROWSERS_PATH",
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
        "CI",
        "PWDEBUG"
      ]
    }
  }
}
```

**Running e2e tests**:

```bash
# Full run via turbo (builds first, then tests)
turbo run e2e --filter=@dorkos/e2e

# Fast run when dev server is already running (skips build)
turbo run e2e --filter=@dorkos/e2e --only

# Direct playwright invocation (fastest, bypasses turbo entirely)
cd apps/e2e && npx playwright test

# Run specific feature
cd apps/e2e && npx playwright test tests/chat/

# Run smoke suite only
cd apps/e2e && npx playwright test --grep @smoke

# Interactive UI mode
cd apps/e2e && npx playwright test --ui
```

**Why `--only` matters**: Without it, `turbo run e2e` would trigger `^build` dependencies — building the server, client, web, etc. When you've already got servers running from `npm run dev`, this wastes 30-60 seconds. `--only` skips the dependency graph and runs just the e2e task.

**Cache**: E2e tasks must be `"cache": false`. Caching browser tests produces false positives — the same test run produces a cache hit even if the app behavior changed.

### 9. AI-Assisted Test Maintenance

**Playwright MCP Server (`@playwright/mcp`)**:

Microsoft's official MCP server connects AI agents to real browser sessions. It is the backbone of the AI orchestration layer.

**Key capabilities**:
- Uses accessibility tree snapshots (not screenshots) — 2-5KB structured data, 10-100x faster than screenshot analysis
- Tools available: `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, `browser_wait_for`, `browser_evaluate`, `browser_navigate_back`
- Runs headed by default (visible browser); use `--headless` for CI
- State management: `--storage-state` to load pre-authenticated sessions, `--save-trace` for debugging

**Adding to Claude Code** (already in the project's environment):
```bash
claude mcp add playwright npx @playwright/mcp@latest
```

Or with config:
```bash
claude mcp add playwright npx @playwright/mcp@latest -- --headless --viewport-size "1280x720"
```

**AI test generation workflow**:

1. **Exploration phase**: Agent uses Playwright MCP to navigate the running app, capturing accessibility snapshots at each step
2. **Test generation**: Agent writes `.spec.ts` files based on observed interactions — using real selectors from the accessibility tree, not guesses
3. **Validation**: Generated test is run with `npx playwright test`; failures feed back to the agent for repair
4. **Integration**: Passing test is committed to the feature's spec directory

**Why AI generation works better with MCP** (vs asking Claude to write tests cold):

Without MCP: LLM guesses selectors, guesses routing, hallucinates component names. 50%+ failure rate.

With MCP: LLM sees the actual rendered accessibility tree. Locators are extracted from real elements. The generated test reflects actual app behavior.

**Self-healing pattern for flaky tests**:

When a locator breaks (e.g., after a component rename):
1. Run `npx playwright test --reporter=json` to identify failing tests
2. Feed failing test file + error output to Claude Code with Playwright MCP active
3. Agent navigates to the failing page, captures current accessibility tree
4. Agent repairs the locator, re-runs the test to verify

**Practical limitations**:
- Each MCP action has a context cost — deep exploration of 10+ pages can consume significant context window
- AI agents sometimes take unexpected paths; human review before committing AI-generated tests is critical
- "Vibe coding" entire test suites produces tests that pass but don't cover the right behavior
- Best results come from writing precise instructions: "Test that sending 'hello' in the chat input results in an assistant response appearing within 10 seconds"

**Slash command design for the AI layer** (the `.claude/commands/` skill approach):

```
.claude/commands/
├── test:explore       # Navigate app with Playwright MCP, capture flows
├── test:generate      # Write spec from explored flow
├── test:debug         # Diagnose and repair a failing test
├── test:heal          # Update locators after UI changes
└── test:coverage      # Identify untested features and suggest new specs
```

---

## Detailed Analysis

### Full `playwright.config.ts` for DorkOS

```typescript
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;
const PORT = process.env.DORKOS_PORT || '4242';
const VITE_PORT = process.env.VITE_PORT || '4241';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  timeout: 30_000,

  reporter: [
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    CI ? ['github'] : ['list'],
    ['./reporters/manifest-reporter.ts'],
  ],

  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: [
    {
      command: `dotenv -- turbo dev --filter=@dorkos/server`,
      url: `http://localhost:${PORT}/api/health`,
      name: 'Express API',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DORKOS_PORT: PORT,
        DORKOS_PULSE_ENABLED: 'false',
        DORKOS_RELAY_ENABLED: 'false',
        DORKOS_MESH_ENABLED: 'false',
        NODE_ENV: 'test',
      },
    },
    {
      command: `dotenv -- turbo dev --filter=@dorkos/client`,
      url: `http://localhost:${VITE_PORT}`,
      name: 'Vite Client',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
    },
  ],

  projects: [
    // Setup project — runs first, creates test fixtures
    {
      name: 'setup',
      testMatch: '**/global.setup.ts',
    },
    // Main test projects
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    // Optional: mobile viewport
    // { name: 'mobile', use: { ...devices['Pixel 5'] }, dependencies: ['setup'] },
  ],
});
```

### Page Object Design for DorkOS Features

```typescript
// pages/ChatPage.ts
import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

export class ChatPage {
  readonly page: Page;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.input = page.getByRole('textbox', { name: /message/i });
    this.sendButton = page.getByRole('button', { name: /send/i });
    this.messageList = page.getByRole('list', { name: /messages/i });
  }

  async goto(sessionId?: string) {
    const url = sessionId ? `/?session=${sessionId}` : '/';
    await this.page.goto(url);
  }

  async sendMessage(text: string) {
    await this.input.fill(text);
    await this.sendButton.click();
  }

  async lastMessage(): Promise<Locator> {
    return this.messageList.locator('[data-testid="message-item"]').last();
  }

  async waitForResponse(timeoutMs = 10_000) {
    // Wait for streaming to complete (done event stops spinner)
    await expect(this.page.locator('[data-testid="inference-indicator"]'))
      .toBeHidden({ timeout: timeoutMs });
  }
}
```

### Test File Structure Example

```typescript
// tests/chat/send-message.spec.ts
import { test, expect } from '../../fixtures';

test.describe('Chat — Send Message', () => {
  test('sends a message and receives a response @smoke', async ({ chatPage }) => {
    await chatPage.sendMessage('Say exactly: hello world');
    await chatPage.waitForResponse();
    const last = await chatPage.lastMessage();
    await expect(last).toContainText('hello world');
  });

  test('shows tool approval card when tool requires permission', async ({ chatPage }) => {
    await chatPage.sendMessage('List files in the current directory');
    await expect(chatPage.page.getByTestId('tool-approval-card')).toBeVisible();
  });
});
```

### Fixture Composition for DorkOS

```typescript
// fixtures/index.ts
import { test as base } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage';
import { SessionSidebarPage } from '../pages/SessionSidebarPage';
import { PulsePage } from '../pages/PulsePage';

type DorkOSFixtures = {
  chatPage: ChatPage;
  sessionSidebar: SessionSidebarPage;
  pulsePage: PulsePage;
};

export const test = base.extend<DorkOSFixtures>({
  chatPage: async ({ page }, use) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto();
    await use(chatPage);
  },
  sessionSidebar: async ({ page }, use) => {
    await use(new SessionSidebarPage(page));
  },
  pulsePage: async ({ page }, use) => {
    const pulsePage = new PulsePage(page);
    await pulsePage.goto();
    await use(pulsePage);
  },
});

export { expect } from '@playwright/test';
```

---

## Approach Comparison Tables

### Test Organization

| Approach | Discoverability | Feature isolation | Cross-feature flows | FSD alignment |
|---|---|---|---|---|
| Feature-mirrored (`tests/chat/`) | High | Excellent | Use `tests/flows/` | Perfect |
| Page-based (`tests/pages/chat-page.spec.ts`) | Medium | Poor | Natural | Moderate |
| Flat with naming (`chat-send-message.spec.ts`) | Low | Poor | Natural | None |

**Winner**: Feature-mirrored — aligns with FSD, scales to any number of features, isolatable.

### Fixture Patterns

| Pattern | Reuse | Composition | Setup boilerplate | Recommended for |
|---|---|---|---|---|
| `beforeEach` + direct import | Low | None | High | One-off tests only |
| `test.extend()` with page objects | High | Excellent | None | All multi-file test suites |
| Worker-scoped auth fixture | High | Excellent | None (once per worker) | Authenticated flows |

**Winner**: `test.extend()` is strictly better in every dimension for the DorkOS scale.

### Reporter Strategy

| Reporter | Use Case | Output |
|---|---|---|
| `html` | Visual debugging, CI artifact | `playwright-report/index.html` |
| `json` | Machine-readable results | `test-results/results.json` |
| `list` | Terminal feedback during dev | stdout |
| `github` | GitHub Actions inline annotations | stdout (CI) |
| Custom manifest | Feature coverage tracking | `test-results/manifest.json` |

**Recommended**: Use all four simultaneously — each serves a different consumer.

---

## Security Considerations

- E2e tests run against a real Express server. Ensure the test environment uses a separate port (or the default 4242) rather than the user's configured production port, to avoid test traffic hitting a live instance.
- Never commit `storageState` files containing real credentials. Add `playwright/.auth/` to `.gitignore`.
- The `DORKOS_BOUNDARY` env var should be set to a temp/test directory when running e2e tests to prevent file operations from escaping the test sandbox.
- Playwright's `--allow-unrestricted-file-access` flag (for MCP) should never be used in CI — it bypasses browser security for file:// URLs.
- The `webServer.env` block can override feature flags (Pulse, Relay, Mesh) to keep test environments deterministic.

---

## Performance Considerations

- **`fullyParallel: true`** — run all spec files in parallel. For DorkOS with its stateless HTTP API, this is safe.
- **`workers: CI ? 1 : undefined`** — CI runs single-worker to avoid port conflicts; local runs use all available cores.
- **`retries: CI ? 2 : 0`** — retries on CI absorb flakiness from cold-start timing; disable locally for fast feedback.
- **`reuseExistingServer: !process.env.CI`** — eliminates 15-30s server startup on every local run.
- **Worker-scoped fixtures** — one auth flow per worker instead of per test, huge speedup for authenticated test suites.
- **`trace: 'on-first-retry'`** — traces are expensive; only record on failure retries.
- **Accessibility tree over screenshots** — Playwright MCP's snapshot mode is 10-100x faster than visual comparison for AI-driven flows.
- **Sharding** — for large suites, Playwright's built-in `--shard=1/4` splits tests across CI machines.

---

## Recommendation

**Recommended Approach**: Dedicated `apps/e2e` workspace, feature-mirrored test directories, `test.extend()` fixture-based Page Objects, multi-reporter config, project dependencies for global setup, and `@playwright/mcp` for the AI orchestration layer.

**Rationale**:

1. The feature-mirrored structure is zero cognitive overhead for a team already using FSD — when you work on `features/chat`, you know tests live in `tests/chat/`.

2. Fixture-based POMs (`test.extend()`) eliminate all `beforeEach` boilerplate, compose cleanly, and produce the most readable test files. The FSD client codebase already demonstrates strong separation of concerns — test fixtures should mirror that discipline.

3. The multi-server `webServer` array config perfectly fits the Vite + Express architecture. The `reuseExistingServer` flag makes local DX excellent — start `npm run dev` once, run tests instantly against it.

4. `@playwright/mcp` is already installable into Claude Code with a single command and is directly useful as the foundation for the `test:generate`, `test:debug`, and `test:heal` slash commands.

5. The Turborepo `--only` flag pattern avoids double-building when running e2e manually, which is the most common local workflow.

**Caveats**:

- DorkOS's Agent SDK sessions involve real Claude API calls — tests that trigger actual agent execution will be slow and require API credentials. These should be tagged `@integration` and excluded from the standard smoke suite. Mock the Agent SDK at the Express route level for unit-level browser tests.
- The `DORKOS_PORT` env var (user-configured as 6942 per MEMORY.md) must be accounted for. The e2e config should read `process.env.DORKOS_PORT` with fallback to `4242`, and the webServer `url` health check must match.
- Playwright MCP AI generation produces tests that pass but may not cover the intended invariant — "just because an AI can succeed at a task doesn't mean the application is working correctly." Every AI-generated test file needs human review before merge.
- The `@playwright/mcp` server runs headed by default. On CI, always pass `--headless`.

---

## Research Gaps & Limitations

- No specific guidance found for testing SSE streaming endpoints with Playwright (the DorkOS streaming protocol). This will require custom `waitForEvent` or `page.evaluate` patterns to intercept EventSource events.
- No existing patterns found for testing Playwright against apps that use `nuqs` URL state — may need to verify that URL parameter persistence works correctly across test navigation.
- Limited public examples of testing Turborepo monorepos where the dev server uses `tsx watch` (not a pre-built artifact) — the `webServer` command timeout may need tuning.

---

## Contradictions & Disputes

- **`globalSetup` vs project dependencies**: The Playwright team's GitHub issues show `globalSetup` has a known race condition with `webServer` startup. The official documentation now recommends project dependencies as the preferred approach, but many tutorials still use `globalSetup`. For DorkOS (no auth/db seeding needed), this distinction is moot — the `webServer` URL poll handles readiness.
- **POM overhead**: Some practitioners argue POM adds indirection that makes test debugging harder ("I need to look in three files to understand one test"). Counter: for a codebase with 8 distinct feature areas, the reuse and discoverability benefits outweigh this. The DorkOS FSD architecture already normalizes this kind of layered lookup.
- **Cache for e2e**: Turborepo docs say e2e tasks should be `cache: false`. This conflicts with general Turbo advice to cache everything. The reasoning: browser tests have external side effects (real servers, SSE, filesystem) that make caching unsafe. `cache: false` is correct.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: `playwright webServer array multiple servers`, `Playwright MCP server tools 2025`, `Playwright test.extend fixtures POM`, `turborepo playwright passThroughEnv`
- Primary information sources: playwright.dev (official docs), turborepo.dev (official docs), GitHub microsoft/playwright-mcp, checklyhq.com (practitioner guides)
- Codebase files read: `turbo.json`, `package.json` (root, server, client), `apps/client/vite.config.ts`, FSD feature directory listing

---

## Sources & Evidence

- [Web server | Playwright](https://playwright.dev/docs/test-webserver) — webServer array config, URL polling, reuseExistingServer
- [Playwright | Turborepo](https://turborepo.dev/docs/guides/tools/playwright) — passThroughEnv, --only flag, package-per-suite recommendation
- [Fixtures | Playwright](https://playwright.dev/docs/test-fixtures) — test.extend(), fixture scopes, composition
- [Global setup and teardown | Playwright](https://playwright.dev/docs/test-global-setup-teardown) — project dependencies approach
- [Reporter | Playwright](https://playwright.dev/docs/api/class-reporter) — Reporter interface, lifecycle methods
- [Reporters | Playwright](https://playwright.dev/docs/test-reporters) — built-in reporters, multiple reporter config
- [Page object models | Playwright](https://playwright.dev/docs/pom) — official POM guidance
- [Authentication | Playwright](https://playwright.dev/docs/auth) — storageState, worker-scoped auth
- [Generating end-to-end tests with AI and Playwright MCP](https://www.checklyhq.com/blog/generate-end-to-end-tests-with-ai-and-playwright/) — AI generation workflow, why MCP context matters
- [GitHub - microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) — tool list, configuration options, Claude Code integration
- [Playwright MCP: Setup, Best Practices](https://testcollab.com/blog/playwright-mcp) — headless/headed modes, snapshot modes
- [Setting Up End-to-End Testing with Playwright: Monorepo vs Standard Repository](https://www.kyrre.dev/blog/end-to-end-testing-setup) — directory structure comparison
- [Organizing Playwright Tests Effectively](https://dev.to/playwright/organizing-playwright-tests-effectively-2hi0) — feature-based org, tagging
- [How to Implement Custom Test Fixtures in Playwright](https://www.checklyhq.com/blog/how-to-implement-custom-test-fixtures-in-playwright/) — test.extend() patterns
- [Building Playwright: POM Fixture & Auth Session](https://idavidov.eu/building-playwright-framework-step-by-step-implementing-pom-as-fixture-and-auth-user-session) — POM via fixtures walkthrough
- [Playwright custom reporter](https://testdino.com/blog/playwright-custom-reporter/) — custom reporter implementation patterns
- [9 Strategies to Get the Most Out of Playwright Test Agents](https://currents.dev/posts/9-strategies-to-get-the-most-out-of-playwright-test-agents) — AI agent best practices
