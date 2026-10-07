---
title: 'The DorkOS runtime: which agent engine to build on, and the plan to ship it before launch'
date: 2026-10-07
type: internal-architecture
status: active
tags:
  [
    agent-runtime,
    dorkos-runtime,
    pi,
    vercel-ai-sdk,
    mastra,
    openai-agents-sdk,
    langgraph,
    claude-agent-sdk,
    opencode,
    credits,
    vendor-terms,
    vision-202610,
  ]
---

# The DorkOS runtime: which agent engine to build on, and the plan to ship it before launch

**Date:** 2026-10-07. **Asked by:** Dorian, after deciding that new users must be able to use DorkOS with no Claude, ChatGPT or OpenRouter subscription, on DorkOS's own runtime, before launch (vision brief item 19).

**How this was made.** Two passes over this repo (the runtime contract, the four runtimes, credits, the status bar), two passes on the live web (agent frameworks, vendor terms), and a hand check of the facts the recommendation leans on hardest: the npm registry for every candidate (`npm view`, 2026-10-07), the GitHub API for Pi, the unpacked Pi 1.0.4 packages, and a fresh fetch of Anthropic's Claude Code legal page. It builds on `research/20260405_pi_coding_agent_and_local_model_frameworks.md`, `research/20260405_ai_coding_agent_runtime_landscape.md`, `research/anthropic-tos-compliance.md` and `research/20261006_agent-computer-bootstrap-and-vendor-logins.md`. Nothing from the private cloud repo is used.

**Companion report:** `research/20261007_one-minute-onboarding.md` (the first-run path that this runtime powers).

---

## The answer in one paragraph

Build the DorkOS runtime on **Pi's two library layers, `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` (MIT, version 1.0.4)**, wrapped by our own `AgentRuntime` adapter, our own tools, our own storage (a message store for the model, the DorkOS event log for display) and our own compaction. Pi's model layer already speaks all three request formats our credits endpoint serves (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses), and its agent loop already has the three hooks our contract needs: a steering queue (mid-turn messages), a before-tool-call hook (approvals) and a context transform (compaction). The loop itself is about 1,100 lines of compiled JavaScript, small enough to read in an afternoon and to fork; the model layer under it is bigger (about 19,000 compiled lines) and is the part we would swap rather than fork. The runner-up is the **Vercel AI SDK** (Apache-2.0); it is the fallback if Pi's stewardship goes wrong, and because our adapter hides the engine, switching later costs one module, not the runtime. **Size:** about 14,000 to 20,000 lines of product code plus a similar amount of tests, roughly **4.5 to 5.5 weeks** for the runtime alone with a small agent team starting 2026-10-12. Together with the onboarding work and the Cloud card page it is a **6 to 7 week programme**, so a mid to late November launch only holds with the cut line in section 4.4. **The terms picture is better for our own runtime than for what ships today.** Anthropic's Commercial Terms expressly allow using Claude "to power products and services Customer makes available to its own customers and end users", so our runtime on credits is on firm ground. But Anthropic's Claude Code page forbids a company paying for Claude Code usage on its end users' behalf, and DorkOS ships exactly that today (Claude Code on DorkOS credits). Three decisions for Dorian follow (section 6).

---

## 1. What "our own runtime" has to plug into

A runtime in DorkOS is one TypeScript interface plus a set of shared tests. The facts below decide which engine fits.

### 1.1 The contract

- `AgentRuntime` (`packages/shared/src/agent-runtime.ts:1243-2206`) has about 38 required members and about 30 optional ones. The required part is mostly session lifecycle, one streaming call (`sendMessage` returns an async generator of events), compaction as a command (`executeCommandIntent(id, 'compact')`), approvals, bounded interrupts that return a receipt, storage reads, locking, and an honest list of capabilities.
- Everything advanced (steer and stage, a warm process between turns, background work, accounts, MCP status, plugins) is optional and switched on by capability flags (`RuntimeCapabilities`, `agent-runtime.ts:589-797`).
- The stream is a 45-member event union (`StreamEventTypeSchema`, `packages/shared/src/schemas.ts:178-222`). The rules that matter: exactly one `done` per turn, errors are typed events that do not end the turn, text arrives as deltas, a dead credential shows up as an `error` event with category `auth_error`, and every reply carries `session_status` with real context token counts (conformance RT-CMP-03).
- The `runtimeConformance` suite (`packages/test-utils/src/runtime-conformance.ts`, 4,358 lines, about 80 cases in 18 groups) gates every runtime. It covers session lifecycle, stream shape, presence, interrupts, the steer/queue/stage dispositions, compaction (RT-CMP-01 to 03), durable history, folder grants, credential failures and the credits negatives.
- The checklist is `contributing/adding-a-runtime.md` (724 lines): facade plus pure event mapper, ESLint confinement of the engine package, a `runtimes.<name>` config block with a migration, registration before the session-list broadcaster, a client descriptor and icon, `checkDependencies`, and a column in the capability matrix.

### 1.2 What the platform already gives a new runtime

This is why an own runtime is a few weeks of work and not a few months:

