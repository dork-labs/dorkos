---
title: 'Codex app-server protocol reference (codex-cli 0.154.0)'
date: 2026-10-05
type: external-best-practices
status: active
tags: [codex, app-server, json-rpc, runtime]
feature_slug: codex-app-server-transport
---

# Codex `app-server` protocol reference: codex-cli 0.154.0

Everything here comes from the vendored binary DorkOS pins: `…/@openai+codex@0.154.0-darwin-arm64/…/vendor/aarch64-apple-darwin/bin/codex` (`codex-cli 0.154.0`).

Sources:

- **Generated schemas** (ground truth), in `/tmp/codex-app-server-schema/`:
  - `ts/` and `json/`: experimental surface (`--experimental`).
  - `ts-stable/` and `json-stable/`: stable surface.
  - The 0.145.0 (PATH binary) generation is kept at `/tmp/codex-app-server-schema-0.145/` for diffing.
- **A live, free smoke run** of the 0.154 binary. No model turn was started. Script: `/tmp/codex-smoke/smoke.mjs`. Transcripts: `/tmp/codex-smoke/transcript-{exp,stable}.jsonl`, with the email redacted.
- **Upstream docs.** `codex-rs/app-server/README.md` was **deleted on 2026-09-07 (commit d3ee328ee)**, so it is absent at tag `rust-v0.154.0`. The nearest full copy is the one at `rust-v0.150.0`, saved as `/tmp/app-server-README-0.150.md`. Current docs live at developers.openai.com/codex/app-server, which redirects to `learn.chatgpt.com/docs/app-server` and matches that README. Core behavior was confirmed against source at `rust-v0.154.0` (`app-server/src/request_processors/turn_processor.rs`, `core/src/unified_exec/*`).

Wherever the README and the schema disagree, the schema wins (see Version-compat).

## 1. Transport and framing

- **Transport.** `codex app-server` defaults to `--listen stdio://`, and `--stdio` is an alias. Other listeners:
  - `unix://[PATH]`: WebSocket over a UDS; the default path is `$CODEX_HOME/app-server-control/app-server-control.sock`.
  - `ws://IP:PORT`: marked "experimental/unsupported".
  - `off`.
- **Framing on stdio.** Newline-delimited JSON (JSONL), one message per line on stdin and stdout. Logs go to stderr (`RUST_LOG`; `LOG_FORMAT=json` makes them JSON lines).
- **JSON-RPC 2.0 without the `"jsonrpc":"2.0"` field.** Verified: no response carries it. Message shapes:
  - Requests: `{id, method, params?, trace?}`. `id` is a string or an int64. `trace` is an optional W3C `{traceparent, tracestate}`.
  - Responses: `{id, result}` or `{id, error:{code,message,data?}}`.
  - Notifications: `{method, params, emittedAtMs}`. The server adds `emittedAtMs` at top level (the `ServerNotificationEnvelope` type).
- **Server→client requests** have `{id, method, params}`, and the client must reply `{id, result}`.
- **Error codes seen in the smoke run.** Every rejection used `-32600`:
  - "Not initialized".
  - "Already initialized".
  - An unknown method, as `Invalid request: unknown variant 'nope/nope', expected one of …`. This is **not** `-32601`.
  - A bad enum value.
  - "thread not found: <id>".
  - "no active turn to steer" and "no active turn to interrupt".
  - "`<method>` requires experimentalApi capability".
- **Overload.** When ingress saturates, requests get `-32001` "Server overloaded; retry later." Treat it as retryable with backoff.

### Handshake (verified)

```jsonc
→ {"id":0,"method":"model/list","params":{}}
← {"id":0,"error":{"code":-32600,"message":"Not initialized"}}
→ {"id":1,"method":"initialize","params":{"clientInfo":{"name":"dorkos_probe","title":"DorkOS probe","version":"0.0.0"},"capabilities":{"experimentalApi":true}}}
← {"id":1,"result":{"userAgent":"dorkos_probe/0.154.0 (Mac OS 26.6.2; arm64) unknown (dorkos_probe; 0.0.0)","codexHome":"/Users/…/.codex","platformFamily":"unix","platformOs":"macos"}}
→ {"method":"initialized"}
← {"method":"remoteControl/status/changed","params":{"status":"disabled",…},"emittedAtMs":…}   // unsolicited
```

