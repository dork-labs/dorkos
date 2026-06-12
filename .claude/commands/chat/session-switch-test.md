---
description: 'Self-test switching between two concurrently-working DorkOS chat sessions in a live browser — drives real interactions, watches both JSONL transcripts, and asserts that streaming, subagents, queued messages, todos, and permission prompts survive session switches. Logs an evidence-based findings report.'
argument-hint: '[url] [topics:lakes,fruit] [perm:default|acceptEdits|bypassPermissions] [model:sonnet]'
category: testing
---

Self-test the DorkOS chat UI under the **hardest** real-world condition: two sessions of the **same agent** doing long, tool-heavy work **at the same time**, while the operator toggles between them in the sidebar. This is the flow where session-scoped live state (streaming, pending permission prompts, queued messages, running subagents, todos) tends to leak or get lost. The command drives the browser, cross-checks the on-disk JSONL transcripts and the server API, and writes an evidence-based report.

This complements `/chat:self-test` (which exercises a single session in depth). Use this one whenever you touch session switching, the SSE stream lifecycle, `useSessionId`, the session-chat store, tool-approval rendering, or message queueing.

---

## Argument Parsing

Parse `$ARGUMENTS`:

1. **URL** — any arg starting with `http`. Default:
   `http://localhost:6241/session?dir=/Users/doriancollier/Keep/temp/empty`
   (Extract the `dir` query param for JSONL resolution. The empty temp dir keeps file side-effects isolated.)
