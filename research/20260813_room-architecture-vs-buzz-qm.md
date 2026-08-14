---
date: 2026-08-13
type: architecture-review
status: current
topic: DorkOS room/agent-participation architecture reviewed against meta/chat-capabilities.md, Block's Buzz, and YC's QM
---

# Room architecture review: DorkOS vs Buzz vs QM

**Question asked:** is the rooms architecture set up to handle everything in `meta/chat-capabilities.md`? Is it simple, bloated, elegant, sound? Where are the gaps and how could it be better?

**Method:** three parallel source dives on 2026-08-13 — (1) a file-level trace of `apps/server/src/services/rooms/` + `communities/` against the capability list; (2) Block's Buzz at `github.com/block/buzz` (via opensrc checkout + the four existing `research/2026072*_buzz-*.md` / `20260807_room_context_delivery_buzz_and_patterns.md` reports, which remain current); (3) YC's QM at `github.com/yc-software/qm` (MIT, open-sourced 2026-07-31; multiplayer agent harness for Slack + web, drives Pi/OpenCode/Codex/Claude Code through one core).

## 1. How DorkOS rooms work today (verified, with pointers)

**Post → dispatch.** `POST /api/rooms/:id/entries` is trigger-only (202); `RoomService.post` resolves mentions once at write time with spans (`mentions.ts`), stamps cascade provenance (`cascade-guard.ts:130-143` — an agent posting mid-turn inherits its live cascade via `activeTurnFor`), publishes, then dispatches. Dispatch failure can never fail a committed post.

**Who runs (`room-trigger.ts:claimTargets`)** — six sequential filters: engagement window (pure predicate over the log, thread-scoped, decays on minutes OR posts — `engagement.ts`), the addressing matrix (`addressing.ts:63-79`: silent / mention-only / engaged / direct-only / always; self excluded), fallback-seat stand-down, cascade guard (depth + **ancestry**: `authorsInCascade` refuses A→B→A at the first repeat), busy check (one turn per (room, agent)), turn budget (two rolling 1-hour ceilings, identity-independent because `authorKind` is forgeable), then session binding. Refusals write room notices (invariant I3, "a refusal is visible") — except one hole: `bindRoomSession` failure is log-only (`room-trigger.ts:706-717`).

**The turn (`room-turn-runner.ts`).** One session per (room, agent) (`room_sessions`, first-write-wins; claude-code renames mid-turn, convergence follows the rename via `onProjectorRekey` + a `runOne` fallback + a 512-entry retired-id ledger). Prompt = the entry's text byte-for-byte; everything else rides `additionalContext` (ADR-0273): roster with isPerson/isSelf, thread excerpt, live `working` claims, unread `pending` window, own last 5 posts, ≤5 reactions on them, addressing state (own `engagedUntil`/`engagedPostsLeft`), budget remainders. Every other member's text sits inside a **nonced untrusted-data fence** (`room-context-block.ts:41-90`). `dispatchMessage({whenBusy:'refuse'})` — room turns never queue and never steer. Reply = final assistant text, auto-posted into the thread it was asked in; empty reply ⇒ deliberate `quiet` (no entry, no notice). Turns that outrun the 10-min wait post late with a note; they are never cancelled.

**Threads** are an entry relation (`threadRootEntryId`, depth 1 enforced), not child rooms. **DMs** are `RoomKind='dm'`, idempotent on member set; agent-seeded multi-agent rooms are refused by `requireSeedingAllowed`.

**What a room-triggered agent CANNOT do today:** react (`requirePersonAuthor` refuses, etiquette E16b), choose or start a thread, attach files to its reply, edit any entry (log is append-only), read history beyond the pending window (no room MCP tools exist at all — `mcp-tool-groups.ts` has no `rooms` group), halt others, or DM another agent.

**Sizes.** `services/rooms/` = 17.6k production lines (+19.4k tests). `services/communities/` = 4.1k. Big files: `room-service.ts` 2,935 (≥6 subjects incl. ~500 lines of bridging), `room-trigger.ts` 1,803, `author-registry.ts` 1,261, notices 1,325 across two files.