- **The queue, the durable SSE stream, the projector and display history are server-side.** A runtime sets `logBackedHistory: true` and the app's chat history comes from the DorkOS event log in SQLite (`session_events`); `test-mode`, Codex and OpenCode already ride it. **But the event log is not a model transcript.** It holds stream events (text deltas, tool cards), it is trimmed to a per-session cap (`EVENT_LOG_MAX_EVENTS`, `packages/db/src/schema/session-events.ts:8-12`), and Codex and OpenCode use it only for display; their model context lives in the vendor's own store. Our runtime has no vendor store, so it needs its own (section 4.2). Under ADR-0310 that is fine: storage is runtime-owned.
- **Every DorkOS tool comes through one MCP connection.** Codex and OpenCode reach all of DorkOS (about 88 verbs: rooms, canvas, browser, memory, `compact_my_session`, connections) through a loopback Streamable-HTTP MCP server with per-turn credentials (`apps/server/src/services/runtimes/shared/dorkos-mcp-injection.ts`). An own runtime needs only an MCP client. The repo already depends on `@modelcontextprotocol/sdk`.
- **Credits plug in by declaration.** A runtime declares `credits: { protocol, scope }` and calls `resolveCreditsLaunch` (`apps/server/src/services/core/cloud/credits-inference.ts:401-428`). The model gate, the protocol-filtered model menu, the Runs on settings section and the conformance negatives all follow from that one declaration.
- **The credits endpoint speaks vendor formats verbatim.** `packages/cloud-api/src/inference.ts:32-46`: `anthropicMessages`, `openaiChat`, `openaiResponses`. The minted token lists which formats it serves (`served`, absent means Anthropic only). The model catalog already carries `recommendedOn` (`inference.ts:147`), the service's suggested starting model per format, which is exactly the hook an "auto-pick" needs.

### 1.3 Things an in-process runtime does better than the three we have

- **The short-lived credits token is not handed to a child process.** Claude Code gets it as `ANTHROPIC_AUTH_TOKEN` in its environment; Codex and OpenCode get it through a loopback relay (`credits-relay.ts`, ADR 261002-221210). ADR 261001-000811 admits that code a credits turn runs can read the token. An in-process loop holds it in the server's memory. **This is a smaller gain than it sounds:** the long-lived link credential that mints those tokens (`cloud.instanceToken`, `packages/shared/src/config-schema.ts:3552`, listed in `SENSITIVE_CONFIG_KEYS`) sits in `~/.dork/config.json`, which any shell command the agent runs can read. Approved mini-app server code also runs inside the server process (ADR-0213), and the person's own MCP servers and skill scripts are subprocesses too. Real isolation needs the credential in the OS keychain or an OS sandbox around tools; that is a separate piece of work (section 4.6).
- **No 480 MB of bundled binaries is needed for the default path.** Today `npm i -g dorkos` pulls the Claude Code binary (about 207 MB on darwin-arm64) and the Codex binary (about 277 MB). With an own default runtime, those can become optional, on-demand downloads for people who pick "use my own sign-in" (see the onboarding report).
- **Approvals are trivial.** The runtime owns the loop, so an approval is "pause the tool, emit `approval_required`, resume on `approveTool`".

### 1.4 What we must build that the vendor runtimes give us for free

The agent loop and its tools (read, write, edit, shell, grep, glob, web fetch), permission enforcement inside those tools, compaction, sub-agents, loading `AGENTS.md` and skills (Harness Sync today projects `.agents/` into vendor folders, `packages/harness/src/vendor/`), prompt caching, retries and token accounting. The engine choice decides how much of this list is already done.

### 1.5 Hard-coded lists that name the three runtimes

These must learn a fourth entry (found outside the guide): `RUNTIME_DISPLAY_NAMES` and `LOGIN_RUNTIME_TYPES` (`agent-runtime.ts:390-435`), `CloudCreditsStatus.runtimes` (`packages/shared/src/cloud-schemas.ts:263`), `creditsWiringReport` (`credits-inference.ts:471-491`), `AgentRuntimeSchema` (`packages/shared/src/mesh-schemas.ts:36`). Also `deriveRuntimeReadiness` finds the "binary installed" check by looking for the word `CLI` in its name (`agent-runtime.ts:470-474`); an in-process runtime must name a check so it reads as installed, or better, the readiness rule learns that some runtimes have no binary.

### 1.6 Prior decisions

ADR-0307 picked OpenCode and Codex as the second and third runtimes and deferred Pi, calling it the leading candidate for a future embedded or native runtime, for example one powering DorkBot. The April report recommended a `PiRuntime` on `pi-agent-core` over Mastra, LangGraph and a hand-rolled AI SDK loop. Nothing on file proposes Mastra, the AI SDK, the OpenAI Agents SDK or LangGraph as a runtime.

---

## 2. The candidates

Versions and licences below are from `npm view` on 2026-10-07 unless marked.

| Candidate                                                | Licence                                                       | Version            | Shape                                   |
| -------------------------------------------------------- | ------------------------------------------------------------- | ------------------ | --------------------------------------- |
| Pi: `@earendil-works/pi-ai` + `pi-agent-core`            | MIT                                                           | 1.0.4 (2026-10-05) | npm libraries, in-process               |
| Pi: `@earendil-works/pi-coding-agent` (the full product) | MIT                                                           | 1.0.4              | in-process SDK or subprocess (RPC mode) |
| Vercel AI SDK `ai` + `@ai-sdk/mcp`                       | Apache-2.0                                                    | 7.0.130, 2.0.69    | npm libraries, in-process               |
| Mastra `@mastra/core`                                    | Apache-2.0 core, separate Enterprise licence for `ee/`        | 1.75.0             | framework, in-process                   |
| OpenAI Agents SDK `@openai/agents`                       | MIT                                                           | 0.19.0             | npm library, in-process                 |
| LangGraph.js `@langchain/langgraph`                      | MIT                                                           | 1.4.20             | graph library, in-process               |
| Claude Agent SDK `@anthropic-ai/claude-agent-sdk`        | "SEE LICENSE IN README.md" (Anthropic terms, not open source) | 0.3.292            | spawns the Claude Code binary           |
| OpenCode `@opencode-ai/sdk`                              | MIT                                                           | 1.18.35            | client for a separate server process    |