- **`InitializeParams`** is `{ clientInfo: {name, title: string|null, version}, capabilities: InitializeCapabilities | null }`.
- **`InitializeCapabilities`** fields:
  - `experimentalApi: boolean`: the opt-in for experimental methods and fields.
  - `requestAttestation: boolean`.
  - `mcpServerOpenaiFormElicitation?: boolean`: legacy.
  - `optOutNotificationMethods?: string[]`: exact method names to suppress on this connection.
  - `extensions?: {[k]: JsonValue}`: MCP extensions such as `"openai/form": {}` and `"io.modelcontextprotocol/ui": {mimeTypes:[…]}`. New in this range.
- **`InitializeResponse`** is `{ userAgent, codexHome, platformFamily, platformOs }`.
  - It has **no protocol-version field**. The version only appears inside `userAgent` (`<clientInfo.name>/0.154.0 …`).
- **Rules.** One `initialize` per connection; a second one gets "Already initialized". Capabilities are fixed for the connection's lifetime. `clientInfo.name` feeds OpenAI compliance logs; OpenAI asks enterprise integrators to register theirs.

## 2. Threads

All thread ids are UUIDv7 strings, and so are turn ids. `Thread.sessionId` is shared across a fork or subagent tree.

| Method                                                                                                                                                                                                           | Params (key)                                                                                                                                    | Result                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `thread/start`                                                                                                                                                                                                   | see below                                                                                                                                       | `ThreadStartResponse`, plus a `thread/started` notification; the connection is auto-subscribed |
| `thread/resume`                                                                                                                                                                                                  | `threadId` (+ the same overrides)                                                                                                               | `{thread (with turns), model, …}`; auto-subscribes; rejoins if the thread is already running   |
| `thread/fork`                                                                                                                                                                                                    | `threadId`, `lastTurnId?`, `ephemeral?`, `excludeTurns?`, overrides                                                                             | new `thread` with `forkedFromId`, plus `thread/started`                                        |
| `thread/list`                                                                                                                                                                                                    | `cursor, limit, sortKey, sortDirection, modelProviders, sourceKinds, archived, sectionId, cwd (string or string[]), useStateDbOnly, searchTerm` | `{data: Thread[], nextCursor, backwardsCursor}`                                                |
| `thread/loaded/list`                                                                                                                                                                                             | `cursor, limit`                                                                                                                                 | `{data: string[], nextCursor}`                                                                 |
| `thread/read`                                                                                                                                                                                                    | `threadId, includeTurns?`                                                                                                                       | `{thread}`, without resuming                                                                   |
| `thread/archive` / `thread/unarchive` / `thread/delete`                                                                                                                                                          | `threadId`                                                                                                                                      | `{}`, plus `thread/archived` etc.                                                              |
| `thread/unsubscribe`                                                                                                                                                                                             | `threadId`                                                                                                                                      | `{status: "notLoaded"                                                                          | "notSubscribed" | "unsubscribed"}` |
| `thread/name/set`, `thread/metadata/update`, `thread/rollback`, `thread/compact/start`, `thread/shellCommand`, `thread/inject_items`, `thread/goal/*`, `thread/items/list`, `thread/turns/list`, `thread/revert` |                                                                                                                                                 | stable in 0.154                                                                                |

### `thread/start` stable params

- `model`, `modelProvider`, `serviceTier`, `cwd`.
- `approvalPolicy: AskForApproval`.
- `approvalsReviewer: "user"|"auto_review"|"guardian_subagent"`.
- `sandbox: "read-only"|"workspace-write"|"danger-full-access"`. This is `SandboxMode`, a kebab-case string.
- `config: {[key]: JsonValue}`: per-thread config overrides.
- `serviceName`, `baseInstructions`, `developerInstructions`, `personality`, `ephemeral`, `sessionStartSource`, `threadSource`.

### `thread/start` experimental-only params

- `permissions` (profile id; it cannot be combined with `sandbox`).
- `dynamicTools`, `environments`, `runtimeWorkspaceRoots`, `projectId`, `historyMode`, `selectedCapabilityRoots`, `allowProviderModelFallback`, `experimentalRawEvents`.
- `multiAgentMode`, which is deprecated and ignored.

`ThreadResumeParams` and `ThreadForkParams` take the same override set. Experimental-only on those two: `path`, `history`, `permissions`, `runtimeWorkspaceRoots`, `initialTurnsPage`, `beforeTurnId`, `deferGoalContinuation`.

### `ThreadStartResponse`

Fields: `thread, model, modelProvider, serviceTier, cwd, runtimeWorkspaceRoots, instructionSources, approvalPolicy, approvalsReviewer, sandbox: SandboxPolicy, activePermissionProfile, reasoningEffort, multiAgentMode`.

