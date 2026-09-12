---
title: 'Canvas and Browser in Rooms — what exists, how to share it, and how to 10x it'
date: 2026-09-11
type: internal-architecture
status: active
tags:
  [
    canvas,
    browser,
    workbench,
    rooms,
    control_ui,
    devtools-bridge,
    right-panel,
    gen-ui,
    project-rooms,
  ]
---

# Canvas and Browser in Rooms

**Question.** The right panel on a session page has a Canvas (tabs of documents, an embedded browser, widgets, diffs) that the agent can drive and read back. Rooms have none of it. How do we give rooms a Canvas and Browser that every agent in the room can use, where the other agents know the state changed, and what would make the whole thing 10x better?

**Method.** Three read-only code sweeps (server tools, client canvas/panel, rooms model) plus the canvas, workbench, project-rooms, room-attachments, room-presence and PiP specs, the seven canvas/panel ADRs, `docs/guides/workbench.mdx`, `docs/guides/generative-ui.mdx`, `docs/concepts/rooms.mdx` and `meta/agent-etiquette.md`. Every `file:line` below was read on `main` @ `b115c710a` (2026-09-11). Inferences are marked.

## TL;DR

1. **The capability already exists in rooms; the addressing does not.** A room turn is an ordinary session turn (`services/rooms/room-turn-runner.ts:860` → `dispatchMessage`), and `control_ui`, `get_ui_state` and the three `browser_*` tools are registered on every claude-code session (`claude-code/mcp-tools/index.ts:234-235`). A room agent can open a canvas today. It lands on that agent's private session stream, which nobody in the room is watching, so nothing shows. Fixing the feature is mostly fixing where the command goes.
2. **Canvas state is client-only today** (`localStorage`, per session, `app-store-canvas.ts:286-298`; the server keeps only a transient `uiState` snapshot). A room canvas is shared by definition, so its state has to move to the server, become durable, and ride the room stream. That is the one structural change; everything else is UI and prompt work.
3. **The only thing that wakes a second agent in a room is a committed `room_entries` row.** So "other agents know the state changed" has exactly three honest shapes: a `canvas` section in every turn's room context (free, wakes nobody), a coalesced notice entry in the log (visible history, wakes nobody, the merge precedent), and a plain `@mention` when an agent actually wants someone to look. Never a new trigger. Etiquette E7 ("silence must be free") forbids a canvas that wakes the room on every change.
4. **Three decisions are yours** (§8): state ownership, wake semantics, tool vocabulary. Recommendations are given.

---

## 1. Inventory: what the Canvas and Browser can do today

### 1.1 The canvas surface (client)

| Capability                                                                                                                                                                                      | Where                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Multi-document tab strip, append-and-activate, dedupe by source key, LRU cap of 12 that never evicts a document being edited                                                                    | `app-store-canvas.ts:80-141`, `:148-176`, `:249-257`; ADR `260708-185518`                  |
| 14 content types, each with its own viewer: `url`, `browser`, `markdown`, `json`, `image`, `pdf`, `widget`, `mcp_app`, `file`, `model3d`, `audio`, `video`, `csv`, `diff`                       | `packages/shared/src/schemas.ts:5017`; dispatch `canvas/ui/AgentCanvas.tsx:47-116`         |
| Per-document edit protection: an agent `update_canvas` is dropped while a person edits that document; other tabs keep updating                                                                  | `app-store-canvas.ts:368-374`; ADR `0292`                                                  |
| File-backed editing with optimistic concurrency (SHA-256, 409 + Reload/Overwrite), atomic writes, frontmatter preserved                                                                         | `canvas/model/use-canvas-file-save.ts`; `PUT /api/files/content`; ADR `0293`               |
| Markdown = Blintz (view and edit are the same engine); code = CodeMirror; 3D, audio, video, CSV, PDF, image zoom                                                                                | ADR `0290`; spec `canvas-file-viewing-overhaul`                                            |
| Diff review with per-hunk accept/reject, reject-all, mark-reviewed, side-by-side, compare-to-last-commit, image 2-up/swipe/onion                                                                | `features/diff-review`; `workbench.autoOpenDiff`                                           |
| Per-document error containment (one broken viewer never kills the tab strip), stale-chunk "Reload app" fallback                                                                                 | `CanvasErrorBoundary`, spec `canvas-file-viewing-overhaul` D3                              |
| Persistence: `localStorage` map `sessionId → {open, documents, activeDocumentId}`, 50-session LRU; nothing server-side                                                                          | `app-store-helpers.ts`, `constants.ts:9`; `session-stream.ts:735-739` says so explicitly   |
| Right panel: tabs are `RightPanelContribution`s; Pulse (global) · Room · Profile · Session · Files · Canvas · Terminal; Canvas/Files/Terminal/Session are `visibleWhen pathname === '/session'` | `app/init-extensions.ts:144-297`; `RightPanelContainer.tsx:129-163`                        |
| Panel layout persisted per agent, 320px floor, ⌘. toggle, phone = full-height sheet                                                                                                             | `app-store-right-panel.ts`, `use-right-panel-sizing.ts`, `RightPanelContainer.tsx:241-289` |
| PiP floating panel (single instance, replaces on open) for widgets and MCP apps; follows the newest widget the agent posts                                                                      | `app-store-pip.ts`, `LiveSessionWidget.tsx:42-87`; ADR `260711-150550`                     |

