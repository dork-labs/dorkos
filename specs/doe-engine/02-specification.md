---
slug: doe-engine
number: 261007-225912
created: 2026-10-07
status: specified
---

# Doe standalone engine package

**Status:** Approved
**Author:** Codex
**Date:** 2026-10-07

## Overview

Build `packages/doe` as a standalone Node agent engine for business work. Its workspace name is `@dorkos/doe`; it can later publish as `@dork-labs/doe`. The default agent owns outcomes and works through tools. Coding runs in a separate builder with its own prompt and tools. The engine is MIT, has clean exports and TSDoc, and imports no DorkOS product package.

## Background / Problem Statement

DorkOS needs an in-process engine whose prompt, tools, model credentials and storage it controls. Vendor coding products supply these together and bring a coding persona. Pi's core supplies a loop and model transports without a prompt or tools. The host's bounded display log cannot serve as model context: it omits opaque reasoning fields and trims events. Doe must retain a separate complete model history through restarts and compaction.

## Goals

- Own the complete business prompt and keep shell/code behavior in the builder.
- Reuse audited permissive code rather than rebuilding transport, loop and search primitives.
- Stream responses and tool progress, support steering/follow-up and cancellable approvals.
- Persist complete model messages, including vendor opaque fields, before reporting durable completion.
- Compact with explicit append-only checkpoints and real provider usage when available.
- Discover tools and skills on demand. Adding deferred tools must not grow the initial schemas.
- Speak Anthropic Messages, OpenAI Chat Completions and OpenAI Responses at an explicit endpoint with an explicit credential; support local compatible endpoints.
- Expose one-beat execution, a cheap pre-turn decision hook and structured quiet completion.
- Prove these through offline unit and integration tests; no ordinary test spends money.

## Non-Goals

DOR-2787 owns the DorkOS `AgentRuntime` implementation, UI, capability registry projection, memory bridge, credential storage and credits wiring. DOR-2788 owns cadence, gatherers, notification batching and the beat runner. DOR-2783 and DOR-2784 own onboarding, default choice/order and the status-bar model item. No runtime plugins, branching UI, model tier contracts or per-turn model router.

## Technical Dependencies

- `@earendil-works/pi-agent-core@1.0.4` and `@earendil-works/pi-ai@1.0.4` (MIT), pinned to the source inspected for this job.
- `@earendil-works/pi-mcp@1.0.4` (MIT), subject to confirming its versioned API matches the inspected standalone 1.1.0 client. If not, use the existing MIT `@modelcontextprotocol/sdk` transport rather than changing the loop pin.
- `typebox@1.3.27` (MIT) for Pi tool schemas; `better-sqlite3` (MIT), matching the repo's version, for model history; YAML parser matching the repo's permissive dependency for skill frontmatter.
- Development uses the repo's TypeScript, ESLint and Vitest toolchain. Emitted runtime code has no workspace product imports; packed exports resolve built files.

### Reuse assessment (before code)

Four tests apply to every selection: permissive licence; no default service reporting; in-process Node use; no forced coding persona. Model and MCP requests occur only against explicitly configured endpoints, and `web_fetch` only against a requested URL. Merely importing or constructing the engine must make zero requests and read no vendor credential directory.

