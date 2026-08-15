---
description: 'Self-test switching between two concurrently-working DorkOS chat sessions in a live browser — drives real interactions, watches both JSONL transcripts, and asserts that streaming, subagents, queued messages, todos, and permission prompts survive session switches. Logs an evidence-based findings report.'
argument-hint: '[url] [topics:lakes,fruit] [perm:default|acceptEdits|bypassPermissions] [model:claude-haiku-4-5] [mode:sandbox|live]'
category: testing
---

Self-test the DorkOS chat UI under the **hardest** real-world condition: two sessions of the **same agent** doing long, tool-heavy work **at the same time**, while the operator toggles between them in the sidebar. This is the flow where session-scoped live state (streaming, pending permission prompts, queued messages, running subagents, todos) tends to leak or get lost. The command drives the browser, cross-checks the on-disk JSONL transcripts and the server API, and writes an evidence-based report.

This complements `/chat:self-test` (which exercises a single session in depth). Use this one whenever you touch session switching, the SSE stream lifecycle, `useSessionId`, the session-chat store, tool-approval rendering, or message queueing.

---

## Argument Parsing

Parse `$ARGUMENTS`:

1. **URL** — any arg starting with `http`. Default (expand `$HOME` to the actual home directory; `mkdir -p` the dir if missing):
   `http://localhost:6241/session?dir=$HOME/Keep/temp/empty`
   (Extract the `dir` query param as `TEST_DIR` for JSONL resolution. The empty temp dir keeps file side-effects isolated.)