## 2. Verdict

**Sound and unusually principled at the core; two structural debts; one dead seam.**

Elegant (keep, and protect): `addressing.ts` + `cascade-guard.ts` are pure, total, enumerable; `engagement.ts` stores nothing (predicate over the durable log); read-cursor-advances-at-claim with both rewind directions reasoned; the untrusted fence with per-turn nonce; visible-refusal invariant; the room-participation spec's recorded operator decisions. The cascade **ancestry** rule is stronger than anything in either reference system — Buzz's own storm postmortem ("'Don't get into a loop' is not a rule an agent can follow") is the argument for our I2 (bounds are mechanisms, never prompts), and Buzz never built its breaker.

Structural debt #1 — **room turns are a parallel reimplementation of session turns** with different answers (refuse vs queue, no steer, no deliverIntoTurn). This single divergence is why A-03 (fold in mid-turn arrivals), A-08 (yielding), and RP8 (collect/debounce/steer/halt) are unbuilt: the machinery exists on the session path and rooms can't reach it.

Structural debt #2 — **the coordination state that must survive a restart doesn't**: turn-budget windows are in-memory (both reset on boot), the retired-id ledger is per-process, and `room-session-convergence.ts` says outright that boot repair of stranded bindings is impossible today.

Dead seam — **CommunityAdapter (4.1k lines) has no production consumer.** `aggregateCommunityRooms` is never called; no Buzz adapter is registered; and the real second backend (Telegram/Slack) bypassed the port via `relay/chat-bridge` → `RoomService.postExternal`. The port was designed for a shape the product didn't take. Its conformance suite passes without protecting any path users hit.

Minor: thread-scope inconsistency (engagement is thread-scoped, the pending context window is room-scoped, reply routing is thread-scoped — they should agree); `room-service.ts` god object; no client caller for the per-room mute route.

## 3. What Buzz does (differently)

Protocol-first Nostr relay + one OS process per agent; the relay has zero opinion on behavior. "Do I run a turn?" is fully deterministic (p-tag mention equality, author gates, TOML rules — never a content regex, never a model call); "do I say anything?" is left to the prompt ("silence is usually correct", prohibited bare-ack phrases). Mature mid-turn handling: default `steer` via a native ACP extension with cancel+merge fallback, and the merge framing is _named to the model_ ("[New message — arrived while you were working]" vs "[New request — supersedes previous]"). Harness auto-reactions 👀/💬 with a panic-safe drop guard. DM hardening: allowlist/anyone never applies inside DMs; unknown channel type fails closed to DM (transitive-access-grant analysis).

Weaknesses we should not import: prompt-only loop protection (their 21-reply storm postmortem, breaker designed but never shipped); essentially no injection posture for channel content (verbatim interpolation); empty context (no roster, no time, computed `is_agent` never rendered); reactions invisible to agents; `since=now` amnesia; per-agent-global response policy; `bypass-permissions` default; CLI-behind-shell as the agent API.

## 4. What QM does (differently)

Service-first org product (~81.5k core + plugins; Postgres; Slack + web). Three-tier gating, cheap→expensive: free routing rule (top-level channel messages never dispatch; thread replies only with "stake"; mentions always) → **cheap `shouldRespond` classifier** for ambient traffic (YES/NO/REACT :emoji:, "prefer NO when unsure", every silent decision audited) → full turn. Ambient listening **off by default** per channel until someone writes standing orders. `routeWake` is a 34-line pure decision table: self→drop, no live run→engage, stop→abort, addressed-during-gated-run→new run, else→**steer**; steer signals are Postgres-durable, polled by all four harnesses, replayed if orphaned. One `slack` tool with 10 actions (post/react/edit/read*thread/whats_new/search/…); typing-ack is an LLM-chosen emoji reaction removed when text lands. `finish_silently`/`stay_silent` are tool-shaped success outcomes. Proactivity guardrails: recipient consent cards for recurring deliveries, cron floors, auto-disable on authz failure. Trust: provenance labels on every inbound chunk with a classifier that reasons about \_which sources may instruct*; scope-labelled transcript entries filtered per viewer (redacted tool results become "interrupted" stubs, pairing preserved); egress audience floor = intersection of allowed hosts across room members; three actions structurally unreachable by the agent (grants, impersonation, approval decisions).

