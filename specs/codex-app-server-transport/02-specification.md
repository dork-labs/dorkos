---
slug: codex-app-server-transport
id: 261005-112122
created: 2026-10-05
status: specified
linearIssue: DOR-2719
adr: 261005-113107
---

# Run Codex through `codex app-server`: specification

Direction: `01-ideation.md`. Decision: ADR `261005-113107` (supersedes ADR-0309, amends ADR `261002-221210`). Protocol reference: `research/20261005_codex-app-server-protocol-0154.md` ("protocol §n" below). Spike evidence: `research/20261005_codex-app-server-spikes.md` ("spike n").

## 1. Goal and non-goals

**Goal.** Codex chats in DorkOS run on a long-lived `codex app-server` process, so that:

- Codex can stop and ask before a risky action, and the person answers in the same approval card Claude Code and OpenCode use.
- A message sent mid-turn steers the running turn.
- Stop ends the turn gracefully, without killing a process.
- Background commands and sub-agents keep running after the reply ends, and when one finishes, the chat wakes and says so.

**Done when** (DOR-2719): the shared conformance suite is green on app-server, and a real Codex chat on the operator's own sign-in shows an approval card, steers mid-turn, stops cleanly, and a background command finishing after the turn wakes the chat.

**Non-goals.**

- Listing or importing the person's own Codex Desktop or CLI threads. The session list stays DorkOS-mapped threads only (§13).
- Fork, compaction (`thread/compact/start`), rollback, `thread/queue/*`, realtime, plugins, review mode. Each is a possible follow-up; none is needed for the done-when.
- Moving DorkOS context out of the prompt into `developerInstructions` or `turn/start.additionalContext`. Prompt assembly (`buildCodexPrompt`, `CodexContextGate`) is unchanged, so both transports send the model the same words. Follow-up.
- Removing the exec path. It stays behind the switch until app-server has shipped a release with nobody needing it; removal is its own issue.
- Restart resume of background work across a DorkOS restart (DOR-2689) and the other DOR-2717 items outside item 8.

## 2. Phases

Each phase is one mergeable PR (`03-tasks.json`).

| Phase  | Ships                                                                                                                                                                                                      | Default transport       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **P1** | Transport seam, JSON-RPC client, process pool, turns on app-server (start/resume, streaming, usage, interrupt, MCP, credits, identity), trust override, thread key, config switch, protocol snapshot check | `auto` → exec           |
| **P2** | Real approvals, questions, elicitations; new mode descriptors; `turn/steer`; approval conformance case                                                                                                     | `auto` → exec           |
| **P3** | Background terminals and sub-agents outlive the turn and wake the chat; `stopTask`; thread reconciliation; flip `auto` to app-server; docs; live proof                                                     | `auto` → **app-server** |

## 3. Transport seam

Everything above "run one resolved turn" stays in `CodexRuntime`: settings resolution, cwd chain, the credits decision and refusal, model swap, connector binding (`openTurn`) and its lease supervisor, identity minting, managed-server resolution, the context gate, prompt assembly, registry and `codex_threads` writes, media capture. Only the part that talks to Codex moves behind an interface.

**Location:** `apps/server/src/services/runtimes/codex/transport/`.

```ts
/** One resolved Codex turn, transport-neutral. */
export interface CodexTurnRequest {
  sessionId: string;
  boundThreadId: string | undefined;
  cwd: string;
  settings: SessionSettings; // mode, model, effort (fastMode: unmapped on both, as today)
  writableDirectories: string[]; // validated write grants (today's additionalDirectories)
  prompt: string; // buildCodexPrompt(...) output, unchanged
  launch: CodexLaunch; // { home: 'person' } | { home: 'credits'; credits: CreditsLaunch }
  tools: CodexTurnTools; // managed servers, dorkos + connector injections, identity env
  signal: AbortSignal; // the turn's controller
  events: CodexEventContext; // existing context: usage reader, media state, threadId
  onThreadBound(threadId: string): void; // persist the binding (first-write-wins)
}

export interface CodexTransport {
  readonly kind: 'exec' | 'app-server';
  /** Static capability overrides for this transport (merged over the shared base). */
  readonly capabilities: Partial<RuntimeCapabilities>;
  runTurn(req: CodexTurnRequest): AsyncGenerator<StreamEvent>; // exactly one terminal done
  interrupt(sessionId: string): Promise<InterruptReceipt>;
  // P2
  answerApproval?(
    sessionId: string,
    id: string,
    approved: boolean,
    o?: ToolDecisionOptions
  ): boolean;
  answerQuestion?(sessionId: string, id: string, answers: Record<string, string>): boolean;
  answerElicitation?(
    sessionId: string,
    id: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean;
  steer?(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult>;
  // P3
  stopBackgroundTask?(sessionId: string, taskId: string): Promise<InterruptReceipt>;
  onRuntimeTurn?(
    listener: (sessionId: string, events: AsyncIterable<StreamEvent>) => void
  ): () => void;
  isSegmentPending?(sessionId: string): boolean;
  shutdown(): Promise<void>;
}
```

- `exec-transport.ts` is today's SDK code moved out of `codex-runtime.ts` (`clientForTurn`, `buildCodexOptions`, `withCodexCredits`, `projectThreadOptions`, `runStreamed` + `mapCodexThread`). Behaviour is byte-identical; its tests move with it.
- `app-server-transport.ts` is new (§4–§12).
- `CodexRuntime` builds one transport at construction from `runtimes.codex.transport` (§15) and delegates. `getCapabilities()` returns `{ ...CODEX_BASE_CAPABILITIES, ...transport.capabilities }` plus the existing `mediaOutput` override. Capabilities are cached by the client with `staleTime: Infinity`, so the transport is fixed for the server's lifetime; a change takes effect at the next start (documented).
- `approveTool`/`submitAnswers`/`submitElicitation`/`deliverIntoTurn`/`stopTask`/`onRuntimeTurn`/`isSegmentPending` delegate when the transport implements them and keep today's honest refusals otherwise. `deliverIntoTurn` stays absent from the runtime object on exec (C1: "absent or refused as unsupported").
- The SDK import stays confined to `codex/` (Hard Rule 2) and now only `exec-transport.ts`, `codex-options.ts`, `credits-launch.ts` (exec half), `event-mapper.ts` and `turn-input.ts` touch it. `runtime-deps.json`'s `sdk_surface_map` is updated to match (§16).

## 4. JSON-RPC client

**File:** `codex/app-server/json-rpc-client.ts`. `model-catalog.ts` is rewritten onto it (one-shot use: spawn, `initialize`, page `model/list`, close), deleting its private framing.