### 2.1 Pi (Mario Zechner, now Earendil)

- **Who and how healthy.** Built by Mario Zechner as `badlogic/pi-mono`; Armin Ronacher's company Earendil acquired it in April 2026, with Zechner staying on ([Ronacher, 2026-04-08](https://mitsuhiko.spicytakes.org/post/2026-04-08-mario-and-earendil)). Earendil committed in [RFC 0015](https://rfc.earendil.com/0015/) that the core stays MIT, with commercial add-ons licensed separately. The repo (`earendil-works/pi`, GitHub API 2026-10-07) has 113,130 stars, 100+ contributors, 283 open issues and a push the same day. It reached 1.0 on 2026-10-02 ([The Register](https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678)). OpenClaw embeds Pi as its agent runtime, so "Pi inside someone else's product" is proven.
- **Layers.** `pi-ai` (model calls) → `pi-agent-core` (the loop) → `pi-coding-agent` (the full CLI product: tools, sessions, compaction, extensions, skills, a TUI, MCP via "Codemode").
- **Model layer (checked in the 1.0.4 package).** `pi-ai` supports, among others, the API types `anthropic-messages`, `openai-completions` and `openai-responses`, with a per-model `baseUrl` and OpenAI-compatible quirk detection. Those are exactly our three credits formats. It depends on the official `@anthropic-ai/sdk` and `openai` packages, plus Google and Bedrock clients.
- **Model layer weight (checked).** `pi-ai` is about 19,300 compiled lines (6.1 MB) with ten dependencies: the Anthropic, OpenAI, Google and AWS Bedrock clients, two proxy agents, `partial-json`, `typebox` and `@earendil-works/pi-telemetry`. The telemetry package is only used for types in the compiled code, but it is installed. Every request sends a Pi `User-Agent` header, which we can override through the model's `headers`.
- **Loop (checked in the 1.0.4 package).** `pi-agent-core` is 1,433 compiled lines, of which the loop proper (`agent-loop.js` plus `agent.js`) is about 1,100; it has two dependencies (`pi-ai`, `typebox`). Its `Agent` has `steer()` and `followUp()` queues with configurable drain modes, `beforeToolCall` and `afterToolCall` hooks, `transformContext` (run before every model call, the natural compaction point), `convertToLlm`, `getApiKey(provider)` (where the short-lived credits token goes), abort, and typed events: `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`. Every one maps onto a DorkOS stream event.
- **What the full product adds.** `pi-coding-agent` has an in-process SDK (`createAgentSession`, an in-memory `SessionManager` option, `steer`, `followUp`, `abort`), JSONL tree-shaped sessions, auto and manual compaction (threshold `contextTokens > contextWindow - reserveTokens`, compact-and-retry on overflow), and MCP. It also carries 20 MB of compiled output, a TUI, its own settings and auth folders under `~/.pi`, and **install telemetry on by default** (`enableInstallTelemetry: true`, "anonymous install/update reporting and selected provider attribution headers", switched off with `PI_TELEMETRY=0`), plus `/share` and bug-report uploads to Earendil's Radius service.
- **No built-in sub-agents** by design; Pi's docs show them as an extension. For us that is fine: sub-agents become a DorkOS tool that starts a child session on the same runtime.

### 2.2 Vercel AI SDK

