# Browser Testing System — Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-02-25
**Mode:** Full decomposition

---

## Phase 1: Foundation (Infrastructure + Seed Tests)

### 1.1 Create apps/e2e workspace with Playwright config

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create the `apps/e2e/` directory as a new Turborepo workspace with `@playwright/test`. Includes:

- `package.json` (`@dorkos/e2e` workspace)
- `tsconfig.json` extending shared preset
- `playwright.config.ts` with multi-server webServer (Express API + Vite Client)
- `.gitignore` for playwright-report/, test-results/, etc.
- Empty directory structure (tests/, fixtures/, pages/, reporters/)
- Initial `manifest.json` (`{ version: 1, tests: {}, runHistory: [] }`)
- Install dependencies and Chromium browser

---

### 1.2 Add turbo tasks and npm scripts for E2E

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Add to `turbo.json`:

- `e2e` task: `cache: false`, `dependsOn: ["^build"]`, `passThroughEnv` for Playwright/CI/SDK vars
- `e2e:ui` task: `cache: false`, `persistent: true`

Add to root `package.json`:

- `test:browser` script: `turbo run e2e --filter=@dorkos/e2e --only`
- `test:browser:ui` script: `turbo run e2e:ui --filter=@dorkos/e2e --only`

---

### 1.3 Create Page Object Models and fixtures

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.4

Create four POMs and the extended Playwright fixture:

- `pages/BasePage.ts` — common `goto()` and `waitForAppReady()` helpers
- `pages/ChatPage.ts` — chat interactions (sendMessage, waitForResponse, getMessages, lastAssistantMessage)
- `pages/SessionSidebarPage.ts` — sidebar interactions (createNewSession, selectSession, getSessionCount)
- `pages/SettingsPage.ts` — settings dialog (open, close, switchTab)
- `fixtures/index.ts` — `test.extend<DorkOSFixtures>()` injecting all four POMs

---

### 1.4 Add data-testid attributes to client components

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.3

Add `data-testid` to 10 client components:

| Component           | File                     | Attribute                                     |
| ------------------- | ------------------------ | --------------------------------------------- |
| App shell           | `App.tsx`                | `data-testid="app-shell"`                     |
| Chat panel          | `ChatPanel.tsx`          | `data-testid="chat-panel"`                    |
| Message list        | `MessageList.tsx`        | `data-testid="message-list"`                  |
| Message item        | `MessageItem.tsx`        | `data-testid="message-item"` + `data-role`    |
| Session sidebar     | `SessionSidebar.tsx`     | `data-testid="session-sidebar"`               |
| Session list        | `SessionSidebar.tsx`     | `data-testid="session-list"`                  |
| Session item        | `SessionItem.tsx`        | `data-testid="session-item"`                  |
| Status line         | `StatusLine.tsx`         | `data-testid="status-line"`                   |
| Settings dialog     | `SettingsDialog.tsx`     | `data-testid="settings-dialog"`               |
| Inference indicator | `InferenceIndicator.tsx` | Rename to `data-testid="inference-indicator"` |

---

### 1.5 Create custom manifest reporter

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.3, 1.4

Create `reporters/manifest-reporter.ts` implementing `Reporter` interface. Updates `manifest.json` after each test run with:

- Per-test entries (specFile, feature, description, lastRun, lastStatus, runCount, passCount, failCount)
- Run history (id, timestamp, total, passed, failed, skipped, duration) capped at 100 entries
- Graceful fallback if manifest.json is missing or corrupt

---

### 1.6 Write seed tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.3, 1.4, 1.5

Four seed test files:

- `tests/smoke/app-loads.spec.ts` — Verifies app shell, sidebar, chat panel, status line render (`@smoke`)
- `tests/chat/send-message.spec.ts` — Sends real message via Agent SDK, verifies response (`@integration`)
- `tests/session-list/session-management.spec.ts` — Creates new session, verifies URL update (`@smoke`)
- `tests/settings/settings-dialog.spec.ts` — Opens/closes dialog, switches tabs (`@smoke`)

---

### 1.7 Write contributing/browser-testing.md guide

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.6

Developer guide with 9 sections: Quick Start, Architecture (two-layer system), Writing Tests (POM patterns, fixture usage, selector strategy), Running Tests (npm scripts, CLI, UI mode, debug mode), AI Commands, Manifest, Adding New Tests, Debugging, Maintenance.

---

## Phase 2: AI Commands

### 2.1 Create /browsertest command with smart routing

**Size:** Medium | **Priority:** High | **Dependencies:** 1.6 | **Parallel with:** 2.2

`.claude/commands/browsertest.md` with smart routing:

- `run [feature]` — Execute tests (all or feature subset)
- `create <feature> <description>` — MCP-driven test creation
- `debug <test-name>` — Diagnose and classify (test bug vs code bug)
- `maintain` — Delegate to /browsertest:maintain
- `report` — Health dashboard from manifest.json
- No subcommand — Feature search in manifest, offer to create if not found

---

### 2.2 Create browser-testing skill

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.6 | **Parallel with:** 2.1

`.claude/skills/browser-testing/SKILL.md` teaching 8 topics:

1. When to use browser test vs unit test
2. Page Object Model patterns (fixture-based)
3. Selector strategy (getByRole > data-testid > CSS)
4. Wait strategy (no arbitrary timeouts)
5. Test tagging (@smoke, @integration)
6. Debugging methodology (reproduce, snapshot, classify, fix)
7. Manifest management
8. DorkOS-specific patterns (SSE, URL state, layout, settings)

---

## Phase 3: Self-Maintenance

### 3.1 Create /browsertest:maintain command

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.1

`.claude/commands/browsertest:maintain.md` implementing 7-step audit:

1. Read manifest
2. Audit each test (file exists? code changed? test passes?)
3. Categorize (healthy, stale, broken, orphaned)
4. Auto-fix stale tests via MCP snapshot comparison
5. Handle orphans (prompt user, confirm removal)
6. Handle broken tests (classify test-vs-code bug)
7. Update manifest and display audit report

---

## Phase 4: Polish

### 4.1 Add relatedCode tracking and coverage mapping

**Size:** Medium | **Priority:** Low | **Dependencies:** 1.5, 1.6, 3.1

Extend manifest schema:

- Add `relatedCode: string[]` and `lastModified: string` to TestEntry
- Add `coverage` section to Manifest (per-feature test coverage percentages)
- Populate seed test `relatedCode` arrays
- Update reporter to preserve relatedCode/lastModified on updates

---

## Dependency Graph

```
1.1 ──┬──→ 1.3 ──┐
      ├──→ 1.5 ──┤
1.2 ──┘           ├──→ 1.6 ──→ 1.7
1.4 ──────────────┘     │
                        ├──→ 2.1 ──→ 3.1 ──→ 4.1
                        └──→ 2.2
```

## Summary

| Phase                | Tasks        | Parallel Opportunities                 |
| -------------------- | ------------ | -------------------------------------- |
| P1: Foundation       | 7 tasks      | 1.1+1.2 parallel; 1.3+1.4+1.5 parallel |
| P2: AI Commands      | 2 tasks      | 2.1+2.2 parallel                       |
| P3: Self-Maintenance | 1 task       | —                                      |
| P4: Polish           | 1 task       | —                                      |
| **Total**            | **11 tasks** | **5 tasks can run in parallel pairs**  |