### 1.2 The embedded browser (client + server)

| Capability                                                                                                                                                                                                | Where                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Chrome: back, forward, reload, address bar (simplified display, `local` chip for served files), Open in system browser                                                                                    | `CanvasBrowserContent.tsx:174-306`                                                  |
| Target classification: `external` · `proxy` (loopback) · `serve` (local path) · `blocked` (`javascript:`, `data:`, `blob:`)                                                                               | `canvas/lib/browser-url.ts:163-197`                                                 |
| Local HTML served on the DorkOS origin behind a signed, short-lived token, in an **opaque-origin** sandbox; relative assets work                                                                          | `routes/workbench-serve.ts`, `services/workbench-serve/token.ts`                    |
| Dev servers get **their own origin**: an ephemeral preview listener per target port, cookie-held token, all methods + WebSocket (HMR works), frame-ancestors stripped, DevTools shim injected into HTML   | `services/workbench-serve/preview-listener.ts`; spec `canvas-dev-server-preview` P2 |
| Reachability cascade: server probe → minted origin health probe from the viewer's browser → direct loopback fallback → honest sentence (`no-upstream`, `origin-unreachable`, `tunnel`, `no-port`, `slow`) | `canvas/model/use-resolved-frame.ts:112-242`; `lib/probe-direct.ts`                 |
| External sites framed directly; refusal cannot be detected cross-origin, so a permanent "can't always be embedded" footer                                                                                 | `CanvasBrowserContent.tsx:481-494`                                                  |
| Per-tab back/forward history, in memory only (signed URLs expire)                                                                                                                                         | `app-store-canvas.ts:61-74`                                                         |
| Instrumented previews: console, network, resource-load errors and screenshots flow from the in-page shim to the parent via `postMessage`, then to `POST /api/sessions/:id/devtools/ingest`                | `canvas/model/use-devtools-bridge.ts`; `routes/session-devtools.ts:32`              |

### 1.3 Agent control (server)