Verified `thread/start` (ephemeral, read-only, `cwd: /tmp`). It made no model call, and it **did start the user's configured MCP servers** (`mcpServer/startupStatus/updated` for codex_apps, node_repl, cua_repl):

```jsonc
→ {"id":11,"method":"thread/start","params":{"cwd":"/tmp","sandbox":"read-only","approvalPolicy":"on-request","ephemeral":true,"developerInstructions":"probe"}}
← {"id":11,"result":{"thread":{"id":"01a10bc4-…","sessionId":"01a10bc4-…","ephemeral":true,"historyMode":"legacy","status":{"type":"idle"},"path":null,"cwd":"/tmp","cliVersion":"0.154.0","originator":"dorkos_probe","source":"vscode","canAcceptDirectInput":true,"model":"gpt-6.1-sol","reasoningEffort":"low","environments":[{"environmentId":"local","cwd":"/tmp","runtimeWorkspaceRoots":["/tmp"]}],"turns":[],…},
   "model":"gpt-6.1-sol","modelProvider":"openai","serviceTier":"default","cwd":"/tmp","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"readOnly","networkAccess":false},"activePermissionProfile":null,"reasoningEffort":"low","multiAgentMode":"explicitRequestOnly",…}}
```

### Thread fields and status

- **`Thread`** fields worth noting: `id, sessionId, forkedFromId, parentThreadId` (set for subagents), `preview, ephemeral, status, path` (unstable), `cwd, cliVersion, originator, source, agentNickname, agentRole, gitInfo, name, model, reasoningEffort, historyMode ("legacy"|"paginated"), turns`.
  - `turns` is filled only on resume, fork, rollback, and read with `includeTurns`.
  - Experimental-only fields: `canAcceptDirectInput`, `environments`, `extra`, `daybreakEnabled`.
- **`ThreadStatus`** is `{type:"notLoaded"} | {type:"idle"} | {type:"systemError"} | {type:"active", activeFlags: ("waitingOnApproval"|"waitingOnUserInput")[]}`. It is pushed through `thread/status/changed {threadId, status}`.

### Side effects to know about

- **Trust.** `thread/start` with a `cwd` and a resolved sandbox of `workspace-write` or full access **marks that project as trusted in the user's `config.toml`** (README).
- **Unloading.** After the last unsubscribe, a thread stays loaded until it has had 30 minutes with no subscribers and no activity. Then `SessionEnd` hooks run and `thread/closed` fires, along with a `thread/status/changed` to `notLoaded`.
- **Listing filters.** `thread/list` by default returns only "interactive" `sourceKinds`. Threads this server created report `source:"vscode"`, so filter on `originator` (or `clientInfo.name`) instead.
- **Old sessions.** `thread/list` in the smoke run read rollouts written by Codex Desktop 0.159.2 (`historyMode:"paginated"`) without trouble. Thread ids are the same rollout ids the SDK path uses, so resuming SDK-era sessions by `threadId` should work. That was not exercised with a turn.

## 3. Turns

### `turn/start` → `{turn: Turn}`

The response's `turn` has `status:"inProgress"`, `items:[]` and `itemsView:"notLoaded"`.

**Stable params:**

- `threadId`, `input: UserInput[]`, `clientUserMessageId?` (echoed as `userMessage.clientId`).
- `cwd`, `approvalPolicy`, `approvalsReviewer`.
- `sandboxPolicy: SandboxPolicy`. This is a tagged object, **not** the `SandboxMode` string `thread/start` takes.
- `model`, `serviceTier`, `serviceTierForTurn`, `effort: string`, `summary: "auto"|"concise"|"detailed"|"none"`, `personality`.
- `outputSchema` (this turn only), `turnTrigger`, `toolOutput`.

**Overrides are sticky:** they also apply to later turns.

**Experimental-only params:** `permissions`, `environments`, `runtimeWorkspaceRoots`, `collaborationMode`, `additionalContext`, `responsesapiClientMetadata`, `cyberAccessProgram`, and `multiAgentMode` (ignored).

**`UserInput`** is one of:

- `{type:"text", text, text_elements: TextElement[]}` (`text_elements` is required by the schema).
- `{type:"image", url, detail?}`: data URLs only; remote http(s) URLs are rejected.
- `{type:"localImage", path, detail?}`.
- `{type:"audio", url}` and `{type:"localAudio", path}`.
- `{type:"skill", name, path}` and `{type:"mention", name, path}`.

**`SandboxPolicy`** is one of:

- `{type:"dangerFullAccess"}`
- `{type:"readOnly", networkAccess}`
- `{type:"externalSandbox", networkAccess}`
- `{type:"workspaceWrite", writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}`

**`AskForApproval`** is `"untrusted" | "on-request" | "never" | {granular:{sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}}`. The `granular` variant is gated behind `experimentalApi`.

**Reasoning effort** is a free-form `string`. Per `model/list` it ranges over `low|medium|high|xhigh|max|ultra`, and `ultra` enables proactive multi-agent behavior.

**Important (source-verified, `turn_processor.rs`).** `turn/start` calls `start_or_steer_turn`. If the thread already has an active turn, the input is **steered into it**: the response carries the _existing_ turn id and no new `turn/started` fires. Track the active turn yourself.

### Other turn methods

- **`turn/steer`** takes `{threadId, input, expectedTurnId (required), clientUserMessageId?}` and returns `{turnId}`.
  - Error messages: "no active turn to steer"; "expected active turn id `X` but found `Y`"; "cannot steer a review/compact turn" (with `codexErrorInfo.activeTurnNotSteerable`); "active turn uses a different output schema".
- **`turn/interrupt`** takes `{threadId, turnId}` and returns `{}`. The turn then ends with `turn/completed` and `status:"interrupted"`. It does **not** kill background terminals.
- **`thread/settings/update`** (experimental) changes next-turn settings without starting a turn.
- **`turn/settings/update`** (experimental) changes model, effort, reviewer or tier on the running turn only.
- **`thread/queue/*`** (experimental, up to 100 per thread) holds server-side FIFO follow-ups that start automatically when the thread goes idle.

### Turn notifications

All of them carry `threadId`, and most carry `turnId`.

