---
slug: browser-testing-system
number: 61
created: 2026-02-25
status: draft
---

# Specification: Browser Testing System

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-25
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [research/20260225_browser_testing_system.md](../../research/20260225_browser_testing_system.md)

---

## 1. Overview

Build an AI-driven browser testing system for DorkOS with two complementary layers:

1. **Standard Playwright Test suite** — deterministic `.spec.ts` files that run via `npx playwright test`, CI-friendly, no AI dependency
2. **AI orchestration layer** — `.claude/commands/` and `.claude/skills/` that use the Playwright MCP server to write, debug, and maintain those tests

The system lives in `apps/e2e/` as a dedicated Turborepo workspace (`@dorkos/e2e`), with feature-mirrored test directories matching the FSD structure, fixture-based Page Object Models, and a custom manifest reporter for AI health tracking.

## 2. Background / Problem Statement

DorkOS has 80+ unit/component test files via Vitest covering individual components and services, but zero browser-level or end-to-end testing. This means:

- No verification that the full-stack user experience works (client + server + Agent SDK)
- No regression detection for cross-component interactions (e.g., sending a chat message triggers sidebar update)
- No way to catch CSS/layout regressions, SSE streaming issues, or real browser behavior
- No automated way to verify the app after changes

The AI orchestration layer addresses a second problem: traditional E2E test suites are expensive to maintain. Tests break when UI changes, requiring manual updates. By leveraging the Playwright MCP server (already available in the development environment), Claude Code can explore the running app, write tests from real accessibility snapshots, and repair broken locators automatically.

## 3. Goals

- Create `apps/e2e/` as a new Turborepo workspace with `@playwright/test`
- Configure multi-server `webServer` for Vite frontend + Express backend
- Implement fixture-based Page Object Models for core DorkOS features
- Write seed tests covering: app loading, chat messaging (with real Agent SDK), session management, settings dialog
- Create a custom Playwright reporter that updates a test manifest (JSON) for AI health tracking
- Create `/browsertest` command for smart test routing (run, debug, maintain, report, create)
- Create `browser-testing` skill teaching test-writing methodology and POM patterns
- Create `/browsertest:maintain` command for automated suite health audits
- Implement health dashboard via `/browsertest report`
- Write `contributing/browser-testing.md` guide
- Add turbo `e2e` task with `cache: false` and appropriate `passThroughEnv`

## 4. Non-Goals

- Multi-browser support (Firefox, WebKit) — add later via additional Playwright projects
- Visual regression testing / screenshot diffing
- Performance benchmarking or load testing
- CI/CD pipeline configuration (tests should work in CI, but pipeline config is separate)
- Testing the Obsidian plugin (DirectTransport path) — standalone web only
- Testing the marketing site (`apps/web`) — separate domain
- Testing the roadmap app (`apps/roadmap`) — independent app
- Mocking the Agent SDK at the Express route level — we use real SDK calls

## 5. Technical Dependencies

| Dependency                  | Version   | Purpose                                      |
| --------------------------- | --------- | -------------------------------------------- |
| `@playwright/test`          | `^1.51.0` | Playwright Test runner, fixtures, assertions |
| `@dorkos/typescript-config` | `*`       | Shared tsconfig preset (devDep)              |

No additional runtime dependencies. Playwright browsers are installed via `npx playwright install chromium`.

## 6. Detailed Design

### 6.1 Package Structure