| Capability                                                                                                                                                                                                                                                                                                         | Where                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `control_ui`: 22 actions. Canvas: `open_canvas`, `update_canvas`, `close_canvas`, `open_file`, `open_diff`, `browser_navigate`. Also `open_terminal`, `open_pip`/`close_pip`, panels, sidebar, `show_toast`, `set_theme`, `scroll_to_message`, `switch_agent`, `apply_layout`, `open_command_palette`, `celebrate` | `schemas.ts:5263`; contract `runtimes/shared/ui-tool-contract.ts:30,78`                       |
| Delivery: tool → `session.eventQueue` → normalizer → projector stamps `seq` → per-session SSE/WS stream as `ui_command`. Never on the global `/api/events` stream                                                                                                                                                  | `ui-tools.ts:164`; `session-event-normalizer.ts:319`; `session-state-projector.ts:622-636`    |
| "Only the session you're viewing": **client-side only**. `stream-manager.ts:1002` drops `ui_command` unless `sessionId === attachedSessionId`. The server has no viewer-presence gate; the tool returns success whether or not anyone is looking                                                                   | `stream-manager.ts:459-469, 1002`; stated to the agent in `context-builder.ts:375`            |
| `get_ui_state`: answered from the last snapshot the client attached to its message POST (`ClientContext.uiState`), plus this turn's optimistic projection. Not a live read                                                                                                                                         | `ui-tools.ts:189-192`; `context-assembler.ts:165`; `ui-state-snapshot.ts:50-73`               |
| Auto-approval: both tools are on the safe-list; `control_ui` is re-parsed and allowed only for `client-only` reach. `apply_layout` is the sole `reaches-the-machine` action and gets a card                                                                                                                        | `interactive-handlers.ts:158-162, 409-414`; `schemas.ts:5409-5498`                            |
| Self-check tools: `browser_read_console` (level, limit ≤500), `browser_read_network` (`failed` = status 0 or ≥400, ≤200), `browser_screenshot` (8 s wait, raster-only, magic-byte checked)                                                                                                                         | `claude-code/mcp-tools/devtools-tools.ts`; `devtools-capture-store.ts`; `constants.ts:94-118` |
| Capture store: per-session rings (500 console / 200 network / 1 screenshot), ~1 MB budget, 50-session LRU, in memory, gone on close                                                                                                                                                                                | `services/session/devtools-capture-store.ts`                                                  |
| Widgets: `dorkos-ui` fences in chat, 24-node catalog, `ui-action` channel (`agent` / `ui` / `url`), `POST /sessions/:id/ui-action`, skill `ui/*.widget.json` templates                                                                                                                                             | `features/gen-ui`; `docs/guides/generative-ui.mdx`                                            |
| MCP apps: `ui://` resources fetched by the server over its own short-lived MCP client, sandboxed frame, canvas or PiP                                                                                                                                                                                              | `services/mcp-apps`; ADR `260708-141143`                                                      |

### 1.4 Runtime parity (matters for a room that mixes runtimes)

| Runtime     | `control_ui`                                                                   | `get_ui_state` | `browser_*` self-check |
| ----------- | ------------------------------------------------------------------------------ | -------------- | ---------------------- |
| claude-code | yes, in-process                                                                | yes            | yes                    |
| codex       | yes, via the `dorkos_ui` MCP server at `/codex-ui-mcp`; refuses `apply_layout` | **no**         | **no**                 |
| opencode    | **no**                                                                         | **no**         | **no**                 |

Sources: `codex/codex-ui-mcp-server.ts:19-21,55`; `devtools-tools.ts:37-47`; `external-mcp/register-from-definitions.ts:35-39`.

### 1.5 Drift already present (fix before extending, or rooms inherit it)

- The tool description advertises **6** canvas types (`ui-tool-contract.ts:38-43`), the system-prompt block **10** (`context-builder.ts:364`), the schema accepts **14**. `mcp_app`, `file`, `diff`, `browser` are reachable but never taught.
- `apply_layout` is in the schema and the reach table but absent from the description and the prompt block.
- With several previews open, a screenshot request is forwarded to every bridge and first ingest wins (`use-devtools-bridge.ts:341-347`).
- ADR `0292`'s "notify-and-reconcile" banner for a withheld agent update was deferred and never landed: an agent's update is silently dropped while a person edits.
- Room bodies render through `shared/ui/markdown-content.tsx` with no `dorkos-ui` renderer plugin, so a widget fence in a room message shows as a code block (`render-room-body.tsx`; `StreamingText.tsx:71-77` is the only registration).

### 1.6 The right panel today, side by side (operator observation, 2026-09-11)

Dorian's note: in an agent session the panel shows the canvas and the browser; in a room those tabs do not exist. Verified in `app/init-extensions.ts`:

| Route                    | Tabs the panel offers                                 | Why                                                                                                          |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/session`               | Pulse · Profile · Session · Files · Canvas · Terminal | Session, Files, Canvas, Terminal all carry `visibleWhen: pathname === '/session'` (`:250, :271, :283, :299`) |
| `/channels`, `/` (#team) | Pulse · Room (Profile only after an agent was opened) | Only Room carries `routeShowsRoom` (`:194`); nothing else is registered for room routes                      |

Two details that shape the fix:

- **The browser is not a panel tab.** It is a `browser` document inside the Canvas tab, with its own tab in the canvas's document strip (`CanvasBrowserContent.tsx`, dispatched from `AgentCanvas.tsx:47-116`). Registering Canvas on room routes brings the browser with it; there is no second tab to add. A dedicated Browser panel tab is a possible design choice, not a prerequisite.
- **Registration is one predicate away.** The Room tab already proves the pattern (ADR `260822-083229`). The missing piece is not the tab; it is the shared state behind it (§3.2). A Canvas tab on a room route that reads the session-keyed `localStorage` slice would show each viewer their own private canvas and call it shared.

### 1.7 What rooms already have that is canvas-shaped

- **Files a room owns** (project rooms): one integration repo per room, one standing worktree per (room, agent), merge-only writes that wake nobody, `ROOM.md` pinned into every member's prompt, a read-only Files section in the Room tab (`RoomPanelBody.tsx:568`). ADRs `260829-115621..115626`.
- **A recorded rejection**: room files are edited with a **source** editor, not Blintz, because a ProseMirror round-trip rewrites the file and attributes the rewrite to the person (`specs/project-rooms/02-specification.md:173`, DOR-1601). A room canvas has to honor this for file-backed documents.
- **Attachments** are first-class rows on an entry, hardlinked into each agent's cwd (ADRs `260807-233815/233816`). Agents cannot upload (Open Question 4 of that spec).
- **Two structured-body precedents** beside prose: `moment` and `merge` on `RoomEntryBody` (`room-schemas.ts:757, 816`). A canvas event would be a third.
- **An ephemeral signal channel** on the room stream: `signal` frames carry no `seq` and are never replayed (`room-schemas.ts:1860`); presence rides it (`working | working_late | held | done`). This is the right transport for cursors and follow-mode, and the wrong one for canvas state.
- **Room context** is server-assembled structured data (`additional-context.ts:433-716`): room, members, `working[]`, `pending[]` (capped by `ambientMaxEntries`), `files` (worktree, branch, ahead/behind), attachments as paths. Other members' text sits in a nonced untrusted fence.

---

## 2. Q1 — Extend the existing capability for agent sessions first

These are the changes a session canvas needs anyway, and each one is a prerequisite for rooms.

1. **One generated catalog.** Derive `CONTROL_UI_DESCRIPTION` and the prompt block from `UiCanvasContentSchema` and `UiCommandSchema`, with a test that fails on drift. Today an agent that could open a diff is not told it can.
2. **Server-owned canvas documents.** Move the document set from `localStorage` to the server: a `canvas_documents` table keyed by scope (`session:<id>` now, `room:<id>` next), with a `seq`, an `authorId`, `openedAt`, `lastActiveAt`. The stream snapshot carries it; `ui_command` becomes a _result_ of a server write, not the write itself. Gains: survives reload without the localStorage LRU, follows you from laptop to phone, and the agent can finally read it.
3. **Let the agent read the canvas.** `get_ui_state` returns a content type. Add `read_canvas` (list documents with ids, titles, authors; fetch one document's content or the browser tab's URL and history). Closes the "what's on the canvas?" loop.
4. **Viewer presence, honestly.** The tool result already says "accepted, not displayed". Make it true: the server knows who is attached to a session stream; return `viewers: 0` so the agent can choose to post text instead of pushing pixels nobody sees.
5. **Notify-and-reconcile** on the edit lock (the deferred half of ADR `0292`): a quiet banner "Ana updated this while you were editing — reload / keep mine".
6. **Drive the browser, not just navigate it.** The shim already talks to the parent. Add `browser_click`, `browser_type`, `browser_scroll`, `browser_wait_for`, `browser_read_page` (accessibility-tree text). Only on instrumented previews (served files and preview-listener origins), never on external sites, same as capture today. This turns the canvas browser into the agent's QA seat.
7. **Recording.** `research/20260611_agent_browser_video_recording.md` settled the options; per-action keyframe GIFs are the cheap first step and reuse the screenshot path.
8. **Runtime parity.** `get_ui_state` and `browser_*` for codex and opencode through the injected loopback `dorkos` server (`runtimes/shared/dorkos-mcp-injection.ts`). A room where only the claude-code agent can see console errors is a room with a hidden pecking order.
9. **Addressable documents.** Every document gets a stable id and a deep link (`/session?session=…&doc=…`). An agent can then write "see the diff" as a link instead of describing it.

---

## 3. Q2 — Putting the Canvas and Browser in rooms

### 3.1 The reframing

In a session the canvas is **the operator's window onto one agent's work**. In a room it is **the room's table**: a thing the room owns, that outlives any one turn, that every member (person or agent) can put something on, see, and point at. Everything below follows from that sentence.

### 3.2 State: server-owned, per room, durable, on the room stream

- `canvas_documents` scoped `room:<roomId>` (the same table as §2.2). Each row: `id`, `roomId`, `content` (the existing `UiCanvasContent` union), `authorId`, `pinned`, `openedAt`, `lastActiveAt`, `seq`.
- A new durable room frame kind `canvas` (opened / updated / closed / pinned / activated) with a `seq`, replayed like `entry`, included in the cold snapshot. Not a `signal`: signals are lossy by design.
- Client: a room-scoped canvas slice hydrated from the snapshot, not from `localStorage`. The existing session slice stays as is until §2.2 migrates it.
- Cap per room (12 unpinned, LRU) plus pins that never evict. Archive with the room. Attachments already set the retention posture: nothing is re-encoded or expired.

### 3.3 Addressing: same verbs, routed by turn context

Keep `open_canvas`, `update_canvas`, `open_file`, `open_diff`, `browser_navigate`, `close_canvas`. Do not fork the vocabulary into `room_canvas_*`: skills, templates and the `<gen_ui>` teaching block would split. Route instead:

- The `control_ui` handler already has `session`. A room turn is dispatched with `clientId: 'dorkos-room'` (`constants.ts:388`) and carries `roomContext`. When the turn is a room turn, canvas actions write to the room canvas service, which publishes the `canvas` frame. Non-canvas actions (`show_toast`, `open_panel`, `set_theme`) are meaningless in a room and return a clear "not available in a room" error rather than silently landing on the private session stream.
- Optional explicit target: `control_ui { action: 'open_canvas', target: { room: <id> } }` for an agent in a DM that wants to put something on a channel's table. Default is the room the turn is running in.
- `get_ui_state` in a room returns the room canvas (documents, active, viewers). Today it returns `DEFAULT_UI_STATE` because room dispatch passes no `clientContext` (`room-turn-runner.ts:860-905`).

### 3.4 Which file is "the" file

A room has no cwd of its own (ADR `260807-233815`). Two cases:

- **Room with a repo.** `open_file` and `open_diff` resolve against the room's `repo/` main by default: that is the only tree every viewer shares. A document from an agent's worktree is allowed but labeled: "Ana's copy · 3 ahead of main". The most valuable diff in a room is exactly that one: **worktree vs main, the merge preview**.
- **Room without a repo.** `open_file` resolves in the agent's own `agentPath`. The operator can read it (same machine, files API), so it renders, but the tab is labeled "in Ana's project". Other agents get the path in context and may or may not be able to read it. Say so in the tool result.

### 3.5 The browser in a room: shared bookmark, local render

The preview listener already serves many viewers (a cookie per listen port, token per mint). A room browser document is a **URL plus who opened it**. Every viewer frames it in their own browser; nothing is streamed. Console and network captures stay keyed by the session that captured them, with the room document id added, so two agents testing the same dev server never read each other's console. Tunnel and phone limits are unchanged and already have honest sentences.

### 3.6 How other agents know the state changed

Three channels, each already precedented, none of them a new trigger:

1. **Room context** gets a `canvas` section on every turn: open documents (id, type, title, author, last change), active document, and for a browser document the URL. Free to receive, wakes nobody (E7). Document _content_ is not inlined; the agent calls `read_canvas` if it wants it. Content from other authors sits inside the untrusted fence like every other member's text.
2. **A coalesced notice entry** per turn: "Ana opened the diff of `src/router.ts` and a preview of localhost:5173" — one line, visible history, wakes nobody, exactly the merge-event precedent (ADR `260829-115625`). Batched per turn (E17), not per command.
3. **A mention** when the agent wants someone to look. The agent writes "@kai the failing test is on the canvas" in its reply. That is the existing wake mechanism and it needs nothing new.

Never: a canvas change as a trigger reason. It would make every agent pay for listening.

### 3.7 UI

- Register `canvas` (and, for rooms with a repo, `files`) as right-panel contributions with `visibleWhen: routeShowsRoom` beside the Room tab. ADR `260822-083229` anticipated exactly this ("future room surfaces (files, canvas) are contribution registrations, not new modals").
- Tabs carry the author's avatar (the identity kit already exists). Pinned tabs first.
- Home is `#team` (ADR `260808-140955`), so `#team` gets a canvas for free. See §4.4.
- Phone: the panel's overlay sheet, unchanged.
- Bridged rooms: mirror a canvas notice outward as one text line with a deep link. Nothing structural crosses the bridge today (`chat-bridge/deliver.ts:806-815`); the `[photo]` placeholder is the precedent.