| Method                                                                                                                                                                           | Params                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn/started`                                                                                                                                                                   | `{threadId, turn}` with empty items                                                                                                                                                               |
| `turn/completed`                                                                                                                                                                 | `{threadId, turn}`, where `turn.status` is `completed                                                                                                                                             | interrupted                                        | failed`, plus `error: TurnError | null, startedAt, completedAt, durationMs`. **No usage is included.** |
| `thread/tokenUsage/updated`                                                                                                                                                      | `{threadId, turnId, tokenUsage:{total, last, modelContextWindow}}`; each breakdown is `{totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens}` |
| `item/started` / `item/completed`                                                                                                                                                | `{item: ThreadItem, threadId, turnId, startedAtMs                                                                                                                                                 | completedAtMs}`; `item/completed` is authoritative |
| `item/agentMessage/delta`                                                                                                                                                        | `{threadId, turnId, itemId, delta}`                                                                                                                                                               |
| `item/reasoning/summaryTextDelta`                                                                                                                                                | `+summaryIndex`                                                                                                                                                                                   |
| `item/reasoning/summaryPartAdded`                                                                                                                                                | `{…, summaryIndex}`                                                                                                                                                                               |
| `item/reasoning/textDelta`                                                                                                                                                       | `+contentIndex` (raw reasoning)                                                                                                                                                                   |
| `item/commandExecution/outputDelta`                                                                                                                                              | `{…, itemId, delta}`                                                                                                                                                                              |
| `item/commandExecution/terminalInteraction`                                                                                                                                      | `{…, itemId, processId, stdin}`                                                                                                                                                                   |
| `item/fileChange/patchUpdated`                                                                                                                                                   | `{…, changes: FileUpdateChange[]}`; only when `features.apply_patch_streaming_events` is on. `item/fileChange/outputDelta` is no longer emitted.                                                  |
| `item/mcpToolCall/progress`                                                                                                                                                      | `{…, itemId, message}`                                                                                                                                                                            |
| `item/plan/delta`                                                                                                                                                                | plan-mode text (marked EXPERIMENTAL in the docs)                                                                                                                                                  |
| `turn/plan/updated`                                                                                                                                                              | `{threadId, turnId, explanation, plan:[{step, status:"pending"                                                                                                                                    | "inProgress"                                       | "completed"}]}`                 |
| `turn/diff/updated`                                                                                                                                                              | `{threadId, turnId, diff}`: an aggregated unified diff                                                                                                                                            |
| `error`                                                                                                                                                                          | `{error: TurnError, willRetry, threadId, turnId}`; may come before a failed `turn/completed`                                                                                                      |
| `serverRequest/resolved`                                                                                                                                                         | `{threadId, requestId}`: fires after any server request is answered **or cleared** by turn start, completion or interrupt                                                                         |
| `thread/compacted`, `model/rerouted`, `model/verification`, `warning`, `configWarning`, `deprecationNotice`, `hook/started`, `hook/completed`, `mcpServer/startupStatus/updated` | other notifications                                                                                                                                                                               |

**`TurnError`** is `{message, codexErrorInfo, additionalDetails, misalignment}`. `codexErrorInfo` is one of:

- `contextWindowExceeded`, `sessionBudgetExceeded`, `usageLimitExceeded`, `rateLimitExceeded`, `serverOverloaded`, `cyberPolicy`, `misalignmentPolicyViolation`.
- `{httpConnectionFailed:{httpStatusCode}}`, `{responseStreamConnectionFailed:{…}}`, `{responseStreamDisconnected:{…}}`, `{responseTooManyFailedAttempts:{…}}`.
- `internalServerError`, `unauthorized`, `badRequest`, `threadRollbackFailed`, `sandboxError`.
- `{activeTurnNotSteerable:{turnKind}}`, `other`.

### `ThreadItem` variants (`type`)

- `userMessage{id, clientId, content}`
- `hookPrompt`
- `agentMessage{id, text, phase, memoryCitation, delivery ("async" = sent without ending the turn), questions}`
- `functionCallOutput` (new since 0.145)
- `plan{text}`
- `reasoning{summary[], content[]}`
- `commandExecution{command, cwd, processId, source, status, commandActions, aggregatedOutput, exitCode, durationMs, pluginId, scriptPath}`
  - `source` is `"agent"|"userShell"|"unifiedExecStartup"|"unifiedExecInteraction"`.
  - `status` is `inProgress|completed|failed|declined`.
- `fileChange{changes:[{path, kind:{type:add|delete|update, move_path}, diff}], status}`
- `mcpToolCall{server, tool, status, arguments, result, error, durationMs, readOnlyHint, appContext, pluginId}`
- `dynamicToolCall`
- `collabAgentToolCall{tool, status, senderThreadId, receiverThreadIds[], prompt, model, reasoningEffort, agentsStates}`
- `subAgentActivity{kind:"started"|"interacted"|"interrupted"|"completed", agentThreadId, agentPath}`
- `webSearch`, `imageView`, `sleep`, `imageGeneration`
- `enteredReviewMode` / `exitedReviewMode`
- `contextCompaction`

## 4. Server→client requests (approvals and input)

Every one of these blocks the turn until answered. The server sends `serverRequest/resolved` once each is answered or cleared.

| Method                                                         | Params                                                                                                                                | Response                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item/commandExecution/requestApproval`                        | `kind: "command"                                                                                                                      | "writeStdin", threadId, turnId, itemId, startedAtMs, approvalId?, environmentId, reason?, networkApprovalContext?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments?`; experimental `additionalPermissions?, availableDecisions?` | `{decision}`, where decision is `"accept" | "acceptForSession"          | {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[…]}} | {"applyNetworkPolicyAmendment":{"network_policy_amendment":{host, action}}} | "decline"                                                                                | "cancel"` |
| `item/fileChange/requestApproval`                              | `threadId, turnId, itemId, startedAtMs, reason?, grantRoot?` (unstable)                                                               | `{decision: "accept"                                                                                                                                                                                                                                                            | "acceptForSession"                        | "decline"                   | "cancel"}`                                                     |
| `item/permissions/requestApproval`                             | `threadId, turnId, itemId, environmentId, startedAtMs, cwd, reason, permissions:{network, fileSystem}`                                | `{permissions: GrantedPermissionProfile (the granted subset; anything omitted is denied), scope: "turn"                                                                                                                                                                         | "session", strictAutoReview?}`            |
| `item/tool/requestUserInput` (marked EXPERIMENTAL in the docs) | `threadId, turnId, itemId, questions:[{id, header, question, isOther, isSecret, options}], isBlocking, autoResolutionMs` (deprecated) | `{answers: {[questionId]: {answers: string[]}}}`                                                                                                                                                                                                                                |
| `mcpServer/elicitation/request`                                | `threadId, turnId                                                                                                                     | null, serverName`& one of`mode:"form"{message, requestedSchema, _meta}`, `"openai/form"`, `"openaiForm"`, `"url"{url, elicitationId}`, `"openai/userVerification"`                                                                                                              | `{action: "accept"                        | "decline"                   | "cancel", content: JsonValue                                   | null, _meta: JsonValue                                                      | null}`. MCP tool approvals arrive here with `_meta.codex_approval_kind:"mcp_tool_call"`. |
| `item/tool/call` (dynamic tools, experimental)                 | `threadId, turnId, callId, namespace, tool, arguments`                                                                                | `{contentItems:[{type:"inputText"                                                                                                                                                                                                                                               | "inputImage"                              | "inputAudio",…}], success}` |
| `account/chatgptAuthTokens/refresh`                            | external-token auth only                                                                                                              |                                                                                                                                                                                                                                                                                 |
| `attestation/generate`                                         | only if `requestAttestation` is set                                                                                                   |                                                                                                                                                                                                                                                                                 |
| `currentTime/read`                                             | experimental                                                                                                                          |                                                                                                                                                                                                                                                                                 |
| `applyPatchApproval`, `execCommandApproval`                    | legacy v1 shapes (`ReviewDecision`); not used by the v2 thread/turn flow                                                              |                                                                                                                                                                                                                                                                                 |

