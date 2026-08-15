---
description: 'Self-test DorkOS rooms in a live browser — two agents in one channel, driven through bursts, mid-turn steering, halt, reactions, threads, and the three-way DM rule, cross-checked against the API and SQLite. Logs an evidence-based findings report.'
argument-hint: '[url] [mode:sandbox|live] [perm:default|acceptEdits|bypassPermissions] [model:claude-haiku-4-5] [agents:ana,bo]'
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Skill, WebSearch, WebFetch, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_type, mcp__plugin_playwright_playwright__browser_press_key, mcp__plugin_playwright_playwright__browser_evaluate, mcp__plugin_playwright_playwright__browser_take_screenshot, mcp__plugin_playwright_playwright__browser_console_messages, mcp__plugin_playwright_playwright__browser_network_requests, mcp__plugin_playwright_playwright__browser_hover, mcp__plugin_playwright_playwright__browser_wait_for
category: testing
---

Self-test the parts of DorkOS that only exist when **more than one participant shares a room**: a channel with two agents and you, driven through a message burst, a mid-turn arrival, a halt, a reaction, a thread, and the three-way rule that keeps you in any room two agents share. The command drives the browser, cross-checks the room API and the SQLite rows underneath it, and writes an evidence-based report.

It is the rooms sibling of `/chat:self-test` (one session, in depth) and `/chat:session-switch-test` (two sessions, switching). Use it whenever you touch `RoomService`, the trigger dispatcher, the collector, room notices, reactions, threads, or the room event stream.

Every check below cites the capability row it verifies in `meta/chat-capabilities.md` — a run of this command is a report against that contract, not a vibe check.

---

## Argument Parsing

Parse `$ARGUMENTS`:

1. **URL** — any arg starting with `http`. Default `http://localhost:6241/channels` (live) or `http://localhost:4248/channels` (sandbox — see Phase 1).
2. **`mode:sandbox|live`** — which stack the run drives (`meta/chat-capabilities.md` §11).
   - `mode:sandbox` — the **test-mode runtime**: throwaway data dir, deterministic, **no model spend**. Room turns really happen (the `chromium-team-room` e2e project proves an agent answers under this runtime), so every **mechanical** check below is reachable. What is **not** reachable is every check whose verdict is a judgment about what the agent chose to say — those are marked `N/A (sandbox)`, never PASS.
   - `mode:live` — the dev stack with a real runtime. Two agents answer per burst, so budget accordingly.
   - **If the invocation does not state a mode, ASK the user before spending anything** (`AskUserQuestion`, offering both with their costs). Never assume `live`.
3. **`perm:<mode>`** — permission mode for the agents' room-bound sessions. Default `acceptEdits`, which is the right default here and not a shortcut: a pending tool approval stalls a room turn, and a stalled turn makes checks 1–4 unreadable (you cannot tell "the agent folded three messages into one reply" from "the agent never got past a gate"). Use `default` only when the run is deliberately about approvals in rooms, and expect the downstream checks to come back BLOCKED.
4. **`model:<id>`** — default `claude-haiku-4-5`. Ignored under `mode:sandbox`.
5. **`agents:a,b`** — the two agents to seat in the channel. Default: the first two agents the create dialog's agent search offers. Pick two whose display names are **not prefixes of one another** — half the assertions here locate an entry by its author's rendered name, and `bo` inside `bobby` will find the wrong row.

Store as `TEST_URL`, `MODE`, `PERM_MODE`, `MODEL`, `AGENT_A`, `AGENT_B`.

## Tooling

Drive the browser with the **Playwright MCP** (`mcp__plugin_playwright_playwright__browser_*`). `claude-in-chrome` is often unavailable in this repo; Playwright MCP is the supported path. Gotchas carried over from `/chat:session-switch-test`, plus the rooms-specific ones:

- `browser_click` takes a **`target`** (ref from snapshot, or a CSS/`text=` selector), not `ref`.
- **The room composer submits on plain `Enter`**, unlike the session composer's `Meta+Enter`. So a newline inside a room message is `Shift+Enter`, and pasting multi-line text sends the first line and strands the rest. Keep room messages to one line wherever the check allows it.
- **Every Bash call is a fresh shell.** `$ROOM_ID`, `$API_PORT`, `$TIMESTAMP` and friends do **not** survive from one block to the next — they read as empty, and an empty variable inside a `mkdir`/`POST` is how a preflight writes into the wrong directory. **Substitute the resolved literals into every block you run**, and record them in the report header so the run is reproducible. The blocks below are written with variables for readability; you are expected to expand them.
- Radix dialogs and popovers (create-channel, reaction picker, member menus) need a real click on the option element — a raw `el.click()` inside `browser_evaluate` does not reliably fire the Radix handler.
- **Do not assert which emoji the quick-reaction row shows.** It is the reader's own most-used set, computed across rooms, so it differs per machine and per run. Read what is there, then assert against what you read (`apps/e2e/pages/RoomsPage.ts` carries the same warning).
- **The halt button does not exist when nothing is working.** `room-header-halt` renders only while `working > 0`, so "the button is missing" is a timing statement, not a bug — re-check while an agent is actually mid-turn.
- The thread panel renders the **same** `RoomEntryRow` component as the main timeline, but only the timeline's copy carries the `id="room-entry-<entryId>"` attribute (duplicate DOM ids are avoided deliberately). Scope every entry query to `[data-testid="room-timeline"]` or to `[data-testid="room-thread-panel"]` — never to the page.

