# Browser Testing Guide

This guide covers the AI-driven browser testing system for DorkOS. The system has two layers: a standard Playwright Test suite for deterministic tests, and an AI orchestration layer for writing, debugging, and maintaining those tests.

## Quick Start

```bash
# Run all browser tests (reuses running dev server)
pnpm test:browser

# Run specific feature
cd apps/e2e && npx playwright test tests/chat/

# Run smoke suite only (fast, no SDK dependency)
cd apps/e2e && npx playwright test --grep @smoke

# Interactive UI mode
pnpm test:browser:ui

# Debug mode (opens browser inspector)
cd apps/e2e && PWDEBUG=1 npx playwright test tests/chat/send-message.spec.ts
```

**Prerequisites:**

- Chromium browser installed: `cd apps/e2e && npx playwright install chromium`
- For `@integration` tests: `ANTHROPIC_API_KEY` must be set in `.env`
- Dev servers running (auto-started if not): `pnpm dev`

## Architecture

### Two-Layer System

**Layer 1: Standard Playwright Test suite** — Deterministic `.spec.ts` files that run via `npx playwright test`. CI-friendly, no AI needed. Lives in `apps/e2e/tests/`.

**Layer 2: AI orchestration layer** — Claude Code commands (`.claude/commands/browsertest.md`) and skills (`.claude/skills/browser-testing/`) that use the Playwright MCP server to write, debug, and maintain tests.

### Directory Structure

```
apps/e2e/
├── playwright.config.ts      # Multi-server config (Vite + Express)
├── manifest.json              # Test registry + run history (AI health tracking)
├── fixtures/
│   └── index.ts               # Extended test with DorkOS fixtures
├── pages/                     # Page Object Models
│   ├── BasePage.ts            # Common navigation helpers
│   ├── ChatPage.ts            # Chat interactions
│   ├── SessionSidebarPage.ts  # Session sidebar
│   └── SettingsPage.ts        # Settings dialog
├── reporters/
│   └── manifest-reporter.ts   # Custom reporter updating manifest.json
└── tests/                     # Test specs organized by feature
    ├── smoke/                 # @smoke — critical path, no SDK
    ├── chat/                  # @integration — requires ANTHROPIC_API_KEY
    ├── session-list/
    └── settings/
```

## Writing Tests

### Import from Fixtures

Always import `test` and `expect` from the custom fixtures, never directly from `@playwright/test`:

```typescript
import { test, expect } from '../../fixtures';
```

### Use Page Object Models

Use POM methods for all interactions. Never use raw `page.locator()` calls in test bodies:

```typescript
test('sends a message', async ({ chatPage }) => {
  await chatPage.sendMessage('Hello');
  await chatPage.waitForResponse();

  const lastMessage = await chatPage.lastAssistantMessage();
  await expect(lastMessage).toContainText('Hello');
});
```

### Selector Strategy

Priority order:
1. `getByRole()` — Semantic, resilient to UI changes
2. `data-testid` — Stable contract between test and implementation
3. CSS class — Last resort, fragile

### Wait Strategy

- **Never** use `page.waitForTimeout()` or `setTimeout`
- Use locator state waits: `.waitFor({ state: 'visible' })`
- For streaming: wait for inference indicator lifecycle
- For navigation: use `expect(page).toHaveURL()`
- For API calls: use `page.waitForResponse()`

### Test Tagging

- `@smoke` — Critical path, no SDK dependency, fast (<5s). Run with `--grep @smoke`
- `@integration` — SDK-dependent, requires `ANTHROPIC_API_KEY`, slower (10-60s). Run with `--grep @integration`

Add tags to `test.describe()` titles:

```typescript
test.describe('Feature — Description @smoke', () => { ... });
```

## Running Tests

| Command | Description |
|---------|-------------|
| `pnpm test:browser` | Run all tests via Turbo |
| `pnpm test:browser:ui` | Playwright interactive UI mode |
| `cd apps/e2e && npx playwright test` | Run directly (faster iteration) |
| `cd apps/e2e && npx playwright test --grep @smoke` | Smoke tests only |
| `cd apps/e2e && npx playwright test tests/chat/` | Specific feature |
| `cd apps/e2e && PWDEBUG=1 npx playwright test <file>` | Debug mode |
| `cd apps/e2e && npx playwright show-report` | View HTML report |

