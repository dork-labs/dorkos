# Playwright MCP — AI-Driven Test Authoring Research

**Date:** 2026-02-25
**Mode:** Focused Investigation
**Searches:** 6 queries + 5 page fetches

---

## 1. Exposed MCP Tools

`@playwright/mcp` (Microsoft's official server) exposes tools prefixed with `browser_`:

### Navigation
- `browser_navigate` — go to URL
- `browser_navigate_back` — history back
- `browser_navigate_forward` — history forward

### Observation (read-only)
- `browser_snapshot` — returns the accessibility tree as structured text (2-5KB; default, no vision model needed)
- `browser_take_screenshot` — pixel screenshot (requires vision-capable model)
- `browser_console_messages` — browser console output
- `browser_network_requests` — captured network activity

### Interaction
- `browser_click` — click by element ref from snapshot
- `browser_type` — keyboard input into field
- `browser_hover` — mouse hover
- `browser_drag` — drag-and-drop
- `browser_press_key` — raw key press
- `browser_select_option` — dropdown selection
- `browser_handle_dialog` — accept/dismiss alerts
- `browser_file_upload` — upload files

### Tab / Window Management
- `browser_tab_new`, `browser_tab_list`, `browser_tab_select`, `browser_tab_close`

### Utilities
- `browser_wait_for` — wait for element or condition
- `browser_resize` — viewport resize
- `browser_pdf_save` — save page as PDF
- `browser_generate_playwright_test` — **generate `.spec.ts` from current session actions**
- `browser_install` — install a browser binary
- `browser_close` — close browser

### Key architecture note
`browser_snapshot` uses Playwright's **accessibility tree**, not pixels. Output is structured, deterministic, and 10-100x smaller than screenshots — ideal for coding agents. Screenshot mode exists but requires a vision model and is slower.

---

## 2. "Explore First, Then Write Tests" Patterns

### The Canonical Pattern (Debs O'Brien / Playwright docs)
1. Point agent at a live URL
2. Agent calls `browser_navigate` + `browser_snapshot` to read the page state
3. Agent tabs through / interacts to discover flows (no predefined script)
4. Agent documents what it found (edge cases, UI quirks, real bugs)
5. Agent calls `browser_generate_playwright_test` or writes `.spec.ts` from observations
6. Agent runs the tests via Playwright CLI tools and iterates

**Key insight:** The exploration phase caught a real bug (wrong search results) that manual testing missed. Autonomous navigation surfaces things a scripted test wouldn't find.

### Prompt Template Structure
From the documented pattern in `.github/generate_tests.prompt.md`:

```
Role: "You are a Playwright test generator"
Rules:
  - DO run steps one by one using tools (not in batch)
  - Prefer role-based locators (getByRole, getByTestId)
  - Use auto-retrying assertions (toBeVisible, not toBe)
Workflow:
  Navigate → Explore 1 key functionality → Generate test → Execute → Iterate
```

### Playwright's Official 3-Agent Architecture (new in 2025)
Initialized via:
```bash
npx playwright init-agents --loop=[vscode|claude|opencode]
```

| Agent | Input | Output |
|-------|-------|--------|
| **Planner** | User request + seed test (+ optional PRD) | Markdown test plan in `specs/` |
| **Generator** | Markdown plan | `.spec.ts` files in `tests/` with live selector verification |
| **Healer** | Failing tests | Patched tests (locator fixes, wait adjustments) |

The seed test runs global setup so the planner has an authenticated/initialized browser context.

---

## 3. Claude + Playwright MCP Patterns Teams Use

### Pattern A: "Quinn" — PR-triggered QA Agent
Source: alexop.dev

```json
// Claude Code invocation in CI
--mcp-config '{"mcpServers":{"playwright":{
  "command":"npx",
  "args":["@playwright/mcp@latest","--headless"]
}}}'
```

- Triggered by GitHub Actions on `qa-verify` label
- Claude receives **restricted tool list** to enforce black-box testing:
  - Allowed: `browser_navigate`, `browser_click`, `browser_type`, `browser_take_screenshot`, `browser_resize`
  - Disallowed: file read/write, code access — forces user-perspective testing
- Three-layer prompt: Identity (QA persona) → Rules → Task (PR-specific)
- Output: Markdown bug report posted back to PR as comment

### Pattern B: VSCode Agent Mode + MCP
- Configure `.vscode/mcp.json` pointing to `@playwright/mcp`
- Use GitHub Copilot's Agent Mode (or Claude extension) as the driver
- Keep a `generate_tests.prompt.md` with role + rules as a reusable template
- Agent explores site, then writes test file, then runs it in-IDE

### Pattern C: Claude Code Directly (Simon Willison's approach)
Source: til.simonwillison.net

- Add `@playwright/mcp` to Claude Code's MCP servers config
- Ask Claude to "explore [URL] and write tests for [feature]"
- Claude uses snapshot tools to understand the DOM without screenshots
- Best for ad-hoc test authoring during development

### Pattern D: Checkly's CI Integration
- Generate tests exploratorily via MCP
- Promote passing tests into Checkly monitoring checks
- Use for both test generation AND ongoing synthetic monitoring

---

## 4. Write → Run → Fix Loop Best Practices

### The Core Loop
```
1. EXPLORE    browser_navigate + browser_snapshot (read the DOM)
2. WRITE      browser_generate_playwright_test or hand-write .spec.ts
3. RUN        npx playwright test [file]
4. OBSERVE    Read failures — use Trace Viewer artifacts
5. FIX        Healer agent or manual prompt with failure output
6. REPEAT     Until green
```

### Locator Best Practices (enforce in prompts)
- Prefer: `getByRole()`, `getByTestId()`, `getByLabel()`, `getByText()`
- Avoid: CSS selectors, XPath — these break on refactors

### Assertion Best Practices
- Use auto-retrying assertions: `toBeVisible()`, `toContainText()`
- Avoid: `toBe(true)` on `.isVisible()` — not auto-retrying

### Structural Best Practices
- One behavior per test (single-purpose)
- Tests should be independent (no shared mutable state between tests)
- Accept a generated test only after it passes consistently (run 2-3 times)

### CI Considerations
- Always use `--headless` flag in CI
- Traces (`--trace on`) and screenshots (`--screenshot only-on-failure`) are essential debugging artifacts
- Don't run MCP-generated tests blind in CI — validate them locally first

### Snapshot vs Screenshot Mode
| Mode | When to use | Token cost |
|------|-------------|------------|
| `browser_snapshot` (default) | Most test generation, coding agents | Low (2-5KB) |
| `browser_take_screenshot` | Visual regression, complex layouts | High (requires vision model) |

---

## 5. DorkOS-Specific Implementation Notes

### MCP Config for Claude Code
Add to `.claude/settings.json` or via `claude mcp add`:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless"]
    }
  }
}
```

### Integration with Existing E2E Tests
The existing `apps/e2e/` directory uses Playwright already. The `BasePage.ts` / `ChatPage.ts` + spec files pattern is compatible with MCP-generated tests — MCP can write to that directory using the same conventions.

### Recommended Workflow for DorkOS
1. Start dev server (`pnpm dev`)
2. Point Claude Code (with Playwright MCP) at `http://localhost:3000`
3. Prompt: "Explore the session list and chat interface, then write Playwright tests for [feature] in `apps/e2e/tests/`"
4. Claude uses `browser_snapshot` to read the accessibility tree of the running app
5. Claude writes tests following the existing `BasePage` pattern
6. Run: `pnpm --filter=@dorkos/e2e test`
7. Feed failures back to Claude for the fix loop