The trustworthy selector source is `apps/e2e/pages/RoomsPage.ts` and `apps/e2e/pages/NewMenuPage.ts`. Read them before inventing a locator; they already encode the flows below.

## Results File

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="test-results/rooms-test"
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/$TIMESTAMP.md"
```

Write the header immediately — config (**including `MODE`**, since a sandbox run and a live run answer different questions), room id once it exists, `Status: IN PROGRESS` — and **append after every phase**, so an interrupted run still leaves a truthful partial record. Screenshots go in the same dir (`$RESULTS_DIR/$TIMESTAMP-<label>.png`), never the repo root.

---

## Phase 1 — Preflight

### 1a. Mode resolution — before probing anything

**`mode:sandbox`** — the test-mode runtime leg. Ports and data dir are the ones `apps/e2e/playwright.config.ts` uses: API **4243**, Vite **4248**, `DORK_HOME=/tmp/dorkos-test-mode-4243`. If nothing answers there, boot it the way the e2e suite does — two panes, from the repo root:

```bash
# API leg — throwaway data dir, wiped on every boot. DORKOS_RELAY_ENABLED is not
# optional here: rooms need it.
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

A fresh sandbox `DORK_HOME` has no agents. Seed the two this test needs the way the e2e fixtures do (`apps/e2e/fixtures/team-room-api.ts` uses `POST /api/agents`, deliberately not `POST /api/mesh/agents`, because only the former puts an agent on the team):

**Write this block with the two agent names inlined as literals** — a fresh shell has no `$AGENT_A`, and an empty name would `mkdir` a stray directory and POST `{"name":""}`. Agent directories go under the repo's own `.temp/` (or your session scratchpad), never `$HOME`:

```bash
# `path` must exist and sit inside DORKOS_BOUNDARY, or the call answers
# 403 "Path outside boundary" — the most common way this preflight fails.
# The e2e legs set the boundary to the checkout root, so .temp is in bounds.
for name in ana bo; do            # <- the two resolved names, inline
  path="$PWD/.temp/rooms-test/$name"
  mkdir -p "$path"
  curl -sf -X POST "http://localhost:4243/api/agents" -H 'content-type: application/json' \
    -d "{\"path\":\"$path\",\"name\":\"$name\",\"runtime\":\"claude-code\"}" | head -c 200; echo
done
```

Seating is asynchronous — the seam that puts a new agent on `#team` runs **after** the creation response, so poll the roster rather than reading it once.

`runtime: 'claude-code'` is right even here, and it still answers: the test-mode leg sets `DORKOS_TEST_RUNTIME_CLAUDE_ALIAS=true`, which registers a `TestModeRuntime` under the `claude-code` type. A claude-code-seeded agent therefore resolves to the mock, spends nothing, and needs no credentials.

**The scenario levers — without these, half this test is unreachable in sandbox.** The default scenario is `simple-text`, a zero-delay echo: the reply lands before you can observe anything, so there is no mid-turn for check 2 and the halt button (which renders only while `working > 0`) never appears for check 3a. Switch the leg to a turn that actually takes time, and end it on command:

```bash
# Every new turn on this leg now works until told to stop (180 heartbeats).
curl -sf -X POST http://localhost:4243/api/test/scenario \
  -H 'content-type: application/json' -d '{"name":"long-turn"}'

# ...drive the check, then release every running long-turn at its next heartbeat:
curl -sf -X POST http://localhost:4243/api/test/finish-turn
```

Both are mounted only when `DORKOS_TEST_RUNTIME` is on (`apps/server/src/routes/test-control.ts`); in production every `/api/test/*` path is a 404. `POST /api/test/reset` returns the default scenario to `simple-text`.

**One honest caveat for check 3a in sandbox:** `TestModeRuntime.interruptQuery` returns `false` — there is no process to signal. So a halt in sandbox is observable through the **claim being dropped and the `halted` notice being written**, not through a killed process. Do not read the no-op interrupt as a halt bug; that is exactly why `finish-turn` exists. The "the model actually stopped mid-sentence" half of A-16 is `live` only.

Then set `API_PORT=4243`, `TEST_URL=http://localhost:4248/channels`, `DORK_DIR=/tmp/dorkos-test-mode-4243`, `DORK_DB=$DORK_DIR/dork.db`, and record `Model: n/a (test-mode)`.