Message order for a command approval:

1. `item/started` (commandExecution, inProgress)
2. the `requestApproval` request
3. the client's reply
4. `serverRequest/resolved`
5. `item/completed` (`completed|failed|declined`)

An unanswered approval sets `thread.status.activeFlags:["waitingOnApproval"]` and has no server-side timeout.

## 5. Background terminals, unified exec, subagents

- **Background terminals** are unified-exec PTY processes (`commandExecution` items with a `processId`). They **outlive the turn**: `turn/interrupt` does not kill them.
  - Manage them with experimental `thread/backgroundTerminals/list` (returns `{data:[{itemId, processId, command, cwd, osPid, cpuPercent, rssKb}], nextCursor}`, verified empty on an idle thread), `/terminate {threadId, processId}` (returns `{terminated}`), and `/clean {threadId}` (returns `{}`).
  - Without the opt-in, the call fails: "thread/backgroundTerminals/list requires experimentalApi capability" (verified).
- **When a background process exits after its turn ended** (source: `core/src/unified_exec/async_watcher.rs`, `spawn_exit_watcher`), the watcher emits a single `ExecCommandEnd`, using the **original turn's `TurnContext`**. On the wire that is `item/completed` for the `commandExecution`, carrying the **old `turnId`**, arriving **after that turn's `turn/completed`**. Live output deltas also keep arriving under the old turn id.
  - Nothing in that path injects input or starts a new turn, so **no new turn is triggered**. The model learns of it only when it next polls with `write_stdin`.
- **Limits** (`unified_exec/mod.rs`):
  - `MAX_UNIFIED_EXEC_PROCESSES = 64`.
  - Default background poll ceiling is `300_000` ms.
  - The output buffer is capped at 1 MiB.
- **Subagents (collab / Multi-Agent V2).** Spawned agents are separate threads with `parentThreadId`, plus `agentNickname` and `agentRole`.
  - The parent turn shows `collabAgentToolCall` and `subAgentActivity` items.
  - A child's completion `item/completed` **may arrive after the parent's `turn/completed`**; it is attributed to the parent turn that spawned it.
  - Parent-owned V2 subagents reject direct `turn/start`, `turn/steer`, settings updates and inject calls with `-32600` "direct app-server input is not allowed for multi-agent v2 sub-agents". `turn/interrupt` is allowed.
  - `thread/list` with experimental `parentThreadId` or `ancestorThreadId` lists descendants.
- **`command/exec`** (stable) and **`process/spawn`** (experimental) are client-driven one-off processes, separate from agent tools. They are connection-scoped and killed when the connection closes.

## 6. Account, auth, models, config, MCP

- **`account/read {refreshToken?}`** returns `{account: {type:"apiKey"} | {type:"chatgpt", email, planType} | {type:"amazonBedrock", …} | null, requiresOpenaiAuth}`. Verified result: `chatgpt`, `planType:"pro"`.
- **`account/login/start`** takes `LoginAccountParams`, one of:
  - `{type:"apiKey", apiKey}`
  - `{type:"chatgpt", …}`: browser flow; `account/login/completed {loginId, success, error}` follows.
  - `{type:"chatgptDeviceCode"}`
  - `{type:"chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType?}`
  - Bedrock variants.
- **Other auth methods:** `account/login/cancel`, `account/logout`. `account/updated` is a notification.
- **Rate limits.** `account/rateLimits/read` was verified. It returns:
  - `{ordinaryUsageAllowed, rateLimits: RateLimitSnapshot, rateLimitsByLimitId, rateLimitResetCredits, accountId, rateLimitUpsell}`.
  - `RateLimitSnapshot` is `{limitId, primary:{usedPercent, windowDurationMins, resetsAt}, secondary, credits:{hasCredits, unlimited, balance}, planType, rateLimitReachedType, …}`.
  - `account/rateLimits/updated` is **sparse**: merge it into the last read; don't replace.