| Capability               | Official/community sources checked                                                            | Licence and four-test result                                                                                                    | Decision and reason                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lazy tools/search        | Pi 1.0.4 `extensions/tool-search/tool`; Fadouse/pi-mcp; pzyyll/pi-mcp                         | Official ranker MIT, pure Node, no network/persona; Fadouse MIT but full-product extension lifecycle                            | Lift official BM25 tokenizer/ranker with notices; add host-owned activation and `searchHint`. Contrary to the prompt, current full Pi has search.                                                                  |
| MCP client               | Standalone `@earendil-works/pi-mcp`; official full-product MCP; Fadouse/pi-mcp                | Standalone MIT, explicit transports, no telemetry, no persona; full-product wrappers depend on settings/extension API           | Depend on standalone client if its pinned API passes transport tests; adapt schemas, names, cancellation and discovery. Disable stdio environment inheritance.                                                     |
| AGENTS/SOUL              | Official resource loader; pi-chat workspace instructions                                      | MIT; Node; resource loader consults vendor directories unless replaced; no built-in SOUL policy                                 | Lift applicable ancestry loading pattern; own explicit root/path resolver and SOUL loading. The host passes all roots. Load nested instructions on file access rather than every subtree into every prompt.        |
| On-demand skills         | Official `core/skills`; pi-chat skill catalogue; webcmd's `.agents/skills` placement          | Pi MIT; metadata discovery is Node/no network; official default roots are vendor-specific                                       | Lift catalogue formatting/discovery conventions with explicit roots; YAML parsing as a dependency. Load bodies only via a skill tool. Respect `disable-model-invocation`, namespaces and symlink cycles.           |
| Sub-agents/builder       | Official `examples/extensions/subagent`; Pi issue #552; pi-chat                               | MIT example launches Pi subprocesses; pi-chat adds a VM and chat service                                                        | Build the small same-process child-engine handoff. Reuse core for each child; only builder is callable initially. Host supplies builder-specific extension context/tools.                                          |
| Compaction               | Official `core/compaction/{compaction,utils}` and docs                                        | MIT, pure cut-point/estimation utilities; summary generator coupled to Pi SessionEntry/projection and coding file tracking      | Lift safe token-estimation/cut-point ideas and attributable pure code; own business summary prompt/checkpoint persistence, preserving complete tool exchanges.                                                     |
| Steering/follow-up       | Pi core `Agent.steer`, `followUp`, queue modes                                                | MIT, in-process, no service/persona                                                                                             | Dependency, not a new queue algorithm; expose normalized facade and drain dispositions.                                                                                                                            |
| Model routing/fallback   | Pi model/provider APIs; full-product model resolver                                           | MIT, all three APIs, no coding persona on API keys; full resolver also reads auth/settings                                      | Use explicit core transports; own catalog-order selection/fallback policy. Never change payer or retry after side effects/tool execution.                                                                          |
| Message store            | Official SessionManager JSONL; pi-chat channel logs                                           | MIT and local; full SessionManager owns a tree/projection, UUIDs and vendor paths                                               | Own SQLite append-only model records because research requires independent durable model storage; preserve raw JSON exactly, add checkpoint records without deletion.                                              |
| Retries/token accounting | Pi-ai retry utilities, stream usage/cost records; full-product retry controller               | MIT, Node, no telemetry/persona                                                                                                 | Depend on exported classification/backoff helpers and provider usage. Host chooses retry policy; no retry for auth/quota, aborted work or completed tool effects.                                                  |
| Web fetch                | counterposition/pi-web-search; Lincoln504/pi-research; Node fetch                             | counterposition repository GPL-3.0 fails licence test; Lincoln MIT but includes native browser/model setup and a research store | Own a small bounded fetch tool over Node fetch, with injected URL policy and cancellation. No external search service or browser dependency.                                                                       |
| Builder file tools       | Official read/write/edit/bash/grep/find plus operation injection; community coding extensions | Pi MIT; built-in tools are Node but default to unrestricted file/process behavior and TUI rendering                             | Lift independent exact-edit helpers with attribution; retain APIs for read/write/edit/search. Add explicit path policy, bounded output and clean process environment. No full-product dependency solely for tools. |

Sources were searched on npm, GitHub and the live web on 2026-10-07, then checked against published code where possible. The npm registry reports 1.1.0 as latest; upgrading beyond 1.0.4 is separate from this implementation.

### Full Pi product re-check

`createAgentSession` accepts a custom resource loader, supplied model runtime, memory settings, custom tools, `agentDir` and session manager. `customPrompt` or a forced prompt replaces the coding preamble; `noTools`/explicit tools remove coding tools. Install telemetry and CLI share/bug-report uploads are not necessary to SDK execution, so a configured SDK can pass the four tests. This corrects any blanket assertion that the full product cannot be used safely.

It still owns session projection, extension lifecycle, settings, authentication/model catalogs and cache warming. Its export map does not expose individual utility modules. Adopting it only for extensions requires those lifecycle adapters and still leaves our mandated independent SQLite model store and compaction. Choose core plus attributed extraction: smaller coupling, complete control of requests and prompt, and no duplicate state. Reconsider full-product embedding only if a runnable spike demonstrates lower total code while preserving these requirements.

## Detailed Design

### Public facade and internal port

`Doe` is configured with a durable store, session id, working directory, model configuration, context/instruction resources, tool registry and host callbacks. Export public model/message/tool/event types with TSDoc, without DorkOS imports. An internal `Engine` port isolates Pi and takes a complete prompt, model context and selected tools. Pi-specific transport and event mapping live in one module. All model transports use only explicitly supplied credentials/endpoints: refuse `sk-ant-oat` tokens before requests; never consult environment keys, vendor login files or fallback credentials.

The facade supports `run`, `steer`, `followUp`, `abort`, explicit `compact`, and `runBeat`. One active run per session; attempts to start another fail clearly. The host can supply approval decisions before tool calls; decisions wait with a cancellation signal, and abort settles pending asks. The facade never assumes a particular permission mode or new trust policy.

