---
description: Audit browser test suite health and fix stale tests
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot
argument-hint: ''
category: testing
---

# Browser Test Maintenance

Audit the browser test suite health, detect stale and orphaned tests, and auto-update broken tests.

## Maintenance Flow

### Step 1: Read Manifest

Read `apps/e2e/manifest.json` to get the list of all tracked tests. If the manifest is empty or has no tests, report that and stop.

### Step 2: Audit Each Test

For each test entry in the manifest:

1. **Check existence**: Glob for `apps/e2e/<specFile>` to verify the spec file still exists on disk
2. **Check staleness**: If the test has `relatedCode` entries, check if any were modified since `lastRun`:
   ```bash
   git log --since="<lastRun>" --oneline -- <relatedCode paths>
   ```
   If any output, the test is potentially stale.
3. **Run the test**: Execute the individual test to check if it passes:
   ```bash
   cd apps/e2e && npx playwright test <specFile> --reporter=json 2>&1
   ```

### Step 3: Categorize Results

Classify each test into one of four categories:

- **Healthy** — Test passes AND related code unchanged since last run
- **Stale** — Test passes BUT related code was modified since last run (may need updating)
- **Broken** — Test fails (selector changed, timing issue, or code regression)
- **Orphaned** — Spec file still exists but related source code files have been deleted

### Step 4: Auto-Fix Stale Tests

For stale tests:

1. Use Playwright MCP `mcp__plugin_playwright_playwright__browser_navigate` to visit the feature at `http://localhost:6241`
2. Use `mcp__plugin_playwright_playwright__browser_snapshot` to capture the current accessibility tree
3. Compare current selectors/structure with what the test expects
4. Update POM locators or test assertions if they've drifted
5. Re-run the test to verify the update works

### Step 5: Handle Orphaned Tests

For orphaned tests:

1. Display the list of orphaned tests to the user
2. Ask for confirmation using AskUserQuestion before removing anything
3. If confirmed: delete the spec file and remove the entry from manifest.json
4. If declined: keep the test but flag it in the report

### Step 6: Handle Broken Tests

For broken tests:

1. Parse the JSON reporter output for error details
2. Use Playwright MCP to inspect the page state at the point of failure
3. **Classify the failure:**
   - **TEST bug** (selector changed, timing issue): Auto-fix the spec or POM, re-run, verify
   - **CODE bug** (feature regression): Report to user with diagnosis — do NOT auto-fix code
4. For code bugs, present the diagnosis and fix options via AskUserQuestion

### Step 7: Update Manifest and Report

Display a summary:

```
Browser Test Audit Results
===========================

Healthy: <N> tests
Stale (updated): <N> tests
Broken (fixed): <N> tests
Broken (code bug): <N> tests
Orphaned (removed): <N> tests

Details:
  [OK] smoke/app-loads.spec.ts — healthy
  [UPDATED] chat/send-message.spec.ts — stale, updated selectors
  [BUG] session-list/session-management.spec.ts — code regression in SessionSidebar
  [ORPHANED] pulse/old-feature.spec.ts — removed (user confirmed)
```

## Key Principles

- Always ask the user before deleting test files
- Auto-fix test-side issues (selectors, timing) without asking
- Never auto-fix code bugs — present diagnosis and ask
- Follow the methodology in `.claude/skills/browser-testing/SKILL.md`
- Update manifest.json with audit results