2. **`topics:a,b`** — two unambiguous, distinct topics for sessions A and B. Default: `lakes,fruit`. Pick concrete nouns (cars, fruit, lakes, clothes) so A and B content is trivially distinguishable on disk and on screen.
3. **`perm:<mode>`** — permission mode for both sessions. Default: `default`.
   - `default` — **prompts on tool use**. Use this to reproduce/regress the permission-prompt-on-switch bug (checks #6). The downstream checks (#2–#4) will be **blocked** if that bug is present, because the agents stall at the first tool gate.
   - `bypassPermissions` / `acceptEdits` — no blocking gate. Use this to exercise subagents, queued messages, and file ops end-to-end (checks #2–#4).
   - **Run both variants** for full coverage.
4. **`model:<id>`** — default `sonnet` (fast, cheap; this tests UI plumbing, not model capability).

Store as `TEST_URL`, `TOPIC_A`, `TOPIC_B`, `PERM_MODE`, `MODEL`.

## Tooling

Drive the browser with the **Playwright MCP** (`mcp__plugin_playwright_playwright__browser_*`). `claude-in-chrome` is often unavailable in this repo; Playwright MCP is the supported path. Key gotchas learned:

- `browser_click` takes a **`target`** (ref from snapshot, or a CSS/`text=` selector), not `ref`.
- New sessions **reset the model to the default (Opus)** — you must set the model **per session** after each "New session".
- The status bar has **two** "Default"-labelled buttons: the first is **Permission Mode**, the second ("Default (recommended)") is the **Model** selector. Don't confuse them.
- The model picker is a Radix dialog; click the option via `text=Sonnet 4.6 · Best for everyday tasks` (a raw `el.click()` in `browser_evaluate` does **not** trigger the Radix handler reliably).
- Multi-line prompts: type the whole text (newlines are fine) then submit with **`Meta+Enter`**.
- Sidebar session entries are buttons with no stable id and (bug) **identical titles**. Tag them via `browser_evaluate` (assign `el.id`) ordered by `getBoundingClientRect().y`, then click by `#id`. Re-tag after each navigation (React re-renders drop the ids).

## Results File

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="test-results/session-switch-test"
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/$TIMESTAMP.md"
```

Write the header immediately (config + `Status: IN PROGRESS`) and **append after every phase** so partial runs are preserved. Screenshots go in the same dir (`$RESULTS_DIR/$TIMESTAMP-<label>.png`), not the repo root.

---

## Phase 1 — Preflight (deterministic, live server)

```bash
DORKOS_PORT="${DORKOS_PORT:-6242}"
for port in $DORKOS_PORT 4242 6241; do
  curl -sf "http://localhost:$port/api/health" | grep -q '"ok"' && API_PORT=$port && break
done
[ -z "$API_PORT" ] && { echo "ERROR: server down — run 'pnpm dev' or 'pnpm dev:dogfood'"; exit 1; }
curl -s "http://localhost:$API_PORT/api/models" | python3 -c "import sys,json;[print(m['value']) for m in json.load(sys.stdin)['models']]"
```

Confirm `$MODEL` is in the model list. Navigate to `TEST_URL`, capture baseline console errors (the `linear-issues` extension 404 and a "Session not found" for any placeholder `?session=` id are **benign**).

## Phase 2 — Create & configure both sessions

For **each** of A (`TOPIC_A`) and B (`TOPIC_B`):

1. **Right-click the `testing` agent** in the left sidebar → context menu → **New session**. (Faithful to how operators do it; also exercises the context menu.) Capture the new `?session=` UUID from the URL — this is the **client/URL id** `URL_ID`.
2. **Set model** to `$MODEL` (status bar → second/"Default (recommended)" button → pick option). Verify the status-bar label updates.
3. **Set permission mode** to `$PERM_MODE` if not `default` (status bar → first "Default" button → pick option).
4. Click the composer, type the **standard test prompt** (below) with the topic substituted, submit with `Meta+Enter`.

**Standard test prompt** (`{topic}` substituted):

```
This will be a test session. I only want to talk about a single topic. During this session I want you to do a bunch of things....

1. I want you to write 5 poems, but I want you to think about each one for a while.
2. Write each poem to a new markdown file in a testing directory. Test renaming, editing, and deleting the files.
2. Create tasks for everything you need to do, and track your progress by marking the tasks complete.
3. I want you to spin up subagents to do random tasks. These tasks should take a while. Use synchronous and async/background agents
4. I want you to ask me several questions. Ask questions after each poem you write. Use the ask user tool to ask questions.
5. I want you to run bash commands. These can be random...may just timers that take 30 seconds.

Everything should be about your topic, and nothing else.

Your topic is {topic}
```

Create A first, then B, so **both stream concurrently**. Screenshot each after submit.

## Phase 3 — Resolve URL id → SDK (JSONL) id

The on-disk JSONL filename is the **SDK** session id, which differs from the URL id. Map by content + mtime:

```bash
D=~/.claude/projects/-Users-doriancollier-Keep-temp-empty   # adjust slug to TEST_URL's dir
for f in $(ls -t "$D"/*.jsonl | head -6); do
  topic=$(grep -o -m1 -iE "topic is (\w+)" "$f" | head -1)
  echo "$(basename "$f" .jsonl) | $(stat -f '%Sm' -t '%H:%M:%S' "$f") | $topic"
done
```

Record the A/B mapping table (URL id, SDK id, topic). All later API/JSONL checks use the **SDK id**.

## Phase 4 — Switch test (the core)

Tag the two newest left-rail session buttons (ordered by y) and switch by clicking `#id`. After **each** switch, capture the **switch-in state** of the now-foreground session via `browser_evaluate`:

- `approveBtn` / `denyBtn` present? (any button whose text is exactly "Approve"/"Deny")
- approval text present? (`/Tool approval required|approval required/`)
- `thinking` indicator present? composer in "Compose next" (queue) mode?
- `tasks` pill text (`\d+/\d+ tasks`)
- running-subagent blocks present? (`[data-testid*="subagent"]` or `SubagentBlock` text)
- page `document.title` (a 🔔 prefix = pending attention)

Perform this sequence, recording state at every step:

1. Land on B (foreground when its first tool gate hits). **Expect**: under `default`, an Approve/Deny prompt renders.
2. Switch to **A**. Record A's switch-in state.
3. Switch back to **B**. Record B's switch-in state.
4. Hard-refresh B (`browser_navigate` same URL). Record post-refresh state.
5. Queue a message in each: while a session streams, type a follow-up and `Meta+Enter` (composer shows "Compose next — will send when ready"). Switch away and back; confirm the queued message is still pending and **drains** when the turn completes.

## Phase 5 — Cross-check disk vs UI (per session)

For each session's SDK JSONL:

```bash
python3 -c "
import json
lines=open('$D/$SDK_ID.jsonl').read().splitlines()
for line in lines[-6:]:
    o=json.loads(line); t=o.get('type'); m=o.get('message',{})
    print(t, m.get('role',''), str(m.get('content',''))[:80])
"
```

- A **trailing `assistant TOOL_USE[...]` with no following `tool_result`** = the agent is **blocked on permission** (matches a stuck UI).
- Confirm tool side-effects: e.g. does `.../testing` exist? (If the dir is absent but the UI claims "Creating testing directory", the mkdir is gated/stuck.)
- Compare DOM message text vs API: `GET /api/sessions/$SDK_ID/messages`.

## Phase 6 — Assertions (the verification matrix)

Record PASS / FAIL / BLOCKED for each, with evidence:

| #   | Check                                    | How to judge                                                                                              |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | JSONL matches client                     | DOM message text == JSONL == API for both sessions                                                        |
| 2   | Running subagents visible above composer | `SubagentBlock` / live indicator appears while a subagent runs                                            |
| 3   | Subagents disappear when done            | indicator clears after the subagent's `tool_result`                                                       |
| 4   | Queued messages drain & process          | "Compose next" message survives a switch and is sent on turn end                                          |
| 5   | Todos accurate                           | task pill count stable across switches; statuses advance                                                  |
| 6   | **Permission prompts survive switching** | Approve/Deny still present after switch-away-and-back and after refresh; approving actually runs the tool |

**Check #6 — expected PASS (fixed by spec #254 / DOR-73, 2026-06-09; mechanism since replaced by spec chat-stream-reconnection):** under `default` mode, a session blocked on a pending approval **recovers** the Approve/Deny prompt on switch-away-and-back and on hard refresh (snapshot-based recovery: the `GET /api/sessions/:id/events` snapshot carries `pendingInteractions`, idempotent by interaction id), and approving the recovered prompt runs the previously-gated tool. Verified live — see `test-results/session-switch-test/20260609-204451-DOR73-acceptance.md`. If check #6 ever regresses again, that's a real bug. (The original failing repro is archived at `test-results/session-switch-test/20260609-173746.md`.)

## Phase 7 — Write report

Append a `## Summary`, a `## Findings` section (one block per issue: Observed / Expected / Evidence / Root cause file:line / Recommendation), the verification matrix, and flip `Status: IN PROGRESS` → `COMPLETE`. For any genuine bug, trace the code before writing the recommendation (see the root-cause map in the 2026-06-09 report: `interactive-handlers.ts`, `routes/sessions.ts`, `stream-tool-handlers.ts`, `session-chat-store.ts`, `use-session-id.ts`, `ToolApproval.tsx`).

## Phase 8 — Re-test loop

This report is the durable record. On a re-run after a fix:

1. Read the latest prior report in `test-results/session-switch-test/`.
2. Re-run the same `perm` variant that previously failed.
3. In the new report, explicitly state whether each prior FAIL now PASSES, linking the prior file.

---

## Technical Notes

- **JSONL:** `~/.claude/projects/{slug}/{sdkSessionId}.jsonl`. Slug = the `dir` with `/`→`-`. Filename = **SDK** id, not URL id.
- **Permission block signature:** trailing `assistant` `tool_use` with no `tool_result`; server holds it in `pendingInteractions` with a ~10-min auto-deny.
- **Composer states:** idle "Message testing…" → streaming shows a red stop button → typing while streaming → "Compose next — will send when ready" (queued).
- **Status-bar "N agents" item** = `SubagentsItem` (`useSubagents`) = count of **available** subagent types, NOT running subagents. Don't read it as "subagents running now".
- **Streaming rides the durable session stream.** POST `/api/sessions/:id/messages` is trigger-only (202 with the canonical session id); ALL turn delivery and cross-client sync arrive on `GET /api/sessions/:id/events` (snapshot → gap-free replay via `Last-Event-ID` → live events with monotonic `seq`). Pending permission prompts ARE recovered: the snapshot carries `pendingInteractions` with server-authoritative `startedAt`/`remainingMs`, so the card and its countdown survive a switch/refresh/reconnect (ADR-0262 countdown semantics; the old pull + re-emit recovery was replaced by the snapshot).