### Complete model history

SQLite contains session metadata and monotonic records: model messages, context checkpoints and usage. Message payloads retain every JSON field including reasoning items, thinking signatures, image blocks, tool calls/results and system/tool changes. Write message-end events before exposing completion to the host. Keep all records indefinitely unless the host explicitly deletes a session. Reject invalid session ids at the public boundary; use SQL parameters exclusively.

A checkpoint records summary, the first retained message, before/after context estimate and summary-call usage. Context restoration uses the newest checkpoint plus retained records. Archive queries still return all original messages. A failed summary or failed persistence never advances the context checkpoint. Reopen tests use a real temporary SQLite file; do not mock durability.

### Owned compaction

Trigger before a request when projected context exceeds `contextWindow - reserveTokens`; manual compaction uses the same operation. Prefer the last provider usage plus estimated trailing messages; distinguish estimated counts from provider counts. Keep recent complete user turns, including their assistant/tool result groups, and all current system instructions and active tool schemas. Summarize older context into business outcomes, decisions, promises, open work and relevant artifacts, without inventing content. A summary with error/abort/length stop is refused. Persist the checkpoint before switching the live context. Emit start/end events and one boundary with before/after tokens. Repeated compaction updates the existing summary and preserves original history.

### Tool discovery and MCP

The registry accepts arbitrary host tool descriptors and execution callbacks. Each has name, description, JSON schema, searchHint and initial-load flag. Reject duplicate/unsafe exposed names. A deterministic alias map handles MCP server qualification, length limits and collisions; contextual prompts use these exact aliases.

Initial tools include read/write, web fetch, skill loading, builder and tool search, plus the host's small always-loaded set. Fixed-budget tests add at least 1,000 large deferred schemas and prove identical initial-schema bytes, below a declared budget. Search ranks description/searchHint and activates only bounded matches for the next request; loading does not execute the tool. List/discovery output is paginated and capped, without embedding every schema in the system prompt. Deferred tools cannot be called until loaded. Optional slots accept future GraphQL/query and event tools through normal registry registration.

MCP uses the standalone client for stdio and Streamable HTTP, with explicit transport configuration, bounded connect/call timeouts, cancellation, pagination and close. Stdio gets a caller-supplied scrubbed environment, never inherited model/cloud secrets. Preserve text, image and structured results; mark MCP failures as tool errors. A local test server proves list/call/cancel/close without an outside connection.

### Instructions and skills

Paths and policy come from the host. Load ancestor `AGENTS.md` in order, agent `AGENTS.md`/`SOUL.md`, supplied memory and arbitrary host context. For a file under a nested instruction directory, add its applicable `AGENTS.md` before operating. Do not recursively load unrelated nested instructions. The host can pass project, user, agent, first-party and plugin skill roots; engine discovers them with deterministic precedence and namespace support, de-duplicates canonical files and prevents symlink cycles. Catalogue contains name/description/location only. Full bodies are returned on demand; relative script paths resolve beside that skill. The business prompt sends script execution to the builder.

### Business colleague and builder

The business prompt expresses own outcomes, goals highest first, reporting up, act/act-then-tell/ask/stay quiet, plain language, respectful interruption timing, raise-once tracking and honest uncertainty. It states only host-supplied roles, manager and goals; it never fabricates future profile features. No coding persona, shell instructions or git rituals appear in this prompt.

The `builder` tool creates a same-process child with its own coding prompt, approved directory, model/payer inherited from the host and dedicated tools. The host injects mini-app how-to and extension tools. Only its concise result returns to the parent; child progress is available as tagged engine events. Abort propagates to children and subprocesses. Builder receives no generic ability to spawn more builders recursively. File tools enforce canonical path grants and output limits. Shell is builder-only, bounded in duration/output, uses an explicit allowlisted environment and stops only its own process. Document that a folder policy around file tools is not an OS shell sandbox; the host must authorize unrestricted shell or supply an isolated executor.

### Models, retry and accounting

An explicit model descriptor supplies protocol, endpoint, id, context window, output limit and credentials callback. No hard-coded model/vendor ordering. Support all three protocols using Pi; local servers use compatible descriptors. Optional fallback descriptors must have the same payer and compatible protocol/history family. Auth/quota failures refuse, and an attempt that has emitted text or executed tools cannot replay silently. Expose substitution and retry events, account for every request including compaction/children and do not claim unavailable cost as zero. Non-model tools do not influence model token counts.

### Heartbeat seam