The AI-driven browser testing system already added in `468d532` gives a foundation for this.

---

## Sources & Evidence

- [GitHub - microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) — Official tool list and config docs
- [Playwright Test Agents Docs](https://playwright.dev/docs/test-agents) — 3-agent architecture (Planner/Generator/Healer)
- [Letting Playwright MCP Explore your site and Write your Tests - DEV Community](https://dev.to/debs_obrien/letting-playwright-mcp-explore-your-site-and-write-your-tests-mf1) — Explore-first workflow walkthrough
- [Building an AI QA Engineer with Claude Code and Playwright MCP](https://alexop.dev/posts/building_ai_qa_engineer_claude_code_playwright/) — "Quinn" PR-triggered CI pattern
- [Using Playwright MCP with Claude Code - Simon Willison's TILs](https://til.simonwillison.net/claude-code/playwright-mcp-claude-code) — Direct Claude Code integration
- [Generating end-to-end tests with AI and Playwright MCP - Checkly](https://www.checklyhq.com/blog/generate-end-to-end-tests-with-ai-and-playwright/) — CI + monitoring promotion pattern
- [Playwright MCP: Setup, Best Practices & Troubleshooting - TestCollab](https://testcollab.com/blog/playwright-mcp) — Best practices summary
- [The Complete Playwright End-to-End Story - Microsoft for Developers](https://developer.microsoft.com/blog/the-complete-playwright-end-to-end-story-tools-ai-and-real-world-workflows) — Official Microsoft overview

---

## Research Gaps

- No documented pattern for using Playwright MCP with DorkOS's existing `BasePage` abstraction specifically
- Healer agent availability in `--loop=claude` mode not confirmed (may require specific Playwright version)
- Tool budget/token cost benchmarks for snapshot vs screenshot modes in long sessions not precisely quantified