- **Framing.** Newline-delimited JSON on stdin/stdout, no `"jsonrpc"` field (protocol §1). Outbound: `{id, method, params}`, notifications `{method, params}`. Inbound line cap **16 MiB** (an `aggregatedOutput` can reach 1 MiB and diffs more); a longer line, or a line that is not JSON, is a protocol fault → the client closes and the process is treated as crashed (§5). stdout is decoded as UTF-8 with a streaming decoder so a multi-byte character split across chunks survives.
- **Ids.** Monotonic integers per connection. A pending map `id → {method, resolve, reject, timer}`.
- **Requests.** `request<M extends ClientMethod>(method, params, {timeoutMs, signal})` typed from `protocol/methods.ts`. Default timeouts: `initialize` 15 s, `thread/start` / `thread/resume` 60 s (MCP startup runs behind them), `turn/start` / `turn/steer` / `turn/interrupt` 15 s, everything else 30 s. On timeout the entry is dropped and the call rejects with `CodexRpcTimeoutError`; a late response for a dropped id is ignored and counted.
- **Errors.** Every rejection is `-32600` (protocol §1), so the client classifies by message text through one table in `protocol/errors.ts`: `not-initialized`, `already-initialized`, `unknown-method`, `thread-not-found`, `no-rollout` ("no rollout found for thread id"), `no-active-turn`, `turn-mismatch` ("expected active turn id"), `not-steerable` (`codexErrorInfo.activeTurnNotSteerable`), `experimental-required`, `other`. `-32001` ("Server overloaded") is `overloaded` and retried up to 3 times with 250/500/1000 ms backoff before surfacing.
- **Notifications.** Parsed by `method`; the client fans out to subscribers registered per `threadId` (and one wildcard subscriber for process-level ones: `account/*`, `mcpServer/startupStatus/updated`, `remoteControl/*`, `configWarning`). Unknown methods are ignored and counted (debug log once per method per process). Notifications are validated with the zod schemas in `protocol/schemas.ts`; a payload that fails validation is logged once and dropped, never thrown into a turn.
- **Server→client requests.** `{id, method, params}` from the server go to one handler registered by the transport. The client guarantees **every** server request gets exactly one reply: if no handler claims it, or the handler throws, it replies with the method's refusal (`decline`/`cancel`/empty grant, §10) and logs. Before P2 wires approvals, the P1 handler answers every approval-shaped request with its refusal; it never auto-accepts.
- **stderr.** Drained continuously into a 64 KiB ring buffer (never left to fill the pipe). Debug-logged line by line with secrets redacted by the existing log redactor; on crash the tail goes to the warn log. Never shown in chat (it can carry paths). The child gets `RUST_LOG=warn` unless the operator set one.
- **Close.** `close()` rejects every pending request with `CodexProcessExitedError`, and ends every per-thread subscription with an `exited` signal the turn mapper turns into an error + done (§7).

## 5. Process pool and supervision

**File:** `codex/app-server/process-pool.ts` (`CodexAppServerPool`, a module singleton like `openCodeServerManager`).