Do not run the Playwright suite during a sandbox run: its config sets `reuseExistingServer: false`, so it fails on the busy ports rather than adopting your leg.

**`mode:live`** — the dev stack (`pnpm dev` / `pnpm dev:dogfood`). Probe for it:

```bash
DORKOS_PORT="${DORKOS_PORT:-6242}"
for port in $DORKOS_PORT 4242 6241; do
  curl -sf "http://localhost:$port/api/health" | grep -q '"ok"' && API_PORT=$port && break
done
[ -z "$API_PORT" ] && { echo "ERROR: server down — run 'pnpm dev' or 'pnpm dev:dogfood'"; exit 1; }
```

**Ask the server where it keeps its data rather than deriving it.** `GET /api/config` reports the resolved `dorkHome`, so the guess this used to make (`DORK_HOME`, else `apps/server/.temp/.dork`, else `~/.dork`) can be wrong in a way nothing notices — it would happily read one install's database while driving another:

```bash
curl -s "http://localhost:$API_PORT/api/config" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('port:', d.get('port'))
print('dorkHome:', d.get('dorkHome'))
print('version:', d.get('version'), '| dev build:', d.get('isDevMode'))
print('workingDirectory:', d.get('workingDirectory'))
"
# DORK_DIR = the reported dorkHome; DORK_DB = "$DORK_DIR/dork.db"
```

Put all four lines in the report header.

**And if `dorkHome` is the operator's real home directory (`$HOME/.dork` — which is what port 4242 means), STOP and ask before driving anything.** The probe above falls through to 4242 whenever the dev server is simply down, so landing on the real install is the accident case, not a choice. Use `AskUserQuestion`: name the port, the `dorkHome` and the version, say that the run creates a channel, posts in it, starts real billable agent turns and reacts to messages there, and offer **drive this install** / **cancel** (starting `pnpm dev` and re-running lands on the dev stack instead). Never infer a yes from `mode:live` or from the probe having found something.

**Live mode writes to real rooms.** This test creates a channel, posts in it, halts turns, and reacts. It never deletes anything, but the room and its entries persist — name the channel so it is obviously disposable (Phase 2) and say so in the report.

**Snapshot the config before any write.** Check 1 changes `rooms.collectDebounceMs` on purpose, and a file copy is the only restore that can put back a key that was never stored (see that check):

```bash
CONFIG_SNAPSHOT="$RESULTS_DIR/$TIMESTAMP-config.json.bak"
if [ -f "$DORK_DIR/config.json" ]; then
  cp "$DORK_DIR/config.json" "$CONFIG_SNAPSHOT" && echo "config snapshot: $CONFIG_SNAPSHOT"
else
  echo "no config.json at $DORK_DIR — nothing to snapshot (an absent file is itself the state to restore: delete the one the run creates)"
fi
```

Report the snapshot path with its restore — `cp "$CONFIG_SNAPSHOT" "$DORK_DIR/config.json"`, then reload the tab; the server re-reads the file on every access, so no restart is needed — and **offer that restore explicitly in the final report**.

### 1b. Baseline

Navigate to `TEST_URL`. Capture baseline console errors (the `linear-issues` extension 404 is benign). Confirm the two agents exist:

```bash
curl -s "http://localhost:$API_PORT/api/mesh/agents" | python3 -c "
import sys, json
for a in json.load(sys.stdin)['agents']:
    print(a.get('displayName') or a.get('name'), '|', a.get('path', ''))
"
```

Fewer than two agents is a **BLOCKED** preflight, not a failure — this test cannot say anything about multi-agent behavior with one agent.

## Phase 2 — Create a channel with two agents

Follow the flow `apps/e2e/pages/RoomsPage.ts::createChannel` encodes — it is the single create surface, and there is no separate dialog on the sidebar `+` any more:

1. Open the New menu: `[data-testid="sidebar-new-button"]`, or the Channels section's own `+` (`button[data-sidebar="group-action"][aria-label="New channel"]`). Both deep-link to the same item, `[data-menu-item-id="new-channel"]`.
2. In the dialog (`role="dialog"`, title "New channel"), fill the textbox named **"Channel name"** with something unmistakably disposable: `rooms-test-<TIMESTAMP>`. **Enter does not submit here** — it moves focus to the agent search, deliberately.
3. In the combobox `aria-label="Search agents"`, type `AGENT_A`, click its exact `role="option"`; repeat for `AGENT_B`. Both appear as chips (`aria-label="Remove {displayName}"`).
4. Submit the button whose label is now `Create channel with 2 agents`. (With no agents the button reads `Create it without agents` — if you see that, the picker did not take.)
5. Capture the room id from the URL (`/channels?id=<roomId>`) → `ROOM_ID`. Screenshot.

Record the roster from the API before driving anything, so later assertions have a baseline:

```bash
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d['id'], '| you are', d['viewerAuthorId'])
for m in d['members']:
    a = m['author']
    print(' -', a['displayName'], '|', a['kind'], '|', a['id'])
"
```

A roster entry nests its identity under `author` (`{ id, kind, displayName, … }`) — there is no flat `authorId` on a member.

`GET /api/rooms/:id` returns the room **and its roster** — it does not return entries. History is a separate endpoint, `GET /api/rooms/:id/entries` (cursor `before`, `limit` default 50, max 200).

---

## Phase 3 — The verification matrix

Run these in order; each writes its own block to the results file as it completes. Every check names the capability row it answers.

### Check 1 — A-03: a burst of three quick messages produces exactly ONE reply

**Post the burst through the API, not the browser.** This is the primary method and not a shortcut: three Playwright-MCP round trips cannot land inside a 500ms window — each click-type-Enter cycle costs far more than that on its own — so a browser-driven burst would produce three separate turns and you would log a product FAIL for a test-harness limitation. The API burst puts the three messages in the window the feature is actually about.

Posting unauthenticated is the **same author** as the browser: `resolveCaller` (`apps/server/src/routes/room-caller.ts`) resolves anything that is not an agent token or a signed-in account to the person at the keyboard — this install's owner. So these three arrive exactly as if you had typed them.

```bash
for q in "what's 2+2?" "name a primary colour" "what day comes after Tuesday?"; do
  curl -sf -X POST "http://localhost:$API_PORT/api/rooms/$ROOM_ID/entries" \
    -H 'content-type: application/json' \
    -d "{\"text\":\"@ana $q\"}" &
done
wait
```

(Expand `$API_PORT`, `$ROOM_ID` and the agent handle to literals before running — fresh shell, see Tooling.)

**Alternative, when you want the burst driven through the real composer:** widen the window first, since it is read live on every collect and needs no restart.

**Read the stored value before you write, and restore exactly what you read — including its absence.** `rooms.collectDebounceMs` usually has no stored key at all; the 500ms is the schema default filling in. So "restore the default" by PATCHing `500` is not a restore: it leaves a key behind where there was none, on a live install, forever. Capture the real prior state first:

```bash
python3 - "$DORK_DIR/config.json" <<'PY'
import json, sys
rooms = json.load(open(sys.argv[1])).get('rooms', {})
print('PRIOR:', 'absent' if 'collectDebounceMs' not in rooms else rooms['collectDebounceMs'])
PY

curl -sf -X PATCH "http://localhost:$API_PORT/api/config" -H 'content-type: application/json' \
  -d '{"rooms":{"collectDebounceMs":8000}}'
```

Then type the three messages in the UI, and put it back:

- **Prior value was a number** → `PATCH` that number back, and re-read the file to confirm.
- **Prior key was absent** → a `PATCH` cannot express absence. Restore the config snapshot taken in Phase 1 instead (`cp "$CONFIG_SNAPSHOT" "$DORK_DIR/config.json"`), then reload the tab; the server re-reads the file on every access. Re-read the file and confirm the key is gone.

This is a real config write on a live install, not a test fixture. Two caveats on the write itself: `rooms.collectDebounceMs` is `operator-only` (`config-write-policy.ts`), which a plain `curl` clears by simply not sending agent-identity headers; but **with login on it also needs a real session cookie**, so on such an install make the change from the cockpit's own settings rather than the shell. Whichever route you take, **print the window value in force beside the verdict** — a verdict about gathering is meaningless without the window it gathered in — and **say in the report which restore path you took and what the file holds now**.

In `mode:sandbox`, use the API burst too, and for the same reason twice over: the `simple-text` echo returns before a second browser-driven post could even be typed.

The window is `rooms.collectDebounceMs` (default **500ms**), capped at `rooms.collectMaxEntries` (default **20**) — declared in `packages/shared/src/config-schema.ts`, read into the collector in `apps/server/src/services/rooms/index.ts`. It opens on the first message and **does not slide**, so three messages inside half a second are one turn's worth of input.

Confirm this machine's actual values rather than trusting the defaults. `GET /api/config` will not tell you: it deliberately exposes only the two engaged-window ceilings from the `rooms` block, because those are the only ones the cockpit says out loud. Read the stored config instead, and fall back to the schema defaults when the key was never written:

```bash
python3 - "$DORK_DIR/config.json" <<'PY' 2>/dev/null || echo "not set — schema defaults apply (500ms / 20)"
import json, sys
rooms = json.load(open(sys.argv[1])).get('rooms', {})
print('collectDebounceMs:', rooms.get('collectDebounceMs', '(default 500)'))
print('collectMaxEntries:', rooms.get('collectMaxEntries', '(default 20)'))
PY
```

If the debounce has been tuned down near zero on this machine, three messages will legitimately produce three turns — that is a configured room, not a broken one. Record the value you read next to the verdict.

