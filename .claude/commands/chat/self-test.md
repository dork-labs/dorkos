---
description: "Self-test the DorkOS chat UI in a live browser session — drives real interactions, monitors JSONL transcript, compares API vs UI, researches issues, and produces an evidence-based findings report"
argument-hint: "[url] [focus:area1,area2]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Task, TaskOutput, AskUserQuestion, Skill, WebSearch, WebFetch, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_console_messages, mcp__claude-in-chrome__read_network_requests, mcp__claude-in-chrome__javascript_tool, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__computer
category: testing
---

Self-test the DorkOS chat UI in a live browser session. This command drives real interactions through the full stack, monitors JSONL transcripts on disk, compares API vs UI state at every step, researches any issues found, and produces an evidence-based findings report. If bugs or significant UX issues are found, it generates a prompt for the `/ideate` command.

---

## Argument Parsing

Parse `$ARGUMENTS` for two optional inputs:

1. **URL**: Any argument starting with `http` — use as `TEST_URL`. Default:
   ```
   TEST_URL="http://localhost:4241/?dir=/Users/doriancollier/Keep/temp/empty"
   ```

2. **Focus areas**: An argument starting with `focus:` — comma-separated list of specific areas to test. Examples:
   - `focus:streaming` — Focus on SSE streaming, freeze detection, chunk delivery
   - `focus:history` — Focus on reload-from-history, message persistence, JSONL fidelity
   - `focus:tasks` — Focus on TaskCreate/TaskUpdate UI, task state rendering
   - `focus:tools` — Focus on tool call cards, approval flows, expand/collapse
   - `focus:scroll` — Focus on auto-scroll, viewport overflow, scroll anchoring
   - `focus:sidebar` — Focus on session list, new session, session switching
   - `focus:status` — Focus on status bar, model selector, permission mode
   - `focus:code` — Focus on code block rendering, syntax highlighting, copy button
   - `focus:commands` — Focus on slash command palette, command discovery
   - `focus:markdown` — Focus on markdown rendering, links, lists, headings

   Multiple areas can be combined: `focus:streaming,history,tasks`

   When focus areas are specified:
   - **Phase 4 messages are tailored** to exercise those areas specifically
   - **Phase 5b checks are weighted** toward those areas
   - **Phase 6 research digs deeper** into focused areas
   - Unfocused areas still get basic coverage but with less depth

   When no focus is specified, run the full default test suite.

Store parsed values as `TEST_URL` and `FOCUS_AREAS` (array, possibly empty).

---

## Results File Setup

Results are saved to `test-results/chat-self-test/` with a unique filename per run.

Generate the filename using a timestamp:

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="test-results/chat-self-test"
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/$TIMESTAMP.md"
```

**Write the initial file immediately** with the header and test config (filled in as known so far). This file is updated incrementally throughout the test — every phase appends its findings as it completes. This ensures partial results are preserved if the test is interrupted.

```markdown
# Chat Self-Test — YYYY-MM-DD HH:MM

## Test Config
- **URL:** [test URL]
- **Focus areas:** [areas or "Full suite"]
- **Started:** [timestamp]
- **Status:** IN PROGRESS

---

```

---

## Phase 1 — Preflight

Parse `$ARGUMENTS`. If a URL starting with `http` is provided, use it as `TEST_URL`. Default:

```
TEST_URL="http://localhost:4241/?dir=/Users/doriancollier/Keep/temp/empty"
```

Extract the `dir` query param value from `TEST_URL` for JSONL resolution later.

Verify the dev server is up. Try multiple ports since the server may run on `DORKOS_PORT` (from `.env`), the default 4242 (when `.env` isn't loaded), or be proxied through Vite on 4241:

```bash
DORKOS_PORT="${DORKOS_PORT:-6942}"
# Try configured port first, then default, then Vite proxy
for port in $DORKOS_PORT 4242 4241; do
  if curl -sf "http://localhost:$port/api/health" | grep -q '"ok"'; then
    API_PORT=$port
    echo "Server found on port $port"
    break
  fi