### 3.8 Editing in a room canvas

- File-backed documents use the **source** editor with attribution on every save, per the project-rooms decision. A save from the canvas is a commit on main by that person, the same as the Files section does today.
- Generated documents (agent-authored markdown with no `sourcePath`, widgets, JSON) may use Blintz; they are the room's, not a file's.
- Optimistic concurrency and the Reload/Overwrite banner carry over; no CRDT. Two people typing in one document at once is a later problem and a different spec.

### 3.9 Bounds (mechanisms, never prompts)

- Canvas operations count toward the turn's spend like posts do (`rooms.maxPostsPerTurn`, default 3, `messages/room-posting.ts:258-270`). Suggest `rooms.maxCanvasOpsPerTurn`, default 3.
- One notice per turn, not one per operation.
- The permission posture is unchanged: canvas actions are `client-only` reach and auto-approved; `apply_layout` still gets a card and is refused in a room.

---

## 4. Q3 — What only a room canvas can do

1. **Presence on the table.** "Ana is looking at tab 2" as avatars on tabs, from `signal` frames (ephemeral, like `working`). Agents too: a turn that calls `read_canvas` on a document shows that agent's face on it while the claim is held (E16a makes that exempt from the speaking rules).
2. **Follow mode.** One member drives the browser; others follow navigation and scroll. Signals again. Off by default; a person turns it on for themselves.
3. **Pinned documents.** `ROOM.md`, the current plan, the status board. Persist, sort first, never evict. A room's "front page" is a pin.
4. **The living status board.** A pinned `widget` document (stat cards, checklist, timeline) that any agent may `update_canvas`. Because Home is `#team`, this gives Home the "what is happening now" surface the team-room-home spec wanted, without rebuilding a dashboard. Etiquette-clean: updating a board is not speaking.
5. **Merge preview and review in place.** `open_diff` of an agent's worktree against main, with per-hunk accept. Accepting all = `merge_to_room_main`. This is the P4 "PR-style review gate" the project-rooms spec left as follow-up, done with parts that exist.
6. **Document-anchored threads.** Each canvas document has a thread (threads exist). Replying in it is "commenting on the doc". A thread turn's context already carries the root entry; add the document.
7. **Agents show their work.** Let `browser_screenshot` post its image as an attachment on the notice entry. Attachments already flow to every agent's cwd, so a second agent can look at the first one's screenshot.
8. **Two agents, one dev server.** Each agent's preview is its own document with its own capture store. The room shows both. "Kai's console has 3 errors, Ana's has none" becomes a fact in context.
9. **Layout presets per room** via the existing `apply_layout` path once Shapes land: a review room opens diff + browser 2-up.

