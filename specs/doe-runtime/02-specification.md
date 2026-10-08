---
slug: doe-runtime
number: 261008-052829
created: 2026-10-08
status: implemented
---

# DorkOS runtime backed by Doe

**Status:** Implemented
**Author:** Codex
**Date:** 2026-10-08

## Overview

Register the standalone Doe engine as runtime `doe`, labeled DorkOS in the app. A founder can choose it for an agent, select a model and explicit inference source, and use the same conversations, tools, memory, rooms and scheduled work as other runtimes.

## Background / Problem Statement

PR #2683 supplies a tested engine but no app entry point. The app currently assumes three production runtimes in several schemas and censuses. The engine's complete SQLite model history is distinct from the durable app display stream. Its host contracts already accept explicit paths, skills, context, tools, approvals and model billing; the missing work is platform glue, not another agent loop.

## Goals

- Implement the complete AgentRuntime contract and shared runtimeConformance with deterministic, credential-free fixtures.
- Make DorkOS available in settings and agent/runtime choices while preserving current defaults and order.
- Read project and nested AGENTS, agent AGENTS/SOUL, memory and five skill source classes directly; defer skill bodies.
- Reach every registry capability through authenticated DorkOS MCP and configured agent MCP servers with bounded eager schemas.
- Support own Anthropic/OpenAI/OpenRouter/custom keys, validated loopback local endpoints and credits in all three formats; preserve the selected bill.
- Register session listing, search, rooms, memory, schedules and usage consistently; confine engine/SDK imports.

## Non-Goals

Runtime defaults, onboarding, Runs on ordering, status-bar model item, beat scheduling, new cloud contracts, subscription-token support and new trust-by-default behavior belong to other tickets. No live paid model request is part of verification. Do not start another runtime to fetch Doe models.

## Technical Dependencies

Use the merged @dorkos/doe engine (MIT), Pi core 1.0.4 already confined inside it, existing @dorkos/shared, @dorkos/harness and test-utils contracts, SQLite/Drizzle and the platform credential and MCP services. The host dependency on @dorkos/doe must be workspace-pinned.

### Reuse table

| Capability                                 | Source / license                                     | Decision                                     | Reason                                                  |
| ------------------------------------------ | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| Loop, model transport, steering, follow-up | @dorkos/doe / MIT (Pi MIT notices retained)          | Dependency                                   | Already audited and merged, no coding persona           |
| Deferred discovery / MCP                   | Doe DeferredToolRegistry, McpConnection / MIT        | Dependency and host naming wrapper           | Fixed initial budget, connection cancellation           |
| Instructions / skills                      | Doe LocalResources; Harness discovery / MIT          | Dependency                                   | Direct sources and lazy bodies                          |
| Builder / file tools / shell               | Doe builder factories / MIT                          | Dependency                                   | Separate coding role and explicit host execution policy |
| Compaction / durable model records         | Doe SqliteModelStore / MIT                           | Dependency                                   | Lossless records separate from display history          |
| Credits / secrets                          | Existing credits resolver and credential store / MIT | Extend formats, reuse storage                | Fail closed on chosen bill                              |
| Display stream / locking / history         | Shared session services / MIT                        | Reuse                                        | Identical durable SSE behavior                          |
| Capabilities / approvals / caller ACL      | Registry and authenticated MCP injection / MIT       | Derive automatically and execute through MCP | No second permissions system                            |
| Agent identity / memory / room context     | Shared context and memory services / MIT             | Reuse neutral rendering                      | Same semantics without vendor prompts                   |
| Web fetch / beat seam                      | Doe factories / MIT                                  | Reuse host extension slots                   | No runner or new engine implementation                  |

## Detailed Design

### Runtime and lifecycle