Weaknesses: 3,043-line orchestrator; 45-field turn-input struct; a declared-but-never-read capability set on the harness port; an addressed-turn "nudge" that re-runs a whole turn to paper over a prompt problem.

## 5. Recommended modifications (ranked, with why)

1. **Unify the turn paths: build RP8 on the session machinery.** Make the room runner use the session path's steer/queue capabilities (`deliverIntoTurn` exists at `claude-code-runtime.ts:701`), with a single pure wake-decision function (QM's `routeWake` shape; Buzz's named steer framing). Unlocks A-03 and A-08, removes the duplication that will otherwise grow.
2. **Give room agents a small tool hand: a `rooms` MCP tool group** (`room_react`, `room_post` with thread target, `room_read_history`, richer `RoomTurnReply` for attachments) + reverse the E16b no-reactions rule with a rate bound. One mechanism unlocks six capability rows (A-06b, A-08, A-10, A-11, A-12-as-marked-correction, A-13b). QM's 10-action tool is the model; keep our typed-MCP advantage over Buzz's CLI-behind-shell.
3. **Add a cheap should-respond gate for non-addressed `engaged` turns.** Today an engaged agent runs a _full_ turn on every in-window post and relies on empty-reply quiet — correct but expensive. QM's middle tier (small model, YES/NO/REACT, audited silences) fits exactly between our addressing matrix and the runner; it is also the honest implementation of "responds only when it has something to say" (A-02).
4. **Decide the CommunityAdapter's fate.** Either route the relay chat-bridge through it (making the conformance suite protect a real path) or park/delete it. 4.1k conformance-tested lines with no consumer is the codebase's one real bloat, and it falsifies "M-11 covered" in the capability doc.
5. **Make coordination state durable**: persist turn-budget windows and the retired-id ledger (SQLite), and make the boot sweep repair stranded bindings instead of reporting them. QM's durable run-signal store is the precedent.
6. **Close the last silent refusal** (`bindRoomSession` failure → room notice, upholding I3) and **fix thread-scope agreement** (thread-scope the pending window, with a small channel tail).
7. **A-04 (agent↔agent DMs)**: relax `requireSeedingAllowed` to "an agent may seed a room containing another agent only if the owner is a member" — the 3-way rule; pairs with the spec's §2.3 DM-disclosure commitment. Adopt Buzz's DM hardening (membership policy never widens inside DMs; unknown kind fails closed).
8. **A-05/A-14 (proactive DMs, quiet hours)**: build on tasks/cron + `relay_notify_user`, stealing QM's guardrails — recipient consent for recurring sends, `finish_silently` as the success case for scheduled fires, quiet-hours policy at the delivery layer.
9. **A-09 (dedup/election): recommend NOT building.** It contradicts settled invariant I1 (no arbitration; declined twice, five months apart). Restraint via `working` visibility + engaged decay + the should-respond gate is the same outcome without a referee. If ever revisited, it needs an ADR.
10. **Steal Buzz's prompt discipline into etiquette/evals**: prohibited bare-ack phrase list; "does this add information the thread doesn't have?" as the per-turn local test; and QM's per-viewer scope filtering when rooms meet multi-tenant sharing.

## 6. Capability-list impact

States corrected in `meta/chat-capabilities.md` (2026-08-13): A-01 mechanism complete (needs e2e only); A-03 not built (refuse-not-steer); A-04 blocked by `requireSeedingAllowed`; A-06 seeing built / adding explicitly refused (E16b); A-07 built but budgets non-durable; A-09 contradicts I1 (ADR required); A-12 impossible today (append-only, no edit route); A-15 implemented (fence + nonce + defuse) but untested; A-16 halt built (route + `RoomHeader`), per-room mute server-only (no client caller).