---

## 5. Q4 — How to 10x it

- **The canvas is the artifact; the message is the caption.** Etiquette E9 and E14 already say long output belongs behind a file, a link or an artifact. Make the canvas that artifact: a room agent that has something long to say opens a document and posts one line. Teach it in `<gen_ui>` and `ROOM_TOOLS_CONTEXT`, bound it in `maxCanvasOpsPerTurn`.
- **One canvas, every surface.** Server-owned documents mean the same table on web, desktop, phone and (markdown and widgets only) Obsidian, and the agent reads the same table you see. Today's canvas is different in every browser tab you own.
- **The browser becomes a seat, not a window.** With click/type/read-page and captures, an agent in a room can be asked "check the checkout flow" and answer with a screenshot and a console excerpt. Two agents can split the test plan. Recording turns that into a GIF in the room.
- **Deep links everywhere.** A document URL pastes into Telegram, a Linear ticket, a PR. It opens the room with that tab active. This is how the canvas leaves the app without the app leaving.
- **Documents as memory.** A pinned plan or board that agents update across days is durable shared state that costs no tokens to keep, unlike re-reading a thread. Search (⌘⇧F) could index agent-authored documents; that is a decision, see §6.
- **Agents as viewers.** `read_canvas` plus presence on tabs closes the loop in both directions: people see what agents are looking at, agents see what people put down.

---

## 6. Q5 — What you are not asking yet

