# @opencode-ai/sdk Changelog: 1.18.15 → 1.18.30

**Generated**: 2026-09-11
**Sources**: GitHub Releases (sst/opencode, monorepo — 872 releases fetched, filtered to the 15 tags in range and then to Core/server relevance), npm registry timestamps (`@opencode-ai/sdk` and the `opencode-ai` sidecar), `.d.ts` diff of the packed 1.18.30 tarball against the installed 1.18.15 tree
**Releases covered**: 15 (1.18.16 → 1.18.30, 2026-08-10 → 2026-09-09)
**Dist-tags**: only `latest` (→ 1.18.30) considered; every `0.0.0-snapshot-*` channel ignored per `runtime-deps.json` guidance.
**Bullet split**: 59 Core (server/CLI — DorkOS's actual dependency surface) vs 15 Desktop/TUI bullets. This range is unusually Core-heavy compared with 1.17.13→1.18.15, where Desktop dominated. Desktop/TUI bullets are counted, not analyzed.

## Version timeline

| SDK         | Published                | Sidecar `opencode-ai` | Published                |
| ----------- | ------------------------ | --------------------- | ------------------------ |
| 1.18.16     | 2026-08-10T06:06:55Z     | 1.18.16               | 2026-08-10T06:05:51Z     |
| 1.18.17     | 2026-08-12T20:25:50Z     | 1.18.17               | 2026-08-12T20:23:26Z     |
| 1.18.18     | 2026-08-13T01:14:50Z     | 1.18.18               | 2026-08-13T01:13:43Z     |
| 1.18.19     | 2026-08-20T06:22:05Z     | 1.18.19               | 2026-08-20T06:21:26Z     |
| 1.18.20     | 2026-08-21T08:10:32Z     | 1.18.20               | 2026-08-21T08:09:54Z     |
| 1.18.21     | 2026-08-21T14:52:11Z     | 1.18.21               | 2026-08-21T14:51:28Z     |
| 1.18.22     | 2026-08-24T14:38:14Z     | 1.18.22               | 2026-08-24T14:37:31Z     |
| 1.18.23     | 2026-08-25T06:30:45Z     | 1.18.23               | 2026-08-25T06:33:58Z     |
| 1.18.24     | 2026-08-28T04:10:04Z     | 1.18.24               | 2026-08-28T04:09:47Z     |
| 1.18.25     | 2026-08-28T05:58:34Z     | 1.18.25               | 2026-08-28T05:57:34Z     |
| 1.18.26     | 2026-09-01T21:51:56Z     | 1.18.26               | 2026-09-01T21:51:32Z     |
| 1.18.27     | 2026-09-02T21:41:52Z     | 1.18.27               | 2026-09-02T21:39:46Z     |
| 1.18.28     | 2026-09-04T15:38:28Z     | 1.18.28               | 2026-09-04T15:40:40Z     |
| 1.18.29     | 2026-09-04T23:47:04Z     | 1.18.29               | 2026-09-04T23:46:25Z     |
| **1.18.30** | **2026-09-09T03:36:39Z** | **1.18.30**           | **2026-09-09T03:33:55Z** |

Every SDK version has a matching sidecar version published within ~3 minutes. The lockstep the previous upgrade pass observed holds without exception across this range.

## Type-level findings (`.d.ts` diff)

The packed 1.18.30 tarball's `dist/` was diffed file-by-file against the installed 1.18.15 tree (`node_modules/.pnpm/@opencode-ai+sdk@1.18.15`). **Every file reachable from DorkOS's imports is byte-for-byte identical**: `index.d.ts`, `client.d.ts`, `server.d.ts`, `process.d.ts`, `error-interceptor.d.ts`, `gen/types.gen.d.ts`, `gen/sdk.gen.d.ts`, `gen/client.gen.d.ts`, and every file under `gen/core/` and `gen/client/`. `package.json` differs only in the `version` field.

Concretely, on the top-level export:

- `Event` union: **32 members, unchanged** — zero added, zero removed, zero reshaped. No new candidate for `event-mapper.ts`'s dispatch or `global-event-hub.ts`'s fan-out.
- `Part` union: **2 members, unchanged**.
- `OpencodeClient` (`gen/sdk.gen.d.ts`, 403 lines): every method signature identical. `createOpencodeClient` identical.
- `AssistantMessage`, `Permission`, `SessionStatus`, `Todo`, `ToolPart`, `Session`, `Message`, `ProviderListResponse`, `McpStatus`, `McpLocalConfig`, `McpRemoteConfig`, `SessionMessagesResponse`, `FilePart`, `TextPart`, `ReasoningPart`, `ToolState`, `UserMessage`: all unchanged.

Exactly three files in the whole tarball differ, all under the separate `@opencode-ai/sdk/v2` export subpath:

1. `dist/v2/gen/types.gen.d.ts` — provider `chunkTimeout` widened from `number` to `number | false`, and both `headerTimeout` and `chunkTimeout` gained documented five-minute defaults (this is the type-level shadow of the 1.18.27 server change itemized below); the index-signature union widened to match.
2. `dist/v2/gen/types.gen.d.ts` — `GlobalUpgradeData.body.target` changed from `target?: string` to `target: string` (a **required-parameter** change, and the only formally breaking type change anywhere in the tarball).
3. `dist/v2/gen/sdk.gen.d.ts` / `.js` — the matching TSDoc on `global.upgrade` ("or latest if not specified" dropped).

**None of this is reachable from DorkOS.** Grep confirms zero `@opencode-ai/sdk/v2`, `/client`, `/server` or any other subpath import anywhere under `apps`, `packages` or `scripts` — every DorkOS import is the bare specifier. The `GlobalUpgradeData` break is unreachable twice over: DorkOS never calls `global.upgrade` (it provisions the sidecar itself via `npm install opencode-ai@<pin>` in `providers/provision.ts`).

**The consequence worth stating plainly**: a second consecutive upgrade window has produced zero change on DorkOS's imported surface, while the `/v2` subpath moved both times. The generated v1 types this adapter is built on are effectively frozen; upstream's active type work is happening in v2. That is the watch item this range escalates (see Internal ⚪).

## Breaking Changes 🔴

**None on DorkOS's surface.** The one formal breaking type change in the tarball — `GlobalUpgradeData.body.target` becoming required — lives in `@opencode-ai/sdk/v2`, a subpath DorkOS does not import, on a method DorkOS does not call. No Core release note in the 15-release range describes a subtractive change to the REST/SSE contract DorkOS's client speaks.

## Deprecations 🟡

None announced. The v1/v2 watch item from the previous pass gained two concrete data points rather than a deprecation:

- **1.18.19**: "Preserved compatibility with existing v1 databases."
- **1.18.24**: "V1 now reads supported V2 config fields so newer config files keep working in more mixed setups."

Upstream is actively maintaining v1↔v2 compatibility, which is reassuring for DorkOS's position on v1 — but both notes confirm the migration is live and ongoing. Re-check this section on the next bump.

## New Features 🟢

Only two Core items in this range are additive rather than corrective; both are provider-catalog changes that flow through the already-typed `ProviderListResponse` with no DorkOS code change.

### 1.18.19 — Cloudflare AI Gateway native passthroughs (2026-08-20)

- Added native OpenAI and Anthropic passthroughs for Cloudflare AI Gateway models.
  - **Relevance**: none for DorkOS code. New provider routing appears in the catalog `providers/models.ts` projects; no shape change.

### 1.18.24 — Azure Entra ID sign-in via the Azure CLI (2026-08-28)

- Azure providers can sign in with Microsoft Entra ID through the Azure CLI instead of requiring an API key (1.18.25 followed up so this works without Bun installed).
  - **Relevance**: low. DorkOS's own connect flow (`providers/check-dependencies.ts`, `services/runtimes/connect/credentials.ts`) covers OpenRouter/Ollama/direct-provider paths; Azure is an OpenCode-CLI-side auth path DorkOS does not drive. Informational.

### 1.18.28 — Copilot session-ID interaction header (2026-09-04)

- The session ID is sent as GitHub Copilot's interaction header to improve request tracking across a session.
  - **Relevance**: none — provider-side telemetry, invisible to DorkOS's client.

### 1.18.30 — Astra system prompt for GPT-6 (2026-09-09)

- Added the Astra system prompt for GPT-6 models (1.18.29 fixed the matching Codex OAuth model filtering so integer GPT versions like `gpt-6` and `gpt-6-astra` are recognized).
  - **Relevance**: none for code; a model-catalog item only.

## Bug Fixes 🔧

Grouped by the DorkOS subsystem each touches, not strictly by version. Bold entries land inside code this adapter actively wraps (skill relevance heuristic #1).

**Turn reliability — retries and finish reasons** (touches `events/session-event-mapper.ts`'s `mapSessionError` and the turn's terminal path in `events/event-mapper.ts`):

- **1.18.17**: Capped automatic session retries and added jitter to reduce repeated retry storms.
- **1.18.20**: Retry provider responses ending with `finish_reason: network_error`; retry more network-error variants (`network-error`, `network_error`); retry xAI capacity and temporary-unavailability stream errors.
- **1.18.21**: Continue responses when a model reports an unknown finish reason instead of stopping early.
- **1.18.27**: Avoid unhandled errors when canceling timed-out SSE reads.

**Provider stream timeouts** (behavioral, no type change — see the impact assessment's own category):

- **1.18.27**: Default provider header timeouts to five minutes so slow model startups fail less often; default streamed chunk timeouts to five minutes, with `false` supported to disable them.

**Subagents** (touches `events/subagent-mapper.ts`, which opens a task card per child session and closes every one the turn left open):

- **1.18.20**: Surface failed subagent tool calls with a resumable `task_id`; surface resumable subagent failures instead of returning an empty result; answer permission requests triggered by subagents during `opencode run` (the `opencode run` half is not DorkOS's path — DorkOS drives the server API).

**Tool-call timing and permission metadata** (touches `events/part-event-mapper.ts` and `messaging/approvals.ts`):

- **1.18.26**: Tool-call timing now stays accurate when tools update their metadata while still running (a `time.start` reset bug); `apply_patch` no longer emits an empty move path in permission metadata.

**Compaction** (touches `messaging/compaction-model.ts` and the `session.compacted` branch of `events/event-mapper.ts`):

- **1.18.17**: Session compaction keeps complete recent turns and produces clearer summaries for smaller models.

**Cost and usage** (touches `events/session-event-mapper.ts:139-149`, which reads `assistant.cost` and `assistant.tokens.*`):

- **1.18.19**: Ignore malformed model pricing instead of breaking usage cost calculation.

**Config parsing** (touches what DorkOS writes through `client.mcp.add` / `mcp/mcp-server-config.ts`, and the user's own `opencode.json`):

- **1.18.16**: Ignore unknown top-level config fields instead of failing config parsing.
- **1.18.24**: V1 reads supported V2 config fields.
- **1.18.27**: Anthropic `thinking.blockBinding` can be opted out via config; blockBinding limited to Claude 5.1+ models so older deployments do not reject requests.

**Session/project routing**:

- 1.18.16: Register projects opened from Home so they are available to the rest of the app (Desktop-adjacent, Core-sectioned).
- 1.18.23: Parent session IDs are no longer sent in request headers for session-aware providers.
- 1.18.26: Claude 5 sessions tolerate stale thinking blocks instead of failing after prompt or tool changes.

**Provider/model routing** (no DorkOS code path, listed for completeness):

- 1.18.17: MERGE Gateway reasoning variants; Copilot PDF attachments; DeepSeek V4 Flash sampling defaults; Muse-family → Meta system prompt.
- 1.18.18: Kimi system prompt for Moonshot/Kimi; xAI `xhigh` reasoning effort.
- 1.18.19: Removed Qwen sampling defaults; authenticated providers shown correctly in `/connect`; OpenAI websocket message-size fallback; ChatGPT workspace compute residency forwarded to Codex; default Console URL updated; web search enabled for the OpenCode Go provider; Codex rate limits matched to ChatGPT subscription limits.
- 1.18.20: Preserve Cerebras `max_completion_tokens` without an extra output cap.
- 1.18.21: Vertex AI `eu`/`us` multi-region Gemini routed through REP endpoints.
- 1.18.22: OpenCode device-login links fixed for relative verification URLs / base paths; `textVerbosity` no longer sent to OpenAI-compatible providers that reject it; Bedrock provider compatibility; removed OpenCode Go first-month discount messaging.
- 1.18.23: Cloudflare AI Gateway routing for third-party providers; Anthropic dotted→dashed model slugs through the gateway.
- 1.18.24/1.18.25/1.18.26: Bedrock reasoning no longer cached into unreplayable empty messages; Azure CLI sign-in without Bun; Bedrock GPT-5.6 accepts `none` reasoning effort; Bedrock reasoning/replay reliability; Azure CLI sign-in asks for the resource name directly.
- 1.18.30: Bedrock DeepSeek model IDs (including ARN-based) preserved; Azure and OpenAI provider SDKs updated; GitLab GPT/Claude reasoning-effort variants.

## Performance ⚡

Nothing Core/server-side in this range. 1.18.17's retry cap + jitter is categorized as a fix (it stops retry storms) rather than a performance item, but it does change the latency profile of a flaky turn.

## Internal ⚪

- **The v1 type surface is frozen; upstream's type work is in v2.** Two consecutive upgrade windows (1.17.13→1.18.15, and now 1.18.15→1.18.30, 38 releases combined) have left `dist/gen/*` byte-identical while `dist/v2/gen/*` changed in both. Every behavior change DorkOS cares about in this range is server-side, invisible to the compiler. The practical conclusion: for this SDK the type diff is a cheap _negative_ check — it reliably proves nothing broke at compile time — and the release notes plus a live turn are the only evidence that matters.
- 1.18.18 and 1.18.25 are single-concern Core patches with no Desktop/TUI content at all.
- Desktop/TUI accounted for 15 of 74 bullets (20%), a sharp reversal from the previous window where they were the large majority. None of the 15 is reachable from DorkOS's server-side client: project-menu right-click, zh-Hans token terminology, macOS last-window behavior, file-search result persistence, archive-session command registration, model-picker header stickiness, stacked-dialog focus, session-rename saving, desktop client ID for device auth, open-in icon size, and GitHub auth for immutable OIDC subject tokens (TUI).