Create small modules under `apps/server/src/services/runtimes/doe/` for facade, persistence, turn streaming, approvals, models and host resources/tools. Implement every required AgentRuntime member. Advertise only actual behavior. Persistent session metadata stores cwd, settings, title and immutable inference source/model configuration; engine SQLite stores full provider messages. Shared EventLog owns user-visible events and replay; `logBackedHistory` may be true for the display log without treating it as model context. Cold queries and `streamGeneration` must not create sessions. Scope listings and history to canonical project cwd. Locks and single-flight honor the existing session services. Stop and interrupt are bounded and report actual outcomes; no false ack while owned work is still running. Compact invokes engine compaction and maps real before/after usage. Update settings durably before returning applied/next-turn receipts. Steer/stage declare support only when queue ordering and context isolation are implemented and tested. Fork is either faithful with fresh independent storage or explicitly unsupported. Never invent internal canonical session IDs.

Boot registration precedes session broadcasters. Shutdown drains owned turns, MCP clients and stores. Factories allow offline engine injection for conformance; production uses the shipped engine. SDKs and Pi stay inside Doe package/runtime ownership, with explicit bans in every flat ESLint runtime block.

### Models, credentials and credits

Add a Zod-authoritative `runtimes.doe` configuration leaf and semver-keyed migration. Keep provider/endpoint/protocol/model metadata separate from encrypted secret references. Resolve secrets only for a request, never during module import, readiness or model listing. Reject `sk-ant-oat` before storage or network. API-key setup uses the existing credential store and provider registry, with masked responses and no key in config, event logs, history or error output. Custom endpoints must not inherit another endpoint's key. Permit no-key inference only at validated HTTP loopback local model endpoints; explicit selection remains required. Model context/output limits are explicit for custom/local models, with unknown prices left unknown.

Extend RuntimeCreditsSupport compatibly to declare supported formats and let the credits resolver choose a requested supported format. Existing single-format runtimes keep their behavior. Map platform `openai-chat-completions` to engine `openai-completions` deliberately. Mint/refresh short-lived credentials through existing credits lifecycle and refuse missing link/token/format/model, disabled credits or unavailable service without own-key/local fallback. Preserve per-session payer and compatible history family across restart and settings changes. A newly linked credits choice still follows the platform's existing consent behavior.

### Instructions, skills, tools and context

For each turn resolve canonical agent home separately from working cwd. Load project ancestor AGENTS, nested instructions before file access, own AGENTS/SOUL and memory through MemoryProvider. Rebuild per-turn context and grants; absent additionalDirectories/roomTurn means no previous grants or room routing. Use shared additionalContext and neutral room/session-model/identity/tool guidance, with exact callable tool names and opaque IDs only in server routing. Keep configured secrets outside resources.

Supply skill metadata from project `.agents/skills`, user agents skills within configured boundaries, agent-owned skills, first-party operating skills and installed plugin roots. Preserve namespace and precedence, handle installed root placeholders and load bodies only through the skill tool. Script skills use the builder helper; the business role receives no shell. Builder execution honors host permissions, canonical path grants, cancellation and explicit execution environment.

Derive DorkOS tool metadata from the capability registry's exposed MCP surfaces, including new contributions automatically; execute through `resolveDorkosMcpInjection` and its authenticated turn/agent boundary, never an unauthenticated global fallback. Use a host wrapper for stable DorkOS names and explicit alias mapping for foreign MCP. Share the existing ALWAYS_LOADED/agent-to-agent/searchHint policy in neutral code, preserving Claude exports. Own MCP tools remain deferred. Initial schema bytes must remain within the engine's fixed budget as thousands of deferred capabilities are added. Future GraphQL/query and event tools can enter the same registry without a Doe edit; do not implement DOR-2754.

### Beat host seam

Expose one runtime-owned beat operation accepting a beat prompt, isolated beat id and optional cheap preflight callback compatible with the existing decisions package. It delegates to the engine runBeat path, exposes end_beat only inside that beat, returns quiet/skipped/raises without automatically notifying anyone, and never replaces the main conversation. Tests prove preflight skips make zero model requests, quiet completion, isolated history and explicit raises. Scheduling and notification delivery remain DOR-2788.

### Platform and client