- **Key.** `(binaryPath, CODEX_HOME, envFingerprint)`, where `envFingerprint` is a SHA-256 of the sorted `name=value` pairs of the process environment. The environment is `runtimeEnvironment('codex', 'turn')` with nothing per turn layered on it (identity and headers moved into thread config, §9), plus for the credits home `codexCreditsProcessEnv` **without** a token (the relay replaces it). In practice that is two processes: the person's home and the credits home. A changed binary (one-click install, `binaryPath` edit) or inheritance policy produces a new key; the old process is drained (no new threads) and reaped once idle.
- **Spawn.** Lazy, on the first turn that needs the key. `spawn(binary, ['app-server', '--listen', 'stdio://'], { env, stdio: 'pipe' })`, cwd = the key's `CODEX_HOME`. No `-c` arguments, ever. Concurrent callers share one in-flight boot.
- **Initialize.** `initialize { clientInfo: { name: 'dorkos', title: 'DorkOS', version: SERVER_VERSION }, capabilities: { experimentalApi: true } }`, then the `initialized` notification. The version is parsed from `userAgent` (`parseCodexAppServerVersion`, already in `model-context-windows.ts`). A version other than the pinned one is allowed (the protocol is additive) and reported by `checkDependencies` as a note on the status card; it is not refused. A failed initialize is a crash.
- **Crash.** Any exit not requested by DorkOS, a protocol fault, or stdin `EPIPE`:
  - every in-flight turn on the process ends with an `error` event ("Codex stopped unexpectedly. Send your message again to continue.", details: exit code/signal and the stderr tail's last line) and its single `done`;
  - every pending interaction emits `interaction_cancelled { reason: 'aborted' }`;
  - (P3) every tracked background task emits `background_task_done { status: 'failed', summary: 'Codex stopped, so this was stopped too.' }` on its session, through a runtime turn when no turn is open (DOR-2717 item 9's Codex twin);
  - every thread key minted for the process is revoked (§9).
    The next turn respawns lazily. A crash loop guard refuses a respawn for 30 s after 3 crashes within 60 s, with the error "Codex keeps stopping. Try again in a minute." and the stderr tail in the log. This mirrors `SIDECAR_TIMING` without eager restarts: nothing waits on a Codex process that has no turn.
- **Idle reaping.** A process is **live** while any of these holds: a turn is open on any of its threads; a server request is pending; a wake is in flight (P3); a thread has a background terminal (`thread/backgroundTerminals/list` non-empty) or an unfinished sub-agent. A process not live for **10 minutes** is closed. A process that has a **stale** thread (its load fingerprint no longer matches, §8) is closed as soon as it is not live. The reaper checks every 60 s with an `unref`'d timer; `thread/backgroundTerminals/list` is only called for threads DorkOS saw start a process-backed command since their last empty listing.
- **Shutdown.** `codexAppServerPool.shutdown()` is called in `apps/server/src/index.ts` `shutdownServices()` immediately after `openCodeServerManager.shutdown()`: for each process, end stdin, wait up to 3 s for exit, SIGTERM, wait 3 s, SIGKILL. Background terminals die with it (documented; restart resume is DOR-2689). The admin restart path runs the same function.
- **Process hygiene.** The pool kills only children it spawned, by the PID it holds (Hard Rule 7). Tests inject `spawn`.

## 6. Thread lifecycle

`codex_threads` stays the source of truth for session ↔ thread (ADR-0309's map carries over; no schema change).

**Load** (`codex/app-server/thread-loader.ts`). Before a turn, the transport makes sure the session's thread is loaded in the right process with the right config:

| State                                  | Action                                                                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No binding                             | `thread/start` with the load params (below). The thread id is **not** persisted yet.                                                                                                                            |
| Bound, not loaded in this process      | `thread/resume { threadId, ...load params }` (a cold resume applies config, spike 1b).                                                                                                                          |
| Bound, loaded, same load fingerprint   | Nothing.                                                                                                                                                                                                        |
| Bound, loaded, different fingerprint   | Use it as is for this turn (a loaded thread ignores new config, spike 1b), mark it stale so the pool recycles the process when idle (§5), and log once.                                                         |
| Cold resume answers `no-rollout`       | The thread never got a first turn. `thread/start` a new one and **replace** the binding (`CodexThreadMap.replaceThreadId`, a new method used only here, guarded on the old id).                                 |
| Cold resume answers `thread-not-found` | The person deleted it in Codex. Start a new thread, replace the binding, and emit a `system_status` "Codex no longer has this conversation, so it starts fresh." The DorkOS history stays visible (log-backed). |

**Load params** (fixed for the thread's loaded life):

- `cwd`, `model` (if set), `approvalPolicy`, `sandbox` (`SandboxMode` string), `approvalsReviewer: 'user'` (always; never `auto_review` or `guardian_subagent`, which let a model answer, §18).
- `config`: `mcp_servers` (§9), `shell_environment_policy.set` (§9), `projects.<realpath(cwd)>.trust_level` (§9), and on credits `model_provider` + `model_providers['dorkos-credits']` + `web_search: 'disabled'` (§9).
- The **load fingerprint** is a hash of everything above except secrets (key ids, not key values), plus the managed-server definitions. `ephemeral` is never set (resume needs rollouts).

**Binding.** `onThreadBound` fires at the first `turn/started` for a thread DorkOS started (not at `thread/start`), because a thread with no rollout cannot be resumed (spike 1b). An interrupted or failed first turn still has a rollout by then, so it stays resumable, matching today.

**Subscriptions.** Start and resume auto-subscribe the connection. DorkOS never calls `thread/unsubscribe` while it holds the thread: it would lose notifications. A thread unloads when its process is reaped. `thread/closed` (30-minute idle unload) drops the loaded-thread record and revokes its thread key.

**The joining trap.** `turn/start` on a thread with an active turn silently steers into it and answers with the existing turn id (protocol §3). The transport keeps `activeTurn: Map<threadId, turnId>`. The server already serialises turns per session, so a `turn/start` while `activeTurn` is set is a bug: the transport refuses it locally with an error event and a done (never sends it). If a `turn/start` response nevertheless returns an id equal to a known active turn, the transport logs an invariant breach and ends its own generator with an error + done.

## 7. Turns and the notification mapper

**Start.** `turn/start` with:

- `threadId`, `input: [{ type: 'text', text: prompt, text_elements: [] }]`, `clientUserMessageId: opts.messageId` when present.
- Per-turn (sticky) overrides, sent every turn so a mode or model change between turns lands: `cwd`, `approvalPolicy`, `sandboxPolicy` as the **tagged object** (protocol risk 6):
  - `read-only` → `{ type: 'readOnly', networkAccess: false }`
  - `workspace-write` → `{ type: 'workspaceWrite', writableRoots: writableDirectories, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }`
  - `danger-full-access` → `{ type: 'dangerFullAccess' }`
- `model`, `effort` (`EFFORT_TO_REASONING`, unchanged), `summary: 'auto'`.

The response's `turn.id` becomes `activeTurn[threadId]`. Mode changes mid-turn keep today's honest answer: `permissionModePendingUntilNextTurn` when a tightening lands while a turn runs (`turn/settings/update` cannot change sandbox or approval).

**Mapping** (`codex/app-server/notification-mapper.ts`, pure, exhaustive over the snapshot's notification and item unions with `never` checks so a new member fails compilation, the same tripwire `event-mapper.ts` has today). Tool names reuse `SHELL_TOOL_NAME`, `PATCH_TOOL_NAME`, `WEB_SEARCH_TOOL_NAME` and the MCP naming in `event-mapper.ts`, and `control_ui` still becomes `ui_command`, so history, the tool cards and rooms see the same shapes on both transports.

| Notification / item                                                          | StreamEvent                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn/started` (our turn)                                                    | `session_status` running; `onThreadBound` on the first one                                                                                                                                            |
| `item/agentMessage/delta`                                                    | `text_delta` (streams; exec only delivered whole messages)                                                                                                                                            |
| `item/completed` `agentMessage`                                              | reconcile: emit the missing tail if deltas were dropped                                                                                                                                               |
| `item/reasoning/summaryTextDelta`                                            | `thinking_delta`                                                                                                                                                                                      |
| `item/started` `commandExecution`                                            | `tool_call_start` (`Shell`, input = command + cwd)                                                                                                                                                    |
| `item/commandExecution/outputDelta`                                          | `tool_progress`                                                                                                                                                                                       |
| `item/completed` `commandExecution`                                          | `tool_call_end` + `tool_result` (output, exit code; `declined` → result says so)                                                                                                                      |
| `item/started`/`completed` `fileChange`                                      | `ApplyPatch` tool start/end/result with the diff summary                                                                                                                                              |
| `item/started`/`completed` `mcpToolCall`, `item/mcpToolCall/progress`        | MCP tool start/progress/end/result; media capture unchanged                                                                                                                                           |
| `webSearch`                                                                  | `WebSearch` tool                                                                                                                                                                                      |
| `turn/plan/updated`                                                          | `task_update` (replaces `todo_list`)                                                                                                                                                                  |
| `collabAgentToolCall`, `subAgentActivity`                                    | `background_task_started` / `background_task_done` (`taskType: 'agent'`, `taskId` = agent thread id)                                                                                                  |
| `commandExecution` with a `processId` still `inProgress` at `turn/completed` | `background_task_started` (`taskType: 'bash'`, `taskId` = item id)                                                                                                                                    |
| `thread/tokenUsage/updated` (our turn)                                       | folded into the turn's usage; context usage from `last.totalTokens` / `modelContextWindow`                                                                                                            |
| `model/rerouted`                                                             | `model_substituted`                                                                                                                                                                                   |
| `error` with `willRetry: true`                                               | `api_retry`                                                                                                                                                                                           |
| `error` with `willRetry: false`                                              | held; emitted as the typed `error` before `done` (de-duplicated against `turn/completed.error`)                                                                                                       |
| `turn/completed` `completed`                                                 | final `session_status` (usage, `terminalReason: 'completed'`) + `done`                                                                                                                                |
| `turn/completed` `interrupted`                                               | quiet `done` (user stop, not an error)                                                                                                                                                                |
| `turn/completed` `failed`                                                    | `error` (copy via the existing `codexErrorCopy`, keyed on `codexErrorInfo`: `unauthorized` → sign-in copy, `usageLimitExceeded` → out-of-usage copy, `contextWindowExceeded` → context copy) + `done` |
| `warning`, `configWarning`, `deprecationNotice`                              | logged; `configWarning` also `system_status` once per process                                                                                                                                         |
| `thread/compacted`, `contextCompaction` item                                 | `compact_boundary`                                                                                                                                                                                    |
| `serverRequest/resolved`                                                     | §10                                                                                                                                                                                                   |
| anything else                                                                | ignored, counted                                                                                                                                                                                      |

**Exactly one `done`.** The generator ends after the terminal of **its** turn id, on abort-bound expiry (§8), or on process exit/protocol fault (error + done). A shared `closeTurn` guard makes a second terminal a no-op, which conformance C2 already pins at the platform layer.

**Usage.** `turn/completed` carries no usage (protocol risk 4). The mapper keeps the latest `thread/tokenUsage/updated` for the turn: `last` gives the current context (tokens/window, the same semantics NOTES.md documents for the rollout reading), `total` the cumulative counters for the existing `UsageStatus` fields. On app-server the rollout-tail reader (`turn-context-usage.ts`) is used only at rest (`readContextUsage` on open); the live reading comes from the notification. Rate limits come from `account/rateLimits/read` once per process and `account/rateLimits/updated` (sparse: merged into the last read, never replacing it), recorded against the person's account in the person's home and dropped in the credits home (today's rule).

**Late events.** A notification whose `turnId` is not the thread's active turn, or that arrives after its turn's `turn/completed`, goes to the thread's **late sink**, never into a closed turn. P1: the sink records them (count + last item) for diagnostics and reaping (a late `item/completed` for a tracked background item clears it). P3 surfaces them (§12).

## 8. Interrupt

`interrupt(sessionId)`: no active turn → `not-running` / `no-open-turn`. Otherwise `turn/interrupt { threadId, turnId }`, then wait for that turn's `turn/completed` (`interrupted`) up to `STOP_ACK_TIMEOUT_MS` (3 s, the shared bound):

- completed within the bound → `acked` (Codex wound the turn down; this is the receipt change from today's `closed`);
- `no-active-turn` from the server (it ended on its own meanwhile) → `not-running` / `no-open-turn`;
- no completion within the bound → `unconfirmed` / `ack-timeout`. There is no session-scoped escalation: killing the process would end every other Codex chat in that home (OpenCode's rule). The stall guard still ends a turn that goes dark.

The turn's `AbortSignal` calls the same path. Interrupt does not kill background terminals (protocol §5); `stopTask` does (§12). The connector binding is revoked exactly as today. Conformance C11 gets a `hangingInterrupt` driver for app-server (fake peer that never completes the turn) asserting `unconfirmed`.

## 9. MCP, identity, credits and secrets

Spike 1 decides this section: thread config is fixed for a loaded thread's life and is ignored, silently, on a loaded resume; `turn/start` has no config; per-thread config reaches MCP servers (literal headers), model providers (literal bearer) and the agent's command environment. Nothing goes in argv or the process environment.

**Thread key (the `dorkos` tool server and the connector route).** Today both carry the per-turn connector bearer in an env-backed header. A loaded thread cannot take a new header each turn, so:

- When DorkOS loads a thread for a registered agent, it mints a **thread key**: 256 random bits, kept only in server memory, bound to `{ runtime: 'codex', sessionId, canonicalCwd, processKey }`. It is sent once, as the literal `Authorization` header (plus the existing runtime-kind and cwd headers as literals) in `config.mcp_servers.dorkos` and `config.mcp_servers.<connector>`.
- Each turn, after `openTurn` returns the turn's binding, the transport **attaches** the binding to the thread key; at turn end it detaches. The internal listener, on a bearer that is a thread key, resolves it to the attached binding and then runs today's checks (runtime, cwd, expiry, revocation) against that binding. No attached binding → the same unauthorized answer as an expired bearer. So a tool call outside a DorkOS turn (a background command poking the URL, a late call) is refused, and the authority is exactly the open turn's.
- Revoked when the thread closes or unloads, when its process exits or is reaped, and at shutdown. Never persisted or logged; the log carries a key id.
- **Where:** `apps/server/src/services/connectors/principal/thread-keys.ts` (registry: `mint`, `attach`, `detach`, `revoke`, `resolve`), consulted by `runtime-principal-service.ts`'s bearer resolution before the turn-bearer lookup. Exec keeps passing turn bearers as today.
- The thread's load cwd is part of its load fingerprint, so a session whose cwd changes gets a reload rather than a key whose cwd no longer matches.

This widens the listener's bearer model (§18) and gets a dedicated security review before P1 merges.

**Managed MCP servers.** `resolveManagedMcpServers` output is written into `config.mcp_servers` with header values as literal `http_headers` (not `env_http_headers` + `DORKOS_MCP_HDR_*` env). They are stable per agent; an edit reaches a loaded thread after its process recycles (§5, §6). Stdio servers keep their `command`/`args`/`env` as config. The reserved-name rule (`dorkos` beats a managed server of the same name) is unchanged.

**The person's own MCP servers.** Per-thread `mcp_servers` merges with `config.toml`'s (spike 1a), exactly as `-c mcp_servers.*` does on exec today. Unchanged.

**Agent identity token.** `resolveAgentTokenEnv` is minted at thread load and passed as `config.shell_environment_policy.set` (spike 1e), so it reaches the commands the agent runs, as today, without entering the app-server's own environment or argv. Token lifetimes (7-day idle, 30-day absolute) dwarf the 30-minute thread unload, and a reload re-mints. One difference to verify in P1: on exec the token is in the process environment, so stdio MCP servers Codex launches inherit it; on app-server they may not. Spec `agent-trust` §3.1 only promises it to the `dorkos` commands the agent runs, so either answer is acceptable, but the P1 test records which it is.

**Credits.** A credits thread runs in the credits-home process. Its load config sets `model_provider: 'dorkos-credits'` and a provider entry pointing at the **credits relay**: `base_url` = the relay's `baseUrl`, `wire_api: 'responses'`, `requires_openai_auth: false`, `experimental_bearer_token` = a relay key issued once per credits process (`relay.issue('openai-responses', 'Codex')`) and revoked when that process stops. The relay already carries `openai-responses` (`POST /responses`, `GET /models`). Consequences:

- The token never enters Codex's process; a new token needs no reload (the relay sends the current one). This retires the per-turn `env_key` variable (amends ADR `261002-221210`).
- `index.ts` starts the relay when Codex **or** OpenCode is enabled (today OpenCode only). No relay → a Codex credits turn is refused with the credits card, never sent elsewhere.
- Unlink: `stopCreditsTurns()` interrupts every credits turn, `creditsRelay.abortAll()` ends in-flight requests, and the pool closes the credits process (`recycleIfOnCredits` twin).
- The per-turn credits decision, model swap and refusal in `CodexRuntime.sendMessage` are unchanged; `threadRunsOnCredits` still reads which home a rollout is in.
- `credits-provider.binary.test.ts` gains an app-server leg against the fake local provider (the spike technique): the provider sees the relay key, a project `.codex/config.toml` provider never wins, and no request reaches anything but the relay.

**Trust (spike 2).** Both transports write `trust_level = "trusted"` into the home's `config.toml` the first time a writable-mode thread runs in a folder, and then load that folder's `.codex/config.toml` (its MCP servers start). The app-server transport stops the write by sending `projects.<realpath(cwd)>.trust_level` in every load config (spike 2c):

- **Person's home:** the person's own recorded verdict for that path when `config.toml` has one (read through `config/read { cwd }` at load), else `"trusted"` for `workspace-write` and `danger-full-access` and nothing for `read-only`. That is exactly what exec does today, minus the write.
- **Credits home:** always `"untrusted"`. That makes ADR `261002-221210`'s "the credits home reads no project config" true; on exec today it is false after the first writable turn in a folder (spike 2b). Exec's behaviour is left as is and noted in NOTES.md; it goes away with exec.

**Process environment.** Unchanged projection (`runtimeEnvironment('codex', 'turn')`, owner opt-ins, model profile). The SDK's `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` is not set; Codex records `originator: 'dorkos'` from `clientInfo.name`.

## 10. Permission modes and approvals (P2)

**Modes.** DorkOS `PermissionMode` ids are unchanged, so stored sessions, `PATCH /api/sessions/:id` and DOR-2714's ceiling comparisons keep working (the comparison is descriptor-based). The app-server transport's descriptors replace the exec ones in its capability overrides:

| id                  | `sandbox` / `sandboxPolicy` | `approvalPolicy` | `stop`     | `asks`       | `reach`      | label (draft)   |
| ------------------- | --------------------------- | ---------------- | ---------- | ------------ | ------------ | --------------- |
| `default`           | `read-only`                 | `on-request`     | `ask`      | `always`     | `workspace`  | Ask first       |
| `acceptEdits`       | `workspace-write`           | `on-request`     | `act`      | `when-risky` | `workspace`  | Workspace write |
| `bypassPermissions` | `danger-full-access`        | `never`          | `autonomy` | `never`      | `everything` | Full access     |

- `default`: reads freely; every change, command that writes, or network use needs an approval. `asks: 'always'` because in a read-only sandbox every change escalates.
- `acceptEdits`: Codex's own "Auto" preset. Edits and commands inside the project and temp folders run; going outside them or onto the network asks.
- `bypassPermissions`: unchanged.
- Descriptions and promises are rewritten to say what is now true ("Codex asks before it changes anything", "asks before it reaches outside this project or the network"), under the `writing-app-copy` skill and its 15-word cap. The `native` field becomes `"read-only, asks first"` style text. Copy is pinned by the existing descriptor conformance checks ("a mode that never stops for approval must not promise that it does").
- `permissionModes.denyReason: false`: Codex's decisions carry no reason text, so the deny box is hidden rather than typed into a void.
- Existing `default` sessions become more capable (they can now ask to make a change). That is the person's approval each time, and the changelog says so.

**Server requests → events** (`codex/app-server/server-requests.ts`). Each pending request is stored as `{ jsonRpcId, method, threadId, turnId, itemId, interactionId, startedAt, timer }`. `interactionId` = the request's `itemId` (or `approvalId` when present), so the card attaches to that item's `tool_call_start`.

| Request                                                                                                                                        | Event                                                                                                                                                                                                                                                                         | `approveTool(approved, { alwaysAllow })` / answer → reply                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval` (`kind: command` or `writeStdin`)                                                                      | `approval_required` (`toolName: 'Shell'`, input = command + cwd, `decisionReason` = `reason`, network host from `networkApprovalContext` in `description`, `hasSuggestions` = `availableDecisions` includes `acceptForSession` (default true), `alwaysAllowScope: 'session'`) | `accept` / `acceptForSession` / `decline`                                                                      |
| `item/fileChange/requestApproval`                                                                                                              | `approval_required` (`toolName: 'ApplyPatch'`, input = the item's changes from its `item/started`, `blockedPath` = `grantRoot` when present)                                                                                                                                  | `accept` / `acceptForSession` / `decline`                                                                      |
| `item/permissions/requestApproval`                                                                                                             | `approval_required` (`toolName: 'Permissions'`, input = requested network/file-system permissions)                                                                                                                                                                            | approve → grant exactly what was requested, `scope: 'turn'` (`'session'` with alwaysAllow); deny → empty grant |
| `mcpServer/elicitation/request` with `_meta.codex_approval_kind: 'mcp_tool_call'`                                                              | `approval_required` (MCP tool name in DorkOS's MCP naming)                                                                                                                                                                                                                    | `{action: 'accept'}` / `{action: 'decline'}`                                                                   |
| `mcpServer/elicitation/request` `form` / `url`                                                                                                 | `elicitation_prompt`                                                                                                                                                                                                                                                          | `submitElicitation` → `{action, content}`                                                                      |
| `mcpServer/elicitation/request` other modes (`openai/form`, `openai/userVerification`)                                                         | none                                                                                                                                                                                                                                                                          | `{action: 'cancel'}`, logged                                                                                   |
| `item/tool/requestUserInput`                                                                                                                   | `question_prompt` (questions in order; `isOther` → free-text option; `isSecret` → masked input)                                                                                                                                                                               | `submitAnswers` canonical index-keyed answers → `{answers: {[questionId]: {answers: [text]}}}`                 |
| `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`, `applyPatchApproval`, `execCommandApproval` | none                                                                                                                                                                                                                                                                          | refusal shape for the method, logged (DorkOS registers no dynamic tools and does not use external-token auth)  |

- **Who answers.** Only `approveTool`/`submitAnswers`/`submitElicitation`, which the server calls only from person-authenticated routes. No agent, tool or MCP path can answer one (§18).
- **Timeout.** The server's existing `INTERACTION_TIMEOUT_MS` applies (`timeoutMs`/`startedAt` on the event). On expiry the transport replies `decline` (empty grant, `cancel` for elicitations), emits `interaction_cancelled { reason: 'timeout' }`, and the agent continues, like Claude Code's auto-deny.
- **Abort.** Interrupt or a turn abort replies `cancel` to every pending request of that turn first, then interrupts.
- **`serverRequest/resolved`.** When the server clears a request DorkOS still holds (turn completed or interrupted, or answered by another client), the transport drops it and emits `interaction_cancelled { reason: 'aborted' }`, so the card is withdrawn. An `approveTool` arriving after that returns `false`.
- **Recovery re-emit.** The pending map backs `getSessionSnapshot`'s pending interactions so a reconnecting client redraws the card with `remainingMs`.
- **Rooms and unattended turns.** Unchanged platform behaviour: the approval waits for a person exactly as Claude Code's does.

**Capabilities in P2:** `supportsToolApproval: true`, `supportsQuestionPrompt: true`, `supportsSteer: true`, `permissionModes` as above with `denyReason: false`.

## 11. Steer (P2)

`deliverIntoTurn(sessionId, content, { mode: 'steer', messageId, additionalContext })`:

- No `activeTurn` for the session's thread → `{ delivered: false, reason: 'no-open-turn' }`.
- Else `turn/steer { threadId, expectedTurnId: activeTurn, input: [{ type: 'text', text: buildSteerText(content, additionalContext) }], clientUserMessageId: messageId }`. `buildSteerText` renders the context bag out of band exactly as `buildCodexPrompt` does, with the person's words last and untouched.
- Errors: `no-active-turn` or `turn-mismatch` → `no-open-turn`; `not-steerable` (review/compact turn) → `no-open-turn`; any other → throw (a genuine fault). Never throws for an ordinary refusal.
- The steered message's events arrive on the open turn's stream (Codex records the `userMessage` with `clientId` = `messageId`), which is what the server matches.
- `mode: 'stage'` → `{ delivered: false, reason: 'unsupported' }`; `supportsContextStaging` stays `false` (`thread/inject_items` is a follow-up).
- `canSteerSession` is omitted: steering is uniform across app-server sessions.
- Conformance: a `dispositionTurn` driver on the fake peer that parks a turn, steers mid-turn, asserts no new `turn_start` and that the fake received `turn/steer` with the right `expectedTurnId` (C1). `supportsPersistentSession: true` (declared in P1) brings the `warmSession` driver: a session is warm while its thread is loaded in a live process; `getSessionWarmth` answers that; `reapSession` unloads by marking stale and is never called with an interaction open (C4, C5, C8).

## 12. Background terminals and sub-agents (P3)

**Detect.** Per loaded thread, the transport tracks:

- background commands: `commandExecution` items with a `processId` still `inProgress` when their turn completes;
- sub-agents: `subAgentActivity` `started` (or `collabAgentToolCall` spawns) without a matching `completed`/`interrupted` by turn end.

A late `item/completed` for a tracked command, or `subAgentActivity` `completed`/`interrupted`, under an old turn id (protocol §5, risk 2) is a **late completion**.

**Wake the chat** (DOR-2717 item 8). On a late completion with no turn open on the session:

1. Set `isSegmentPending(sessionId)` true at once, so a queued message waits (bounded at 5 s; `onDispatchGateChange` fires if the wake never opens).
2. Coalesce completions arriving within 1.5 s into one wake.
3. Open a runtime turn through the `onRuntimeTurn` listener (origin `runtime`, the detached-turn rules in `runtime-turns/runtime-turn.ts`). It first emits `background_task_done` for each completion (`status` from exit code or sub-agent outcome, `summary` = exit code and the last 2 KB of output, or the sub-agent's final message), then opens a connector binding the same way `sendMessage` does and calls `turn/start` with a DorkOS-authored notice: `<background_update>` block naming each finished task, its outcome and the output tail, and asking the agent to carry on. That turn's events stream into the same runtime turn, ending in one `done`.
4. History shows the agent's reply as the agent's own turn; the notice never renders as the person's words (the block is rendered out of band like other context, and the turn's origin is `runtime`).

Rules:

- **Wake only when the work's own turn ended normally** (`completed`). After an `interrupted` or `failed` turn, a later completion is shown (`background_task_done` in a runtime turn with no `turn/start`) but does not start a model turn. The person stopped it; DorkOS does not restart it behind their back.
- A completion while a turn is open is emitted into that turn as `background_task_done` and needs no wake (the model is running).
- At most one wake in flight per thread. Every wake is subject to the session's room turn limits where those apply.
- `thread/backgroundTerminals/list` reconciles the tracked set at turn start and when the reaper asks (a terminal that vanished without an `item/completed` is closed as `stopped`).

**`stopTask(sessionId, taskId)`.** A tracked background command → `thread/backgroundTerminals/terminate { threadId, processId }` → `acked` when `{terminated: true}`, `not-running` when the process is gone. A sub-agent → `turn/interrupt` on its thread (allowed for parent-owned V2 sub-agents, protocol §5) → same receipts. Unknown id → `not-running` / `no-open-turn`.

**Lifetime.** A process with live background work is never reaped (§5). DorkOS shutdown ends them (documented). The 4-hour background ceiling from DOR-2098 applies once it lands; until then the pool's own ceiling is: a background terminal still running 4 h after its turn ended is terminated and reported `stopped`.

**Open (P3 live check):** whether the parent connection receives the spawned sub-agent threads' item events (protocol risk 11). If it does not, DorkOS relies on the parent's `subAgentActivity` items only, which is enough for start/done and the wake; streaming sub-agent text (`subagent_text_delta`) is then a follow-up.

## 13. Thread listing

- `listSessions` stays the DorkOS registry hydrated from `codex_threads` (already restart-safe). **Decision:** the person's own Codex Desktop/CLI threads in `~/.codex` are not listed or imported. Doing so would put conversations DorkOS never started into every project list, under a runtime label, with no DorkOS history behind them. A follow-up issue can offer an explicit import.
- P3 adds reconciliation on open: the first time a session is opened per process, `thread/read { threadId }` (no turns) confirms the thread exists; `thread-not-found` marks the session so the next message starts fresh with the notice in §6. Name changes made in Codex are not pulled in (DorkOS titles stay DorkOS's).
- History stays log-backed (`logBackedHistory: true`).

## 14. Capability flags by phase (app-server transport)

| Flag                                                   | exec (today, unchanged)       | P1                                                                               | P2                                          | P3          |
| ------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- | ----------- |
| `supportsToolApproval`                                 | false                         | false                                                                            | **true**                                    | true        |
| `supportsQuestionPrompt`                               | false                         | false                                                                            | **true**                                    | true        |
| `supportsSteer`                                        | false                         | false                                                                            | **true**                                    | true        |
| `supportsContextStaging`                               | false                         | false                                                                            | false                                       | false       |
| `supportsPersistentSession`                            | false                         | **true**                                                                         | true                                        | true        |
| `permissionModes`                                      | exec descriptors              | exec descriptors, `approvalPolicy: 'never'` everywhere (no approval channel yet) | app-server descriptors, `denyReason: false` | same        |
| `deliverIntoTurn` / `canSteerSession`                  | absent                        | absent                                                                           | present / omitted                           | same        |
| `onRuntimeTurn` / `isSegmentPending` / real `stopTask` | absent / absent / not-running | absent                                                                           | absent                                      | **present** |

P1 sends `approvalPolicy: 'never'` with the same sandbox mapping as exec, so P1 behaves like today for the person; the server-request handler still refuses anything that arrives.

## 15. Config: `runtimes.codex.transport`

- **Schema** (`packages/shared/src/config-schema.ts`, inside `runtimes.codex`): `transport: z.enum(['auto', 'app-server', 'exec']).default('auto')`, and `transport: 'auto'` in both the object's and `runtimes`' `.default(() => …)` literals (config defaults are declared twice).
- **Meaning.** `auto` = DorkOS's current default: exec in P1 and P2, app-server from P3. Resolved in one function, `resolveCodexTransport(config)` in `codex/transport/index.ts`. P3 flips it by changing that function only: **no migration** and no seeded value, so an explicit `exec` or `app-server` a person set survives the flip.
- **Migration** (P1): a nested leaf in a section every stored config has, so the body is load-bearing. One new `CONFIG_MIGRATIONS` key strictly above the newest `v*` tag at merge time (today `v0.97.0`, so `0.98.0` unless a release lands first), writing `transport: 'auto'` when absent, idempotent; pinned in `merged-migration-hashes.ts`; upgrade-path test in `config-manager.test.ts`.
- **Disclosure:** `'runtimes.codex.transport': 'expose'`. **Write policy:** `'operator-only'` (it changes which process DorkOS spawns and whether approvals can happen, so an agent should not flip it).
- **Docs:** row in `contributing/configuration.md` and `docs/getting-started/configuration.mdx`: "How DorkOS runs Codex. `auto` follows DorkOS's default; `exec` is the older one-process-per-reply way. Takes effect after a restart."
- No UI toggle.

## 16. Dependency tracking

- **Snapshot.** `codex/app-server/protocol/schema-snapshot.json`, committed: for every method, notification and server request DorkOS uses (listed in `protocol/methods.ts`), the JSON Schema of its params and result taken from `codex app-server generate-json-schema --experimental`, plus the binary version. Generated by `pnpm codex:protocol-snapshot` (`scripts/codex-protocol-snapshot.ts`) from the vendored binary, deterministic (sorted keys).
- **Check.** `codex/app-server/__tests__/protocol-snapshot.binary.test.ts`: regenerates into a temp dir and fails on any difference, naming the method and field. Runs wherever the vendored binary is installed (the `credits-provider.binary.test.ts` precedent); where it is not, it skips **by name** with the reason. The lockfile carries the linux-x64 vendored package, so it is expected to run on CI; P1 confirms that in the PR rather than assuming it.
- **Typos guard.** Because the server silently drops unknown params (spike 1c), `protocol/schemas.ts` (the zod subset the client sends and parses) is checked against the snapshot by a plain unit test: every outbound param key must exist in the snapshot's params schema, and every enum literal DorkOS sends (`sandbox`, `approvalPolicy`, `SandboxPolicy.type`, decisions) must be in the snapshot's enum.
- **`.claude/config/runtime-deps.json`:** a new `@openai/codex` entry (the binary and its app-server protocol): `codebase_root` `apps/server/src/services/runtimes/codex/`, `related_adrs` `["0309", "261005-113107"]`, `sdk_surface_map` mapping protocol groups to files (`initialize, model/list` → `json-rpc-client.ts, model-catalog.ts`; `thread/*` → `thread-loader.ts`; `turn/*, notifications` → `app-server-transport.ts, notification-mapper.ts`; `server requests` → `server-requests.ts`; `thread/backgroundTerminals/*` → `background-work.ts`), and `upgrade_notes`: regenerate the snapshot and read the diff; experimental methods carry no compatibility promise; unknown params are dropped silently; re-run the spike checks for trust writes and loaded-thread config when the binary moves; the `@openai/codex-sdk` entry's notes gain "exec fallback only".
- `contributing/adding-a-runtime.md` §"Bumping a pinned SDK" gains the snapshot step.

## 17. Tests and conformance

- **Fake peer.** `codex/__tests__/fake-app-server.ts`: an in-memory duplex speaking the protocol, driven by scripts (`expect request → reply`, `emit notification`, `send server request → await reply`, `exit`). Injected through the pool's `spawn` seam. It enforces the joining trap and loaded-config immutability so tests cannot assume otherwise.
- **Unit:** `json-rpc-client.test.ts` (framing incl. split UTF-8 and the line cap, timeouts, late responses, `-32001` retry, error classification, every server request answered exactly once), `process-pool.test.ts` (keying, lazy boot sharing, crash fan-out, crash-loop guard, idle reaping never reaping a live process, stale recycle, shutdown order), `thread-loader.test.ts` (every row of §6), `notification-mapper.test.ts` (every row of §7, exactly-one done, late events routed to the sink, usage folding), `server-requests.test.ts` (every row of §10, timeout, abort, resolved-clears), `thread-keys.test.ts` (resolve only with an attached binding; revoked on exit; never logged), `background-work.test.ts` (P3 wake rules).
- **Conformance.** `codex/__tests__/conformance.test.ts` runs `runtimeConformance` twice: `transport: 'exec'` (today's scenarios) and `transport: 'app-server'` (fake peer), each with the drivers its capabilities require: `warmSession`, `dispositionTurn`, `hangingInterrupt` (app-server), `approvalTurn` (P2), `durableHistory`, `creditsTurn`.
- **New conformance case** (`packages/test-utils/src/runtime-conformance.ts`, P2): `approvalTurn` driver = drive a turn to an open approval, then `probes.answer(approved)`. Asserts: the `approval_required` payload parses `ApprovalEventSchema` and names an id the turn's tool start carried; approving resumes and the turn ends with one `done`; denying ends the tool as declined; `approveTool` on an unknown id returns `false`; interrupting with the card open emits `interaction_cancelled`. A runtime declaring `supportsToolApproval` with no driver SKIPs the case by name; codex and test-mode wire it in P2, and a follow-up issue wires claude-code and opencode.
- **Live (real Codex, the operator's own sign-in, never in turbo/CI):** the existing `DORKOS_CODEX_LIVE=1` arm of `conformance.test.ts` runs both transports; `app-server-live.test.ts` (same flag) adds the done-when scenarios in a fresh `mkdtemp` project: (a) `default` mode, ask Codex to create a file → an approval arrives → approve → file exists; (b) steer a long answer mid-turn → the turn's text follows the steer, one turn; (c) Stop mid-command → `acked`, no orphan turn; (d) ask Codex to start `sleep 20 && echo done` as a background terminal and end its reply → within 60 s a runtime turn opens with `background_task_done` and an agent reply. Costs ride the person's Codex plan, the same as today's live arm; `DORKOS_CODEX_LIVE` is not a paid flag in the AGENTS.md table and stays out of every turbo task.
- **Browser proof** (P3 done-when): on `pnpm dev:dogfood` with `runtimes.codex.transport: 'app-server'`, a real Codex chat recorded showing the approval card, a steer, a clean stop and the background wake (`capturing-product-media` tooling, attached to DOR-2719). Not a CI test.
- **Existing tests** that encode exec facts (`supportsToolApproval: false`, "cannot stop to ask" promises, the `closed` interrupt receipt) stay green on the exec leg and gain app-server twins.

## 18. Security notes

- **Approvals are answered only by a person.** `approvalsReviewer` is always `'user'`; `auto_review` and `guardian_subagent` are never sent (they let a model decide). Answers come only through the person-authenticated interaction routes. P1's handler refuses every approval request; nothing is ever auto-accepted.
- **No secrets in argv or the app-server's environment.** The thread key, managed MCP header values, identity token and relay key travel over stdin JSON-RPC inside thread config. `ps` shows `codex app-server --listen stdio://` and nothing else. The DorkOS tool bearer and the credits token, both in the environment of every exec turn today, are gone from the process.
- **The thread key** is valid only for the session's open turn, only on the loopback listener, and only while its process lives. It widens the bearer model from "per turn" to "per loaded thread, resolved per turn"; a stolen key opens nothing between turns and nothing off the machine. Security review before P1 merges.
- **Process environment projection is unchanged** (DOR-1904 rules). Commands the agent runs still see `CODEX_HOME` and whatever the projection passes.
- **Trust:** DorkOS stops writing the person's `config.toml`; the credits home never loads project config.
- **One blast radius per home.** A Codex crash ends every Codex turn in that home; each gets an honest error.
- **Experimental API** is opted into for background-terminal control. Its surface is pinned by the snapshot check; a change fails the check rather than shipping silently.

## 19. Docs to update

- `docs/guides/runtimes.mdx`: the capability table (approvals, steer, background work for Codex); replace "Codex has no interactive approvals" with how the three modes now ask; remove "Codex sessions don't survive a server restart in the session list" (already false); a short line on background commands finishing after a reply.
- `docs/guides/permissions.mdx`: Codex's modes, if it names them.
- `docs/getting-started/configuration.mdx` and `contributing/configuration.md`: `runtimes.codex.transport`.
- `contributing/adding-a-runtime.md`: Codex as the worked example of a long-lived JSON-RPC child (beside OpenCode's HTTP sidecar), the snapshot step in the bump checklist.
- `apps/server/src/services/runtimes/codex/NOTES.md`: a dated section with the spike verdicts and the new mode table; Verdict 1/3 marked exec-only.
- `codex/runtime-constants.ts` comments, `credits-relay.ts` header ("Codex does not go through it" becomes "Codex on app-server goes through it").
- Changelog fragments: P1 none user-visible beyond the switch (fragment for the config field); P2 "Codex can ask before it changes things, and you can steer it mid-reply"; P3 "Background commands Codex starts keep running after its reply, and the chat picks up when they finish." Following `writing-changelogs`.

## 20. Risks and open questions

From the protocol research's list, resolved or carried:

| #   | Risk                                                        | Resolution                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `turn/start` silently steers into an active turn            | Local `activeTurn` map; refuse locally; invariant check on the response (§6)                                                                                                                                                                                |
| 2   | Late events after `turn/completed`                          | Thread-level late sink; P3 wake (§7, §12)                                                                                                                                                                                                                   |
| 3   | Background terminals outlive turns; cleanup is experimental | Opt in; snapshot-pinned; reaper respects them; 4 h ceiling; `stopTask` (§5, §12)                                                                                                                                                                            |
| 4   | `turn/completed` has no usage                               | Fold `thread/tokenUsage/updated` (§7)                                                                                                                                                                                                                       |
| 5   | Approvals block forever; cleared requests                   | DorkOS timeout → decline; `serverRequest/resolved` → `interaction_cancelled` (§10)                                                                                                                                                                          |
| 6   | Sandbox spelling differs by method                          | Typed builders + snapshot enum check (§7, §16)                                                                                                                                                                                                              |
| 7   | Side effects on the person's Codex install                  | Trust write stopped by in-memory override; their MCP servers still start per thread (as on exec); `originator: dorkos` (§9)                                                                                                                                 |
| 8   | Errors indistinguishable by code                            | Message-text classification table, tested against the fake and the binary (§4)                                                                                                                                                                              |
| 9   | No version handshake                                        | Pin + snapshot check + `userAgent` parse + status-card note (§5, §16)                                                                                                                                                                                       |
| 10  | Newer-version rollouts (Codex Desktop 0.159)                | Carried: DorkOS resumes only threads it started; a person continuing a DorkOS thread in a newer Codex Desktop could write a rollout 0.154 cannot resume. Cold resume errors map to the §6 "starts fresh" path with a notice. Verified in the P3 live check. |
| 11  | Sub-agent subscription unverified                           | Carried to the P3 live check (§12)                                                                                                                                                                                                                          |
| 12  | Shared blast radius; memory grows with loaded threads       | Honest crash fan-out; idle reaping; the 30-minute unload (§5)                                                                                                                                                                                               |
| 13  | Unverified with a real turn                                 | P1's live arm and P3's live proof on the operator's sign-in; the fake-provider technique covers wiring for free (§17)                                                                                                                                       |

New from the spikes:

- **Loaded threads ignore new config silently.** Designed around (§6, §9). If a later binary adds a reload or unload method, the stale-recycle path can use it instead.
- **Unknown params are dropped silently.** The snapshot and typo guards (§16).
- **Exec writes trust into the credits home today** (spike 2b), so ADR `261002-221210`'s "reads no project config" premise is false on exec after the first writable credits turn in a folder. Not fixed on exec (it goes away with exec); worth a note on the credits ADR's next audit. The command-line provider still wins there, so the token cannot be redirected.

Open:

1. **Does waking the chat start a model turn?** This spec says yes, once per batch of completions, only after a turn that ended normally, matching Claude Code's behaviour and the done-when's "wakes the chat". The alternative is to show the completion and wait for the person's next message, which spends nothing but leaves the agent unaware until then. Recommendation: wake (as specified).
2. **The thread key** changes the internal listener's bearer model (§9). Recommendation: adopt it; the alternative (one process per agent per session, keyed by bearer) brings back exec's process-per-turn costs and loses background work on every turn.
