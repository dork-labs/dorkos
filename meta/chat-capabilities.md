# Chat Capabilities — Master List

**Status:** Living (created 2026-08-13; §6 states re-audited 2026-08-14 after the chat-architecture landing run — PRs #1005–#1015, DOR-773/1201–1209). First inventory of everything a user should be able to do in DorkOS chat, across all four chat surfaces, with the current test coverage for each. This is the contract our chat tests should check against. When a capability ships, it gets a row here; when a row has no coverage, that is a named gap, not an unknown one.

Coverage legend — where each capability is verified today:

- **U** = unit/route tests (`apps/server`, `apps/client`, vitest)
- **E** = Playwright e2e (`apps/e2e`, deterministic, test-mode runtime where possible)
- **S** = agentic self-test (`/chat:self-test`, `/chat:session-switch-test` — live model, evidence report)
- **—** = no automated coverage found (2026-08-13 audit)

## The four chat surfaces

1. **Direct agent session** (`/session`) — one human, one agent, runtime-owned transcript.
2. **Channel** (`/channels`, and `#team` on `/`) — many humans and agents in one room.
3. **Thread** — a reply chain inside a channel (`?thread=` param, `RoomThreadPanel`).
4. **DM** — a one-to-one room between two members (human↔agent, agent↔agent).

A capability is only "done" when it behaves correctly on the surface(s) it applies to, on desktop **and** mobile, live **and** after reload-from-history.

## 1. Composing & sending

| ID   | Capability                                                                         | Surfaces | Coverage                |
| ---- | ---------------------------------------------------------------------------------- | -------- | ----------------------- |
| C-01 | Send a message; it appears immediately and persists                                | all      | U, E, S                 |
| C-02 | Multi-line input; Meta+Enter submits                                               | all      | E, S                    |
| C-03 | Rich formatting in the composer (code, lists)                                      | session  | E                       |
| C-04 | Slash-command palette (`/`), incl. native commands like compact                    | session  | E (enabled-check only)  |
| C-05 | @-mention picker; mention renders as a pill; mentioned agent is triggered          | rooms    | E (picker), U (trigger) |
| C-06 | Attach files                                                                       | rooms    | U, E                    |
| C-07 | Queue a message while the agent is working ("Compose next"); it drains on turn end | session  | U, E, S                 |
| C-08 | Edit or cancel a queued message before it sends                                    | session  | U, E                    |
| C-09 | Steer a message **into** a live turn (`deliverIntoTurn`)                           | session  | U                       |
| C-10 | Stop a running turn; Stop reaches a still-starting agent                           | session  | U                       |

## 2. Receiving & rendering

| ID   | Capability                                                                | Surfaces | Coverage                               |
| ---- | ------------------------------------------------------------------------- | -------- | -------------------------------------- |
| R-01 | Token streaming renders live, no freeze; stop button lifecycle is correct | session  | E, S                                   |
| R-02 | Markdown: headings, lists, tables, links                                  | all      | S                                      |
| R-03 | Code blocks: highlighting, copy button, HTML shown as code not injected   | session  | E, S                                   |
| R-04 | Tool-call cards: visible, ordered, expand/collapse                        | session  | E, S                                   |
| R-05 | Subagent blocks appear while running, clear when done                     | session  | S                                      |
| R-06 | Todos/tasks pill: counts and statuses advance with TodoWrite              | session  | S                                      |
| R-07 | Background task bar for async agents                                      | session  | —                                      |
| R-08 | Reactions on room entries                                                 | rooms    | E                                      |
| R-09 | Agent stall/silence notice in rooms                                       | rooms    | U                                      |
| R-10 | Error states: failed send, retry                                          | session  | E                                      |
| R-11 | Auto-scroll and scroll anchoring; no layout jumps                         | all      | S                                      |
| R-12 | Screen-reader announcer mirrors streamed text                             | session  | E (indirectly, via strict-mode gotcha) |

## 3. Interactive prompts (the agent asks you something)

| ID   | Capability                                                                                     | Surfaces | Coverage       |
| ---- | ---------------------------------------------------------------------------------------------- | -------- | -------------- |
| I-01 | Tool approval card renders; Approve runs the tool; Deny refuses it                             | session  | U, S           |
| I-02 | Batch approval bar for multiple pending tools                                                  | session  | —              |
| I-03 | AskUserQuestion prompt renders; answer is delivered                                            | session  | U (partial), S |
| I-04 | Elicitation prompt (MCP)                                                                       | session  | —              |
| I-05 | Pending prompts survive switch-away-and-back and hard refresh (snapshot `pendingInteractions`) | session  | U, S           |
| I-06 | Approval answered outside DorkOS (e.g. OpenCode CLI) shows the real outcome                    | session  | U              |
| I-07 | Approval timeout (~10-min auto-deny) is visible and honest                                     | session  | U              |

## 4. Session lifecycle & context

| ID   | Capability                                                                                                                                        | Surfaces | Coverage                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| L-01 | New session; model and permission mode selectable per session                                                                                     | session  | E, S                               |
| L-02 | Rename a session (incl. via palette)                                                                                                              | session  | U, E                               |
| L-03 | Resume an old session; full history renders identically to live (reload-from-history parity)                                                      | session  | S                                  |
| L-04 | **Compaction**: `/compact` and auto-compaction produce a visible boundary; history before it still renders; the turn after it has correct context | session  | — (palette row enabled-check only) |
| L-05 | Session fork / branch                                                                                                                             | session  | —                                  |
| L-06 | Session lock (`X-Client-Id`): two writers don't corrupt a session                                                                                 | session  | U                                  |
| L-07 | Cross-client sync: same session in two windows agrees (messages, queue, edits)                                                                    | session  | E                                  |
| L-08 | SSE reconnection: gap-free replay via `Last-Event-ID` after network drop                                                                          | session  | U, E                               |
| L-09 | Switching between two concurrently-working sessions loses no live state (streaming, prompts, queue, todos, subagents)                             | session  | S                                  |
| L-10 | Per-runtime parity: the same chat behaviors on claude-code, codex, opencode                                                                       | session  | U (conformance)                    |

## 5. Rooms, threads, DMs

| ID   | Capability                                                                                              | Surfaces | Coverage                             |
| ---- | ------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------ |
| M-01 | Create a channel; roster of humans + agents                                                             | channel  | U, E                                 |
| M-02 | Post in a channel; everyone (and every window) sees it live                                             | channel  | E                                    |
| M-03 | Agent room turns: an addressed/mentioned agent replies in the room; turn budget respected               | channel  | U                                    |
| M-04 | Etiquette: agents don't over-participate (see `meta/agent-etiquette.md`)                                | channel  | —                                    |
| M-05 | **Threads**: open a thread, reply in it, replies stay out of the main timeline, thread arrivals surface | thread   | —                                    |
| M-06 | Thread deep-link (`?thread=`) restores the panel and focus                                              | thread   | — (hooks unit-tested only)           |
| M-07 | DMs: open, post, agent replies                                                                          | dm       | E (open/post)                        |
| M-08 | Unread/read state, correct across devices                                                               | rooms    | E                                    |
| M-09 | Presence (who's here, incl. sidebar)                                                                    | rooms    | E                                    |
| M-10 | Archive a room; archived rooms discoverable in palette                                                  | rooms    | E                                    |
| M-11 | Bridged/relay channels (Buzz) behave like local rooms (community conformance)                           | channel  | U (conformance), E (bridged-channel) |
| M-12 | Room ↔ session binding: the agent's room turn maps to a real transcript that can be repaired/converged  | channel  | U                                    |
| M-13 | Notifications: 🔔 title prefix / attention signals when a background surface needs you                  | all      | S (partial)                          |

## 6. Agent autonomy & conversational behavior

The goal: agents participate in channels and DMs the way a good human colleague participates in Slack — present, useful, mostly quiet (`meta/agent-etiquette.md`). Much of the machinery exists (`ResponseMode` in `packages/shared/src/mesh-schemas.ts`: `always` / `engaged` / `direct-only` / `mention-only` / `silent`; `engagement.ts` turn-taking windows; `addressing.ts`; `turn-budget.ts` cascade ceilings; `room-context.ts` feeds each triggered agent the roster, thread subjects, and reactions on its own recent posts). **State** below is honest: built / partial / not built / unverified. States re-audited 2026-08-14 after the landing run (rows marked #1015 ride the final PR of that run) — full architecture review with mechanism pointers and the Buzz/QM comparison: `research/20260813_room-architecture-vs-buzz-qm.md`.

| ID   | Capability                                                                                                                                                                                                          | State                                                                                                                                                                                                                                                                           | Coverage |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A-01 | An agent @mentions another agent in a channel; the mentioned agent responds (agent↔agent conversation)                                                                                                              | built (dispatch is author-kind-agnostic; cascade ancestry bounds it)                                                                                                                                                                                                            | U        |
| A-02 | **Intelligent response mode**: an unmentioned agent listens and replies only when it has something to add (`engaged` / `always` modes + etiquette rubric)                                                           | partial (modes + window built; the cheap should-respond gate is specced — `specs/engaged-response-gate`, DOR-1203 — build staged behind a labelled corpus)                                                                                                                      | U        |
| A-03 | New channel messages arriving **while an agent is composing** are folded into its reply (the room analog of `deliverIntoTurn`); no answering a stale room                                                           | **built** (RP8, PR #1014): bursts collect (500ms/20 cap, config), mid-turn arrivals fold into the next answer (`arrivedDuringPrevTurn`), same-room busy parks and resumes on claim release; a human entry can never be vetoed by an agent reply in the same batch               | U        |
| A-04 | Agent-initiated agent↔agent DMs are **three-way by policy**: the human is always a member and sees the whole exchange                                                                                               | **built** (DOR-1208, PR #1009): 3-way rule enforced at seeding, addMember, and owner-removal; agent posts in non-channels reach only members they @mention                                                                                                                      | U        |
| A-05 | Agents proactively DM the human (progress, blockers, findings) — batched and quiet-hours-aware, never spammy                                                                                                        | partial (DOR-1209, PR #1013: with no chat app connected, `relay_notify_user` lands in the agent's DorkOS DM — a stock install is never silent; consent/quiet-hours/escalation specced in `specs/proactive-agent-dms`, open on DOR-1209)                                         | U        |
| A-06 | Agents use reactions well: ✅/👀/👍 instead of a "got it" message; agents **see** reactions on their own posts (built: `room-context.ts` acknowledgments) and can **add** them                                      | **built** (#1015): `react_to_room_entry`, bounded 20/agent/room/hour, additions-only spend; E16b reversed by ADR `260814-195522`; reactions still never cascade; judgment quality untested                                                                                      | U        |
| A-07 | Cascade/storm protection: two agents can't ping-pong forever; budgets visible when hit                                                                                                                              | built ×3 (cascade depth + ancestry, turn budget, park-and-resume claim) — budget windows are **durable** since DOR-1205; ancestry is re-asked per entry when a collected batch runs                                                                                             | U        |
| A-08 | Yielding: if a human (or another agent) answers first, or the addressed question gets resolved mid-compose, the agent stands down instead of double-answering                                                       | not built                                                                                                                                                                                                                                                                       | —        |
| A-09 | Deduplication: when several agents could answer one mention/question, exactly one does (claim/first-responder), no pile-on                                                                                          | **contradicts invariant I1** (no arbitration, declined twice) — needs an ADR, not a feature; restraint comes from `working` visibility + engaged decay instead                                                                                                                  | —        |
| A-10 | Thread discipline: agents take long tangents and work-progress updates **into a thread**, keeping the main timeline quiet                                                                                           | partial (#1015: `post_to_room` can target a thread — the mechanism exists; choosing to is conduct, untested)                                                                                                                                                                    | —        |
| A-11 | Looping in: an agent brings a third party into a conversation ("looping in @x") with a one-line context handoff, not a bare mention                                                                                 | not built                                                                                                                                                                                                                                                                       | —        |
| A-12 | Self-correction: an agent that said something wrong corrects itself explicitly (edit or follow-up marked as a correction), never silently                                                                           | partial (#1015: an agent can now post an affirmative correction via `post_to_room`; the log stays append-only — no edit route, no marked-correction convention)                                                                                                                 | —        |
| A-13 | Catch-up: an agent (or the human) can ask "what did I miss?" and get an honest summary of the channel since a point in time                                                                                         | partial (#1015: `read_room_history` + `search_room_history` give an agent the log back, membership- and join-scoped; nothing summarizes it for a person yet)                                                                                                                    | —        |
| A-14 | Time/attention awareness: quiet hours, urgency-gated escalation (thread → channel → DM → notification), never 3am pings for non-urgent info                                                                         | not built                                                                                                                                                                                                                                                                       | —        |
| A-15 | Untrusted-content posture: content posted by **other room members** (incl. other agents and bridged/external users) is data, not instructions — prompt-injection via a channel post must not steer an agent's tools | **implemented and hardened** (nonced fence + `defuseSystemTags` + `sanitizeIdentity`; DOR-1207 added a forge-refusal test — a member pasting the fence's own heading cannot create a second boundary). Mechanics are pinned (U); an adversarial injection eval is still missing | U        |
| A-16 | Human override: mute/silence an agent per room (`silent` mode), and stop an in-flight room turn                                                                                                                     | partial (halt is complete since RP8 — interrupts every turn, drops parked batches first, ordering pinned by a two-agent test; `silent` mode built; per-room mute route still has **no client caller**)                                                                          | U        |

## 7. Agent context in channels — can they find what they need?

Your question: is there a way to **check** an agent gets all the right context in a channel? Today: `room-context.ts` (ADR-0273) assembles what a triggered agent is told — room, roster with addressable handles, recent entries, thread subject excerpts, its own last 5 posts, up to 5 reactions on them — and it is unit-tested (`room-context.test.ts`, `room-context-handles`). But that only proves the **payload is assembled**, not that the agent can actually **use** it. Nothing verifies comprehension.

The check we're missing is a **context-recall probe suite** (natural fit: a `rooms` suite in `packages/evals`): seed a channel with known history, then ask the agent questions whose answers require each context source, and oracle-judge the replies:

| ID   | Probe                                                                 | Verifies                                     |
| ---- | --------------------------------------------------------------------- | -------------------------------------------- |
| X-01 | "What did @kai say about the deploy earlier?"                         | recent-entries window depth                  |
| X-02 | "Who else is in this room and what are their handles?"                | roster + addressable handles                 |
| X-03 | Ask inside a thread about the thread's opening message                | thread subject excerpt                       |
| X-04 | "Which of your suggestions did people 👍?"                            | acknowledgments feed                         |
| X-05 | Reference an attachment posted earlier ("open the file Priya shared") | attachment paths reach the agent             |
| X-06 | Ask about something said **beyond** the context window                | honest "I don't see that" (no confabulation) |
| X-07 | Same probes in a bridged (Buzz/relay) room                            | context parity across community backends     |
| X-08 | Probe after the room's bound session compacted                        | room context survives compaction             |

## 8. Edge cases the tests should force

- **Concurrency**: two sessions streaming at once while switching (covered by `/chat:session-switch-test`); an agent active in a **room and a direct session at the same time**; two humans posting in one thread simultaneously.
- **Interruption**: refresh mid-stream; network drop mid-stream; server restart mid-turn; stop pressed during tool execution; queued message pending when the turn errors.
- **Compaction**: compaction firing **while** a message is queued; compaction mid-multi-turn task; transcript rendering across the boundary; compaction in a room-bound session.
- **Prompts**: approval pending during a session switch, a refresh, a compaction, and a second incoming prompt; question prompt answered from a second window; approval answered outside DorkOS.
- **Scale**: 500+ message session reload; very long single message; rapid-fire sends; many rooms with unread counts.
- **Identity**: URL session id ≠ SDK session id (the JSONL mapping trap); duplicate session titles in the sidebar; placeholder ids in `room_sessions`.
- **Mobile**: every capability above on a phone viewport (composer, thread panel via room-sheet-phone, approval cards).
- **Runtime spread**: C-07 queueing, I-01 approvals, and L-04 compaction on codex and opencode, not just claude-code.
- **Autonomy** (new, from §6): mention loops (A mentions B mentions A — budget must break it, and the break must be visible); two agents answering the same mention at once; a human answering a question while an agent is mid-compose on it; a message **deleted or edited** after an agent started replying to it; an agent mentioned inside a thread (does it get thread scope or channel scope?); a reaction used as an answer ("👍 to approve?") — is that ever an approval signal, and if not, is that explicit; an `engaged`-mode agent in a high-traffic channel (does restraint hold at volume); bridged-room members with external identities mentioning a local agent; prompt-injection posted by a bridged external user (A-15).

## 9. Known coverage gaps (2026-08-13)

Ranked by user pain if broken:

1. **Compaction end-to-end (L-04)** — no test asserts a compaction actually happens and the session stays coherent.
2. **Threads (M-05, M-06)** — UI and hooks exist, zero dedicated e2e.
3. **Approve/Deny + AskUserQuestion in e2e (I-01…I-04)** — only the live self-test sees them; nothing deterministic pins them.
4. **Steering + stop (C-09, C-10)** — server-tested only; never exercised through the UI.
5. **Subagents, todos pill, background task bar in e2e (R-05, R-06, R-07)** — dev-simulator scenarios exist but aren't wired into Playwright.
6. **Cross-runtime chat parity at the e2e layer (L-10 beyond unit conformance)**.
7. **Fork/resume (L-05)** and **agent etiquette (M-04)** — no automated signal at all.
8. **Agent context comprehension (X-01…X-08)** — context assembly is unit-tested; whether agents can actually use it is untested. Needs the context-recall probe suite (§7).
9. **Autonomy behaviors (§6)** — largely BUILT as of 2026-08-14 (A-03/A-04/A-06/A-07 shipped; A-05/A-10/A-12/A-13 partial) with unit coverage, but nothing above the unit layer: no e2e drives an agent burst/steer/halt through the UI, and no eval judges restraint or comprehension. A-15's fence mechanics are pinned; the adversarial injection eval is still the security-relevant gap before Mesh+Relay leaves the demo-claim gate.
10. **No rooms self-test exists.** `/chat:self-test` and `/chat:session-switch-test` are session-only, written before channels matured — and this run grew rooms the most (collect/steer/halt, 3-way DMs, reactions, tool hand, DM notifications). A `/chat:rooms-test` sibling (live browser, two agents in a channel, burst → one reply; halt; reaction; thread) is now the highest-value new self-test, and the `rooms` eval suite (§7's probes + the gate's tuning loop, shapes specced in `specs/engaged-response-gate`) is its deterministic counterpart.

## 10. The test surface today (all of it)

Everything in the repo that verifies behavior, not just the two chat self-tests:

**Deterministic (no model, CI-able)**

- Unit/route tests — vitest across all packages; `runtimeConformance` and `communityConformance` parity suites.
- Playwright e2e — `apps/e2e` (54 tracked specs, `manifest.json`, `GOTCHAS.md`); mock leg runs against the test-mode runtime in a throwaway `/tmp` data dir.
- `apps/e2e/tests/streams/multi-window.spec.ts` — the CI regression guard for the connection budget.
- CLI smoke — `pnpm smoke:docker`, `pnpm smoke:integration` (Docker, packaging-level).
- Free structural evals — `pnpm evals -- --suite core --tier test-mode` (no spend; runs nightly).

**Agentic / live-model (spends tokens, needs a running stack)**

- `/chat:self-test` — single-session depth (this doc §1–§4).
- `/chat:session-switch-test` — two concurrent sessions + switching (§L-09).
- `/multiwindow` — N cockpit windows against a live instance; wraps `pnpm --filter @dorkos/e2e multi-window`, prints a PASS/FAIL table.
- Agent evals — `pnpm evals:local` (`packages/evals`): suites `governance`, `agents`, `operate`, `connectors`, `ui` (widget round-trip), `selftest` (harness boots + health). Oracle-judged, budget-capped. **No chat/rooms suite exists yet** — its intended shape (tuning + gating loops, drive-a-room-post harness gap) is specced in `specs/engaged-response-gate/01-ideation.md`.

**Meta-tooling (manages or exercises tests, is not itself a test)**

- `/browsertest` — run/create/debug/report for `apps/e2e` (explore-first authoring loop).
- `/browsertest:maintain` — staleness audit: checks each manifest entry's `relatedCode` against git history, re-runs, auto-fixes test bugs.
- `/debug:test`, `/debug:browser` — fixers for failing tests / broken UI.
- Capture pipeline — `apps/e2e/capture` (product screenshots/video); implicitly asserts key UI states render, but is media tooling, not verification.

## 11. Run modes and the single entry point

**Run-mode convention for agentic self-tests** (to be wired into `/chat:self-test`, `/chat:session-switch-test`, and any future self-test):

- `mode:sandbox` — run against the **test-mode runtime** (throwaway data dir, no model spend, deterministic). Verifies UI plumbing.
- `mode:live` — run against the dev environment with a real runtime. **Default model: Haiku** (`claude-haiku-4-5`) unless the run is explicitly about model behavior. Verifies streaming feel, real tool loops, timing.
- If the invocation doesn't state a mode, the command **asks the user** before spending anything.

**Run-everything entry point** (planned): one command that runs the whole ladder and produces a single report —

1. `pnpm verify` (typecheck + lint + affected unit tests)
2. `pnpm test -- --run` (full unit suite)
3. `apps/e2e` Playwright (mock leg always; cockpit leg if a stack is up)
4. `pnpm evals -- --suite core --tier test-mode` (free structural evals)
5. **Gated, ask-first**: live evals (`pnpm evals:local`), the agentic self-tests, `/multiwindow`, Docker smokes

Steps 1–4 are free and deterministic; step 5 spends money or needs a live stack, so it is opt-in per run. Candidate shape: a `/test:all` command (or `pnpm test:everything`) that runs 1–4, then asks about 5, and writes one summary with pass/fail per tier.

## 12. How this list is used

- New chat feature → add its rows here in the same PR.
- Each gap above should become a deterministic e2e spec against the **test-mode runtime** where possible (free, CI-able), with the agentic self-tests reserved for what only a real model shows (timing, streaming feel, real tool loops). Autonomy (§6) and context-comprehension (§7) capabilities are judgment-shaped — their natural home is a `rooms` suite in `packages/evals` (oracle-judged, budget-capped, with a free structural tier).
- The self-tests (`/chat:self-test`, `/chat:session-switch-test`) should cite the IDs here in their verification matrices, so a run maps back to this contract.