done
[ -z "$API_PORT" ] && { echo "ERROR: DorkOS server not responding. Run 'pnpm dev' first."; exit 1; }
```

Check server config for Pulse status:

```bash
curl -s "http://localhost:$API_PORT/api/config" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('PULSE_ENABLED:', d.get('pulse',{}).get('enabled', False))
"
```

Fetch the current model list to know what's available:

```bash
curl -s "http://localhost:$API_PORT/api/models" | jq '.models[].value'
```

Fetch runtime capabilities and verify the `ClaudeCodeRuntime` is correctly registered:

```bash
curl -s "http://localhost:$API_PORT/api/capabilities" | python3 -c "
import sys, json
d = json.load(sys.stdin)
default = d.get('defaultRuntime', '(missing)')
caps = d.get('capabilities', {}).get(default, {})
print('Default runtime:', default)
print('supportsPermissionModes:', caps.get('supportsPermissionModes'))
print('supportsToolApproval:', caps.get('supportsToolApproval'))
print('supportsQuestionPrompt:', caps.get('supportsQuestionPrompt'))
print('supportsCostTracking:', caps.get('supportsCostTracking'))
"
```

Store `RUNTIME_CAPS` — if `supportsPermissionModes` or `supportsToolApproval` is `false`, note it as a **preflight warning** because Phase 3 and 4 depend on those capabilities being enabled. A missing or empty capabilities response is a **Bug** (the `GET /api/capabilities` endpoint was added in the agent-runtime-abstraction spec).

Navigate the browser to `TEST_URL`. Use `mcp__claude-in-chrome__tabs_context_mcp` first to get tab context, then `mcp__claude-in-chrome__navigate`. Take a screenshot and read the page. Capture any pre-existing console errors as a baseline via `mcp__claude-in-chrome__read_console_messages` (filter: `error`).

**Update the results file** — fill in the remaining Test Config fields (API port, Pulse status, available models, runtime capabilities, baseline console errors).

---

## Phase 2 — Create New Session

1. Locate the "New Session" button in the SessionSidebar via `mcp__claude-in-chrome__find`.
2. Click it and wait for the URL to update with a `?session=` query parameter.
3. Extract the session UUID from the URL. Store it as `URL_SESSION_ID`.

4. Locate the JSONL file on disk by session ID:

```bash
JSONL_FILE=$(find ~/.claude/projects -name "${URL_SESSION_ID}.jsonl" -type f 2>/dev/null)
SDK_SESSION_ID="$URL_SESSION_ID"
echo "JSONL: $JSONL_FILE"
```

The file may not exist yet — re-run this check after the first message is sent.

5. Take a screenshot of the new empty session.

**Update the results file** — append session IDs and JSONL path.

---

## Phase 3 — Configure Session

1. **Change model:** Click the model selector in the status bar. Choose `claude-haiku-4-5` (fastest, cheapest — appropriate for UI testing, not AI capability testing). If `claude-haiku-4-5` is not available, choose the smallest/cheapest model visible in the list.
2. **Set permission mode:** Click the permission mode selector in the status bar. Choose "Accept Edits" so tool-use file writes do not require manual approval during the test.
3. Take a screenshot after configuring both settings. Verify both settings are reflected in the status bar.

**Update the results file** — append model and permission mode used.

---

## Phase 4 — Send Messages & Observe

### Message Selection

**When focus areas are specified**, tailor messages to exercise those areas. Design 3-5 messages that specifically stress the focused functionality. For example:

| Focus | Tailored Messages |
|-------|-------------------|
| `streaming` | Long code generation, multi-tool sequences, rapid follow-ups |
| `history` | Messages that produce varied content types (code, text, tools) |
| `tasks` | `Use TodoWrite to create 3 tasks`, `Mark the first task done`, `Add a 4th task` |
| `tools` | `Use Bash to list files in /tmp`, `Read the contents of /etc/hostname` |
| `code` | `Write a Python class with decorators`, `Write a React component with JSX` |
| `markdown` | `Explain quicksort with headings, bullet lists, and a table` |
| `scroll` | Generate very long responses, send many messages in sequence |
| `commands` | Type `/` in chat input and test palette, try various commands |

**When no focus is specified**, use the default 5-message script:

| # | Message | Tests |
|---|---------|-------|
| 1 | `Write a JavaScript bubble sort function with comments` | Code rendering |
| 2 | `Add TypeScript types to the function` | Multi-turn context |
| 3 | `Write a minimal HTML page with a <h1>Hello World</h1> heading` | HTML in code blocks |
| 4 | `Use TodoWrite to create a task list with 3 tasks for our current conversation` | Task UI |
| 5 | `What is 2+2?` | Simple text response |

### Per-message observation loop (repeat for each message):

**a. Send the message:**
Click the chat input (use `mcp__claude-in-chrome__find` for "Message Claude input"), type the message text, and press `Meta+Enter` (Cmd+Enter) to submit.

**b. Wait for streaming to complete (with SSE freeze regression detection):**
Wait up to 120 seconds for the stop button to disappear. Use this staleness detection heuristic:

1. Take a screenshot after 15 seconds.
2. Wait 10 more seconds, take another screenshot.
3. If visible text is identical between screenshots but stop button persists, record an **"SSE stream freeze"** observation and click the stop button to unblock the test.
4. If stop button disappears naturally, note the actual streaming duration.

This prevents the test from hanging indefinitely per message. An SSE stream freeze is a **regression** and should be investigated with high priority.

**c. Take a screenshot** of the full rendered exchange.

**d. Collect console messages** at `warning` level via `mcp__claude-in-chrome__read_console_messages`. Note any new warnings since the last check.

**e. Collect network requests** via `mcp__claude-in-chrome__read_network_requests`. Note status codes for `/api/sessions/:id/messages` POST calls.

**f. Extract visible messages from the DOM:**
```js
// Use mcp__claude-in-chrome__javascript_tool
() => [...document.querySelectorAll('[data-message-role]')]
  .map(el => ({ role: el.dataset.messageRole, text: el.textContent.slice(0, 120) }))
