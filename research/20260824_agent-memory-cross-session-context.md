---
title: 'Agent memory across sessions, rooms and DMs — ground truth, prior art, and a recommended architecture'
date: 2026-08-24
type: architecture-research
status: active
tags:
  [
    memory,
    rooms,
    sessions,
    agent-context,
    dor-632,
    wing,
    hermes,
    openclaw,
    buzz,
    promptql,
    memory-provider,
  ]
---

# Agent memory across sessions, rooms and DMs

## The problem

A user set up an agent in a direct session, then added the agent to a channel.
In the channel, the agent knew nothing about the direct-session conversation.
This is the **designed behavior today**, not a bug: every surface an agent
appears on is a separate runtime session with no bridge between them.

This failure is already filed as **DOR-632** ("An agent re-learns the operator
from scratch in every room") and deliberately fenced off from message-search
(`specs/message-search/02-specification.md:33,73,462` — "different corpora,
different ranking, different access rules"). The litepaper names the answer as
**Wing** ("persistent memory across all agent sessions"), status: Vision, zero
code (`meta/dorkos-litepaper.md:184-195`).

This report: (1) audits what exists, (2) summarizes how Hermes agent, OpenClaw,
Buzz, PromptQL and the research literature solve it, (3) recommends an
architecture. Sources: seven parallel research passes (codebase audit; Hermes
`NousResearch/hermes-agent`; OpenClaw `openclaw/openclaw`; Buzz `block/buzz`
refresh vs. `research/20260807_room_context_delivery_buzz_and_patterns.md`;
PromptQL; memory-systems landscape; buy-vs-build library survey). External
repos read via `opensrc` caches — note the Buzz cache was **stale despite
`opensrc fetch` reporting success** (mtimes frozen at Jul 24); findings there
came from a fresh clone. Verify opensrc cache freshness before trusting it.

## Part 1 — Ground truth: what DorkOS has today

An agent in 3 channels + 2 DMs + 1 direct session holds **six disjoint
memories** — one runtime transcript each — with zero overlap.

1. **Session binding.** Rooms bind one persistent runtime session per
   `(roomId, authorId)` (`room_sessions`, `room-store.ts:1661`; bind at
   `room-trigger.ts:1296-1300`). Threads run in the channel's session; a DM is
   its own room, so its own session. The direct `/session` surface is addressed
   by URL session id and never touches `room_sessions`. The only join between
   the two worlds is `resolveRoomOrigins` (`room-store.ts:1717`) — a read-only
   cockpit label. **No bridge exists.**
2. **Room turn context is generous but room-local.** `buildRoomContext`
   (`room-context.ts:306`) pushes: up to 30 unread entries
   (`DEFAULT_AMBIENT_MAX_ENTRIES`, `packages/db/src/schema/rooms.ts:224`), 20
   gathered burst entries, roster, 5 own-recent posts, 5 reactions, 5
   channel-tail entries for thread turns, budget/addressing state. The cursor
   (`room_members.lastReadSeq`) is durable and advances at claim time
   (`room-trigger.ts:1322-1337`).
3. **Pull tools exist but can't leave the room.** `read_room_history` /
   `search_room_history` (`room-capabilities.ts:412,462`) are FTS-backed and
   membership-gated — but **no capability lists an agent's rooms**, and the
   only roomId an agent ever holds is the current one. The search index covers
   rooms only: `SEARCH_SOURCES = [roomsSource]`
   (`services/search/registry.ts:95`). Session transcripts are not indexed.
4. **No cross-session tools.** Nothing lists, searches, summarizes or resumes
   another session. Closest: `get_session_count`
   (`services/runtimes/claude-code/mcp-tools/core-tools.ts:180`) returns
   an integer.
5. **Zero memory infrastructure.** Agent dirs hold `agent.json` + `SOUL.md` +
   `NOPE.md` only (`packages/shared/src/convention-files.ts:11-12`); no memory
   file is scaffolded; `@dorkos/harness` projects instructions only. The
   claude-code adapter **actively suppresses** the SDK preset's auto-memory
   section (`launch-resolver.ts:268-271`, `excludeDynamicSections: true`, per
   ADR-0273 A2). The `memory_recall` event is a UI display passthrough
   (`specs/memory-recall-indicator/`), nothing more.
6. **What IS shared across an agent's sessions:** its identity files. Every
   turn on every runtime injects `<agent_identity>`, `<agent_persona>`
   (SOUL.md), `<agent_safety_boundaries>` (NOPE.md), `<user_profile>`, `<env>`
   (`agent-context.ts:269`, blocks built at `:188`) — because they key off the agent's `cwd`, not
   the session. **This is the seam a memory block slots into.**
7. **No context accounting.** The system-prompt append runs ~15–18 KB (~4–5K
   tokens) per turn; the room context block can add 2–15 KB. Every bound is a
   hardcoded entry/char cap; nothing measures or budgets tokens
   (`contextTokens` is post-hoc display only —
   `decisions/260717-125124-fleet-context-health.md`).
8. **The seam pattern is ready.** Four swappable ports exist (AgentRuntime,
   Transport, ConnectorProvider, CommunityAdapter) with conformance suites in
   `@dorkos/test-utils` and a written four-rule port contract
   (`community-adapter.ts:14-33`). A `MemoryProvider` would be **seam #5**.
9. **The eval template is ready.** `packages/evals/src/suite/rooms-recall.ts`
   (X-01…X-06 + restraint + injection) probes comprehension of the current
   room's context. Nothing probes cross-session or cross-surface recall.
10. **The only shipped "memory" pattern is /flow's** — externalize state to
    files, fresh session per issue, "the model is amnesiac by design"
    (ADR-0280). It lives in the marketplace plugin, not the product.

## Part 2 — Prior art (what the seven passes found)

### Hermes agent (Nous Research) — three tiers, cleanly separated

- **Tier 1: curated always-loaded files.** `MEMORY.md` (agent notes, hard cap
  2,200 chars ≈ 800 tokens) + `USER.md` (user profile, 1,375 chars ≈ 500
  tokens), injected into the system prompt at session start as a **frozen
  snapshot** (mid-session writes hit disk but not the live prompt — preserves
  prompt cache). Writes past the cap are **rejected**, forcing the agent to
  consolidate. Scoped **per profile (identity), not per session** — identical
  across CLI and 20+ chat platforms. Injection-scanned before accept
  (`tools/threat_patterns.py`).
- **Tier 2: zero-LLM-cost transcript search.** All sessions in one SQLite
  (`~/.hermes/state.db`) with FTS5 (+trigram). A `session_search` tool:
  discovery (top-N sessions, snippet + first/last-3 "bookends" + ±5 window),
  scroll, browse. 15–50 ms, no model call. The system prompt tells the agent
  to use it whenever the user says "we discussed this before."
- **Tier 3: one optional external provider** behind a `MemoryProvider` ABC
  (8 plugins: Mem0, Honcho, Hindsight, holographic w/ decay half-life, …),
  prefetch-injected per turn in a fenced block; `sync_turn()` must be
  non-blocking (a wedged provider once stalled turns ~298 s).
- Session keys: `agent:main:{platform}:{chatType}:{chatId}[:{userId}]` —
  groups per-user-isolated by default. Transcripts never shared across
  surfaces; only Tiers 1/3 and `session_search` cross.
- Known weak spot = our hard case: single `USER.md` assumes one human;
  multi-human identity mapping is provider-level and manual.

### OpenClaw — same shape, plus the scars

- Sessions: DMs collapse to one main key (configurable `dmScope`), groups
  **always isolated** per channel. Docs: "true isolation requires one agent per
  person."
- Memory = the **agent workspace**, shared across every session of that agent:
  bootstrap files in fixed order (`AGENTS.md` → `SOUL.md` → `IDENTITY.md` →
  `USER.md` → `TOOLS.md` → `BOOTSTRAP.md` → `MEMORY.md`,
  `src/agents/system-prompt.ts:69-77`) with hard caps
  (`bootstrapMaxChars` 20K/file, 60K total, truncation warnings), plus
  `memory/YYYY-MM-DD.md` daily notes that are **search-only, not injected**.
- `memory_search`: hybrid FTS5 (BM25) + sqlite-vec, ~400-token chunks,
  30-day-half-life time decay (MEMORY.md itself never decayed), 10 embedding
  providers incl. fully local; keyword-only works with no embedding key.
  Transcript indexing is a separate opt-in.
- **Cross-session peeking is an explicit tool**: `sessions_list` /
  `sessions_history` with visibility scopes `self → tree (default) → agent →
all`, redacted and bounded.
- **Pre-compaction memory flush**: a silent turn before compaction reminds the
  agent to write important context to memory files. Community-caught gap: no
  flush on gateway shutdown.
- **Dreaming** (opt-in cron): stage/dedupe → reflect → score (frequency 0.24,
  relevance 0.30, diversity 0.15, recency 0.15, …) → promote into MEMORY.md;
  human-reviewable `DREAMS.md`.
- Pluggable via two slots (`plugins.slots.memory`, `plugins.slots.contextEngine`)
  with quarantine-and-fallback failure isolation.
- **Scars to avoid:** MEMORY.md became a "token bomb" before caps (issues
  #50096/#26949/#24624); a `lightweight` context flag silently didn't strip
  context for months (#66060 — 5-10x bloat); docs claimed MEMORY.md is not
  loaded in group sessions but **no code enforces it** (doc/code drift on a
  privacy-relevant scoping rule); flat chunk search criticized for no
  entity/relationship structure and no provenance; a real security failure ran
  the other direction — the shared main DM session leaked one user's env/API
  keys to other users (Giskard audit).

### Buzz (block/buzz) — the (agent, owner) key, and honest prompts

Refresh of `research/20260807_room_context_delivery_buzz_and_patterns.md`
(~400 commits since; room-context delivery unchanged in shape; the durable
per-agent read cursor is still absent and now **explicitly deferred in
writing** — PR #5423: "durable process-restart/session resume remains out of
scope").

- **NIP-AE engrams give Buzz agents real cross-channel memory.** Encrypted
  Nostr events keyed by **(agent, owner) pair — never by channel or session**:
  one `core` profile (~10KB budget, 64KB hard cap) **pushed once per new
  session**, plus cold `mem/<slug>` entries that are **pull-only by exact
  slug**. Agent-written only, via `buzz mem set/patch/rm` mid-turn.
- Fetch is fail-open with three distinct outcomes (found / confirmed-absent /
  unknown-due-to-error) — an error never renders the "you have no memory"
  onboarding path, so a slow relay can't cause real memory to be overwritten.
- **No search, no ranking, no decay over cold memory** — the spec itself names
  the resulting "orphan" problem and punts it. Memory-writing survives only by
  repeated prompt nagging — evidence manual capture doesn't self-sustain.
- **`## Session Model` prompt section** (added 2026-08-04, zero runtime code):
  "You are one per-channel session of your agent identity… Sessions share your
  core memory, your workspace on disk, and the relay. They do NOT share
  conversation context." Fixed real bugs (sessions claiming ownership of other
  sessions' work). Cheapest possible mitigation; ship the analog regardless of
  architecture.
- Standing context (base/system/team/memory-core/canvas) moved from
  resend-every-turn to **once per session** after measuring the waste.

### PromptQL — plan-and-compute, and its own retreat to a curated wiki

- Mechanism: the LLM writes an inspectable query plan; deterministic
  Python/SQL executes it **outside the context window**; intermediate results
  live in named artifacts; only small exact slices return to context.
  Self-published FRAMES numbers (~100% vs ~60% agentic RAG) are vendor-run;
  no independent replication found.
- The paradigm's strongest independent support: Claude Code removed its vector
  DB for agentic grep search; Amazon Science measured keyword-search agents at
  94.5% of RAG faithfulness with zero vector store; Chroma's "context rot"
  shows large injected context is itself a reliability liability; Berkeley DAB
  finds agents "select the right data but fail at planning the computation."
- **Most telling:** PromptQL's own Slack "shared brain" product (PromptQL Tag)
  is a **human-reviewed, curated wiki of decisions** layered over message
  history — even the plan-and-compute vendor didn't trust raw querying for
  conversational recall.

### Literature and benchmarks (selected)

- **Generative Agents** (Park 2023): retrieval = recency × importance ×
  relevance + periodic reflection writing summaries back into the stream.
- **MemGPT/Letta**: core (in-context, agent-edited blocks — shareable across
  agents) / recall (full history, searchable) / archival (cold store);
  sleep-time agents do consolidation off the hot path.
- **Verbatim-beats-extracted** (arXiv 2601.00821): raw chunks beat
  LLM-extracted "facts" on retrieval quality — extraction is lossy.
- **Anatomy of Agentic Memory survey** (arXiv 2602.19320): MemoryOS = 32 s
  user-facing latency; A-MEM = 15 h index build; "complexity does not
  guarantee performance"; benchmark saturation warning (big context windows
  solve many benchmarks with zero memory system).
- **Benchmarks are untrustworthy**: LoCoMo audited at 6.4% wrong answers, an
  LLM judge accepting 63% of wrong answers, and a prompt that forbids "I don't
  know"; Mem0-vs-Zep is an open methodology dispute. Build a small internal
  eval instead (we already have the `rooms-recall` template).
- **Scoping prior art**: Mastra's two orthogonal keys (thread-scoped history +
  `resourceId`-scoped private working memory that follows a person across
  threads, invisible to other participants); Letta's explicit per-block
  attachment (default-deny sharing); Anthropic's API memory tool = model emits
  file-op intents, **host owns storage** (subclassable backend — the cleanest
  pluggability pattern found).

### Buy vs build (library survey verdict)

**Nothing solves cross-surface conversational memory out of the box.** Every
candidate solves storage+retrieval; none ships the scoping/write-policy layer
(whose memory, which surfaces read it, what a private fact may do in a shared
room). Ranked fits for our constraints (TS/Node, local-first, SQLite,
permissive license, no mandatory embedding key):

1. **Build thin** on existing SQLite/Drizzle + FTS5; pure-JS extras when
   needed (Orama or vectra; `transformers.js` local ONNX embeddings) — no
   native-module pain for Electron packaging.
2. **`mcp-memory-service` (doobidoo)** — Apache-2.0, MCP-native sidecar,
   SQLite-vec + local ONNX by default, decay/consolidation built. Cleanest
   "buy" as an optional provider behind our seam, not the core.
3. **claude-mem** — Apache-2.0, huge adoption, SQLite+FTS5+local-embedding;
   Claude-Code-hook-native, so an architecture reference (and possibly a
   claude-code-runtime-only integration), not a multi-runtime core.
4. Supermemory self-host (MIT, TS, Ollama) — pending a maintenance check.
5. Hindsight (MIT, Claude-first tooling) — re-verify activity.

Disqualified: Zep CE (dead), Graphiti (Python + graph DB server), LangMem
(Python-only; BaseStore JS is an empty interface), Letta (server+Postgres,
heavy for one operator), Basic Memory + Honcho (**AGPL**), Redis memory server
(Redis dependency, AGPL history), Memori (license unconfirmed),
`@modelcontextprotocol/server-memory` (toy-grade, no semantic recall, open
reliability bugs).

## Part 3 — The convergent architecture

Four independent production systems (Hermes, OpenClaw, Buzz, Letta) plus
PromptQL's own product retreat landed on the same three-tier shape:

| Tier                            | What                                                                           | Scope                             | Cost model                                | Who has it                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1. Curated always-loaded memory | Small, hard-capped notes (facts, preferences, lessons), injected every session | **Agent identity, never session** | Fixed, known, ~0.5–2K tokens              | Hermes MEMORY/USER.md · OpenClaw workspace · Buzz `core` engram · Letta core blocks · PromptQL wiki |
| 2. Searchable raw history       | Verbatim transcripts + room logs, FTS-indexed, explicit search/browse tools    | Per conversation (stays put)      | Zero until used; ms-latency; no LLM calls | Hermes `session_search` · OpenClaw `sessions_history`/`memory_search` · Buzz `messages search`      |
| 3. Optional smart provider      | Vector/graph/consolidation/decay backends behind a pluggable seam              | Provider-defined                  | Paid, async, off the hot path             | Hermes provider ABC (8 backends) · OpenClaw slots · Letta archival · MCP sidecars                   |

Sessions are **never** unified across surfaces — everyone keeps transcripts
surface-scoped and shares the memory layer instead. Tier 1 fixes the reported
scenario by construction; Tier 2 answers "what exactly did we say"; Tier 3 is
where experimentation lives.

## Part 4 — Recommendation

### Principles

- **Memory is agent-scoped; history is conversation-scoped.** Fix DOR-632 by
  adding the missing agent-scoped layer, not by merging sessions.
- **Default-deny across the privacy boundary.** Rooms contain other people
  (and bridged third parties via Telegram/Slack projections). Direct-session
  and DM _transcripts_ never auto-flow into rooms; what flows is the curated
  Tier-1 memory, which has an explicit visibility model (below). Test the
  assembled prompt, not the doc claim (OpenClaw's drift lesson).
- **Files + SQLite first, vectors later, graphs probably never.** Evidence:
  verbatim-beats-extracted, agentic-search convergence, overhead numbers.
  Plain markdown memory is user-legible and user-editable — control panel, not
  black box (brand fit).
- **Model emits intent; host owns storage** (Anthropic memory-tool pattern).
  Small fixed tool surface; backends swap behind it.
- **Capture must be automatic at checkpoints**, not only agent-initiated
  (Buzz's nagging lesson): pre-compaction flush + turn-end background review,
  async, never blocking a turn (Hermes's 298 s scar).
- **Hard token cap from day one, measured** (OpenClaw's token bomb). Frozen
  snapshot per session for prompt-cache stability (Hermes).

### Phase 0 — honesty prompt (1 day, ship immediately)

Add a `<session_model>` block to the system-prompt append (beside
`<agent_identity>`, `agent-context.ts`): "You are one session of this agent.
Other sessions of you exist in other rooms and direct chats. They share your
identity and memory files; they do NOT share this conversation." Include the
current surface (room name/kind or direct). Zero-risk, fixes the
worst confusion class today, validated verbatim by Buzz.

### Phase 1 — Tier 1: agent memory files (the DOR-632 fix)

- Scaffold `.dork/MEMORY.md` (and optionally `memory/` notes) beside SOUL.md /
  NOPE.md via `convention-files.ts`; project with the harness like the others.
- Inject as `<agent_memory>` in `buildAgentContextAppend` — it already runs on
  **every turn of every surface and runtime**, which is exactly why the fix is
  cheap: the seam exists (`agent-context.ts:269`). Hard cap on injection
  (start ~8 KB chars ≈ 2K tokens; reject-past-cap on writes like Hermes, or
  truncate-with-warning like OpenClaw — prefer reject: it forces curation).
- Write path: a `memory` tool (append/replace/remove on the agent's own
  files), host-executed, permission-tiered like `config_patch` (it is
  agent-writable prompt input — same injection threat model; scan writes).
- Automatic capture: (a) pre-compaction flush nudge (claude-code emits
  `compact_boundary`; opencode too); (b) turn-end async review for room turns
  ("anything durable learned? write it"), budgeted and quiet.
- **Visibility v1:** one file, agent-scoped, injected everywhere — with a
  written rule in the memory tool description: operator-private facts
  (credentials, personal details) belong in `MEMORY.md` only if safe to
  surface in ANY room the agent joins; bridged rooms exist. **Visibility v2**
  (if needed): split `MEMORY.md` (everywhere) from `PRIVATE.md` (direct
  sessions + operator-only DMs), enforced in the context builder and pinned by
  a test that asserts the assembled group-room prompt excludes it.

### Phase 2 — Tier 2: cross-session search tools

- Index session transcripts into the existing search registry
  (`SEARCH_SOURCES`, currently rooms-only) — claude-code JSONL and the
  event-log-backed runtimes both have readable history (`transcript-reader.ts`).
- New capabilities: `list_my_conversations` (the agent's rooms + its own
  sessions, titles + recency — closes the "no rooms.list" gap too) and
  `search_my_history` (FTS across its own sessions + member rooms, bounded,
  redacted like OpenClaw: strip credential-shaped text, cap sizes, flag
  truncation). Zero LLM cost, ms latency, no embeddings needed.
- Scope rule: an agent searches only **its own** sessions and rooms it is a
  member of (joinedSeq-floored, same as `search_room_history`).
- Teach it in `<session_model>`: "when someone references a past conversation
  you don't see here, search your history."

### Phase 3 — Tier 3: the MemoryProvider seam (the pluggability answer)

- `packages/shared/src/memory-provider.ts` — seam #5, built by the
  four-rule port recipe (`community-adapter.ts:14-33`): Zod-first, every
  method required, typed `MemoryUnsupportedError`, no credentials across the
  port, capability flags.
- Minimal surface (the converged 4-op interface): `write`, `query`, `forget`,
  plus async `consolidate` off the hot path; namespaced
  `[agentId, scopeType, scopeId]` keys (LangGraph BaseStore pattern).
- `memoryConformance` in `@dorkos/test-utils` + `fake-memory-provider`.
- Backends: **builtin** (the Phase 1–2 files + FTS — default, zero-config);
  **hybrid** (adds sqlite-vec or Orama + local ONNX embeddings for paraphrase
  recall, RRF-fused); **MCP sidecar** (e.g. `mcp-memory-service`) for
  experiments. Single active provider per agent (Hermes/OpenClaw precedent),
  quarantine-and-fallback on failure (OpenClaw), non-blocking sync contract
  (Hermes).
- Decay lives here: ranking-time recency weighting (30-day half-life on notes,
  never on MEMORY.md) and a Dreaming-style opt-in consolidation cron that
  promotes note patterns into MEMORY.md with human-reviewable output. Storage
  is never lossy — transcripts stay verbatim; decay affects retrieval ranking
  and injection, not truth.

### Context-cost accounting (crosscutting, currently absent)

Injected-context size is unmeasured today (§1.7). With memory added, ship:
per-block char counts on the launch debug surface, a hard cap on
`<agent_memory>`, and extend fleet-context-health to show "memory share of
context." A "lightweight" or capped mode must be pinned by a test that
measures the assembled prompt (OpenClaw #66060).

## Part 5 — Testing (chat-capabilities + evals)

`meta/chat-capabilities.md` §7 probes recall of the current room only
(X-01…X-08). Cross-surface memory has no capability row and no probe — added
as §7.1 (named gaps) alongside this report. Proposed probes, built on the
`rooms-recall` eval pattern:

| ID   | Probe                                                                                             | Verifies                                    |
| ---- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| X-09 | Tell the agent a fact in a direct session; ask for it in a channel the agent was later added to   | Tier 1 memory crosses surfaces (DOR-632)    |
| X-10 | Ask in a channel about a conversation that happened in another room the agent is a member of      | Tier 2 `search_my_history` / list tools     |
| X-11 | Seed an operator-private fact in a direct session; probe for it in a bridged/group room           | **Negative**: privacy boundary holds        |
| X-12 | Fill memory past its cap; verify the agent consolidates and the injected block stays under budget | Cap enforcement + curation behavior         |
| X-13 | "When/where did we decide X?" across two rooms                                                    | Provenance-aware recall, honest "not found" |

X-11 also needs a deterministic e2e twin that asserts the **assembled
group-room prompt** excludes private memory (the OpenClaw doc/code-drift
lesson: privacy scoping must be pinned by a prompt-content test, not prose).

## Open questions

1. **Whose memory in a multi-human room?** Tier 1 is (agent)-scoped; Buzz keys
   by (agent, owner). Single-operator today makes these equivalent, but
   bridged rooms already introduce third parties; communities will make it
   worse. Likely answer: keep Tier 1 (agent, operator)-scoped and treat
   other-human facts as ordinary notes with provenance, revisit at
   multi-operator.
2. **Suppressed SDK auto-memory** (`excludeDynamicSections`): keep suppressed
   (one memory system, ours, runtime-neutral) — revisit only if the SDK's
   memory tooling becomes substantially better than what we build.
3. **Embeddings**: defer entirely until an eval shows FTS missing
   paraphrase-recall cases (X-13-style probes will tell us). Local-only
   (transformers.js/Ollama) when added — no OpenAI-key dependency.
4. **DM vs direct session for Tier-1 injection**: inject everywhere from day
   one (that's the point), but the v2 PRIVATE.md split may want DM-with-
   third-parties treated as "room," not "private."
5. **Naming**: this is plausibly the first shippable slice of **Wing**. If so,
   the litepaper's honesty rule applies — no "Wing" branding until it exists.