2. **`topics:a,b`** — two unambiguous, distinct topics for sessions A and B. Default: `lakes,fruit`. Pick concrete nouns (cars, fruit, lakes, clothes) so A and B content is trivially distinguishable on disk and on screen.
3. **`perm:<mode>`** — permission mode for both sessions. Default: `default`.
   - `default` — **prompts on tool use**. Use this to reproduce/regress the permission-prompt-on-switch bug (checks #6). The downstream checks (#2–#4) will be **blocked** if that bug is present, because the agents stall at the first tool gate.
   - `bypassPermissions` / `acceptEdits` — no blocking gate. Use this to exercise subagents, queued messages, and file ops end-to-end (checks #2–#4).
   - **Run both variants** for full coverage.
4. **`model:<id>`** — default `claude-haiku-4-5` (fastest, cheapest; this tests UI plumbing, not model capability). Ignored under `mode:sandbox`, where no model answers.
5. **`mode:sandbox|live`** — which stack the run drives (`meta/chat-capabilities.md` §11).
   - `mode:sandbox` — the **test-mode runtime**: throwaway data dir, deterministic, **no model spend**. Verifies UI plumbing: switching, queueing, stream lifecycle.
   - `mode:live` — the dev stack with a real runtime. Verifies streaming feel, real tool loops, timing, and permission gates as they actually behave.
   - **If the invocation does not state a mode, ASK the user before spending anything** (`AskUserQuestion`, offering both, with the cost of each). Never assume `live`.

Store as `TEST_URL`, `TOPIC_A`, `TOPIC_B`, `PERM_MODE`, `MODEL`, `MODE`.

## Tooling

Drive the browser with the **Playwright MCP** (`mcp__plugin_playwright_playwright__browser_*`). `claude-in-chrome` is often unavailable in this repo; Playwright MCP is the supported path. Key gotchas learned:

- `browser_click` takes a **`target`** (ref from snapshot, or a CSS/`text=` selector), not `ref`.
- New sessions **reset the model to the default (Opus)** — you must set the model **per session** after each "New session".
- The status bar has **two** "Default"-labelled buttons: the first is **Permission Mode**, the second ("Default (recommended)") is the **Model** selector. Don't confuse them.
- The model picker is a Radix dialog; click the option whose row names **`$MODEL`** — read the visible options from the snapshot and match on the model's own name (e.g. a Haiku row under the default, a Sonnet row when `model:sonnet` was passed). Do **not** hard-code one model's row text: the default is now Haiku, and a runner that clicks a remembered "Sonnet 4.6 · Best for everyday tasks" would silently test a different model than the one it logs. A raw `el.click()` in `browser_evaluate` does **not** trigger the Radix handler reliably.
- Haiku is the right default here because this suite tests **UI plumbing**, not model capability — the gates below (streaming, queueing, prompts, switching) do not care which model answers. The one place it shows is check #2/#3: a smaller model may spin up fewer or shorter subagents, so a thin subagent observation is a **judgment-quality** limitation to note, not a gate failure. Re-run with `model:sonnet` if the subagent checks need more to look at.
- Multi-line prompts: type the whole text (newlines are fine) then submit with **`Meta+Enter`**.
- **Every Bash call is a fresh shell** — `$TEST_URL`, `$API_PORT`, `$D`, `$SDK_ID` do not survive between blocks. Substitute the resolved literals into every block you run, and record them in the report header.
- Sidebar session entries are buttons with no stable id and (bug) **identical titles**. Tag them via `browser_evaluate` (assign `el.id`) ordered by `getBoundingClientRect().y`, then click by `#id`. Re-tag after each navigation (React re-renders drop the ids).

## Results File

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="test-results/session-switch-test"
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/$TIMESTAMP.md"
```

Write the header immediately (config — **including `MODE`**, since a sandbox run and a live run answer different questions — plus `Status: IN PROGRESS`) and **append after every phase** so partial runs are preserved. Screenshots go in the same dir (`$RESULTS_DIR/$TIMESTAMP-<label>.png`), not the repo root.

---

## Phase 1 — Preflight (deterministic, live server)

### 1a. Mode resolution — do this before probing anything

The two modes drive **different stacks on different ports**. If `MODE` is unset, ask first (see argument 5).

**`mode:sandbox`** — the test-mode runtime leg (`TestModeRuntime`, no model, no spend). Ports and data dir are the ones `apps/e2e/playwright.config.ts` uses: API **4243**, Vite **4248**, `DORK_HOME=/tmp/dorkos-test-mode-4243`. If nothing answers there, boot it the way the e2e suite does — two panes, from the repo root:

```bash
# API leg — throwaway data dir, wiped on every boot
DORKOS_TEST_RUNTIME=true DORKOS_PORT=4243 VITE_PORT=4248 \
  DORK_HOME=/tmp/dorkos-test-mode-4243 DORKOS_RELAY_ENABLED=true \
  dotenv -- sh -c 'rm -rf /tmp/dorkos-test-mode-4243 && turbo run build --filter=@dorkos/server && pnpm --filter @dorkos/server exec tsx src/index.ts'

# Client leg — Vite on 4248, proxying /api to 4243
DORKOS_PORT=4243 VITE_PORT=4248 dotenv -- turbo dev --filter=@dorkos/client
```

A never-onboarded `DORK_HOME` renders the **first-run wizard instead of the cockpit**, so every wait for the app shell times out. Dismiss it once, exactly as `apps/e2e/global-setup.ts` does:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
curl -sf -X PATCH http://localhost:4248/api/config -H 'content-type: application/json' \
  -d "{\"onboarding\":{\"dismissedAt\":\"$NOW\"},\"profile\":{\"rolePromptDismissedAt\":\"$NOW\"}}" >/dev/null
```

Then set `TEST_URL`'s host to `localhost:4248`, `API_PORT=4243`, and record `Model: n/a (test-mode)`. Phase 3's JSONL mapping does **not** apply — the test-mode runtime writes no `~/.claude/projects` transcript, so cross-check against `GET /api/sessions/:id/messages` and the durable event stream only, and mark every JSONL row `N/A (sandbox)` rather than PASS.

Do not run the Playwright suite at the same time as a sandbox run: its config sets `reuseExistingServer: false`, so it fails on the busy ports instead of adopting your leg.

**`mode:live`** — the dev stack (`pnpm dev` / `pnpm dev:dogfood`), the port probe below, `$MODEL` honored, **real spend on every turn**. Both sessions stream concurrently, so budget for two.

### 1b. Server probe (live mode; skip if sandbox resolved its own ports above)

```bash
DORKOS_PORT="${DORKOS_PORT:-6242}"
for port in $DORKOS_PORT 4242 6241; do
  curl -sf "http://localhost:$port/api/health" | grep -q '"ok"' && API_PORT=$port && break
done
[ -z "$API_PORT" ] && { echo "ERROR: server down — run 'pnpm dev' or 'pnpm dev:dogfood'"; exit 1; }
curl -s "http://localhost:$API_PORT/api/models" | python3 -c "import sys,json;[print(m['value']) for m in json.load(sys.stdin)['models']]"
```

Confirm `$MODEL` is in the model list. Navigate to `TEST_URL`, capture baseline console errors (the `linear-issues` extension 404 and a "Session not found" for any placeholder `?session=` id are **benign**).

### 1c. Name the install before you drive it — and get a yes for the real one

**The probe above falls through to 4242, the operator's installed cockpit on their real `~/.dork`** — which is what answers whenever the dev server is simply down. That is the accident case, not a choice, and this test creates two sessions and drives real tool-heavy turns in whatever it found. Ask the server which install it is:

```bash
curl -s "http://localhost:$API_PORT/api/config" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('port:', d.get('port'))
print('dorkHome:', d.get('dorkHome'))
print('version:', d.get('version'), '| dev build:', d.get('isDevMode'))
print('workingDirectory:', d.get('workingDirectory'))
"
```

Record `DORK_DIR` = the reported `dorkHome` (authoritative — never guess it from the port) and put all four lines in the report header. If `dorkHome` is the operator's real home directory (`$HOME/.dork`), **STOP and ask with `AskUserQuestion` before driving anything**: name the port, the `dorkHome` and the version, say that the run creates two sessions and spends real model credit there, and offer **drive this install** / **cancel** (starting `pnpm dev` and re-running lands on the dev stack instead). Never infer a yes from `mode:live` or from the probe having found something.

### 1d. Snapshot the config before any write

This test sets the model and the permission mode per session, and those are real writes. Copy the file aside first so every one of them is undoable:

```bash
CONFIG_SNAPSHOT="$RESULTS_DIR/$TIMESTAMP-config.json.bak"
if [ -f "$DORK_DIR/config.json" ]; then
  cp "$DORK_DIR/config.json" "$CONFIG_SNAPSHOT" && echo "config snapshot: $CONFIG_SNAPSHOT"
else
  echo "no config.json at $DORK_DIR — nothing to snapshot"
fi
```

Report the snapshot path with its restore (`cp "$CONFIG_SNAPSHOT" "$DORK_DIR/config.json"`, then reload the tab — the server re-reads the file on every access, so no restart is needed), and **offer the restore explicitly in the final report**. The file copy is the only restore that reinstates a key the run ADDED where none existed: a `PATCH` writing a schema default stores that key, which is not the same as it being absent.

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
D=~/.claude/projects/$(echo "$TEST_DIR" | tr '/' '-')   # slug = TEST_URL's dir with / -> -
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

Append a `## Summary`, a `## Findings` section (one block per issue: Observed / Expected / Evidence / Root cause file:line / Recommendation), the verification matrix, a **`## What this run left behind`** block (install driven — port, `dorkHome`, version; settings changed; session ids created; the config snapshot path and its `cp` restore), and flip `Status: IN PROGRESS` → `COMPLETE`. For any genuine bug, trace the code before writing the recommendation (see the root-cause map in the 2026-06-09 report: `interactive-handlers.ts`, `routes/sessions.ts`, `stream-tool-handlers.ts`, `session-chat-store.ts`, `use-session-id.ts`, `ToolApproval.tsx`).

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