**Then verify in the browser**, which is the half that matters for a UI self-test: the three human messages and **one** agent reply render in `[data-testid="room-timeline"]`, arriving live over the room stream without a refresh. The API is where the burst is posted; the browser is where the result is judged.

**Expect:** exactly **one** new agent entry from `AGENT_A`, and its text addresses **all three** questions. Count entries by author, not by eye:

An entry carries `authorId`, not a display name — resolve names from the roster you captured in Phase 2 (this helper is used by several checks below, so keep it to hand):

```bash
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID/entries?limit=200" > /tmp/rt-entries.json
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID" > /tmp/rt-room.json
python3 -c "
import json
names = {m['author']['id']: m['author']['displayName'] for m in json.load(open('/tmp/rt-room.json'))['members']}
for e in json.load(open('/tmp/rt-entries.json'))['entries']:
    body = e.get('body', {})
    print(e['seq'], '|', e['kind'], '|', body.get('notice', '-'), '|',
          names.get(e['authorId'], e['authorId']), '|', body.get('text', '')[:90])
"
```

| Verdict | When                                                                                                     |
| ------- | -------------------------------------------------------------------------------------------------------- |
| PASS    | One agent entry, and (live) it answers 2+2, a colour, and Wednesday                                      |
| FAIL    | Two or three separate replies, **with all three posts inside the window** — the collector did not gather |
| PARTIAL | One reply that answers only the last message — gathering worked, folding into the answer did not         |
| BLOCKED | The three posts did not land inside the window in force — re-run, do not record a product verdict        |

The BLOCKED row is the one that keeps this check honest: before writing FAIL, confirm from the entries' own timestamps that the three human posts really were within `collectDebounceMs` of each other. A spread-out burst answered three times is correct behavior.

In `mode:sandbox`, the **count** is the check and it is fully valid; "addresses all three" is `N/A (sandbox)` — a canned runtime has no opinion about arithmetic.

### Check 2 — A-03: a message sent mid-turn folds into the NEXT answer

1. Make `AGENT_A` work long enough to interrupt. **Live:** ask for something slow (`@ana write a four-line poem about lakes, slowly`). **Sandbox:** switch the leg to `long-turn` first (Phase 1a) — the default `simple-text` echo returns before there is any "mid" to send into, so without this the check is not merely hard, it is impossible.
2. The moment the working signal appears — `[data-testid="room-header-working"]` reading "1 agent working", or the presence line `[data-testid="room-presence"]` under the composer — post a second, unrelated message: `@ana also, what's the capital of France?`.
3. **Sandbox only:** release the first turn with `POST /api/test/finish-turn` so the parked message can be claimed. Live turns end on their own.

**Expect** three things, and check all three:

- **No `agent_busy` notice** is written for the second message. Same-room busy **parks**, it does not refuse; a busy notice in this room is the bug.
- When the first turn's claim releases, a **second turn starts by itself** and answers the parked message. Nobody had to re-send it.
- The reply to the second message is a **separate entry**, not an edit of the first.

The framing that makes this observable: the fold is invisible on the wire. There is no `arrivedDuringPrevTurn` field on `RoomEntry` — it is a render flag in the agent's ambient context, which appends `[arrived while you were working]` to the entry's context line (`apps/server/src/services/runtimes/shared/room-context-block.ts`). So the browser-visible evidence is **behavioral**: two ordinary posts, two turns, no busy notice, and no human re-send. State exactly that in the report; do not claim to have seen a flag you cannot see.

```bash
# Notices are entries too: kind is 'notice' (the only value beside 'post'), and
# the machine-readable code lives at body.notice.
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID/entries?limit=200" | python3 -c "
import sys, json
for e in json.load(sys.stdin)['entries']:
    if e['kind'] == 'notice':
        print(e['seq'], '|', e['body'].get('notice'), '|', e['body'].get('text', '')[:100])
"
```

### Check 3 — A-16: the halt button stops everything, once — and a literal "stop" is just a message

Two halves, and the second is the one that catches the regression.

**3a. Halt stops all in-flight turns and says so exactly once.** Get **both** agents working at the same time (`@ana and @bo each write a slow eight-line poem about lakes`), wait for `[data-testid="room-header-working"]` to read **"2 agents working"**, then click `[data-testid="room-header-halt"]` (visible text "Stop"). It calls `POST /api/rooms/:id/halt`.

**In sandbox this check needs the `long-turn` scenario**, for a blunt reason: the halt button renders only while `working > 0`, and under the default echo scenario `working` is never above zero long enough to click. With `long-turn` set, both agents stay working until you halt them or call `finish-turn`.

Expect:

- Both turns stop; the working chip and the presence line disappear.
  - **Sandbox caveat:** `TestModeRuntime.interruptQuery` returns `false` — there is no process to signal — so what you are observing here is the **claim being dropped and the notice being written**, not a killed generation. A no-op interrupt in sandbox is expected and is not a halt bug. The "the model really stopped mid-sentence" half of A-16 is `live` only; record it as `N/A (sandbox)`.
- **Exactly one** notice row appears: `[data-testid="room-notice"][data-notice="halted"]`, reading `Everything here was stopped. 2 agents were working and have been interrupted; send a message to start again.` (One agent → `One agent was working and has been interrupted…`; nothing running → `Nothing was running at the time.`)
- Two notices for one halt is a FAIL. The notice is damped per room and re-armed by the next claim, and the ordering is load-bearing: the notice is written **before** any claim is released, so a vanished working indicator is never left unexplained.

```bash
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID/entries?limit=200" | python3 -c "
import sys, json
h = [e for e in json.load(sys.stdin)['entries'] if e['body'].get('notice') == 'halted']
print('halted notices:', len(h))
for e in h:
    print(' ', e['seq'], e['body'].get('text', '')[:120])
"
```

**3b. The guard: a message whose text is "stop" is answered normally.** Post `@ana stop`. **Expect** an ordinary turn — `AGENT_A` replies, no turn is interrupted, and **no `halted` notice is written**. Halting is a button, never an inference from anything anybody typed (`.claude/rules/room-conduct.md`); the invariant is pinned server-side by `apps/server/src/services/rooms/__tests__/room-stopped-turns.test.ts`. If a typed "stop" ever halts the room, that is a serious FAIL — it means anyone who can post can silence every agent, including a bridged external user.

Also worth one line in the report: halting is human-only. An agent calling the halt route gets `PEOPLE_ONLY`; that is server-side and not browser-reachable, so cite it as a known mechanism, not as something this run verified.

### Check 4 — A-06: the agent reacts instead of posting filler

Post something that wants acknowledgment and nothing else: `@ana heads up, I'm deploying in five minutes — no reply needed, just ack.`

**Expect** a reaction on your message — `[data-testid="entry-reactions"]` appears on that entry with a pill `[data-testid="entry-reaction"][data-emoji="..."]` — and **no** new agent message saying "got it". The agent's tool is `react_to_room_entry`; additions are budgeted at 20 per agent per room per hour (`apps/server/src/services/rooms/reactions/reaction-budget.ts`; retractions are free, and humans are never counted).

Then verify **your own** reactions render, which is the mechanical half and always checkable: hover one of the agent's entries, use the picker (`[data-entry-action="react-more"]`, or `[data-testid="entry-reactions-add"]` when pills already exist) → `[data-testid="reaction-picker"]` → pick an emoji. The pill must appear with `data-mine="true"`, and it must arrive via the room's event stream, not only after a refresh.

Split the verdict honestly:

- **Mechanical** (reaction round-trips, renders, is scoped to the right entry, survives reload) — PASS/FAIL in both modes.
- **Judgment** (did the agent _choose_ a reaction over a message) — PASS/FAIL in `live` only, `N/A (sandbox)` otherwise. `meta/chat-capabilities.md` A-06 says the mechanism is built and the judgment is untested; a single observation here is evidence, not proof — say which one you have.

Reactions never cascade: a reaction must not trigger a turn, write a notice, or reorder the room. Check that too.

### Check 5 — M-05: a thread reply lands in the thread, not the main timeline

1. Hover one of `AGENT_A`'s entries in the main timeline, click **"Reply in thread"** in its action bar.
2. The panel opens: `[data-testid="room-thread-panel"]` (`aria-label="Thread"`), feed `[data-testid="room-thread-feed"]`, and the URL gains `&thread=<entryId>` — the id of the **root entry**, not a room id.
3. Post in the panel's composer (placeholder/accessible name **"Reply in this thread…"**), then post again mentioning `AGENT_A` so an agent reply lands in the thread too.

**Expect:**

- Both replies render inside `[data-testid="room-thread-panel"]`.
- **Neither appears in `[data-testid="room-timeline"]`.** The default timeline is `parentEntryId IS NULL` (`packages/db/src/schema/rooms.ts`), so a thread reply in the main feed is a real bug.
- The root entry grows a reply-count row, `[data-testid="room-thread-replies"]` with `[data-testid="room-thread-reply-count"]`, rendered as the root's immediate next sibling.
- A hard reload of the `&thread=` URL restores the panel on the same root.

Confirm the shape server-side — the relation is `parentEntryId` / `threadRootEntryId` on the entry, one level deep only (replying to a reply is refused as `NESTED_THREAD`):

```bash
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID/entries?limit=200" | python3 -c "
import sys, json
for e in json.load(sys.stdin)['entries']:
    print(e['seq'], '| parent:', e.get('parentEntryId'), '| root:', e.get('threadRootEntryId'),
          '|', e['body'].get('text', '')[:60])
"
```