`runBeat` accepts a beat prompt and an optional decision callback that returns skip/run with its reason. Skip performs no full model call. A beat has fresh lightweight context from supplied changes, instructions and commitments rather than the main chat's long history. `end_beat` takes `quiet` or bounded raises with their reporting rung, records a structured result and ends the loop after the tool batch. Free beat text is never a user notification; explicit posting tools remain the host's responsibility. Persist beat records separately so they cannot replace the main conversation context. No timer, gatherer, batching service or cadence policy is implemented.

## User Experience

Part 1 is an npm library with a runnable documented example using an explicit compatible local endpoint. A host sees streaming text, thinking, tool progress, compaction, usage and terminal events. Clear errors identify missing credentials, refused subscription tokens, path violations, invalid tools and failed persistence. No DorkOS settings or default choice changes ship in this part.

## Testing Strategy

- Unit tests: prompt separation; BM25/searchHint matching; schema budget independent of deferred tool count; skill metadata versus body; instructions ancestry; path/symlink policy; unique exact edits; environment scrubbing; model/token refusal and fallback rules.
- Integration tests: scripted Pi streams exercise tool calls, lazy activation, steering/follow-up, approval cancellation, aborted tools, builder summaries and beat termination. Real temporary SQLite proves opaque message round-trip, monotonic writes, restart context, repeated compaction and failed-checkpoint recovery.
- Transport tests: local HTTP fixtures for all three model protocols, tool exchanges and reasoning preservation; local MCP server for pagination/errors/cancellation/close; network spy proves construction makes no requests and requests go only to configured destinations. No real credentials or external model calls.
- Verification: targeted tests, package build/typecheck/lint, then `pnpm verify`, followed by independent spec and code review before any PR. Each test explains the failure it protects against.

## Performance Considerations

No model call during construction or skill discovery. Initial tool schemas have a fixed byte budget; skill bodies and deferred schemas stay out. SQLite writes are batched per completed message, not text delta. Bound fetched/file/process output and tool inventories; avoid unbounded subprocess queues. Use Pi provider lazy imports. Compaction retains complete recent turns and never blocks unrelated sessions.

## Security Considerations

No inherited payer credentials or vendor login resolution. Never persist raw credentials in history, context, logs or MCP metadata. API token refusal happens before requests. Tool paths use canonical grants including symlink targets, and instruction loading must not grant access by itself. Web URLs pass host policy on redirects too. Host-owned approval hooks keep current stranger/code/front-door protections intact. Shell limitations are documented honestly; explicit execution policy is required. Ordinary tests cannot arm paid calls.

## Documentation

Package README, MIT LICENSE, THIRD-PARTY-NOTICES with upstream version/paths and licences for lifted code, TSDoc on exports, developer NOTES with protocol fixture evidence and limitations, and a changelog fragment. Package README must name the engine for developers without claiming DOR-2787 is available in the app.

## Implementation Phases

1. Package scaffolding, internal engine port and append-only model store.
2. Resource loading, registry/search/MCP and safe local tools.
3. Pi transport integration, owned compaction, builder and heartbeat seam.
4. Offline end-to-end evidence, documentation, independent review, PR and merge.

## Open Questions

- ~~Workflow display: TaskCreate/TaskList unavailable.~~ **(RESOLVED)** Dorian authorized canonical `03-tasks.json` tracking and autonomous parallel execution on 2026-10-07. All workflow stages and independent review remain required.
- ~~Can full Pi be customized enough to run a business agent?~~ **(RESOLVED)** Yes, supplied resources/tools/model runtime can remove the defaults. **Rationale:** inspected SDK options and system-prompt construction. Core remains selected because full-product lifecycle/persistence duplicates the required owned store and host responsibilities.

## Related ADRs

ADR-0307 (Pi deferred as future embedded runtime); ADR-0310 (runtime-owned storage); ADR `261006-225605` (trust direction, not permission to remove existing gates). Seed a proposed engine-boundary ADR before execution; no other architectural decisions need re-litigating.

## References

- DOR-2786; DOR-2787; DOR-2788; `.temp/vision-202610/15-codex-doe-prompt.md`.
- `research/20261007_dorkos-runtime.md`; `research/20261007_agent-teams-role-play.md`; `meta/PROACTIVE-AGENTS.md`.
- [Pi source](https://github.com/earendil-works/pi), published 1.0.4 tarballs and SDK/compaction/skills/tool-search modules.
- [Fadouse MCP extension](https://github.com/Fadouse/pi-mcp), [pzyyll MCP extension](https://github.com/pzyyll/pi-mcp), [counterposition extensions](https://github.com/counterposition/pi), [pi-research](https://github.com/Lincoln504/pi-research), [Pi subagent extraction discussion](https://github.com/earendil-works/pi/issues/552).