- **`model/list {cursor, limit, includeHidden}`** returns `{data: Model[], nextCursor}`. `Model` is `{id, model, displayName, description, hidden, isDefault, supportedReasoningEfforts:[{reasoningEffort, description}], defaultReasoningEffort, inputModalities, supportsPersonality, multiAgentVersion, serviceTiers, defaultServiceTier, upgrade, upgradeInfo, …}`. Keep the effort array in the order given.
- **Config:** `config/read {includeLayers?, cwd?}`, `config/value/write`, `config/batchWrite`, `configRequirements/read`, `config/mcpServer/reload`.
- **MCP:** `mcpServerStatus/list {threadId?, detail?}`, `mcpServer/oauth/login`, `mcpServer/tool/call`, `mcpServer/resource/read`.
- **Also stable:** `skills/*`, `hooks/list`, `plugin/*`, `marketplace/*`, `app/*`, `fs/*`, `feedback/upload`, `review/start`, `permissionProfile/list`, `experimentalFeature/*`.

## 7. Stable vs experimental (0.154)

In the TS output, the notification union is identical in both modes.

**Methods that require `capabilities.experimentalApi:true`:**

- `thread/backgroundTerminals/{list,terminate,clean}`
- `thread/settings/update`, `turn/settings/update`
- `thread/queue/{add,list,update,delete,reorder,start}`
- `thread/search`, `thread/searchOccurrences`, `thread/timeline/list`
- `thread/memoryMode/set`, `memory/reset`
- `thread/increment_elicitation`, `thread/decrement_elicitation`
- `thread/realtime/*`
- `collaborationMode/list`
- `environment/{add,info,status}`
- `process/{spawn,kill,writeStdin,resizePty}`
- `fuzzyFileSearch/session*`
- `project/*`
- `remoteControl/*`
- `userVerification/*`
- `account/bedrock/{discover,setup}`
- `mcpServer/event/stream/{start,stop}`
- `plugin/search`
- `server/diagnostics`
- `mock/experimentalMethod`
- the server request `currentTime/read`

**Experimental-only fields** are listed in sections 2–4. Beyond those: `CommandExecutionRequestApprovalParams.additionalPermissions` and `availableDecisions`; `ThreadListParams.parentThreadId`, `ancestorThreadId` and `projectId`; and the `granular` approval-policy variant.

**What happens without the opt-in:** the request fails with `-32600 "<descriptor> requires experimentalApi capability"`. Descriptors look like `thread/start.permissions` or `askForApproval.granular`.

**Everything else is stable**, including: `thread/start|resume|fork|list|read|archive|unarchive|delete|unsubscribe|loaded/list|turns/list|items/list|rollback|revert|compact/start|inject_items|shellCommand`, `turn/start|steer|interrupt`, `model/list`, the `account/*` methods, `config/*`, and `mcpServerStatus/list`.

## 8. CODEX_HOME, config, and multiplexing

- **Home directory.** `CODEX_HOME` comes from the process env when the process spawns, and `initialize` echoes it as `codexHome`. The env (PATH, API keys and so on) is inherited from the spawner and used by every thread. `shell_environment_policy` controls what tools see.
- **Process-wide overrides.** `codex app-server -c key=value` (TOML values), `--enable` and `--disable FEATURE`, and `--strict-config` apply to every thread in the process.
- **Per-thread overrides.** `thread/start|resume|fork` take a `config: {dotted.key: JsonValue}` map plus the first-class fields.
- **One process, many threads.** One process and one connection can host many loaded threads, each with its own `cwd`, sandbox, approval policy, model and developer instructions. `turn/start` can change cwd, sandbox, approval, model and effort per turn, and those changes stick.
- **One turn per thread.** Each thread runs at most one active turn; a second `turn/start` steers into it. Different threads run concurrently.
- **Bounded queues.** Overload returns `-32001`.
- **Notifications are per subscription.** Notifications reach only connections subscribed to that thread. Start, resume and fork auto-subscribe.
- **MCP servers start per thread.** The user's configured MCP servers start for each loaded thread (seen in the smoke run). A separate `CODEX_HOME` or `-c mcp_servers…` is needed to isolate them.

## 9. Version compatibility

- **No protocol version is negotiated.**
  - Parse the version from `initialize.result.userAgent` (`…/0.154.0 …`) or from `codex --version`.
  - Generated schemas are tied to the binary that produced them, so regenerate on every bump and diff.
  - New optional fields keep appearing, and unknown notification methods should be ignored.