The `webServer` config in `playwright.config.ts` auto-starts both Express and Vite dev servers if they're not already running. Set `reuseExistingServer: true` (default in dev) to reuse running servers for faster feedback.

## AI Commands

### `/browsertest` — Main Entry Point

Smart routing based on arguments:

| Usage | Behavior |
|-------|----------|
| `/browsertest run` | Run entire suite |
| `/browsertest run chat` | Run all chat feature tests |
| `/browsertest chat messaging` | Run existing test OR create new one |
| `/browsertest debug chat-messaging` | Debug a specific failing test |
| `/browsertest maintain` | Audit suite health, update stale tests |
| `/browsertest report` | Show test health dashboard |
| `/browsertest create chat file-upload` | Explore feature, write test, iterate until 3/3 stable |

### `/browsertest:maintain` — Suite Health Audit

Audits all tests, categorizes them as healthy/stale/broken/orphaned, and auto-fixes test-side issues.

## Manifest

`apps/e2e/manifest.json` is the central registry tracking all tests with metadata:

```json
{
  "version": 1,
  "tests": {
    "send-message": {
      "specFile": "tests/chat/send-message.spec.ts",
      "feature": "chat",
      "description": "sends a message and receives a response",
      "lastRun": "2026-02-25T10:30:00Z",
      "lastStatus": "passed",
      "runCount": 12,
      "passCount": 11,
      "failCount": 1,
      "relatedCode": ["apps/client/src/layers/features/chat/ui/ChatPanel.tsx"],
      "lastModified": ""
    }
  },
  "runHistory": [
    { "id": "2026-02-25T10-30-00", "timestamp": "...", "total": 8, "passed": 7, "failed": 1, "skipped": 0, "duration": 45000 }
  ]
}
```

The manifest is automatically updated by the custom reporter after each test run. AI commands read it for health dashboards and stale test detection.

## Adding New Tests

### Manual

1. Create a POM if the feature needs one (in `pages/`)
2. Register the POM as a fixture in `fixtures/index.ts`
3. Create the test file in `tests/<feature>/`
4. Run the test: `cd apps/e2e && npx playwright test tests/<feature>/<test>.spec.ts`
5. Manifest is auto-updated by the reporter

### AI-Assisted (`/browsertest create`)

The AI command uses a 5-phase explore-first loop:

1. **EXPLORE** — Navigates the feature with Playwright MCP, capturing snapshots at each state change to discover real selectors and timing
2. **WRITE** — Creates/updates POMs and spec using only explored selectors (never guesses)
3. **RUN & OBSERVE** — Runs the test; on failure, inspects actual browser state to diagnose and fix (up to 3 iterations)
4. **STABILIZE** — Runs 3 consecutive times (`--repeat-each=3`) to catch flakiness
5. **RECORD** — Writes `explorationNotes` to manifest, appends new gotchas to `GOTCHAS.md`

Before starting, the command reads `apps/e2e/GOTCHAS.md` (known anti-patterns) and checks `explorationNotes` on related tests in the manifest.

## Debugging

### Playwright Tools

- **Debug mode**: `PWDEBUG=1 npx playwright test <file>` — Opens browser inspector
- **Traces**: `trace: 'on-first-retry'` is configured — view with `npx playwright show-trace`
- **HTML report**: Generated after each run at `playwright-report/`
- **Screenshots**: Captured on failure at `test-results/`

### AI-Assisted Debugging

Use `/browsertest debug <test-name>` which:
1. Runs the failing test with JSON reporter for error details
2. Uses Playwright MCP to inspect current page state
3. Classifies as TEST bug or CODE bug
4. Auto-fixes test-side issues; presents diagnosis for code bugs

## Maintenance

### Stale Test Detection

The `/browsertest:maintain` command compares `relatedCode` modification dates against `lastRun` dates in the manifest to identify tests that may need updating.

### Auto-Update Flow

When a stale test is detected:
1. AI navigates to the feature using Playwright MCP
2. Captures current accessibility tree
3. Compares with test expectations
4. Updates POM locators or assertions as needed
5. Re-runs to verify

### Orphan Detection

Tests whose `relatedCode` files no longer exist are flagged as orphaned. The maintenance command asks for confirmation before removing them.