```
First inspect the actual DOM via `mcp__claude-in-chrome__read_page` to confirm the correct selectors are used.

**g. Compare against the API:**
```bash
curl -s "http://localhost:$API_PORT/api/sessions/$SDK_SESSION_ID/messages" \
  | jq '[.messages[] | {role, preview: (.content | if type=="string" then .[0:100] else (.[0].text // "[block]")[0:100] end)}]'
```

**h. Compare against JSONL on disk:**
```bash
python3 -c "
import sys, json
for line in open('$JSONL_FILE'):
    o = json.loads(line)
    print(o.get('type','?'), '|', o.get('message',{}).get('role',''), '|', str(o.get('message',{}).get('content',''))[:80])
"
```

**i. For task list messages:**
After sending, check whether task list UI elements are visible in the DOM. Compare rendered tasks against:
- `task_update` SSE events captured in the network log
- `TaskCreate`/`TaskUpdate` tool_use blocks in the JSONL

**j. Record any discrepancy or anomaly** — data mismatch, console error, broken element, missing state update, unexpected blank area, scroll regression, SSE freeze, etc.

**k. Update the results file** — after EACH message, append the observation for that message. Use this per-message format:

```markdown
### Message [N]: `[message text]`
- **Streaming duration:** [Xs or "SSE freeze detected"]
- **Console warnings:** [count new]
- **Network status:** [POST status code]
- **DOM message count:** [count] (expected: [count])
- **JSONL message count:** [count]
- **API match:** [yes/no]
- **Observations:** [any issues or "Clean"]
```

---

## Phase 5 — Final State Capture

After all messages:

1. Full-page screenshot.
2. Console messages at `debug` level (comprehensive log) via `mcp__claude-in-chrome__read_console_messages`.
3. Full network request log via `mcp__claude-in-chrome__read_network_requests`.
4. Full DOM snapshot of the message list via `mcp__claude-in-chrome__read_page`.
5. Read the complete JSONL file (all lines) in structured form:

```bash
python3 -c "
import json
for i, line in enumerate(open('$JSONL_FILE')):
    o = json.loads(line)
    print(f'{i:3}', o.get('type','?').ljust(20), o.get('message',{}).get('role','').ljust(12), str(o.get('message',{}).get('content',''))[:60])