- **0.145.0 → 0.154.0**, additive only; nothing was removed. All new methods are experimental except where marked:
  - **New methods:** `thread/revert` and `thread/section/move` (stable), `threadSection/*`, `plugin/reconcile`, `externalAgentConfig/import/recordHistory`, `thread/queue/*`, `turn/settings/update`, `thread/timeline/list`, `project/*`, `userVerification/*`, `server/diagnostics`, `account/bedrock/*`, `mcpServer/event/stream/*`, `plugin/search`.
  - **Promoted to stable:** `thread/items/list` and `thread/turns/list` were experimental in 0.145.
  - **New notifications:** `thread/reverted`, `thread/queue/changed`, `project/changed`, `thread/project/updated`, `autoApprovalReview/strictReviewRequired`, `modelProvider/authRecovery{Started,Completed}`, `mcpServer/event/stream/notification`, `thread/realtime/item/*`.
  - **New fields:**
    - `TurnStartParams`: `turnTrigger`, `toolOutput`, `serviceTierForTurn`, `cyberAccessProgram`.
    - `CommandExecutionRequestApprovalParams.kind` (`command|writeStdin`).
    - `ToolRequestUserInputParams.isBlocking`.
    - `InitializeCapabilities.extensions`.
    - `Thread`: `model`, `reasoningEffort`, `originator`, `section`, `projectId`.
    - `TurnError.misalignment`.
    - `Model`: `modelSpecialty`, `multiAgentVersion`.
  - **New item:** `ThreadItem` gained `functionCallOutput`.
  - **CLI flag:** `--code-mode-host` was added.
- **Upstream docs are stale.** The README was removed after 0.150. Its examples also use wrong enum spellings: `"sandbox":"workspaceWrite"` and `"approvalPolicy":"unlessTrusted"`. The 0.154 binary rejects `workspaceWrite` (verified); the correct values are `workspace-write` and `untrusted`. Trust the generated schema.

## 10. Open risks for an integrator

1. **`turn/start` silently steers** when a turn is already active. DorkOS must serialize turns per thread, or treat a response turn id that matches the active turn as "steered".
2. **Late events after `turn/completed`.** Background-terminal exits and subagent completions emit `item/completed` (and deltas) under an already-completed turn id. Per-turn streams that close on `turn/completed` will drop them, or attribute them to a closed turn. They need a thread-level sink.
3. **Background terminals outlive interrupts and turns,** with up to 64 processes per session. Cleaning them up requires the experimental API. Opting in moves DorkOS onto a surface with no compatibility guarantees.
4. **`turn/completed` carries no usage.** Cost and usage accounting must fold `thread/tokenUsage/updated`, which carries cumulative `total` and per-step `last`.
5. **Approvals block indefinitely.** If the client never answers, the turn hangs. `serverRequest/resolved` may also clear a request DorkOS is still showing (on interrupt or completion), and the UI must withdraw the card.
6. **Sandbox spelling differs by method.** `thread/start` takes the kebab-case `SandboxMode` string; `turn/start` takes the tagged `SandboxPolicy` object. Mixing them up fails with `-32600`.
7. **Side effects on the user's Codex install.** `thread/start` with a cwd and a writable sandbox writes trust into `config.toml`. Threads start the user's MCP servers and hooks, and are listed as `source:"vscode"`. A dedicated `CODEX_HOME` avoids most of this, but then loses the user's sign-in unless auth is copied or `account/login/start` is driven.
8. **Errors aren't distinguishable by code.** All JSON-RPC rejections, including unknown methods and missing threads, are `-32600`, so classification has to parse the message text.
9. **No version handshake.** Schema drift is silent. Pin the binary, regenerate types in CI, and parse `userAgent` for the version.
10. **Rollouts from newer Codex versions.** The operator's Codex Desktop (0.159.2) writes `historyMode:"paginated"` threads into the same `~/.codex`. Listing them from 0.154 worked; resuming them with a turn was not tested.
11. **Subagent subscription is unverified.** Whether the parent connection is auto-subscribed to spawned subagent threads, and so gets their `item/*` events, was not confirmed. Only the parent-side `subAgentActivity` items are documented.
12. **One process is a shared blast radius.** A crash or OOM takes down every thread. The 30-minute idle unload means memory grows with the number of threads.
13. **Unverified with a real turn.** The streaming item shapes, the approval round-trips, `availableDecisions` and `item/fileChange/patchUpdated` (feature-flagged) were not run, because a turn costs money. A single cheap turn should confirm them before cut-over.
