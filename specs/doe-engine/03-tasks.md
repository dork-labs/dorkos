# Doe engine task breakdown

Generated: 2026-10-07T23:04:01.431985Z
Mode: full
Spec: `specs/doe-engine/02-specification.md`

Canonical source: `03-tasks.json`. Dorian authorized canonical JSON tracking and parallel implementation on 2026-10-07. Tasks 1.1 through 3.4 are complete after independent specification and quality reviews. Task 4.1 is in progress; no PR or merged completion is claimed.

Eight tasks in four phases. Dependency order: 1.1 → (2.1 and 2.2) → 3.1 → (3.2, 3.3 and 3.4) → 4.1. Each implementation writer used an isolated worktree. See `04-implementation.md` for actual coverage and review evidence.

Pi core, AI and MCP 1.0.4 APIs are proven by actual local wire fixtures. Tool schema, filesystem, subprocess, compaction and beat bounds are declared and tested. There is no open workflow-display decision. Part 2 begins only after DOR-2786 merges and closes.

### Task 1.1: [doe-engine] [P1] Establish package contracts and durable model storage

Phase: 1 — Foundation | Size: large | Priority: high
Dependencies: none
Parallel with: none

Create packages/doe as an MIT standalone Node package named @dorkos/doe, prepared for later publication as @dork-labs/doe. Follow existing Node workspace build, lint, TypeScript and Vitest patterns (packages/decisions is a reference). Register the doe Vitest project in root vitest.config.ts and update the lockfile. Emitted runtime imports must have no DorkOS product dependencies; packed export targets must resolve built files. Pin @earendil-works/pi-agent-core and @earendil-works/pi-ai to 1.0.4; use typebox 1.3.27, the repository's better-sqlite3 version, and its permissive YAML parser. Do not add the full Pi product or unaudited utility APIs. Record upstream paths, version and MIT notices for each later extraction in THIRD-PARTY-NOTICES.

Define documented public contracts for Doe configuration, explicit model descriptor (protocol, endpoint, id, context/output limits, credentials callback, payer/history compatibility), model messages, tool descriptor/callback, instruction/skill roots, path/execution policy, approval callback, cancellation, structured beat result and streaming events. Define the internal Engine port accepting a complete prompt, model context and selected tools; isolate Pi types behind that port. Establish module ownership boundaries so later resource, registry, compaction, builder and beat modules plug into the facade without simultaneous barrel/config edits. Seed the required engine-boundary ADR using the repository's timestamp identifier procedure; record the standalone core/store/host split without claiming the app runtime ships.

Implement SQLite session metadata and append-only, monotonic model-message, context-checkpoint and usage records. Preserve every JSON payload field (opaque reasoning, signatures, images, calls/results, system/tool changes); do not project history into a display transcript. Parameterize all SQL, reject invalid session ids, provide archive and restored-context queries, and delete only on explicit host session deletion. Checkpoints contain summary, first retained message, before/after count estimates and summary usage; restore newest checkpoint plus retained records while archive queries return originals. Make completed-message persistence transactional and expose failure; no write per streaming delta, no credentials in records.

Acceptance: clean package exports/typecheck/build, no runtime workspace product imports, opaque payload round-trips unchanged, monotonic records survive close/reopen, archive remains complete after a checkpoint, failed checkpoint writes leave prior restoration intact, and explicit deletion is scoped to one valid session. Tests use real temporary SQLite files, not mocked durability; test malformed ids and SQL-like ids, reasoning/image/tool records, checkpoint failure recovery and independent sessions. Construction/import must read no vendor credentials and send no requests. Maintain TSDoc on every export.

### Task 2.1: [doe-engine] [P2] Implement instructions skills and bounded local tools

Phase: 2 — Resources and tools | Size: large | Priority: high
Dependencies: 1.1
Parallel with: 2.2

Implement host-owned resource loading and local tools inside packages/doe using the foundation contracts. Paths and grants are supplied explicitly; never derive vendor roots or credentials from home directories. Assemble ancestor AGENTS.md in order, agent AGENTS.md and SOUL.md, supplied memory and arbitrary context. Before a file operation, load applicable nested AGENTS.md only for that path; do not eagerly scan unrelated instruction subtrees or grant access because instructions exist. Discover skills from explicit project/user/agent/first-party/plugin roots with deterministic documented precedence, namespaces, canonical-file deduplication and symlink-cycle protection. Catalogue only name, description and location; load bodies on demand with a skill tool, respect disable-model-invocation, and resolve relative scripts beside the skill. Tell the business agent to send script execution to builder.