```
apps/e2e/
├── package.json              # @dorkos/e2e workspace
├── tsconfig.json             # TypeScript config extending shared preset
├── playwright.config.ts      # Multi-server webServer, Chromium project, reporters
├── manifest.json             # Test registry with metadata, run history
├── fixtures/
│   └── index.ts              # Extended test with DorkOS page object fixtures
├── pages/                    # Page Object Models
│   ├── BasePage.ts           # Common navigation, wait helpers
│   ├── ChatPage.ts           # Chat panel interactions
│   ├── SessionSidebarPage.ts # Sidebar interactions
│   └── SettingsPage.ts       # Settings dialog interactions
├── reporters/
│   └── manifest-reporter.ts  # Custom reporter updating manifest.json
├── tests/                    # Test specs organized by feature
│   ├── smoke/
│   │   └── app-loads.spec.ts
│   ├── chat/
│   │   └── send-message.spec.ts
│   ├── session-list/
│   │   └── session-management.spec.ts
│   └── settings/
│       └── settings-dialog.spec.ts
└── .gitignore                # Local ignores (test-results/, playwright-report/)
```

### 6.2 Playwright Configuration

```typescript
// apps/e2e/playwright.config.ts
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
      command: 'dotenv -- turbo dev --filter=@dorkos/server',
      url: `http://localhost:${PORT}/api/health`,
      name: 'Express API',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'dotenv -- turbo dev --filter=@dorkos/client',
      url: `http://localhost:${VITE_PORT}`,
      name: 'Vite Client',
      timeout: 120_000,
      reuseExistingServer: !CI,
      stdout: 'pipe',
    },
  ],

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

Key decisions:

- **`reuseExistingServer: !CI`** — reuses running dev servers locally (instant startup), spawns fresh in CI
- **`cache: false`** in turbo.json — browser tests have external side effects, caching produces false positives
- **No `globalSetup`** — webServer URL polling handles readiness; no auth/DB seeding needed
- **`trace: 'on-first-retry'`** — traces are expensive, only recorded on failure retries

### 6.3 Page Object Models

POMs are injected as Playwright fixtures via `test.extend()`, eliminating `beforeEach` boilerplate:

```typescript
// fixtures/index.ts
import { test as base } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage';
import { SessionSidebarPage } from '../pages/SessionSidebarPage';
import { SettingsPage } from '../pages/SettingsPage';
import { BasePage } from '../pages/BasePage';

type DorkOSFixtures = {
  basePage: BasePage;
  chatPage: ChatPage;
  sessionSidebar: SessionSidebarPage;
  settingsPage: SettingsPage;
};

export const test = base.extend<DorkOSFixtures>({
  basePage: async ({ page }, use) => {
    await use(new BasePage(page));
  },
  chatPage: async ({ page }, use) => {
    const chatPage = new ChatPage(page);
    await chatPage.goto();
    await use(chatPage);
  },
  sessionSidebar: async ({ page }, use) => {
    await use(new SessionSidebarPage(page));
  },
  settingsPage: async ({ page }, use) => {
    await use(new SettingsPage(page));
  },
});

export { expect } from '@playwright/test';
```

**BasePage** provides common helpers:

```typescript
// pages/BasePage.ts
import type { Page } from '@playwright/test';

export class BasePage {
  constructor(readonly page: Page) {}

  async goto(path = '/') {
    await this.page.goto(path);
  }

  async waitForAppReady() {
    // Wait for the main app shell to render
    await this.page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  }
}
```

**ChatPage** encapsulates chat interactions:

```typescript
// pages/ChatPage.ts
import type { Page, Locator } from '@playwright/test';

export class ChatPage {
  readonly page: Page;
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.input = page.getByRole('textbox', { name: /message/i });
    this.sendButton = page.getByRole('button', { name: /send/i });
    this.messageList = page.locator('[data-testid="message-list"]');
  }

  async goto(sessionId?: string) {
    const url = sessionId ? `/?session=${sessionId}` : '/';
    await this.page.goto(url);
    await this.page.waitForSelector('[data-testid="chat-panel"]', { timeout: 10_000 });
  }

  async sendMessage(text: string) {
    await this.input.fill(text);
    await this.sendButton.click();
  }

  async waitForResponse(timeoutMs = 60_000) {
    // Wait for inference indicator to appear then disappear (streaming complete)
    await this.page
      .locator('[data-testid="inference-indicator"]')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    await this.page
      .locator('[data-testid="inference-indicator"]')
      .waitFor({ state: 'hidden', timeout: timeoutMs });
  }

  async getMessages(): Promise<Locator> {
    return this.messageList.locator('[data-testid="message-item"]');
  }

  async lastAssistantMessage(): Promise<Locator> {
    return this.messageList.locator('[data-testid="message-item"][data-role="assistant"]').last();
  }
}
```