Audit every runtime universe: AgentRuntimeSchema, display names, harness mapping (Doe uses direct sources, no vendor projection), runtime readiness, usage ledgers, capability matrix, credits status/wiring, model metadata, search enumeration/copy tests, server startup and client descriptors/icons/creation/settings. Distinguish OAuth login allowlists from general runtime universes; Doe has no vendor subscription login. Client settings permit explicit provider/protocol/endpoint/model/limits and securely entered own keys, with local/credits choices and clear refusal states. Label DorkOS everywhere users see it. Preserve existing defaults and relative ordering; normal choice only. All app blocks follow the 15-word copy limit and existing FSD structure.

## User Experience

Open Settings → Runtimes → DorkOS, choose an inference source and model, then choose DorkOS when creating or changing an agent. Unconfigured runtime settings explain the required choice. Unsupported subscription tokens, missing credits and invalid local metadata produce specific short errors; the request never changes payer. Conversation history, room replies, memory and scheduled sessions use the platform's familiar flows. Do not add onboarding or alter defaults.

## Testing Strategy

- Unit: configuration/migration, masked secrets, subscription refusal before I/O, endpoint-key isolation, credits three-format selection and every existing refusal, readiness and no startup side effects, event mapping, bounded interruptions and errors.
- Integration: actual loopback exchanges for all three engine protocols; temporary SQLite restart preserving full model records, payer and display events; complete shared conformance; two independent sessions and cwd scoping; approvals/questions only when advertised; compaction and queue races.
- Resource/tool: prove each of five skill sources metadata-only before load, nested instructions before access, refreshed memory, correct home/cwd, plugin names/placeholders, scripts through builder, every neutral context block in offline model requests, registry growth with constant eager bytes and permission/caller gates through MCP.
- Platform: search/list/ledger/room/schedule regressions and capability matrix. Client settings and runtime choice tests cover correct labels, untouched defaults/order and endpoint/credential errors. Add a focused browser test if needed to establish the actual settings/choice flow.
- Mocking: inject offline models and temporary local services, never real billing flags or credentials. Each meaningful test states its purpose; no silent conformance skips from missing fixtures.

## Performance Considerations

Bound initial tool schemas using DeferredToolRegistry. Limit MCP discovery, requests and shutdown via existing engine limits. Models/credentials resolve only on demand. Display EventLog remains bounded; model SQLite is authoritative and retains complete messages across compaction. Avoid full-suite repetition after targeted verification passes, except mandatory final pnpm verify.

## Security Considerations

Keep current approval and caller gates. Trust does not extend to stranger messages or plugins. Encrypted secrets and lazy credentials never become model context. Canonical grants reset each turn; nested instructions cannot expand access. Foreign tool names cannot impersonate host tools. Credits do not fall back to another bill. Only explicit loopback endpoints allow absent keys. Owned process cleanup is scoped and bounded.

## Documentation

Add a user guide for choosing the DorkOS runtime and supported inference sources only after proof. Update adding-a-runtime census and configuration docs where the public contract changes. Add one curated changelog fragment describing tested behavior, and record implementation/review evidence in this spec folder.

## Implementation Phases

1. Shared contracts, credits/config/model credentials and platform censuses.
2. Host tool/resource/context assembly and the AgentRuntime facade, persistence and streaming.
3. Client settings/choices, cross-runtime/conformance verification, independent spec/quality review and queued PR delivery.

## Open Questions

- ~~Can the unavailable Task API block execution?~~ (RESOLVED) Answer: use canonical 03-tasks.json; rationale: explicit user authorization.
- ~~Should Doe become the default?~~ (RESOLVED) Answer: no; rationale: DOR-2783/2784 own defaults and onboarding.
- ~~Should MCP or direct registry invocation own execution?~~ (RESOLVED) Answer: authenticated MCP with registry-derived metadata; rationale: explicit brief and existing per-turn caller boundaries.

## Related ADRs

ADR 261007-230223 owns the standalone Pi core/model store decision. A new draft ADR records host ownership, authenticated tool projection and explicit payer selection.

## References

DOR-2787; merged DOR-2786 and PR #2683; research/20261007_dorkos-runtime.md; contributing/adding-a-runtime.md; shared AgentRuntime and runtimeConformance; vision context 16 and Doe prompt 15; meta/PROACTIVE-AGENTS.md and meta/agent-etiquette.md.