### Check 6 — A-04: a room two agents share always has you in it

The three-way rule is enforced at three write verbs, and only some of them are reachable from a browser. Test what is reachable; cite the rest instead of claiming it.

**6a. The agent-seeded DM includes you (reachable).** Ask one agent, in this channel or its own session, to send you a proactive note — the path is `relay_notify_user`, which opens a DM if none exists. A new DM appears in the sidebar's DMs section, and its roster is exactly **the agent and you**:

```bash
curl -s "http://localhost:$API_PORT/api/rooms?kind=dm" | python3 -c "
import sys, json
for r in json.load(sys.stdin)['rooms']:
    print(r['id'], '|', r.get('title'), '|', [p.get('displayName') for p in (r.get('participants') or [])])
"
```

A stock install is never silent: with no chat app connected, that notification lands here rather than nowhere.

**6b. You cannot leave a room your two agents share (reachable, and the sharp edge).** Open the channel's roster — the header button named `Members of <channel>` — and try to remove **yourself** from the two-agent channel created in Phase 2. Expect a refusal, `OWNER_MUST_BE_PRESENT`: **"Two agents share this room — take one of them out before you leave it."** Then remove one agent and try again: now it is allowed. That sequence is the rule made visible — it is a property of the room's shape, not of who asked, and it refuses the owner herself on purpose.

**6c. Not reachable today, and say so.** No shipped agent tool seats a _second_ agent in a new room — the `rooms` capability domain is four verbs (`post_to_room`, `react_to_room_entry`, `read_room_history`, `search_room_history`) and none of them creates a room. So the creation-time half of the rule (`OPERATOR_ONLY`, "Two agents can only share a room you are in — add yourself to it") cannot be provoked from a browser. Record it as `N/A (not browser-reachable)` with a pointer to `RoomService.requireSeedingAllowed`, never as PASS.

### Check 7 — Triangulation: DOM vs API vs SQLite

For the whole room, compare all three layers. Any disagreement is a finding even when the UI looks right — a room that renders correctly from a stale cache is a bug waiting for a reload.

```bash
# API
curl -s "http://localhost:$API_PORT/api/rooms/$ROOM_ID/entries?limit=200" \
  | python3 -c "import sys,json; e=json.load(sys.stdin)['entries']; print('api entries:', len(e))"

# Disk — one consolidated database, dork.db
sqlite3 "$DORK_DB" \
  "SELECT seq, kind, author_id, substr(body, 1, 60) FROM room_entries WHERE room_id = '$ROOM_ID' ORDER BY seq;"
```

```js
// DOM — via browser_evaluate. Scope to the timeline: the thread panel renders
// the same component and would double every count.
() => {
  const t = document.querySelector('[data-testid="room-timeline"]');
  return {
    entries: t.querySelectorAll('[data-testid="room-entry"]').length,
    notices: t.querySelectorAll('[data-testid="room-notice"]').length,
    halted: t.querySelectorAll('[data-testid="room-notice"][data-notice="halted"]').length,
    reactions: t.querySelectorAll('[data-testid="entry-reaction"]').length,
  };
};
```

Reconcile deliberately, because the layers legitimately differ: the DOM count is timeline-only (thread replies are excluded by design), while the API and SQLite counts include thread replies and notices. Compute the expected DOM number as `entries where parentEntryId is null` before calling a mismatch a bug.

Then **hard-refresh** and re-run all three. Reload-from-history parity is where room bugs hide, exactly as it is for sessions.

---

## Phase 4 — Report

Append a `## Summary`, then the matrix, then a `## Findings` section — one block per issue: **Observed / Expected / Evidence (entry seq, notice code, screenshot path) / Root cause file:line / Recommendation** — and flip `Status: IN PROGRESS` → `COMPLETE`.

| #   | Row  | Check                                            | Verdict | Evidence |
| --- | ---- | ------------------------------------------------ | ------- | -------- |
| 1   | A-03 | Burst of 3 → exactly one reply, addressing all 3 |         |          |
| 2   | A-03 | Mid-turn arrival folds into the next answer      |         |          |
| 3a  | A-16 | Halt stops every turn, exactly one notice        |         |          |
| 3b  | A-16 | A literal "stop" message is answered normally    |         |          |
| 4   | A-06 | Agent reacts instead of filler; pills render     |         |          |
| 5   | M-05 | Thread reply stays out of the main timeline      |         |          |
| 6a  | A-04 | Agent-seeded DM includes the operator            |         |          |
| 6b  | A-04 | Owner cannot leave a two-agent room              |         |          |
| 7   | —    | DOM == API == SQLite, live and after reload      |         |          |

Verdict vocabulary — use it exactly:

- **PASS** / **FAIL** — observed, with evidence.
- **BLOCKED** — something upstream stopped the check from running (a stalled approval, a missing second agent, a dead stack). Never a PASS.
- **PARTIAL** — the mechanism worked, the judgment did not (or vice versa). Say which half.
- **N/A (sandbox)** — a judgment check under the test-mode runtime.
- **N/A (not browser-reachable)** — enforced server-side with no UI path, e.g. check 6c.

For any genuine bug, trace the code before writing the recommendation. The root-cause map for this surface:

| Area                                       | File                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Membership, posting, reactions, 3-way rule | `apps/server/src/services/rooms/room-service.ts`                                                                                                      |
| Dispatch, halt, claims                     | `apps/server/src/services/rooms/room-trigger.ts`                                                                                                      |
| The burst window and parking               | `apps/server/src/services/rooms/room-collect.ts`                                                                                                      |
| Every notice's exact words                 | `apps/server/src/services/rooms/notices/notice-copy.ts`                                                                                               |
| Reaction budget                            | `apps/server/src/services/rooms/reactions/reaction-budget.ts`                                                                                         |
| Routes                                     | `apps/server/src/routes/rooms.ts`, `apps/server/src/routes/room-events-handler.ts`                                                                    |
| What a triggered agent is told             | `apps/server/src/services/runtimes/shared/room-context-block.ts`                                                                                      |
| Client                                     | `apps/client/src/layers/widgets/room-view/ui/` — `RoomHeader`, `RoomComposer`, `RoomEntryRow`, `RoomNoticeRow`, `RoomThreadPanel`, `RoomPresenceLine` |

If the run found bugs, close with the `/flow:ideate` prompt shape `/chat:self-test` uses — problem statement, this report's path, the affected files found while tracing, and what "fixed" looks like.

## Phase 5 — Re-test loop

This report is the durable record. On a re-run after a fix:

1. Read the most recent prior report in `test-results/rooms-test/`.
2. Re-run in the **same mode** that previously failed — a sandbox PASS never clears a live FAIL, and the reverse is equally untrue.
3. In the new report, state explicitly whether each prior FAIL now PASSES, linking the prior file.
4. If a check that used to be `N/A (not browser-reachable)` became reachable (a new tool, a new UI affordance), promote it and say what changed.

---

## Technical Notes

- **Rooms API:** `GET /api/rooms` (list, with per-community `warnings[]`), `POST /api/rooms` (201 new / **200 an existing DM reopened** — DM creation is idempotent on the member set), `GET /api/rooms/:id` (room **+ roster**, 404 `ROOM_NOT_FOUND` if you are not a member — no entries), `GET /api/rooms/:id/entries` (history; `before` cursor, `limit` default 50 / max 200), `POST /api/rooms/:id/entries` (**trigger-only, 202** — the entry itself arrives on the stream, exactly like session messages), `POST /api/rooms/:id/threads` (reply, also 202), `POST /api/rooms/:id/entries/:entryId/reactions` (202, toggle), `POST /api/rooms/:id/halt`, `POST /api/rooms/:id/members`. Routes: `apps/server/src/routes/rooms.ts`.
- **Live updates:** `GET /api/rooms/:id/events` — durable per-room stream (snapshot → gap-free replay via `Last-Event-ID` → live), the same contract as `GET /api/sessions/:id/events`. The cockpit itself uses the WebSocket served on the same path (`apps/server/src/routes/room-events-socket.ts`); the SSE route is the public integration contract. **A 202 from a post and nothing on screen means a stream problem, not a write problem** — check the stream before blaming the write.
- **Disk:** one consolidated `dork.db` under the data dir (`apps/server/.temp/.dork/` in dev, `~/.dork/` in production, `DORK_HOME` overrides both). Room tables: `rooms`, `room_members`, `room_entries`, `room_entry_reactions`, `room_attachments`, `room_sessions`, `authors`.
- **Threads** are a relation between entries in one room, not a separate entity: `parentEntryId` (what this answers) and `threadRootEntryId` (the head). One level deep, enforced as service policy (`NESTED_THREAD`). The main timeline is `parentEntryId IS NULL`.
- **The collect window** opens on the first message for a `(room, agent)` pair and does **not** slide — a sliding window would starve a busy room. It closes early at `rooms.collectMaxEntries`. Everything gathered becomes **one** turn, answering the newest, with the rest as ambient context.
- **Same-room busy parks; different-room busy refuses.** A busy notice inside the room you are testing is a finding.
- **The halt ordering is deliberate:** notice first, then drop parked batches, then interrupt live claims — dropping after releasing would let held messages run one macrotask past the halt.
- **Reaction budget:** 20 additions per agent per room per rolling hour, rebuilt from `room_entry_reactions.created_at` so it survives a restart. The refusal reads: "You have used up your reactions in this room for now — say something instead, or wait."
- **Conduct rules for this surface** live in `.claude/rules/room-conduct.md` and `meta/agent-etiquette.md`; the capability contract this matrix cites is `meta/chat-capabilities.md` §5 and §6.