**SessionSidebarPage**:

```typescript
// pages/SessionSidebarPage.ts
import type { Page, Locator } from '@playwright/test';

export class SessionSidebarPage {
  readonly page: Page;
  readonly newChatButton: Locator;
  readonly sessionList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.newChatButton = page.getByRole('button', { name: /new chat/i });
    this.sessionList = page.locator('[data-testid="session-list"]');
  }

  async createNewSession() {
    await this.newChatButton.click();
  }

  async selectSession(index: number) {
    const sessions = this.sessionList.locator('[data-testid="session-item"]');
    await sessions.nth(index).click();
  }

  async getSessionCount(): Promise<number> {
    return this.sessionList.locator('[data-testid="session-item"]').count();
  }
}
```

**SettingsPage**:

```typescript
// pages/SettingsPage.ts
import type { Page, Locator } from '@playwright/test';

export class SettingsPage {
  readonly page: Page;
  readonly dialog: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dialog = page.locator('[data-testid="settings-dialog"]');
  }

  async open() {
    await this.page.getByRole('button', { name: /settings/i }).click();
    await this.dialog.waitFor({ state: 'visible' });
  }

  async close() {
    await this.page.keyboard.press('Escape');
    await this.dialog.waitFor({ state: 'hidden' });
  }

  async switchTab(tabName: string) {
    await this.dialog.getByRole('tab', { name: new RegExp(tabName, 'i') }).click();
  }
}
```

### 6.4 Seed Tests

**Smoke test** — verifies the app loads:

```typescript
// tests/smoke/app-loads.spec.ts
import { test, expect } from '../../fixtures';

test.describe('Smoke — App Loading @smoke', () => {
  test('renders the app shell with sidebar and chat panel', async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await expect(basePage.page.locator('[data-testid="session-sidebar"]')).toBeVisible();
    await expect(basePage.page.locator('[data-testid="chat-panel"]')).toBeVisible();
  });

  test('displays the status line', async ({ basePage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await expect(basePage.page.locator('[data-testid="status-line"]')).toBeVisible();
  });
});
```

**Chat test** — sends a real message via Agent SDK:

```typescript
// tests/chat/send-message.spec.ts
import { test, expect } from '../../fixtures';

test.describe('Chat — Send Message @integration', () => {
  test('sends a message and receives a response', async ({ chatPage }) => {
    await chatPage.sendMessage('Respond with exactly: hello world');
    await chatPage.waitForResponse();

    const lastMessage = await chatPage.lastAssistantMessage();
    await expect(lastMessage).toContainText('hello world');
  });

  test('shows inference indicator while streaming', async ({ chatPage }) => {
    await chatPage.sendMessage('Count from 1 to 5');

    // Inference indicator should appear during streaming
    await expect(chatPage.page.locator('[data-testid="inference-indicator"]')).toBeVisible({
      timeout: 10_000,
    });
  });
});
```

**Session management** — tests sidebar interactions:

```typescript
// tests/session-list/session-management.spec.ts
import { test, expect } from '../../fixtures';

test.describe('Session List — Management @smoke', () => {
  test('creates a new chat session', async ({ chatPage, sessionSidebar }) => {
    const initialCount = await sessionSidebar.getSessionCount();
    await sessionSidebar.createNewSession();

    // URL should update with new session ID
    await expect(chatPage.page).toHaveURL(/session=/);
  });
});
```

**Settings dialog** — tests settings UI:

```typescript
// tests/settings/settings-dialog.spec.ts
import { test, expect } from '../../fixtures';

test.describe('Settings — Dialog @smoke', () => {
  test('opens and closes the settings dialog', async ({ basePage, settingsPage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await settingsPage.open();
    await expect(settingsPage.dialog).toBeVisible();

    await settingsPage.close();
    await expect(settingsPage.dialog).toBeHidden();
  });

  test('switches between settings tabs', async ({ basePage, settingsPage }) => {
    await basePage.goto();
    await basePage.waitForAppReady();

    await settingsPage.open();
    await settingsPage.switchTab('Server');

    await expect(settingsPage.dialog.getByRole('tabpanel')).toBeVisible();
  });
});
```

### 6.5 data-testid Attributes

The following `data-testid` attributes need to be added to client components for stable E2E selectors. These are the minimum set for the seed tests:

| Component           | File                     | Attribute                                                                                       |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| App shell wrapper   | `App.tsx`                | `data-testid="app-shell"`                                                                       |
| Chat panel          | `ChatPanel.tsx`          | `data-testid="chat-panel"`                                                                      |
| Message list        | `MessageList.tsx`        | `data-testid="message-list"`                                                                    |
| Message item        | `MessageItem.tsx`        | `data-testid="message-item"` + `data-role="user\|assistant"`                                    |
| Session sidebar     | `SessionSidebar.tsx`     | `data-testid="session-sidebar"`                                                                 |
| Session list        | `SessionSidebar.tsx`     | `data-testid="session-list"`                                                                    |
| Session item        | `SessionItem.tsx`        | `data-testid="session-item"`                                                                    |
| Status line         | `StatusLine.tsx`         | `data-testid="status-line"`                                                                     |
| Settings dialog     | `SettingsDialog.tsx`     | `data-testid="settings-dialog"`                                                                 |
| Inference indicator | `InferenceIndicator.tsx` | Already exists: `data-testid="inference-indicator-streaming"` (rename to `inference-indicator`) |

### 6.6 Custom Manifest Reporter

```typescript
// reporters/manifest-reporter.ts
import type { Reporter, TestCase, TestResult, FullResult, Suite } from '@playwright/test/reporter';
import fs from 'node:fs';
import path from 'node:path';

interface TestEntry {
  specFile: string;
  feature: string;
  description: string;
  lastRun: string;
  lastStatus: string;
  runCount: number;
  passCount: number;
  failCount: number;
}

interface Manifest {
  version: number;
  tests: Record<string, TestEntry>;
  runHistory: Array<{
    id: string;
    timestamp: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
  }>;
}

class ManifestReporter implements Reporter {
  private manifestPath: string;
  private manifest: Manifest;
  private runResults: { title: string; status: string; file: string; duration: number }[] = [];
  private startTime = Date.now();

  constructor() {
    this.manifestPath = path.resolve(__dirname, '..', 'manifest.json');
    this.manifest = this.loadManifest();
  }

  private loadManifest(): Manifest {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf-8'));
    } catch {
      return { version: 1, tests: {}, runHistory: [] };
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const relativeFile = path.relative(path.resolve(__dirname, '..', 'tests'), test.location.file);
    const feature = relativeFile.split(path.sep)[0] || 'unknown';
    const testKey = path.basename(test.location.file, '.spec.ts');

    // Update test entry
    const existing = this.manifest.tests[testKey] || {
      specFile: `tests/${relativeFile}`,
      feature,
      description: test.title,
      lastRun: '',
      lastStatus: '',
      runCount: 0,
      passCount: 0,
      failCount: 0,
    };

    existing.lastRun = new Date().toISOString();
    existing.lastStatus = result.status;
    existing.runCount++;
    if (result.status === 'passed') existing.passCount++;
    if (result.status === 'failed') existing.failCount++;
    this.manifest.tests[testKey] = existing;

    this.runResults.push({
      title: test.title,
      status: result.status,
      file: relativeFile,
      duration: result.duration,
    });
  }

  onEnd(result: FullResult) {
    const now = new Date();
    const runId = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Add run to history (keep last 100)
    this.manifest.runHistory.push({
      id: runId,
      timestamp: now.toISOString(),
      total: this.runResults.length,
      passed: this.runResults.filter((r) => r.status === 'passed').length,
      failed: this.runResults.filter((r) => r.status === 'failed').length,
      skipped: this.runResults.filter((r) => r.status === 'skipped').length,
      duration: Date.now() - this.startTime,
    });
    if (this.manifest.runHistory.length > 100) {
      this.manifest.runHistory = this.manifest.runHistory.slice(-100);
    }

    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }
}

export default ManifestReporter;
```

