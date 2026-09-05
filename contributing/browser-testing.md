# Browser Testing Guide

> **Sync note:** A condensed, user-facing version of the testing docs is published on the docs site at `docs/contributing/testing.mdx`. When you change the testing setup here, update that page too so the two do not drift.

This guide covers the AI-driven browser testing system for DorkOS. The system has two layers: a standard Playwright Test suite for deterministic tests, and an AI orchestration layer for writing, debugging, and maintaining those tests.

> **Verifying against a live instance?** This guide covers the deterministic
> Playwright suite. For checking a change against a real running DorkOS with
> real agent turns — and the traps that make such a check pass while proving
> nothing — see `browser-verification.md`.

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
- `@integration` tests need real model credentials AND are excluded by default — opt in with `E2E_INTEGRATION=1` (see `apps/e2e/README.md`)
- Dev servers running (auto-started if not): `pnpm dev`

## Architecture

### Two-Layer System

**Layer 1: Standard Playwright Test suite** — Deterministic `.spec.ts` files that run via `npx playwright test`. CI-friendly, no AI needed. Lives in `apps/e2e/tests/`.

**Layer 2: AI orchestration layer** — Claude Code commands (`.claude/commands/browsertest.md`) and skills (`.claude/skills/browser-testing/`) that use the Playwright MCP server to write, debug, and maintain tests.

### Directory Structure

```
apps/e2e/
├── playwright.config.ts      # Multi-server config (Vite + Express)
├── manifest.json              # Test registry + run history (regenerable, gitignored — DOR-726)
├── manifest-curated.json      # Hand-curated relatedCode/explorationNotes (tracked)
├── GOTCHAS.md                 # Known anti-patterns and hard-won lessons
├── BROWSER_TEST_PLAN.md       # Manual + automated test coverage checklist
├── global-setup.ts            # Dismisses first-run onboarding on every API leg
├── fixtures/
│   ├── index.ts               # Extended test with DorkOS fixtures
│   ├── rooms-api.ts           # Seeds/cleans rooms and agents over REST
│   └── tasks-api.ts           # Seeds/cleans scheduled tasks over REST
├── pages/                     # Page Object Models
│   ├── BasePage.ts            # Common navigation helpers
│   ├── ChatPage.ts            # Chat interactions
│   ├── command-palette.ts     # Shared opener every dialog POM uses
│   ├── DashboardSidebarPage.ts # Sidebar roster, groups, drag-and-drop
│   ├── RightPanelPage.ts      # Right panel tabs (Pulse, Profile)
│   ├── RoomsPage.ts           # Channels and DMs
│   ├── SettingsPage.ts        # Settings dialog
│   ├── TasksPage.ts           # Tasks Scheduler dialog
│   └── RelayPage.ts           # Relay "Connections" dialog
├── reporters/
│   └── manifest-reporter.ts   # Custom reporter updating manifest.json
└── tests/                     # Test specs organized by feature
    ├── smoke/                 # @smoke — critical path, no SDK
    ├── agents/                # The /agents fleet page (replaced mesh/)
    ├── chat/                  # send-message is @integration; status-line-fit is not
    ├── dashboard-sidebar/     # Roster groups and drag-and-drop
    ├── pulse/                 # Pulse panel tests
    ├── relay/                 # Relay "Connections" dialog + adapter wizard
    ├── production/            # The built app served by Express, real CSP
    ├── rooms/                 # Channels, DMs, mentions, palette
    ├── settings/
    └── tasks/                 # Tasks Scheduler dialog
```

## Writing Tests

### Import from Fixtures

Always import `test` and `expect` from the custom fixtures, never directly from `@playwright/test`:

```typescript
import { test, expect } from '../../fixtures';
```

The fixture file (`fixtures/index.ts`) provides these pre-instantiated Page Objects,
plus two seeding helpers:

| Fixture            | Class                  | Auto-navigates?                                                      |
| ------------------ | ---------------------- | -------------------------------------------------------------------- |
| `basePage`         | `BasePage`             | No                                                                   |
| `chatPage`         | `ChatPage`             | Yes — calls `goto()` which navigates and ensures a session is active |
| `dashboardSidebar` | `DashboardSidebarPage` | No                                                                   |
| `roomsPage`        | `RoomsPage`            | No                                                                   |
| `rightPanel`       | `RightPanelPage`       | No                                                                   |
| `settingsPage`     | `SettingsPage`         | No — call `settingsPage.open()` to open the dialog                   |
| `tasksPage`        | `TasksPage`            | No — call `tasksPage.open()` to open the dialog                      |
| `relayPage`        | `RelayPage`            | No — call `relayPage.open()` to open the dialog                      |
| `authPage`         | `AuthPage`             | No                                                                   |
| `roomsApi`         | `RoomsApi`             | Seeds rooms/agents over REST; cleans up in teardown                  |
| `tasksApi`         | `TasksApi`             | Seeds schedules over REST; cleans up in teardown                     |

