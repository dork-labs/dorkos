---
id: 260824-233720
title: Agent memory — an agent-scoped memory layer across sessions, rooms and DMs
status: ideation
created: 2026-08-24
---

# Agent memory — an agent-scoped memory layer across sessions, rooms and DMs

**Slug:** agent-memory
**Author:** Dorian + Claude (ideation session 2026-08-24, from the seven-pass research run)
**Date:** 2026-08-24
**Tracker:** DOR-632 - An agent re-learns the operator from scratch in every room

---

## 1) Intent & Assumptions

- **Task brief:** An agent told something in one conversation knows it in every
  other conversation it takes part in. Today it does not: each room, DM and
  direct session binds its own runtime session, and nothing durable crosses
  them. Tell an agent in #infra "we deploy Tuesdays, never Friday" and in
  #product it has a different session and no way to know to look (DOR-632). The
  reported real-world failure: an operator set an agent up in a direct session,
  added it to a channel, and in the channel the agent knew nothing about the
  setup conversation.
- **Assumptions** (logged per the calibration ladder; none blocked on the operator):
  - Sessions stay surface-scoped. We add a memory layer; we do not merge or
    bridge runtime sessions. Every system studied (Hermes, OpenClaw, Buzz,
    Letta) made the same call.
  - Single-operator install is the v1 reality, but **bridged rooms already
    carry third parties** (Telegram/Slack projections), so the privacy boundary
    is a v1 concern, not a multi-tenant future concern.
  - This spec is the first shippable slice of what the litepaper calls Wing.
    Per the honesty pillar, nothing ships under the Wing name until it exists.
- **Out of scope:**
  - Human-facing message search (DOR-672) — different corpus, ranking, access
    rules; the fence between the two is already written into
    `specs/message-search/02-specification.md:462`.
  - Vector/semantic search, knowledge graphs, cross-agent shared memory — all
    deferred behind the provider seam (see §5); none in the first slice.
  - Unifying or resuming sessions across surfaces.
  - Changing room-context delivery (RP3/RP7) — memory rides beside it, not
    through it.

## 2) Pre-reading Log

- `research/20260824_agent-memory-cross-session-context.md` — the source
  document for this ideation: seven parallel research passes (DorkOS codebase
  audit; Hermes agent; OpenClaw; Buzz refresh incl. NIP-AE engrams; PromptQL;
  memory-systems landscape; buy-vs-build survey). Its recommendation is adopted
  here; this artifact records the decisions and the E7 cost analysis DOR-632's
  validation criteria ask for.
- DOR-632 ticket body — proposes the agent's own directory (agentPath,
  `.dork/agent.json`, projected by `@dorkos/harness`) as "the unused resource
  scope." The research independently confirms this is the right scope, and
  found the injection seam already live (below).
- `meta/agent-etiquette.md` E7 — "Silence must be free. If an agent is charged
  for listening, restraint becomes something the product punishes. Cost should
  attach to speaking."
- `research/20260807_room_context_delivery_buzz_and_patterns.md` — prior Buzz
  research; the refresh found its room-context findings unchanged and added the
  engram memory deep-dive.
- `meta/chat-capabilities.md` §7.1 (added 2026-08-24) — the X-09…X-13
  cross-surface memory probes this work must eventually satisfy.

## 3) Codebase Map

- **The gap, precisely:** an agent in 3 channels + 2 DMs + 1 direct session
  holds six disjoint runtime transcripts. Rooms bind one session per
  `(roomId, authorId)` (`room_sessions`, `room-store.ts:1661`); the direct
  surface is URL-addressed; the only join is a read-only cockpit label
  (`resolveRoomOrigins`, `room-store.ts:1717`). No tool lists an agent's rooms
  or sessions; the search index covers rooms only
  (`services/search/registry.ts:95`).