### 6.7 Turbo Integration

Add to `turbo.json`:

```json
{
  "e2e": {
    "dependsOn": ["^build"],
    "cache": false,
    "passThroughEnv": [
      "PLAYWRIGHT_BROWSERS_PATH",
      "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
      "CI",
      "PWDEBUG",
      "ANTHROPIC_API_KEY"
    ]
  },
  "e2e:ui": {
    "cache": false,
    "persistent": true
  }
}
```

Add to root `package.json`:

```json
{
  "scripts": {
    "test:browser": "turbo run e2e --filter=@dorkos/e2e --only",
    "test:browser:ui": "turbo run e2e:ui --filter=@dorkos/e2e --only"
  }
}
```

The `--only` flag bypasses the `^build` dependency graph when dev servers are already running.

### 6.8 /browsertest Command

`.claude/commands/browsertest.md`:

```yaml
---
description: Run, create, debug, and maintain browser tests
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TaskOutput, AskUserQuestion
argument-hint: '<run|debug|maintain|report|create> [feature] [description]'
category: testing
---
```

**Smart routing logic:**

| Usage                                  | Behavior                                              |
| -------------------------------------- | ----------------------------------------------------- |
| `/browsertest run`                     | Run entire suite: `npx playwright test`               |
| `/browsertest run chat`                | Run feature subset: `npx playwright test tests/chat/` |
| `/browsertest chat messaging`          | Find matching test in manifest OR create new one      |
| `/browsertest debug chat-messaging`    | Diagnose failing test with Playwright MCP             |
| `/browsertest maintain`                | Delegates to `/browsertest:maintain`                  |
| `/browsertest report`                  | Show health dashboard from manifest.json              |
| `/browsertest create chat file-upload` | Explicitly create a new test                          |

**Test creation flow:**

1. Use Playwright MCP to navigate to the feature in the running app
2. Capture accessibility snapshots to identify key elements and selectors
3. Generate `.spec.ts` file with appropriate POM usage
4. Run the test to verify it passes
5. Update manifest.json with test metadata

**Debug flow:**

1. Run the failing test with `--reporter=json` to capture error details
2. Use Playwright MCP to navigate to the failing page
3. Capture current accessibility tree
4. Classify: TEST bug (selector changed, timing issue) or CODE bug (regression)
5. If TEST bug: auto-fix the spec, re-run, update manifest
6. If CODE bug: present diagnosis + fix options via AskUserQuestion

### 6.9 /browsertest:maintain Command

`.claude/commands/browsertest:maintain.md`:

```yaml
---
description: Audit browser test suite health and fix stale tests
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TaskOutput, AskUserQuestion
argument-hint: ''
category: testing
---
```

**Maintenance flow:**

1. Read `apps/e2e/manifest.json`
2. For each test entry:
   - Check if the spec file still exists
   - Check if `relatedCode` files were modified since `lastModified` (via git log)
   - Run the test
3. Categorize results:
   - **Healthy** — passes, code unchanged
   - **Stale** — passes but related code changed (may need update)
   - **Broken** — fails
   - **Orphaned** — related code deleted