Provide bounded read/write tools plus builder-only exact edit/search tools. Enforce canonical path grants for existing files, new destinations and symlink targets; reject escape attempts and never expand grants through instruction discovery. Exact editing must require a uniquely matching target rather than silently editing ambiguous occurrences. Reuse audited MIT independent edit helpers only with notices; retain no TUI/full-product lifecycle dependency. Provide web_fetch using Node fetch with host-injected URL policy checked on the requested URL and every redirect, cancellation and explicit response/output bounds. No search service or browser dependency. Export descriptors suitable for initial registry registration, without adding shell to the business tools; shell execution is implemented with builder later.

Acceptance/tests: ordered ancestry and nested-load timing; supplied memory/context preserved; unrelated nested instructions absent; namespaced skill precedence and duplicate/cyclic symlink roots; metadata excludes bodies; prohibited automatic skill invocation; relative-script resolution; read/write/new-path and symlink grant escapes; unique versus ambiguous exact edit; truncated/bounded file/search output; local HTTP fetch cancellation, redirects rejected by policy and oversized responses. Import, construction and discovery make no model or external network calls. Path, schema and fetch failures are clear tool errors. Do not alter host trust policy or app settings.

### Task 2.2: [doe-engine] [P2] Implement deferred tool registry and explicit MCP transports

Phase: 2 — Resources and tools | Size: large | Priority: high
Dependencies: 1.1
Parallel with: 2.1

Implement a host-extensible tool registry in packages/doe accepting descriptors with name, description, JSON schema, searchHint, initial-load flag and execution callback. Reject duplicate and unsafe exposed names. Add deterministic MCP-server-qualified aliases handling length limits and collisions; exact aliases must be used in discovery, execution and contextual prompts. Lift the audited Pi 1.0.4 MIT BM25 tokenizer/ranker with upstream notices; rank description and searchHint. tool_search activates only a bounded result set for the next model request and never executes found tools. Reject calls to still-deferred tools. Bound and paginate inventories; do not embed all deferred schemas in system context. Provide normal registry slots for future query/event tools without implementing those services. Initial registration includes read/write, web_fetch, skill loading, builder, tool_search and a host-supplied small always-loaded set; factory registration can complete when builder exists.

Audit the versioned @earendil-works/pi-mcp@1.0.4 exported API against the inspected standalone 1.1.0 client before adoption. If incompatible or unavailable, use the existing MIT @modelcontextprotocol/sdk transports; never change the 1.0.4 core loop pin to obtain MCP. Record which dependency/API was proven. Support explicit stdio and Streamable HTTP settings, bounded connect/call timeouts, AbortSignal cancellation, pagination and idempotent close. Stdio must receive only a caller-supplied scrubbed environment rather than process.env; ensure model/cloud secrets are absent. Preserve MCP text, image and structured results and convert failures into tool errors. No automatic vendor config discovery, credential inheritance or outside connection on import/construction.

Acceptance/tests: at least 1,000 large deferred schemas yield identical initial-schema bytes to the baseline, beneath a declared constant budget; bounded searchHint/description ranking, deterministic ties, activation-before-call, unknown names, unsafe/duplicate names and stable collision aliases; list pages capped; adding a host capability needs no engine edit. A local MCP fixture proves list pagination, call/result fidelity, tool errors, call/connect timeout, cancellation and close for each transport. A stdio fixture records its environment to prove an explicit allowlist and absent injected sentinel secrets. Test only audited actual APIs, never copied guessed signatures.

### Task 3.1: [doe-engine] [P3] Connect Pi protocols and the cancellable streaming facade

Phase: 3 — Engine behavior | Size: large | Priority: high
Dependencies: 1.1, 2.1, 2.2
Parallel with: none

Implement the Doe facade and a single Pi-specific transport/event mapping module using pinned Pi core/ai 1.0.4 through the internal Engine port. Inspect installed/published exports before using APIs. Support run, steer, followUp and abort using Pi's existing queues, exposing normalized queue/drain dispositions rather than a second algorithm. Define callable compact and runBeat delegation hooks for the dedicated modules to attach. Enforce one active run per durable session and reject overlapping attempts clearly; unrelated sessions remain independent. Assemble host resources, selected registry tools and the complete business prompt. The prompt owns outcomes, ranks supplied goals highest first, reports up, chooses act/act-then-tell/ask/stay quiet, uses plain words and honest uncertainty, protects interruption timing and tracks raise-once behavior. Include only host-supplied roles/managers/goals. No shell instructions, coding persona, git rituals or invented profile capabilities belong in this prompt.

