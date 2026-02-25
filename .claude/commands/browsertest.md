---
description: Run, create, debug, and maintain browser tests
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TaskOutput, AskUserQuestion
argument-hint: '<run|debug|maintain|report|create> [feature] [description]'
category: testing
---

# Browser Test Command

You are managing DorkOS browser tests. Parse `$ARGUMENTS` and route to the appropriate action.

## Routing Logic

Parse the first word of `$ARGUMENTS`:

### `run [feature]`

Execute browser tests.

```bash
# Run all tests
cd apps/e2e && npx playwright test

# Run specific feature
cd apps/e2e && npx playwright test tests/<feature>/
```

After running, read `apps/e2e/manifest.json` and display a results summary.

### `create <feature> <description>`

Create a new browser test using a 5-phase explore-first loop. Never guess selectors — discover them by navigating like a real user.

#### Pre-Flight

1. Read `apps/e2e/manifest.json` — check if a similar test already exists. If it does, confirm with the user before overwriting.
2. Read `apps/e2e/GOTCHAS.md` — absorb known anti-patterns before writing anything.
3. Check manifest for `explorationNotes` on related tests — build on prior knowledge.
4. Read `apps/e2e/pages/` for existing POMs that may already cover needed interactions.

#### Phase 1: EXPLORE

Navigate the feature step-by-step as a real user would. At **each** meaningful state change:

1. `mcp__playwright__browser_navigate` to `http://localhost:4241` (or the relevant page)
2. `mcp__playwright__browser_snapshot` to capture the accessibility tree
3. Document: element roles, names, testids, hierarchy, loading indicators, conditional rendering
4. Note timing: what loads immediately, what appears after an SSE event or API call, what animates

Continue until you have observed every state the test needs to assert against. Stay within the scope of `<description>` — don't explore unrelated features.

#### Phase 2: WRITE

Using **only** the selectors discovered in Phase 1:

1. Create or update POMs in `apps/e2e/pages/` with the explored locators. Prefer `getByRole()` → `data-testid` → text. Never use CSS classes.
2. Register new POMs in `apps/e2e/fixtures/index.ts`.
3. Write the `.spec.ts` file in `apps/e2e/tests/<feature>/` using custom fixtures from `../../fixtures`.
4. Follow the patterns in `.claude/skills/browser-testing/SKILL.md`.

#### Phase 3: RUN & OBSERVE

```bash
cd apps/e2e && npx playwright test tests/<feature>/<new-test>.spec.ts
```

- **If it passes** → proceed to Phase 4.
- **If it fails** (max 3 iterations):
  1. Read the error message and identify the failing step.
  2. Use `mcp__playwright__browser_navigate` + `mcp__playwright__browser_snapshot` to inspect the **actual** page state at the point of failure.
  3. Diagnose: wrong selector? timing issue? unexpected UI state?
  4. Fix the spec or POM, then re-run.
- **If still failing after 3 iterations** → use `AskUserQuestion` to present the diagnosis and ask for guidance.

#### Phase 4: STABILIZE

Run the test 3 consecutive times:

```bash
cd apps/e2e && npx playwright test tests/<feature>/<new-test>.spec.ts --repeat-each=3
```

- **3/3 pass** → proceed to Phase 5.
- **Any failure** → diagnose the flaky step (usually a timing issue), fix, then re-run Phase 3 once. If still flaky after that, ask the user.

#### Phase 5: RECORD

1. Write `explorationNotes` to the test entry in `apps/e2e/manifest.json` — document selectors, timing observations, and gotchas specific to this feature.
2. If you discovered any new anti-patterns, append them to `apps/e2e/GOTCHAS.md` under the appropriate category.
3. Display a summary: test name, phases completed, iterations needed, key observations.

### `debug <test-name>`

Debug a failing test:

1. Run the test with JSON output: `cd apps/e2e && npx playwright test tests/**/<test-name>.spec.ts --reporter=json 2>&1`
2. Parse the error message and failure location
3. Use Playwright MCP to navigate to the page where the test fails
4. Use `mcp__playwright__browser_snapshot` to capture the current accessibility tree
5. Compare the snapshot with what the test expects (locators, text content, element visibility)
6. **Classify the failure:**
   - **TEST bug** (selector changed, timing issue, new UI pattern): Auto-fix the spec or POM, re-run, verify
   - **CODE bug** (regression, broken feature): Present diagnosis and fix options via AskUserQuestion
7. Update manifest.json with the debug session results

### `maintain`

Delegate to the maintain command:

```
Read and follow the instructions in .claude/commands/browsertest:maintain.md
```

### `report`

Display a health dashboard from manifest data:

1. Read `apps/e2e/manifest.json`
2. Calculate aggregate statistics
3. Display formatted report:

```
Browser Test Health Dashboard
==============================

Suite Status: <N> tests | <N> passing | <N> failing | <N>% pass rate
Last Run: <timestamp> (<duration>ms)

Feature Breakdown:
  <feature>: <passed>/<total> passing (<percent>%)
  ...

Recent History (last 5 runs):
  #<N>: <passed>/<total> passed (<duration>ms)
  ...
```

### No recognized subcommand (default)

Treat the arguments as a feature search:

1. Read `apps/e2e/manifest.json`
2. Search for a test matching the arguments (fuzzy match on test key, feature, or description)
3. **If found**: Run the matching test
4. **If not found**: Offer to create a new test using the `create` flow above

## Key Principles

- Always import `test` and `expect` from `../../fixtures`, never from `@playwright/test` directly
- Use Page Object Models for all interactions
- Tag tests: `@smoke` for fast critical path, `@integration` for SDK-dependent
- Never use `page.waitForTimeout()` — use locator state waits
- Auto-fix test bugs; ask the user before making code changes