4. For stale tests: Use Playwright MCP to explore the current UI and update POMs/assertions
5. For orphaned tests: Prompt user to confirm removal
6. Update manifest with audit results
7. Display health report

### 6.10 browser-testing Skill

`.claude/skills/browser-testing/SKILL.md`:

```yaml
---
name: browser-testing
description: Methodology for writing and maintaining DorkOS browser tests
---
```

Teaches:

- When to write a browser test vs unit test (cross-component flows, SSE streaming, real API calls)
- Page Object Model patterns for DorkOS (fixture-based, locator-first)
- Selector strategy (prefer `getByRole` > `data-testid` > CSS class)
- Wait strategy (avoid arbitrary timeouts, use locator visibility/hidden states)
- Test tagging (`@smoke` for critical path, `@integration` for SDK-dependent)
- Debugging methodology (reproduce with MCP snapshot, isolate, classify test-vs-code bug)
- Manifest management (how tests are tracked, when to update metadata)
- DorkOS-specific patterns (SSE stream testing, inference indicator waits)

### 6.11 /browsertest report (Health Dashboard)

Reads `apps/e2e/manifest.json` and displays:

```
Browser Test Health Dashboard
==============================

Suite Status: 4 tests | 3 passing | 1 failing | 92% pass rate
Last Run: 2026-02-25T10:30:00Z (45s)

Feature Breakdown:
  smoke:         1/1 passing (100%)
  chat:          1/2 passing (50%)  ← needs attention
  session-list:  1/1 passing (100%)
  settings:      1/1 passing (100%)

Recent History (last 5 runs):
  #5: 4/4 passed (42s)
  #4: 3/4 passed (45s)
  #3: 4/4 passed (38s)
  #2: 4/4 passed (41s)
  #1: 3/4 passed (50s)

Stale Tests (code changed since last update):
  - send-message.spec.ts (ChatInput.tsx modified 2d ago)

Run: /browsertest maintain  to update stale tests
```

## 7. User Experience

### For developers running tests manually:

```bash
# Run all browser tests (reuses running dev server)
npm run test:browser

# Run specific feature
cd apps/e2e && npx playwright test tests/chat/

# Run smoke suite only
cd apps/e2e && npx playwright test --grep @smoke

# Interactive UI mode
npm run test:browser:ui

# Debug mode (opens browser inspector)
cd apps/e2e && PWDEBUG=1 npx playwright test tests/chat/send-message.spec.ts
```

### For AI-assisted workflows:

```
/browsertest run                    # Run full suite
/browsertest chat file-upload       # Create or run a test
/browsertest debug send-message     # Debug a failing test
/browsertest maintain               # Audit and fix stale tests
/browsertest report                 # View health dashboard
```

## 8. Testing Strategy

This spec IS the testing infrastructure, so the meta-testing approach is:

- **Seed tests validate the framework** — if `app-loads.spec.ts` passes, the Playwright config, webServer, and fixture wiring all work correctly
- **Chat send-message test validates SDK integration** — proves the full stack works (client → server → Agent SDK → SSE → client)
- **Manifest reporter tested by running tests** — after any test run, `manifest.json` should be updated with correct run history
- **Command/skill tested by usage** — `/browsertest run` and `/browsertest maintain` are verified by invoking them

No unit tests for the E2E infrastructure itself — the tests ARE the tests.

## 9. Performance Considerations

- **`reuseExistingServer: !CI`** — eliminates 15-30s server startup on every local run
- **`fullyParallel: true`** — spec files run in parallel (safe because DorkOS API is stateless per-session)
- **`workers: CI ? 1 : undefined`** — CI runs single-worker to avoid port conflicts; local uses all cores
- **`trace: 'on-first-retry'`** — traces are expensive (10-50MB), only recorded on failure
- **`@integration` tag on SDK tests** — allows running `--grep @smoke` for fast feedback (skip slow SDK calls)
- **Manifest reporter is synchronous** — writes JSON at end of run, no impact during test execution