- Apache-2.0, very actively maintained (version 7, published the day of this report). `ToolLoopAgent` with `stopWhen` gives a multi-step tool loop; `@ai-sdk/mcp` is a stable MCP client; official OpenAI and Anthropic providers plus an OpenAI-compatible provider all take a custom base URL ([ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent), [loop control](https://ai-sdk.dev/docs/agents/loop-control)).
- **No sessions, no compaction, no coding tools, no steering queue.** A mid-turn message means writing our own loop around `streamText`, which is most of what `pi-agent-core` already is.
- Strengths over Pi: a large company behind it, the biggest provider ecosystem, and boring stability. It is the right fallback.

### 2.3 Mastra

Apache-2.0 core with an Enterprise-licensed `ee/` folder ([Mastra licence post](https://mastra.ai/blog/apache-license)). It brings agents, memory, workflows, a model router and observability, built on the AI SDK. Those are subsystems DorkOS already owns (`@dorkos/memory`, the event log, Relay, Mesh), so adopting Mastra means two sources of truth. Heaviest option; wrong shape.

### 2.4 OpenAI Agents SDK (TypeScript)

MIT, clean primitives (agents, tools, handoffs, guardrails, sessions, tracing), MCP support, and non-OpenAI models through an adapter. **Tracing is on by default and sends spans to OpenAI's platform**, and users report spans reaching `api.openai.com` even when the model endpoint points elsewhere ([tracing docs](https://openai.github.io/openai-agents-python/tracing/), [issue](https://github.com/VRSEN/agency-swarm/issues/828)). It can be switched off, but "all traffic goes through our proxy" would then depend on a flag we must test forever. Steering mid-turn is not a first-class concept.

### 2.5 LangGraph.js

MIT and mature, with SQLite and Postgres checkpointers. It is a general state-machine library, not an agent harness: no coding tools, no transcript format, no compaction. We would build the whole loop on top of a graph executor. Wrong shape.

### 2.6 Claude Agent SDK on an API key

- **Not open source.** The npm licence field reads "SEE LICENSE IN README.md"; use is governed by Anthropic's Commercial Terms.
- **It is Claude Code underneath**, so it carries the Claude Code product rules. Anthropic's legal page (fetched 2026-10-07, [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)) says that running Claude Code in your products requires the Commercial Terms and these conditions: "The Claude Code binary must not be modified" and "**Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential."
- That section names Claude Code; it applies to the Agent SDK by inference, because the SDK runs the Claude Code binary. So DorkOS cannot be the payer for an Agent SDK runtime either. It also speaks only Anthropic's format, so it cannot run a non-Anthropic model on credits. **Ruled out** as the DorkOS runtime. It stays what it is today: the engine behind "use your own Claude sign-in or key".

### 2.7 OpenCode embedded as a library

MIT and already our third runtime (ADR-0308). It is a client/server product: `@opencode-ai/sdk` talks to a separate `opencode serve` process, which DorkOS manages as a sidecar (`apps/server/src/services/runtimes/opencode/server-manager.ts`). It cannot run in-process. Rebranding it would also mean shipping another vendor's binary, release cadence and storage under our name, which is what Dorian ruled out ("not OpenCode renamed").

### 2.8 Others, one line each

- **Codex CLI** (Apache-2.0, Rust): already a runtime; OpenAI-only; subprocess.
- **Goose** (Apache-2.0, Rust, now under the Linux Foundation's Agentic AI Foundation): credible, but a subprocess, and Rust.
- **Cline SDK** (`@cline/sdk`, announced May 2026 as an embeddable harness): promising, young; npm shows no licence on `@cline/core` while the parent says Apache-2.0, so check before relying on it ([MarkTechPost](https://www.marktechpost.com/2026/05/14/cline-releases-cline-sdk-an-open-source-agent-runtime-now-powering-its-cli-and-kanban-with-ide-extensions-being-migrated/)).
- **Letta** (Apache-2.0): a memory-first agent server, different category.

---

## 3. Side by side

Scores are for our needs, not in general. "Ours" means DorkOS builds it.

| Need                                      | Pi core (`pi-ai` + `pi-agent-core`)                                                                                               | Vercel AI SDK        | Mastra                          | OpenAI Agents                                | LangGraph.js            | Claude Agent SDK | OpenCode         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------- | -------------------------------------------- | ----------------------- | ---------------- | ---------------- |
| Licence fits an MIT app                   | Yes (MIT)                                                                                                                         | Yes (Apache-2.0)     | Core yes, `ee/` no              | Yes (MIT)                                    | Yes (MIT)               | **No**           | Yes (MIT)        |
| All 3 credits formats via custom base URL | **Yes, native**                                                                                                                   | Yes, via 3 providers | Yes (AI SDK under it)           | Chat/Responses native; Anthropic via adapter | Via LangChain models    | Anthropic only   | Yes              |
| Shell, file edit tools                    | Ours (or lift from `pi-coding-agent`, MIT)                                                                                        | Ours                 | Ours                            | Ours                                         | Ours                    | Built in         | Built in         |
| Browser                                   | Ours, via the DorkOS MCP tools (already exist)                                                                                    | same                 | same                            | same                                         | same                    | same             | same             |
| MCP client                                | Ours (`@modelcontextprotocol/sdk`, already a dependency)                                                                          | **`@ai-sdk/mcp`**    | Built in                        | Built in                                     | Adapter                 | Built in         | Built in         |
| Events map to our stream                  | **Yes, 1:1 shapes**                                                                                                               | Yes (stream parts)   | Yes                             | Yes                                          | Partly                  | Already mapped   | Already mapped   |
| Sessions (ADR-0310)                       | Ours: DorkOS event log                                                                                                            | Ours                 | Its own memory store (conflict) | Its own sessions                             | Checkpointers           | Its own JSONL    | Its own SQLite   |
| Compaction                                | Hook built in; algorithm ours or lifted                                                                                           | Ours                 | Memory processors               | Ours                                         | Ours                    | Built in         | Built in         |
| Sub-agents                                | Ours (DorkOS tool)                                                                                                                | Ours                 | Built in                        | Handoffs                                     | Graphs                  | Built in         | Built in         |
| Mid-turn steering                         | **Built in (`steer`, `followUp`)**                                                                                                | Ours                 | No                              | No                                           | Interrupts              | Built in         | No               |
| Runs in Node and on a server              | Yes                                                                                                                               | Yes                  | Yes                             | Yes                                          | Yes                     | Needs the binary | Needs the binary |
| Data leaves only to our proxy             | Yes for the core (telemetry calls live in `pi-coding-agent`; `pi-ai` installs `pi-telemetry` for types and sends a Pi User-Agent) | Yes                  | Check its telemetry             | **No by default (tracing)**                  | Yes unless LangSmith on | Anthropic only   | Check            |
| Maturity                                  | 113k stars, 1.0 last week, company-backed                                                                                         | Very high            | High                            | Medium (0.x)                                 | High                    | High, closed     | High             |
| Dependency weight                         | Medium (loop: 2 deps; `pi-ai`: 10 deps incl. 4 vendor clients)                                                                    | Light                | Heavy                           | Medium                                       | Medium                  | Heavy binary     | Heavy binary     |

---

## 4. Recommendation

### 4.1 Build on Pi core, own everything above it

**Use `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as the engine. Do not embed `pi-coding-agent` as a whole.** Reasons:

1. **It fits our contract with the fewest moving parts.** Steering, approvals and compaction are hooks in the core loop, not features we would build around someone else's session object. Our server already owns the queue, the transcript, the stream and the tools via MCP; Pi core owns only "call the model, run tools, loop", which is what we want to borrow.
2. **It already speaks our three credits formats** with prompt caching for Anthropic models, so the auto-picker can choose any model in the credits catalog, not just one vendor's.
3. **The full product is the wrong layer for us.** `pi-coding-agent` brings its own session files and settings under `~/.pi`, a TUI, uploads to Earendil's service and install telemetry that is on by default. All of that would sit beside our storage and our privacy story. We can still lift MIT code from it (the edit tool's diff logic, the compaction prompt and the file-tracking summary) with attribution.
4. **The loop is small enough to own.** About 1,100 lines. If Earendil's direction ever diverges from ours, forking the loop is cheap, and the RFC 0015 MIT commitment covers the past regardless. The model layer (`pi-ai`, about 19,000 lines of per-vendor quirks) is not cheap to fork; if it goes wrong, we swap it for the Vercel AI SDK's providers behind the `Engine` port instead.
5. **Precedent inside the repo.** ADR-0307 already named Pi as the leading candidate for exactly this.

**Hide the engine behind our adapter.** The runtime's own modules (tools, storage, compaction, routing) talk to a small internal `Engine` port, so swapping Pi core for the Vercel AI SDK later is a one-module change. That is the main mitigation for the stewardship risk.

### 4.2 Shape of the runtime

- **Name in code:** `dorkos` runtime type, adapter dir `apps/server/src/services/runtimes/dorkos/`, engine imports confined there by ESLint (Hard Rule 2 pattern). **In the app:** never a name. It is just "DorkOS" or nothing at all.
- **Storage, two parts:** a durable, untrimmed **message store** per session (Pi's `AgentMessage[]` as rows in SQLite, owned by this runtime) is the model's context and the source of truth; it must round-trip what the vendors need back, such as Anthropic thinking signatures and Responses reasoning items. Compaction writes a summary entry into it rather than deleting rows. The DorkOS event log (`logBackedHistory: true`) stays the display history, exactly as for Codex and OpenCode. Session listing works through the existing aggregation (ADR-0310).
- **Who pays, three ways:** DorkOS credits (the default), the person's own API key (OpenAI, Anthropic or any OpenAI-compatible server), or a local model (Ollama, LM Studio). `pi-ai` already takes any base URL and key, so the last two cost little, and they keep "no account" useful: without them, the "Continue without an account" path has no working agent unless the person installs a vendor CLI. Cline and Kilo Code (section 5.5) run the same split.
- **Credits:** declare `credits: { protocol: 'openai-responses' | 'openai-chat-completions' | 'anthropic-messages', scope: 'conversation' }`. Today a runtime declares one protocol (`RuntimeCreditsSupport.protocol`, `agent-runtime.ts:830-855`). Our runtime can speak all three, so the contract should widen to "a set of protocols, picked per model" (a small contract change, done in phase 1). Until then, declare the one the service lists most models for.
- **Tools, first set:** `read`, `write`, `edit`, `shell`, `grep`, `glob`, `web_fetch`. Browser, rooms, canvas, memory, connections, scheduling, `compact_my_session` and `create_extension` come from the DorkOS MCP server with no new code. Shell runs as a subprocess with a scrubbed environment (no credits token, no DorkOS secrets).
- **Permission modes:** start with two descriptors that match "trusted by default" once the audit trail lands: full power (no asks) and ask-before-risky. Approvals go through `beforeToolCall`.
- **Compaction:** in `transformContext` when the context passes a threshold, plus on request through `executeCommandIntent('compact')`. Emit `operation_progress` and one `compact_boundary` with real token counts (RT-CMP-01 to 03).
- **Steering:** declare `supportsSteer: true` and map `deliverIntoTurn(mode: 'steer')` to `agent.steer()`. Staging maps to `followUp` or to `additionalContext`.
- **Sub-agents:** a `task` tool that starts a child session on the same runtime and streams it back as `background_task_*` and `subagent_text_delta` events.
- **Instructions:** read the agent's `AGENTS.md`, `SOUL.md` and skills directly from `.agents/` (Harness Sync already knows the tree), so this runtime is the first that needs no vendor projection.
- **Server use later:** nothing in Pi core is tied to a desktop. The same adapter runs inside a cloud agent's server, which is the path to "cloud agents" after launch.

### 4.3 Model routing: auto-pick now, a router later

- **Before launch: auto-pick per agent, not per turn.** The credits catalog already names a suggested model per format (`recommendedOn`, at most one per format), and the model shape deliberately names no vendor (`packages/cloud-api/src/inference.ts:146-154`). That is enough for "DorkOS picks one default". Three plain tiers (quick, standard, strongest) need a new optional `tier` field on catalog models: a contract-first DOR change, with the Cloud side filling it in. Give every agent the suggested model (or the standard tier once it exists) by default. DorkOS picks; the person never has to. Which vendor's model is suggested is a catalog decision on the Cloud side, not app code. Settings and the hidden-by-default status-bar item let a person change it (see the onboarding report, section 6).
- **Fallback, not failure:** when the chosen model is down or refused, retry on the next model in the same tier and say so with the existing `model_substituted` event.
- **After launch: a per-turn router through the DecisionModel ladder.** `packages/decisions` is a confidence ladder (free rules, then a small model, then a frontier model, then a person, with daily caps and a circuit breaker). Nothing imports it yet. Asking it "which tier does this turn need" fits its `choice` question shape, but it returns labels not model ids and adds a model call before every turn. Worth it only once we have real usage to tune against. Do not put it on the launch path.

### 4.4 Build plan

Sizes are lines of product code (P) and test code (T), from the existing runtimes: Codex is 14.0k P and 18.1k T, OpenCode 11.6k P and 16.0k T, test-mode 5.2k P. Those runtimes hand the loop, tools, transcript and compaction to a vendor; ours owns all of them, so it is not smaller than they are, it just skips process management and transcript parsing. Time assumes the usual setup: one implementer agent per phase plus a separate reviewer, starting Monday 2026-10-12.

| Phase                                   | What                                                                                                                                                                                                                                                                                                                                                                               | Size                           | Time                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------- |
| 0. Spike                                | Pi core in-process against the real credits endpoint in all three formats; one tool; events mapped; reasoning items and thinking signatures round-tripped; first-token time and memory measured. Decide the `Engine` port and the message-store schema. Write `NOTES.md`.                                                                                                          | throwaway                      | 2 to 3 days                |
| 1. The runtime                          | Facade, event mapper, `Engine` port, the message store, event-log display history, locking, `checkDependencies`, capabilities, the 7 local tools, approvals, DorkOS MCP client, credits declaration (and the "set of protocols" contract change), config block and migration, registration, the hard-coded lists in section 1.5, client descriptor. Core conformance groups green. | 7k to 9k P, 7k to 9k T         | 2 weeks                    |
| 2. Depth                                | Compaction, steering and follow-up, bounded interrupts, context gauge, sub-agents, `AGENTS.md` and skills loading, prompt caching, retries, cost and token reporting. Full conformance and the capability-matrix column.                                                                                                                                                           | 3k to 5k P, 4k to 6k T         | 1 week                     |
| 3. Models, keys and hardening           | Auto-pick from the catalog and same-model-family fallback, model settings, the status-bar model item hidden by default, own API key and local model as payers, shell env scrub, evals on the core suite, a live smoke.                                                                                                                                                             | 3k to 4k P, 3k to 4k T         | 1 week                     |
| 4. Make it the default for new installs | New installs that press "Continue with DorkOS" get DorkBot and new agents on the DorkOS runtime. Existing installs keep their runtime and payer; they switch only through a Runs on choice (the money-path rule). The vendor runtimes move under "Use my own AI sign-in".                                                                                                          | 1k to 2k P                     | 0.5 week, overlapping      |
| **Runtime total**                       |                                                                                                                                                                                                                                                                                                                                                                                    | **14k to 20k P, 14k to 20k T** | **about 4.5 to 5.5 weeks** |

**The whole programme, not just the runtime.** In the same window: the onboarding build list (companion report, section 9), the Cloud card page and two contract changes (card on file, model tier), and the docs rewrite. With agents working in parallel tracks that is about **6 to 7 weeks** from 2026-10-12, landing between 2026-11-23 and 2026-11-30. **Cut line if it slips:** sub-agents, prompt caching, the tier field and local models move to after launch; the first-run path, compaction, steering, interrupts and own-key support do not.

**Two new money paths.** AGENTS.md lists the paths that spend real money and requires each to have its own flag beside its own key, read at module scope, kept out of every turbo task. This runtime adds two: a live smoke on credits and an eval leg on credits. Each gets its own flag (for example `DORKOS_RUNTIME_LIVE_PAID=1` and `DORKOS_EVALS_PAID_CREDITS=1`), `paidPathFor` and `packages/evals/src/runner/__tests__/paid-provider.test.ts` learn both, and the eval sandbox needs a way to run linked to a test DorkOS account, since credits can only be chosen on a linked computer and no test data directory is linked. Until that exists, the eval leg runs on the person's own key with the existing paid-provider flags.

### 4.5 What "done before launch" means

All of these, and nothing else:

1. A new user with no outside AI account signs in, adds a card, and gets a real agent reply from DorkBot on the DorkOS runtime, with no runtime or model name on screen.
2. The runtime passes the full `runtimeConformance` suite with honest declarations, including compaction, steering, interrupts, durable history and the credits negatives.
3. It runs every DorkOS tool through MCP, plus the 7 local tools, and can build a mini app with `create_extension` end to end (the first-run demo in the onboarding report).
4. Long sessions keep their full model context across restarts and compaction (the message store), proven by a test.
5. Auto-pick and fallback work; a person can change the model in Settings and from a pinned status-bar item; the runtime also runs on the person's own key.
6. The core eval suite, plus a set of founder and business cases written for it, passes at an agreed absolute pass rate on credits (proposed: 85 percent), and first-token time is under 3 seconds on a warm server. Matching Claude Code on hard coding tasks is a goal, not a launch gate.
7. Claude Code, Codex and OpenCode still work, under "use my own sign-in".

Not before launch: the per-turn router, cloud-hosted agents, a plugin system for the runtime, branching sessions, and full isolation of the link credential from agent tools (tracked as a risk below).

### 4.6 Risks

| Risk                                                                                                                                             | How likely                                                                                                           | What we do                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code on DorkOS credits**, live today, conflicts with Anthropic's Claude Code page (section 5.1)                                         | Already true                                                                                                         | Switch it off before any real charge (decision 2); remove it when the runtime ships                                                          |
| Anthropic's resale clause read against our own runtime                                                                                           | Low                                                                                                                  | The Commercial Terms expressly permit powering our own product for end users; confirm in writing anyway                                      |
| Pi changes direction or slows down after the acquisition                                                                                         | Low to medium                                                                                                        | Depend only on the two MIT layers; `Engine` port; pin versions; fork the loop if needed; AI SDK providers replace `pi-ai` if needed          |
| Quality gap against Claude Code on hard coding tasks                                                                                             | Medium                                                                                                               | Default agents in DorkOS are business agents, not only coders; an absolute eval gate; "use my own sign-in" stays one click away              |
| Schedule (6 to 7 weeks for the programme against a mid to late November launch)                                                                  | Medium to high                                                                                                       | Phase 0 answers the unknowns in 3 days; the cut line in 4.4                                                                                  |
| Tools can read the link credential (`cloud.instanceToken` in `~/.dork/config.json`) and approved mini-app server code runs in the server process | Medium, and true for every runtime today                                                                             | Move the credential to the OS keychain (small, worth doing before launch); OS sandbox for tools after launch                                 |
| Tool safety: full-power shell in our own loop                                                                                                    | Medium                                                                                                               | Scrubbed env, folder grants enforced in the tools, approvals until the audit trail lands (the decided order in AGENTS.md)                    |
| Pi telemetry or uploads sneak in                                                                                                                 | Low (the calls live in `pi-coding-agent`, which we do not depend on; `pi-ai` installs `pi-telemetry` for types only) | A test that fails if any request goes anywhere but the configured base URL; override the User-Agent; check the dependency tree on every bump |
| `pi-ai` pulls four vendor SDKs and their AWS helpers                                                                                             | Low                                                                                                                  | Acceptable size; lazy-import the unused ones later                                                                                           |

---

## 5. Vendor terms: can DorkOS resell model usage inside its own agent?

Not legal advice. Quotes are from pages read on 2026-10-07; OpenAI's policy pages returned HTTP 403 to our fetch tool, so those quotes come from search excerpts and need a human check before anything ships.

### 5.1 Anthropic (Claude API)

- **The Commercial Terms allow our case.** Section A.1: "Subject to these Terms, Anthropic gives Customer permission to use the Services, including to power products and services Customer makes available to its own customers and end users." ([anthropic.com/legal/commercial-terms](https://www.anthropic.com/legal/commercial-terms), fetched 2026-10-07.)
- **What they restrict.** Section D.4: "Customer may not and must not attempt to ... resell the Services except as expressly approved by Anthropic." Read beside A.1, that is about reselling Claude itself (a raw API resale business), not about an app whose own agent calls Claude for its users. Our runtime on credits is the A.1 case. Still worth one written confirmation, because "credits" can look like resale from the outside.
- **The Claude Code page is clear, and stricter.** Under "preinstalling or running Claude Code in your products or services", it sets two conditions. First: "The Claude Code binary must not be modified ... customers may not remove, disable, or restrict any authentication method built into it." Second: "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential." ([code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), fetched 2026-10-07.)
- **This touches what DorkOS ships today, now.** ADR 261001-000811 lets a Claude Code session run on DorkOS credits, and the CLI and desktop app bundle the Claude Code binary. Read plainly, DorkOS paying for Claude Code usage on a person's behalf is what the second condition forbids, unless Anthropic agrees otherwise. The same ADR blanks the Claude sign-in variables and refuses some folders on a credits turn, which could be read as "restricting an authentication method" under the first condition. Our own report from yesterday reached the same point for agent computers: Claude Code on DorkOS credits inside a box needs a separate agreement with Anthropic (`research/20261006_agent-computer-bootstrap-and-vendor-logins.md`, line 72); that report also records a decision not to ask Anthropic for now, made about subscriptions in hosted boxes. The DorkOS runtime is the clean way out: credits pay for DorkOS's own agent calling a model, never for Claude Code.
- **Also:** the Usage Policy forbids training on outputs and requires respecting Anthropic's supported regions; as the key holder, DorkOS must not serve Claude to people in unsupported regions.
- **Action:** one written question to Anthropic sales (the legal page links "contact sales" for exactly this): (1) confirm our own agent on credits is the A.1 case; (2) ask whether Claude Code on DorkOS credits, as shipped, is acceptable. Until (2) is answered yes, keep Claude Code off credits (decision 2).

### 5.2 OpenAI (API)

- The May 2025 Business Terms grant "the right to use OpenAI's application programming interfaces ('APIs') to integrate the Services into your applications, products, or services (each a 'Customer Application') and to make Customer Applications available to End Users." ([openai.com/policies/may-2025-business-terms](https://openai.com/policies/may-2025-business-terms/), search excerpt.)
- What is forbidden is reselling account access or trading API keys: "resell or lease access to your account or any End User Account", "buy, sell, or transfer API keys". Our users never see a key, so we are on the allowed side.
- **Good practice:** send a hashed per-user `safety_identifier` on every request, so one bad user does not get the whole DorkOS key flagged ([safety best practices](https://platform.openai.com/docs/guides/safety-best-practices)).
- **Clearest of the three.** OpenAI models are safe to auto-pick on credits today.

### 5.3 OpenRouter

- The standard terms forbid our model outright: "access the Site or Service for purposes of reselling API access to Models or otherwise developing a competing service" ([openrouter.ai/terms](https://openrouter.ai/terms), section 7).
- The Enterprise Access Agreement allows it: "to access and use the Service for the purpose of making the Service available to Customer's End Customers" ([openrouter.ai/terms-of-service-enterprise](https://openrouter.ai/terms-of-service-enterprise), section 2.1).
- Each model's own vendor terms still apply on top; OpenRouter does not clear Anthropic's clause for us.
- **So:** if the credits service sources any model through OpenRouter, it needs the enterprise agreement first. This is a Cloud question, not an app question, and nothing private is implied here.

### 5.4 Google (Gemini API), briefly

No resale ban was found in the terms text; the competing-models ban applies; and "You may use only Paid Services when making API Clients available to users in the European Economic Area, Switzerland, or the United Kingdom" ([ai.google.dev/gemini-api/terms](https://ai.google.dev/gemini-api/terms)).

### 5.5 Precedents for "own agent, our credits"

Zed (hosted models at "API list price plus 10 percent"), Warp (credits, card for paid), Cline and Kilo Code (own key at zero markup beside platform credits), and Amp (pass-through pricing with no markup except Enterprise) all run their own agent loop and bill model usage themselves. Cline and Kilo Code are the closest to what we are building: their own agent, both "use your own key" and "use our credits" side by side.

---

## 6. Decisions for Dorian

1. **Engine.** Recommended: build on Pi core (`pi-ai` + `pi-agent-core`) behind our own `Engine` port, with the Vercel AI SDK as the fallback. The other choice is the Vercel AI SDK from day one: a larger company behind it, but we write the steering queue and loop ourselves, about one extra week.
2. **Claude Code on DorkOS credits, which ships today.** Recommended (A): switch it off now with the existing switch, before any real charge, and remove it when the DorkOS runtime ships; Claude Code then runs only on the person's own sign-in or key. The other choice (B): keep it and ask Anthropic for a written agreement first, accepting the exposure until they answer.
3. **Launch date.** The runtime plus onboarding plus Cloud is a 6 to 7 week programme (late November). Recommended: keep the date and hold the cut line in section 4.4. The other choice: move launch into early December and ship sub-agents and model tiers with it.

---

## Sources

- Repo: `packages/shared/src/agent-runtime.ts`, `packages/shared/src/schemas.ts`, `packages/test-utils/src/runtime-conformance.ts`, `contributing/adding-a-runtime.md`, `apps/server/src/services/runtimes/*`, `apps/server/src/services/core/cloud/credits-*.ts`, `packages/cloud-api/src/inference.ts`, `packages/decisions/src/*`, `apps/client/src/layers/features/status/model/status-bar-registry.ts`, ADR-0307, ADR-0310, ADR 261001-000811, ADR 261002-221210.
- npm registry, `npm view <package> version license` for all eight candidates, 2026-10-07. GitHub API `repos/badlogic/pi-mono` (redirects to `earendil-works/pi`), 2026-10-07. Unpacked `@earendil-works/pi-agent-core@1.0.4`, `pi-ai@1.0.4`, `pi-coding-agent@1.0.4` (type declarations, `docs/sdk.md`, `docs/compaction.md`, `docs/settings.md`).
- Pi: [github.com/earendil-works/pi](https://github.com/badlogic/pi-mono), [RFC 0015](https://rfc.earendil.com/0015/), [The Register, 2026-10-02](https://www.theregister.com/ai-and-ml/2026/10/02/pi-coding-agent-pulls-a-180-and-adds-mcp-support/5300678), [Ronacher, 2026-04-08](https://mitsuhiko.spicytakes.org/post/2026-04-08-mario-and-earendil), [Flavio Copes on Pi](https://flaviocopes.com/pi/).
- Vercel AI SDK: [AI SDK 5](https://vercel.com/blog/ai-sdk-5), [ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent), [@ai-sdk/mcp](https://www.npmjs.com/package/@ai-sdk/mcp).
- Mastra: [licence](https://mastra.ai/blog/apache-license), [model router](https://mastra.ai/blog/model-router).
- OpenAI Agents SDK: [npm](https://www.npmjs.com/package/@openai/agents), [tracing](https://openai.github.io/openai-agents-python/tracing/), [trace leak report](https://github.com/VRSEN/agency-swarm/issues/828).
- LangGraph.js: [npm](https://www.npmjs.com/package/@langchain/langgraph).
- OpenCode: [anomalyco/opencode](https://github.com/anomalyco/opencode).
- Terms: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (fetched 2026-10-07), [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Anthropic Usage Policy](https://www.anthropic.com/legal/aup), [OpenAI Business Terms](https://openai.com/policies/may-2025-business-terms/), [OpenRouter terms](https://openrouter.ai/terms), [OpenRouter enterprise terms](https://openrouter.ai/terms-of-service-enterprise), [Gemini API terms](https://ai.google.dev/gemini-api/terms).

## Gaps

- OpenAI policy quotes came through search excerpts (403 on direct fetch). Check by hand.
- Anthropic's view of "our own agent on credits" is unknown until we ask.
- Pi core's behaviour against our credits endpoint is untested; phase 0 exists to test it.
- The Cline SDK licence discrepancy was not resolved.