Use explicit descriptors to support Anthropic Messages, OpenAI Chat Completions and OpenAI Responses, including compatible local endpoints, context window and output limit. Credentials come only from the supplied callback, with missing-credential validation where required; refuse sk-ant-oat subscription tokens before requests. Never inspect environment keys, vendor login files or a fallback credential. Lazy-load provider code. Implement host-selected retry policy using audited exported classification/backoff helpers. Auth/quota and aborted failures refuse retries; an attempt that emitted text or executed a tool cannot replay silently. Fallbacks require the same payer and compatible protocol/history family, with no hard-coded vendor/order selection. Emit retry/substitution events and honest usage/cost (unavailable cost remains unavailable), counting every model request and excluding non-model tool activity.

Stream text, thinking, tool progress, usage and terminal events. Await host approval decisions with cancellation before tool execution; abort settles pending approval asks and cancels running tools. Persist complete message-end records before exposing durable completion, including tool exchanges and opaque fields; persistence errors terminate clearly rather than reporting success. Never log/store credentials.

Acceptance/tests: local HTTP fixtures exercise all three protocols, streaming and tool exchanges with opaque reasoning preservation; network spy proves import/construction/discovery send no requests and configured requests go only to supplied destinations. Scripted streams verify steering/follow-up queue order/dispositions, overlapping-run refusal, approval accept/refuse/abort, running-tool abort and persistence-before-completion failures. Test subscription-token refusal before network, absent credential resolution, same-payer compatible fallback, incompatible/different-payer refusal, auth/quota refusal and no replay after text/tool effects. Prompt assertions prove business/builder separation and host-only profile facts.

### Task 3.2: [doe-engine] [P3] Implement atomic business context compaction

Phase: 3 — Engine behavior | Size: large | Priority: high
Dependencies: 3.1
Parallel with: 3.3, 3.4

Implement Doe.compact and automatic pre-request compaction in a dedicated packages/doe module using the engine and append-only store. Trigger when projected input context exceeds contextWindow minus reserveTokens. Prefer last reported provider usage plus estimated trailing messages; label estimated counts distinctly from provider counts. Manual and automatic paths share one operation. Reuse only audited MIT pure estimation/cut-point utilities with notices; do not adopt Pi SessionManager or coding-summary/session projection logic.

Choose cut points that retain recent complete user turns and all assistant/tool call/result groups, plus current system instructions and active tool schemas. Summarize older context into business outcomes, decisions, promises, open work and relevant artifacts without invention. Include the previous summary when compacting again. Error, abort and length-stop summaries are refused. Record summary-call usage as real model usage even when the operation fails. Persist the summary checkpoint, first retained message and before/after estimates before replacing live context; summary or persistence failure must preserve the previous live/restored checkpoint. Emit start/end events and exactly one successful boundary containing before/after counts. Never delete original model messages. Use facade hooks rather than rewriting unrelated resource/transport modules.

Acceptance/tests: a real temporary SQLite database supports close/reopen after compaction, repeated compaction, full original archive and restored summary plus retained records. Exercise tool groups at cut boundaries, current system/tool updates, provider versus estimate count labels, manual/automatic parity, low context limits, failed/aborted/length-stopped summary and failed checkpoint persistence. Verify no orphan calls/results, no false successful boundary, usage for summary calls and continued independence of another session during compaction. No external model call or real credentials.

### Task 3.3: [doe-engine] [P3] Implement the separate bounded builder child

Phase: 3 — Engine behavior | Size: large | Priority: high
Dependencies: 3.1
Parallel with: 3.2, 3.4

Implement the initial builder tool as a same-process child Doe engine with its own coding prompt and dedicated tools. Inherit the explicit model/payer from host-approved configuration and pass an approved working directory; inject host mini-app guidance and extension tools without importing DorkOS. Return only a concise final result to the business parent, while emitting child progress as tagged events. Builder cannot register generic recursive builder spawning or run a second builder through tool discovery. Keep child durable records distinguishable from parent context so child exchanges do not flood the business model history; account for child requests in exposed usage without double counting.

Wire resource module read/write/exact-edit/search tools and a builder-only shell tool. Shell requires an explicit host execution policy: either authorization for unrestricted shell or an injected isolated executor. File path grants alone are not an OS shell sandbox. Enforce duration/output bounds, bounded process work, an explicit allowlisted environment with no inherited model/cloud secrets, and cancellation propagated from parent to child and each process. Stop only a process started by this builder using its held process identity, never by process name or an all-process operation. Honor host tool approvals inside children. No shell/coding instruction or shell tool enters the default business prompt/toolset.