- **The resource scope (confirming DOR-632's proposal):** the agent directory.
  `buildAgentContextAppend(cwd)`
  (`apps/server/src/services/runtimes/shared/agent-context.ts:269`, via its
  block builder `buildAgentBlock` at `:188`) already
  injects `<agent_identity>` / `<agent_persona>` (SOUL.md) /
  `<agent_safety_boundaries>` (NOPE.md) into **every turn of every runtime on
  every surface**, because it keys off the agent's cwd, not the session. A
  memory block slots into this seam with no new plumbing. Convention files
  live in `packages/shared/src/convention-files.ts` (today: `soul`, `nope`);
  scaffolding via `ensureDorkBot()` / agent creation; harness projection via
  `@dorkos/harness` (instructions only today).
- **Adjacent machinery:** ADR-0273 structured prepend (per-turn context
  channel); the claude-code adapter suppresses the SDK's own auto-memory
  (`launch-resolver.ts:268-271`, `excludeDynamicSections: true`) — kept
  suppressed so DorkOS owns one runtime-neutral memory system.
- **Seam pattern for pluggability:** four ports exist (AgentRuntime, Transport,
  ConnectorProvider, CommunityAdapter) with conformance suites in
  `@dorkos/test-utils` and the four-rule port contract
  (`community-adapter.ts:14-33`). MemoryProvider becomes seam #5.
- **Blast radius:** `agent-context.ts` (new block), `convention-files.ts` +
  scaffolding (new file), MCP tool registry (memory write tool; later the
  search/list tools), `packages/harness` (projection), evals
  (`rooms-recall.ts` pattern → memory probes), `meta/chat-capabilities.md`
  §7.1. No changes to room-context delivery, session binding, or transcripts.

## 5) Research

Condensed from `research/20260824_agent-memory-cross-session-context.md`; the
convergence across four independent production systems is the headline finding.

- **Option A — merge/bridge sessions across surfaces.** Rejected. No studied
  system does it; OpenClaw's one collapsed scope (the shared DM session)
  produced an audited security failure (cross-user credential leakage).
- **Option B — retrieval-first (vector RAG over everything).** Rejected as the
  core. Verbatim-beats-extracted ablation (arXiv 2601.00821), agentic-search
  convergence (Claude Code removed its vector DB; Amazon Science: keyword
  agents at 94.5% of RAG faithfulness), context-rot evidence, and the overhead
  numbers (MemoryOS 32 s latency; A-MEM 15 h index) all argue against
  vector-first for a local, single-operator workload.
- **Option C — buy a memory library/service.** Rejected as the core: the
  buy-vs-build survey found nothing that ships the scoping/write-policy layer
  (whose memory, which surfaces read it, what a private fact may do in a shared
  room) — that layer is ours regardless. Best buys become optional providers
  behind the seam (`mcp-memory-service`; claude-mem as architecture reference).
  License landmines noted: Basic Memory and Honcho are AGPL; Zep CE is dead;
  LangMem is Python-only.
- **Option D — the convergent three-tier shape (RECOMMENDED).** Hermes,
  OpenClaw, Buzz (engrams) and Letta all independently built: (1) a small,
  hard-capped, curated memory scoped to the **agent identity**, injected every
  session; (2) zero-LLM-cost search over verbatim history, pull-only; (3) an
  optional pluggable provider for anything smarter. PromptQL's own product
  retreat (a curated wiki over Slack history rather than raw plan-and-compute)
  is a fourth confirmation of the curated tier.

**Recommendation:** Option D, phased: Phase 0 session-model honesty prompt →
Phase 1 Tier-1 memory files (the DOR-632 fix) → Phase 2 Tier-2 cross-session
search tools → Phase 3 the MemoryProvider seam. Phases 0+1 are this spec's
build; 2 and 3 are named follow-ups filed at DECOMPOSE.

### The E7 evaluation (validation criterion 2)

E7: silence must be free — cost attaches to speaking, not listening.

- An idle room member runs no turn: ambient entries accumulate against its
  cursor (`room_members.lastReadSeq`) with zero model cost. Memory changes
  nothing here — the `<agent_memory>` block is assembled only when a turn
  actually runs, i.e. when the agent has been triggered to speak. **Carrying
  memory does not make listening expensive; it makes speaking marginally more
  expensive, which is exactly where E7 wants the cost.**
- The marginal speaking cost is bounded and known: the Tier-1 block rides the
  existing system-prompt append under a hard cap (~8 KB chars ≈ ~2K tokens;
  today's append is ~15–18 KB, so worst case ≈ +13%, and it is
  prompt-cache-friendly because the block is a frozen per-session snapshot,
  Hermes-style).
- Tier 2 is pull-only (tools), so its cost is zero until the agent chooses to
  use it mid-turn — the "pull-based" arm of the ticket's E7 constraint. Tier 1
  satisfies the "small enough" arm. The design uses both arms deliberately.

### Concrete read/write mechanisms and their costs (validation criterion 3)

**Reads:**

1. **Injection (Tier 1):** `<agent_memory>` block in `buildAgentContextAppend`
   — cost ≤ the cap (~2K tokens) per turn, every surface, every runtime;
   best-effort like its sibling blocks (a failed read drops the block, never
   the turn); placed after static tool docs per the cache-placement note in
   `agent-context.ts:260-262`.
2. **Pull (Tier 2):** `search_my_history` + `list_my_conversations` MCP tools —
   SQLite FTS over the agent's own sessions and member rooms, ~15–50 ms, zero
   model tokens until results (bounded, redacted) return. Prior art: Hermes
   `session_search`; OpenClaw `sessions_history` visibility scopes.

**Writes:**

1. **Agent-authored:** a `memory` tool (append/replace/remove against the
   agent's own memory file) — model emits intent, host executes (Anthropic
   memory-tool pattern). Writes past the cap are **rejected** with a
   consolidate-first error (Hermes), which keeps the read cost provably
   bounded. Permission-tiered and injection-scanned like `config_patch` (same
   threat model: agent-writable prompt input).
2. **Automatic checkpoints:** a pre-compaction flush nudge (OpenClaw) and a
   budgeted async turn-end review (Hermes background review) — because Buzz's
   experience shows manual-only capture does not self-sustain. Cost: one cheap
   model pass per checkpoint, off the hot path, never blocking a turn
   (Hermes's 298 s wedged-provider scar → non-blocking contract).

## 6) Decisions

| #   | Decision                        | Choice                                                                                                                                                             | Rationale                                                                                                                                                             |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Resource scope                  | The agent's own directory (`.dork/MEMORY.md` beside SOUL.md/NOPE.md), agent-scoped, never session-scoped                                                           | DOR-632's proposed shape, confirmed: the identity-file seam already crosses every surface (`agent-context.ts`); Buzz keys memory by identity pair for the same reason |
| 2   | Sessions                        | Never merged; memory layer added beside them                                                                                                                       | Universal prior art; OpenClaw's collapsed scope is the cautionary tale                                                                                                |
| 3   | Storage                         | Plain markdown + existing SQLite FTS; no vector DB, no graph in v1                                                                                                 | Verbatim-beats-extracted; agentic-search convergence; user-legible and user-editable (control panel, not black box)                                                   |
| 4   | Read path (Tier 1)              | Frozen-snapshot injection via `buildAgentContextAppend`, hard cap, reject-past-cap writes                                                                          | E7 "small enough" arm; prompt-cache stability; forces curation instead of silent truncation                                                                           |
| 5   | Read path (Tier 2)              | Pull-only search/list tools over the agent's own history                                                                                                           | E7 "pull-based" arm; zero cost until used                                                                                                                             |
| 6   | Privacy boundary                | Direct-session/DM **transcripts** never auto-flow into rooms; only curated Tier-1 memory crosses, and a prompt-content test pins what a group-room prompt contains | Bridged rooms already carry third parties; OpenClaw's doc/code drift on exactly this rule shows a doc sentence is not enforcement                                     |
| 7   | Programme shape                 | This spec builds Phase 0 (session-model prompt block) + Phase 1 (Tier-1 files); Phases 2–3 filed as follow-up issues at DECOMPOSE                                  | Smallest slice that fixes the reported failure; each later phase is independently shippable                                                                           |
| 8   | Pluggability                    | MemoryProvider as seam #5 (four-rule port contract + `memoryConformance`), designed in the spec, built in Phase 3                                                  | Matches the repo's proven seam pattern; keeps v1 thin while making the swap additive                                                                                  |
| 9   | SDK auto-memory                 | Stays suppressed (`excludeDynamicSections: true`)                                                                                                                  | One memory system, runtime-neutral, DorkOS-owned                                                                                                                      |
| 10  | Session-model honesty (Phase 0) | Ship a `<session_model>` block naming what does and does not carry across sessions                                                                                 | Buzz shipped exactly this against real bugs; zero runtime cost; needed even after memory exists                                                                       |

No operator clarification was needed — the ticket's validation criteria plus
the research findings resolved every fork; assumptions are logged in §1.

**Convergence & next step:** the ideation converges on a concrete shape (per
the ticket's completion rule) → **route to SPECIFY**. The specification should
define: the exact file set and caps, the `<agent_memory>` block contract, the
`memory` tool schema and permission tier, the two automatic checkpoints, the
Phase 2 tool schemas and scope rules, the MemoryProvider port sketch, the
context-cost accounting hooks, and the test plan (X-09…X-13 probes + the
group-room prompt-content test).