"
```

6. Fetch final session metadata:

```bash
curl -s "http://localhost:$API_PORT/api/sessions/$SDK_SESSION_ID" | jq '{model, permissionMode, title}'
```

**Update the results file** — append final state summary.

---

## Phase 5b — Reload from History (Critical Regression Check)

This phase verifies that message history renders correctly when loaded from disk — a different code path (`GET /api/sessions/:id/messages` -> `transcript-parser.ts` -> `MessageList` props) that often hides bugs invisible during live streaming.

**Method A: Hard page refresh**

Navigate to the same URL with the `?session=` param preserved. Wait for messages to finish loading. Take a screenshot.

**Method B: Navigate away then back**

1. Click a different session in the sidebar (or click the DorkOS logo to go home).
2. Wait for that session to load.
3. Click the test session back in the sidebar.
4. Wait for messages to re-render.
5. Take a screenshot.

**Verify after each reload:**

| Check | Expected |
|-------|----------|
| Message count | Same as during live session (DOM count == JSONL count) |
| Code blocks | Properly rendered (not raw markdown) |
| Tool call cards | All tool calls visible and collapsible |
| Task list | Tasks visible with correct status |
| Tool call order | Same order as during live session |
| Model/permission display | Correct values in status bar |
| Scroll position | Scrolled to bottom (latest message) |

Compare the history-loaded screenshots against the live-session screenshots from Phase 4. Note any visual differences, especially:
- Expanded/collapsed state of tool call cards
- Missing or duplicated messages
- Timestamp correctness
- Any layout shifts or blank areas

**Update the results file** — append reload comparison results.

---

## Phase 6 — Issue Analysis & Deep Research

Classify each observation into one of:

| Class | Meaning |
|-------|---------|
| **Bug** | Broken functionality — data mismatch, console error, broken element |
| **UX Issue** | Works but feels wrong — scroll, animation, layout, affordance |
| **Improvement** | Could be better — missing feature, unclear affordance |

**For every Bug or significant UX Issue, do the research before writing anything:**

1. **Trace the code path.** Use `Grep` and `Read` to find the relevant component, hook, or service. Do not guess file locations.
2. **Review ADRs.** `Glob` `decisions/*.md` and read any ADRs relevant to the topic area.
3. **Read contributing guides.** Read `contributing/architecture.md`, `contributing/data-fetching.md`, `contributing/animations.md`, `contributing/design-system.md` as applicable.
4. **Validate the assumption.** Confirm the bug exists in actual code, not just in observation.
5. **Research best practices.** Use `WebSearch` if the fix isn't clear from the codebase alone.

When focus areas were specified, go deeper on issues within those areas — trace full call stacks, read all related tests, check git history for recent regressions.

Only after completing this research: form a concrete recommendation with file paths and line references.

---

## Phase 7 — Write Final Report

**Update the results file** with the complete findings. Replace the `Status: IN PROGRESS` with `Status: COMPLETE` and append:

```markdown
## Summary

[2-3 sentences: overall quality, number of issues, anything critical]

## Issues Found

### [Issue Title] — [Bug | UX Issue | Improvement]
**Observed:** [what actually happened]
**Expected:** [what should have happened]
**Root cause:** [file:line reference after code research]
**ADR context:** [relevant ADR if any]
**Research:** [what you found]
**Recommendation:** [concrete suggestion with specifics]

[Repeat for each issue]

## Observations (No Issues)
[What worked well — important to preserve in future changes]

## Passing Verdict (if applicable)
[Note if all checks passed]

---

**Completed:** [timestamp]
**Duration:** [total time]
**Focus areas:** [areas or "Full suite"]
```

---

## Phase 8 — Ideation Prompt (if warranted)

If bugs or significant UX issues were found, generate a prompt for the `/ideate` command and present it to the user.

The `/ideate` command takes a `<task-brief>` argument and performs structured discovery (parallel codebase exploration + research agents), interactive clarification, and writes an ideation document to `specs/`. It works best when the task brief:

- **States the problem clearly** — what's broken or suboptimal, with specifics
- **Includes evidence** — reference the self-test findings file, specific observations, file paths
- **Scopes the work** — what's in and out of scope
- **Mentions affected areas** — components, hooks, services discovered during research
- **Implies a desired outcome** — what "fixed" or "improved" looks like

**Generate the prompt like this:**

```
Based on the self-test findings, compose a task brief for /ideate that:

1. Opens with a clear problem statement (1-2 sentences)
2. References the findings file: test-results/chat-self-test/[TIMESTAMP].md
3. Lists the specific issues discovered (summarized, not copy-pasted)
4. Names the affected code areas found during Phase 6 research (file paths)
5. States what success looks like
6. Explicitly scopes out unrelated areas
```

**Present the prompt to the user** in a copyable format:

```
═══════════════════════════════════════════════════
         SELF-TEST COMPLETE — ISSUES FOUND
═══════════════════════════════════════════════════

Results: test-results/chat-self-test/[TIMESTAMP].md

Issues: [N] bugs, [N] UX issues, [N] improvements

To start an improvement cycle, run:

/ideate [generated task brief]

═══════════════════════════════════════════════════
```

If only minor improvements were found, note them with priority labels (P1/P2/P3) and suggest the user can run `/ideate` if they want to address them.

If no issues were found:

```
═══════════════════════════════════════════════════
         SELF-TEST COMPLETE — ALL CLEAR
═══════════════════════════════════════════════════

Results: test-results/chat-self-test/[TIMESTAMP].md

All checks passed. No bugs or significant issues found.

═══════════════════════════════════════════════════
```

---

## Technical Notes

- **JSONL location:** `~/.claude/projects/{slug}/{sessionId}.jsonl` — use `find` by session ID.
- **Session ID:** `?session=` URL param, managed by `useSessionId()` hook via nuqs.
- **Model selector:** `ModelItem` in `StatusLine` — opens a `ResponsiveDropdownMenu`.
- **Permission mode selector:** `PermissionModeItem` in `StatusLine` — 4 options available.
- **New session button:** Plus icon in `SessionSidebar`.
- **API port:** `DORKOS_PORT` env var — default is 4242; user config may override (e.g., 6942 via `.env`). The Vite dev server on 4241 proxies `/api` to the backend.
- **Streaming:** The web client always uses direct SSE — the POST response body IS the SSE stream (no Relay mediation). A separate persistent EventSource handles cross-client `sync_update` events only (see ADR-0117).
- **Streaming complete signal:** Stop button present during streaming, gone when done.
- **SSE event types to watch:** `text_delta`, `tool_call_start`, `tool_call_end`, `tool_result`, `task_update`, `done`.
- **SSE freeze detection:** Use content staleness detection (two screenshots 10s apart with identical text) to detect and unblock via stop button click. Any SSE freeze is a regression.