1. **Who owns the state.** Server or browser. Everything in §3 and §4 assumes server. If it stays in `localStorage`, "shared" means "each viewer's private copy", and the feature is a demo.
2. **Does a canvas change wake anyone.** Recommend never (§3.6). If you want "agents react to the board", the honest path is a scheduled task that reads the board, not a trigger.
3. **Prompt injection through the canvas.** Canvas content from another author is untrusted text and must sit inside the nonced fence in room context. A `widget` definition or `markdown` document is exactly the kind of thing an attacker in a bridged room would want to plant, except that bridges cannot post structure, which is a property worth keeping.
4. **Spend and budget.** If canvas operations are free, they become the loophole for a chatty agent. Count them (§3.9).
5. **Retention and search.** How many documents a room keeps, whether agent-authored documents are indexed by message search (the index copy says "never tool output"; a canvas document is closer to a message than to tool output). Decide explicitly.
6. **Rooms without a repo.** `open_file` there means "a file on Ana's machine". Fine on one machine, confusing in a community. Label it now so the seam is honest later.
7. **Communities.** The `CommunityAdapter` port is text-only and single-identity. Keep the room canvas off the port, as attachments are, and say so in the ADR.
8. **Runtime parity first.** A codex or opencode member cannot read a console today. Either land §2.8 first or the room context should say which members can see the browser.
9. **Obsidian and the desktop.** DirectTransport has no serve, proxy or terminal. A room canvas there is markdown, widgets and diffs. The docs must not claim more (demo-claim gate).
10. **Human-human collisions.** Two people editing one generated document: last write wins with a banner is acceptable now; CRDT is a separate spec if a community ever needs it.
11. **Testing.** Rooms have e2e specs, a `chat:rooms-test` skill, and conformance suites. A room canvas needs a conformance case ("agent A opens, agent B's next context lists it, nobody was woken") and a browser spec that fails on today's code.
12. **The drifts in §1.5.** Fix them first, or the room agent is taught six content types and given fourteen.

---

## 7. Suggested sequence

| Phase | Scope                                                                                                                                                                   | Depends on |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P0    | Generated catalog + drift tests; `dorkos-ui` renderer in room bodies; notify-and-reconcile banner                                                                       | —          |
| P1    | Server-owned `canvas_documents` for sessions, snapshot + stream, `localStorage` migration; `read_canvas`; viewer count                                                  | P0         |
| P2    | Room scope: table rows, `canvas` frame, room slice, right-panel contributions, tool routing by turn context, room-context `canvas` section, coalesced notice, spend cap | P1         |
| P3    | Presence on tabs, follow mode, pins, `#team` status board, doc-anchored threads                                                                                         | P2         |
| P4    | Browser driving tools, recording, screenshots as attachments, codex/opencode parity                                                                                     | P1         |
| P5    | Merge-preview diff with accept-to-merge                                                                                                                                 | P2         |

Each phase is one spec and a handful of PRs. P2 is the feature; P0 and P1 are the floor it stands on.

---

## 8. Decisions to make

| #   | Decision        | Option A (recommended)                                                        | Option B                                                     |
| --- | --------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D1  | State ownership | Server-owned, durable, on the room stream; sessions migrate to the same table | Keep `localStorage`, add a room key; shared only by accident |
| D2  | Wake semantics  | Canvas changes never trigger a turn; context + notice + mention               | Canvas change is a trigger reason with its own dials         |
| D3  | Tool vocabulary | Same `control_ui` verbs, routed by turn context, optional explicit `target`   | New `room_canvas_*` verbs in the room capability domain      |

A: D1-A because nothing else in §3 works without it. D2-A because E7 is a product thesis, not a preference. D3-A because every skill and template that emits `open_canvas` keeps working in a room on day one.

---

## Sources

- Specs: `right-panel-workbench`, `canvas-dev-server-preview`, `canvas-file-viewing-overhaul`, `canvas-markdown-editing`, `canvas-persistence-and-toggle`, `pip-panel`, `mcp-apps-host`, `project-rooms`, `room-attachments`, `room-presence`, `team-room-home`, `shapes`.
- ADRs: `260708-185518`, `0290`, `0292`, `0293`, `260708-141143`, `260711-150550`, `260822-083229`, `260807-233815/233816`, `260829-115621..115626`, `260814-024525`, `260808-140955`.
- Docs: `docs/guides/workbench.mdx`, `docs/guides/generative-ui.mdx`, `docs/concepts/rooms.mdx`; `meta/agent-etiquette.md`.
- Research: `20260326_agent_ui_control_canvas_spec_research.md`, `20260720_context-aware-right-inspector-panels.md`, `20260611_agent_browser_video_recording.md`, `20260724_multi-user-communities.md`.