There is no `meshPage`: the Mesh dialog was replaced by the `/agents` page.

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

For dialog-based features (Settings, Tasks, Relay), call `open()` first:

```typescript
test('tasks dialog opens @smoke', async ({ basePage, tasksPage }) => {
  await basePage.goto();
  await basePage.waitForAppReady();
  await tasksPage.open();
  await expect(tasksPage.heading).toBeVisible();
  await tasksPage.close();
});
```

**Opening a dialog**: go through the command palette — `openFromCommandPalette(page, 'Tasks Scheduler')` — which is what every dialog page object's `open()` now does.

These used to dispatch a JS click instead:

```ts
// Do NOT do this.
page.evaluate(() => {
  (document.querySelector('button[aria-label="Mesh agent discovery"]') as HTMLElement)?.click();
});
```

The advice it was written for (pointer interception by the main content area) had stopped being true, and by the time anyone checked, none of those `aria-label`s existed in the client at all. The `?.` is what made that survivable and therefore invisible: a missing button is a silent no-op, so the dialog never opens and the test spends its full 30s timeout waiting for it. **Thirty-two failures presented as timeouts, which read like flake, and were nothing of the kind.**

A real locator still waits out its timeout — what you get back is a diagnosis instead of a mystery: `waiting for getByRole('option', { name: 'Tasks Scheduler' })` names the control that is missing, where the old failure named a dialog nobody had asked to open.

If a click is genuinely intercepted, fix the interception or `await expect(button).toBeVisible()` first — never reach past the DOM with `evaluate`, and never with optional chaining.

### Selector Strategy

Priority order:

1. `getByRole()` — Semantic, resilient to UI changes
2. `data-testid` — Stable contract between test and implementation
3. CSS class — Last resort, fragile

**Known role quirk**: The chat message input uses `combobox` role (not `textbox`) with the name `"Message Claude..."`. Always use `page.getByRole('combobox', { name: /message claude/i })` — the `ChatPage` POM handles this automatically.

### Wait Strategy

- **Never** use `page.waitForTimeout()` or `setTimeout`
- Use locator state waits: `.waitFor({ state: 'visible' })`
- For streaming: wait for inference indicator lifecycle
- For navigation: use `expect(page).toHaveURL()`
- For API calls: use `page.waitForResponse()`

### Test Tagging

- `@smoke` — Critical path, no SDK dependency, fast (<5s). Run with `--grep @smoke`
- `@integration` — needs a real model turn and real credentials, slower (10-60s). **Excluded from every run by default**; opt in with `E2E_INTEGRATION=1`.

Tag `@integration` only when a test genuinely cannot pass without a live model — the tag now decides what CI runs, so wearing it needlessly silently drops coverage. `status-line-fit.spec.ts` carried it for a long time while only measuring layout, which kept five working tests out of the suite for nothing.

Add tags to `test.describe()` titles:

```typescript
test.describe('Feature — Description @smoke', () => { ... });
```

## Running Tests

| Command                                               | Description                     |
| ----------------------------------------------------- | ------------------------------- |
| `pnpm test:browser`                                   | Run all tests via Turbo         |
| `pnpm test:browser:ui`                                | Playwright interactive UI mode  |
| `cd apps/e2e && npx playwright test`                  | Run directly (faster iteration) |
| `cd apps/e2e && npx playwright test --grep @smoke`    | Smoke tests only                |
| `cd apps/e2e && npx playwright test tests/chat/`      | Specific feature                |
| `cd apps/e2e && PWDEBUG=1 npx playwright test <file>` | Debug mode                      |
| `cd apps/e2e && npx playwright show-report`           | View HTML report                |

The `webServer` config in `playwright.config.ts` auto-starts every leg the run needs — the Express and Vite servers, and (opt-in) the marketing site and production legs. No run adopts a server it did not start, so a busy port is a startup error naming that port rather than a silent attachment. `apps/e2e/README.md` has the port table and the isolated-run recipe.

### The production leg (`E2E_PROD`)

Almost every spec loads the app from Vite, which serves its own shell with **no `Content-Security-Policy` header**. The shipped policy goes out only with the built shell an `NODE_ENV=production` Express server serves, so a directive that breaks a real browser surface used to be invisible to this entire suite (DOR-560 shipped one). `E2E_PROD=1` boots that leg — the built client, served the way production serves it — and the `chromium-production` project runs `tests/production/` against it. It is on by default in CI and off by default locally, because it has to build the client first.