## 10. Security Considerations

- `ANTHROPIC_API_KEY` must be available for `@integration` tests — passed through Turbo's `passThroughEnv`, never committed
- `playwright/.auth/` added to `.gitignore` — prevents credential leakage if auth is added later
- `webServer.env` can override feature flags to keep test environments deterministic
- Never use `--allow-unrestricted-file-access` in CI (Playwright MCP flag)

## 11. Documentation

Create `contributing/browser-testing.md` covering:

1. **Quick start** — how to run browser tests
2. **Architecture** — two-layer system (Playwright Test + AI orchestration)
3. **Writing tests** — POM patterns, fixture usage, selector strategy
4. **Running tests** — npm scripts, Playwright CLI, UI mode, debug mode
5. **AI commands** — `/browsertest` usage reference
6. **Manifest** — how test metadata is tracked
7. **Adding tests** — step-by-step for new feature tests
8. **Debugging** — interpreting failures, using traces, MCP-assisted debugging
9. **Maintenance** — stale test detection, audit workflow

## 12. Implementation Phases

### Phase 1: Foundation (Infrastructure + Seed Tests)

1. Install `@playwright/test` and Chromium browser
2. Create `apps/e2e/` workspace (package.json, tsconfig.json)
3. Write `playwright.config.ts` with multi-server webServer
4. Create base fixtures (`fixtures/index.ts`)
5. Create Page Object Models (BasePage, ChatPage, SessionSidebarPage, SettingsPage)
6. Add `data-testid` attributes to client components (10 components)
7. Write seed tests (smoke, chat, session-list, settings)
8. Create custom manifest reporter
9. Initialize `manifest.json`
10. Add turbo tasks (`e2e`, `e2e:ui`) and npm scripts
11. Update `.gitignore` (playwright-report/, test-results/)
12. Write `contributing/browser-testing.md`

### Phase 2: AI Commands

1. Create `.claude/commands/browsertest.md` with smart routing
2. Create `.claude/skills/browser-testing/SKILL.md` with methodology
3. Implement test creation flow (MCP explore → write spec → verify → register in manifest)
4. Implement test run flow (execute → report → auto-debug on failure)
5. Implement debug flow (reproduce → classify → fix-or-report)

### Phase 3: Self-Maintenance

1. Create `.claude/commands/browsertest:maintain.md`
2. Implement stale test detection (compare code modification dates via git log)
3. Implement orphan test detection (check if related source files exist)
4. Implement auto-update flow (MCP re-explore → update spec → verify)

### Phase 4: Polish

1. Implement health dashboard (`/browsertest report`)
2. Add `relatedCode` tracking to manifest entries
3. Test coverage mapping (which features have tests, which don't)

## 13. Open Questions

None — all questions resolved during ideation.

## 14. Related ADRs

- [ADR-0004: Monorepo with Turborepo](../../decisions/0004-monorepo-with-turborepo.md) — workspace structure, task configuration
- [ADR-0002: Adopt Feature-Sliced Design](../../decisions/0002-adopt-feature-sliced-design.md) — test directory mirrors FSD feature structure

## 15. References

- [Playwright Test documentation](https://playwright.dev/docs/intro)
- [Playwright webServer config](https://playwright.dev/docs/test-webserver)
- [Playwright fixtures](https://playwright.dev/docs/test-fixtures)
- [Playwright Page Object Models](https://playwright.dev/docs/pom)
- [Turborepo Playwright guide](https://turborepo.dev/docs/guides/tools/playwright)
- [Playwright MCP server](https://github.com/microsoft/playwright-mcp)
- [Research artifact](../../research/20260225_browser_testing_system.md) — full research findings with 17 sources
- [Ideation document](./01-ideation.md) — problem analysis and decision rationale