Acceptance/tests: scripted child streams prove coding/business prompt separation, host guidance/tools, payer inheritance, concise return and tagged progress. Parent abort cancels pending child approvals, tools and owned process; another fixture process remains running. Test shell missing-policy refusal, allowlisted environment using sentinel secrets, time/output bounds, isolated-executor hook, canonical path escapes and duplicate edit matches, recursion refusal and child usage accounting. Use local subprocess fixtures only, no external model requests. Document unrestricted shell honestly and avoid claiming file grants provide isolation.

### Task 3.4: [doe-engine] [P3] Implement structured isolated beat execution

Phase: 3 — Engine behavior | Size: large | Priority: high
Dependencies: 3.1
Parallel with: 3.2, 3.3

Implement Doe.runBeat as a one-beat seam in packages/doe, with a supplied beat prompt and optional decision callback returning skip/run and a reason. A skip must perform no full model request and produce a structured result. A run uses fresh lightweight context supplied as changes, instructions and commitments rather than the main conversation's long history. Reuse the business prompt principles without inventing reporting lines/profile features or changing existing host permission behavior. Provide end_beat with a discriminated quiet result or bounded raises carrying reporting rung; validate bounds and malformed inputs. End the loop after the current tool batch, preventing a second model continuation after completion. Free beat text is streamed as engine activity but never treated as a user notification. Only explicit host posting tools may notify.

Persist beat messages, usage and structured outcome separately from main chat context so close/reopen or compaction cannot replace the primary conversation. Preserve complete opaque beat messages and account for its model requests. Respect the facade's one-active-run guard, host approval decisions and cancellation. Expose reason/status in results and distinguish cancellation/failure from a valid quiet completion. Do not build timers, gatherers, notification batching, cadence policy, a heartbeat service or DorkOS runtime wiring.

Acceptance/tests: spy proves skip never calls the full model, decision reason survives; scripted streams prove quiet and bounded raises, validation, tagged beat activity, end after tool batch and no extra request; free text invokes no posting/notification; abort settles approvals/tools. Real SQLite reopen proves beat records/outcomes survive while main restored context and archive remain unchanged. Test same-session overlap rejection and independent sessions. Fixtures are offline and never use real credentials.

### Task 4.1: [doe-engine] [P4] Prove offline host flows and prepare standalone package delivery

Phase: 4 — Evidence and delivery | Size: large | Priority: high
Dependencies: 3.2, 3.3, 3.4
Parallel with: none

Complete Part 1 offline end-to-end evidence and package documentation without app/runtime registration, onboarding/default changes, cloud contracts, schedules or the future beat runner. Add a runnable example using an explicit compatible local endpoint, explicit model/credentials settings, temporary durable store, resources/tools, streamed events and close/abort cleanup. The example may make requests only when explicitly run, never during import or ordinary tests. Test a scripted local model plus local MCP host through a complete run: lazy discovery, approved tool, streaming response, full durable history, restart, compaction, builder result and isolated beat. Prove no credentials appear in history/logs/MCP metadata and no traffic escapes fixture/configured destinations. Each test states the failure it prevents; do not mirror implementation for coverage alone.

Write package README, MIT LICENSE, THIRD-PARTY-NOTICES with upstream versions/paths/licences for every extracted utility, TSDoc on all exports and developer NOTES containing fixture evidence for the three protocols, pinned MCP API/fallback decision, limits and shell execution caveat. Explain host ownership of paths, credentials, approvals, context, tools and beat notifications; cost unknowns are unknown. Name Doe for developers while clearly keeping DOR-2787 app availability and DOR-2788 service behavior outside this package. Add a timestamp-id changelog fragment following writing-for-humans and repository voice, making no unbuilt app claims. Verify built package contents/exports in a packed consumer smoke test with no workspace product dependencies or import-time network/vendor auth reads.

Run targeted doe tests, package build/typecheck/lint, root Vitest census test and pnpm verify. Confirm output before reporting success. Independently review specification compliance first, then code quality on pinned BASE_SHA..HEAD_SHA; the implementer cannot review its own work. Route fixes to originating workers and re-review affected changes. Record the complete evidence and remaining limitations for VERIFY. Use the repository creating-pull-requests/verification stages for the eventual Part 1 PR and merge; DOR-2787 begins only after Part 1 merges and DOR-2786 closes. Do not open a PR until reviews converge, bypass gates or claim completion before merge. Dorian authorized canonical JSON tracking and autonomous delivery on 2026-10-07.