Keep it a smoke subset: the shell booting, and the surfaces the policy can silently take away. Ordinary feature coverage belongs on the cockpit leg. Never drive a turn there — that leg registers the real Claude Code runtime.

## AI Commands

### `/browsertest` — Main Entry Point

Smart routing based on arguments:

| Usage                                  | Behavior                                              |
| -------------------------------------- | ----------------------------------------------------- |
| `/browsertest run`                     | Run entire suite                                      |
| `/browsertest run chat`                | Run all chat feature tests                            |
| `/browsertest chat messaging`          | Run existing test OR create new one                   |
| `/browsertest debug chat-messaging`    | Debug a specific failing test                         |
| `/browsertest maintain`                | Audit suite health, update stale tests                |
| `/browsertest report`                  | Show test health dashboard                            |
| `/browsertest create chat file-upload` | Explore feature, write test, iterate until 3/3 stable |

### `/browsertest:maintain` — Suite Health Audit

Audits all tests, categorizes them as healthy/stale/broken/orphaned, and auto-fixes test-side issues.

## Manifest

`apps/e2e/manifest.json` is the central registry tracking all tests with metadata. It is **gitignored** (DOR-726): every run rewrites its `lastRun`/run-count fields, so no legitimate action could ever leave it clean tracked — two branches had to hand-restore it before committing when it still was. Delete it and it regenerates from nothing the next time the suite runs.

`apps/e2e/manifest-curated.json` is the half that stays **tracked**: just each test's hand-set `relatedCode` and `explorationNotes`, nothing a run could regenerate on its own. `manifest-reporter.ts` merges it back into `manifest.json` on every write (`applyCurated`), so a person's curation survives even a `manifest.json` that started from nothing — the loss a first cut of the gitignore fix caused, caught in review.

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
    {
      "id": "2026-02-25T10-30-00",
      "timestamp": "...",
      "total": 8,
      "passed": 7,
      "failed": 1,
      "skipped": 0,
      "duration": 45000
    }
  ]
}
```

The manifest is automatically updated by the custom reporter after each test run. AI commands read it for health dashboards and stale test detection.

**`failCount` is a lifetime tally, not a flake rate** — worth knowing before you file a ticket about one. The reporter counts a **run of the whole file**: `runCount` goes up once per invocation that touched the file, and `failCount` once for any invocation in which any test in it was red. Every red the file was in while somebody was writing it is in there, so a file that was built test-first, or rewritten under a big refactor, carries the whole TDD loop in its numbers forever.

`room-entry-actions` was ticketed at "31 failures in 69 runs" on that reading (DOR-1412). Read back off the tracked manifest's own history — `git log --all -- apps/e2e/manifest.json`, then `git show <commit>:apps/e2e/manifest.json` for the trees where it was still tracked — 17 of the 31 landed on the one branch that added its thread tests and 5 more on a later branch editing the same file; `failCount` had not moved for the last twelve recorded runs, which were all green. **To ask whether a spec is flaky, repeat it and count** (`--repeat-each=N --workers=1`), and read the manifest for what it can actually answer: when a file last ran, and whether it passed.

## Adding New Tests

### Manual

Before writing new tests, read `apps/e2e/GOTCHAS.md` for known anti-patterns and consult `apps/e2e/BROWSER_TEST_PLAN.md` for feature coverage gaps.

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

### Copy Drift — the PR-time guard (DOR-1647)

This suite quotes real product copy on purpose, and the copy moves. Because `browser-test` reports an instant pass-through on pull requests and only runs the shards in the merge queue (see the header of `.github/workflows/browser-test.yml`), a PR that rewrites a string used to be green everywhere until the queue ran it — and a failure there ejects the PR from the queue _and_ switches off auto-merge. It happened twice in one day on 2026-08-31.

`scripts/check-copy-spec-drift.ts` is the cheap signal that closes most of that hole, running as the `copy-spec-drift` job on every pull request. It compares two things statically, without a browser:

1. the runs of authored text your change deleted from `apps/client/src`, `apps/site/src`, `apps/server/src` and `packages/shared/src` — parsed with the TypeScript compiler, so strings, template pieces and JSX text all count and comments never do;
2. every string, template piece and regular expression under `apps/e2e`.

If a browser-suite string still spans copy your change deleted, and nothing in the app covers that string more specifically any more, the job goes red and names the spec file and line. The fix is nearly always to update the assertion in the same change.

Run it yourself before pushing — it reads your working tree, so uncommitted edits count:

```bash
pnpm check:copy-spec-drift            # against origin/main
pnpm check:copy-spec-drift <base-ref> # against something else
```

What it does **not** catch: assertions that count things rather than read them (`toHaveCount`), copy assembled from a lookup table, and specs that build their expected text the same dynamic way the component does. Those still only surface in the queue. The job is advisory — it is not a required check — so a red does not block the merge queue, but it does stop `merge-tail.yml` arming auto-merge until someone looks.

## Test-Mode Server (Mock Browser Tests)

Browser tests that don't need real Claude API calls use `TestModeRuntime` — a server-side `AgentRuntime` that yields pre-defined `StreamEvent` sequences. No `vi.fn()` or Vitest imports — it runs in a live server process.

### How It Works

1. Playwright starts a second Express server with `DORKOS_TEST_RUNTIME=true` on `MOCK_PORT` (default 4243, env `DORKOS_MOCK_PORT`)
2. A second Vite client on `MOCK_VITE_PORT` (default 4248, env `DORKOS_MOCK_VITE_PORT`) proxies `/api` to the mock server
3. Tests configure scenarios via `POST /api/test/scenario` before each interaction
4. The `chromium-mock` Playwright project targets the mock Vite client

### Port Layout

Every row names the env var that MOVES the leg — the name you set, not the
`playwright.config.ts` constant it lands in:

| Env var (default)                 | Service                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `DORKOS_COCKPIT_PORT` (4245)      | Cockpit Express server                                                    |
| `DORKOS_COCKPIT_VITE_PORT` (4244) | Vite client proxying to the cockpit server                                |
| `DORKOS_MOCK_PORT` (4243)         | Test-mode Express server                                                  |
| `DORKOS_MOCK_VITE_PORT` (4248)    | Vite client proxying to mock server — 6244 is reserved for `@dorkos/site` |
| `DORKOS_PROD_PORT` (4246)         | Production Express server, serving the built client (opt-in, `E2E_PROD`)  |

Every Express leg runs against a throwaway `DORK_HOME` under `/tmp`, keyed by that
leg's port and deleted before every boot — `/tmp/dorkos-cockpit-<port>`,
`/tmp/dorkos-test-mode-<port>` and `/tmp/dorkos-production-<port>`. No run reads or writes the dev data directory
(`apps/server/.temp/.dork`) or a real `~/.dork` (DOR-1223). The cockpit leg reads
`DORKOS_COCKPIT_PORT` rather than `DORKOS_PORT` for the same reason: `DORKOS_PORT`
is the dev server's own variable, set in the root `.env` and passed through by
turbo.

### Test Control API

Three endpoints on the mock server wire up test state before each spec:

```typescript
// Reset to default scenario (simple-text) and clear any state
await request.post(`${API_URL}/api/test/reset`);

// Dismiss the onboarding wizard (fresh DORK_HOME shows it by default)
await request.patch(`${API_URL}/api/config`, {
  data: { onboarding: { dismissedAt: new Date().toISOString() } },
});

// Seed a test agent so the send button is enabled
const res = await request.post(`${API_URL}/api/test/seed-agent`);
const { agentDir } = await res.json();

// Navigate to chat with the seeded agent directory
await chatPage.goto(undefined, { dir: agentDir });

// Set a specific scenario
await request.post(`${API_URL}/api/test/scenario`, {
  // Others: 'tool-call', 'todo-write', 'error', 'compacting', 'compacting-hold'
  data: { name: 'simple-text' },
});
```

The `seed-agent` endpoint creates a temporary `.dork/agent.json` under the mock DORK_HOME, registers that agent with the mesh, and returns `{ agentDir, agentId }`. Without it, the chat input's send button stays disabled because no agent is registered for the working directory.

Both halves matter, and the second one used to be missing (DOR-1142). `GET /api/sessions/recent` and `/daily-counts` fan out over `meshCore.listWithPaths()`, so a directory the mesh has never heard of contributes no sessions however many it holds — which left every sidebar zone built from recent sessions (Today, Heads-up) structurally empty on the test-mode leg. **Do not hand-roll registration around it.** Three suites once carried their own `POST /api/mesh/agents` dance in `beforeEach`; all three are deleted. That route is also the wrong tool here — it seats the agent in `#team`, which is a cross-project side effect on a server another project also drives. (It no longer mints a second id over the manifest's own: since DOR-1019 it adopts a manifest already on disk rather than rewriting it.)

The fixture's id is derived from its directory, so re-seeding in a per-test `beforeEach` is a true upsert rather than a new identity each time. Nothing needs unregistering between tests, and `POST /api/test/reset` deliberately leaves the mesh alone.

### Writing Mock Browser Tests

Mock tests live in `tests/chat-mock.spec.ts` and are matched by the `chromium-mock` project via `testMatch: ['**/chat-mock.spec.ts']`. They import from `@playwright/test` directly (not fixtures) and use `ChatPage` from `pages/ChatPage.ts`.

The `chromium` project ignores mock test files via `testIgnore: ['**/chat-mock.spec.ts']`, and vice versa — the two projects are fully isolated.
