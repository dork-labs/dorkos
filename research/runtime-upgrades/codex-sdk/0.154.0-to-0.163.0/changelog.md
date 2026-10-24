# `@openai/codex-sdk` + `@openai/codex` 0.154.0 → 0.163.0 — Changelog

- **Generated**: 2026-10-20 (read-only analysis against `dorkos-wt/dor-3028-skills` at `c31970db88`, i.e. `origin/main`)
- **Sources**: npm registry `time` + `dist-tags` (target resolution); byte diff of the packed SDK tarballs (0.154.0, 0.163.0, alpha 0.164.0-alpha.7); **a regenerated app-server protocol snapshot** from the real 0.163.0 `darwin-arm64` binary, built with a copy of the repo's own `snapshot.ts` builder and diffed against the committed `schema-snapshot.json` (full diff: `protocol-snapshot-diff.txt` (local scratch, not committed), 342 lines; new snapshot: `schema-snapshot-0.163.0.json` (local scratch, not committed)); `codex features list` from both binaries under a scratch `CODEX_HOME` (`features-0.154.0.txt`, `features-0.163.0.txt`); GitHub releases `rust-v0.155.0` … `rust-v0.163.0` (17 stable tags; notes cached in `notes/` (local scratch, not committed)); upstream source diffs of `models-manager/src/{cache,manager}.rs` and `tui/src/token_usage.rs`; selected PR bodies via `gh api`.
- **Versions covered**: 17 stable releases — 0.155.0, 0.155.1, 0.156.0, 0.156.1, 0.157.0, 0.157.1, 0.158.0, 0.159.0, 0.159.1, 0.159.2, 0.159.3, 0.160.0, 0.160.1, 0.161.0, 0.162.0, 0.162.1, **0.163.0** (published 2026-10-15T21:37Z). ~1,000+ merged PRs across the span.
- **dist-tags at analysis time**: `latest` = **0.163.0** for both `@openai/codex-sdk` and `@openai/codex`; `alpha` = 0.164.0-alpha.7 (2026-10-20).
- **Desktop npm aliases exist**: `@openai/codex@0.163.0-darwin-arm64` and `@openai/codex@0.163.0-win32-x64` both resolve on npm.

## Headline findings

1. **The TypeScript SDK changed by one optional field.** `dist/index.d.ts` gains `type CyberAccessProgram = "standard" | "daybreak_blue" | "daybreak_red"` and an optional `TurnOptions.cyberAccessProgram`; `dist/index.js` forwards it as `--cyber-access-program` (#49939). `ThreadEvent`, `ThreadItem` and every item type, `CodexOptions`, `ThreadOptions`, `SandboxMode`, `ModelReasoningEffort`, `ApprovalMode`, `Usage` are unchanged. The exec event-mapper's `never` tripwires cannot fire. README and LICENSE are identical.

   | File                | 0.154.0 sha256                                                     | 0.163.0 sha256                                                     |
   | ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
   | `dist/index.d.ts`   | `954d28bec3db17316c2f6acbbd157210ded9f75143c50827215739110327c7ac` | `5b57ce417b5f6e608c8e52707761384be220ff27e0206e93e4c253e83f206a8f` |
   | `dist/index.js`     | `d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f` | `340f42940ffd5c7b31e6e11a159517339c048d30577d88cafeac976cd620f6a4` |
   | `dist/index.js.map` | `830f7fb2…`                                                        | `40bad72f…`                                                        |
   | tarball             | `1b64f973…` (`openai-codex-sdk-0.154.0.tgz`)                       | `4d70dfef…` (`openai-codex-sdk-0.163.0.tgz`)                       |

   `package.json`: `version` and the `@openai/codex` dependency pin move to 0.163.0, nothing else.

2. **The app-server protocol is where the bump bites, and it is compile-visible.** The regenerated snapshot (my rebuild of 0.154.0 reproduces the committed `schema-snapshot.json` byte-for-byte, so the 0.163.0 diff is exactly what `protocol-snapshot.binary.test.ts` will report) shows:
   - **4 new server notifications** (insertions only; existing order preserved): `thread/readState/changed` (index 3), `thread/attachment/updated` (11), `thread/prediction/updated` (13), `account/gatewayOAuth/changed` (48). `SERVER_NOTIFICATION_METHODS` is checked order-sensitively against the snapshot, and `NOTIFICATION_DISPOSITION` is a `Record` over the union, so both must change.
   - **No change** to server-request methods (11) or `ThreadItem` types (19).
   - **No change** to any outbound field DorkOS sends; only additive optional params (`TurnStartParams.parentTurnId/rootTurnId/disabledPluginIds`, `ThreadStartParams.daybreakEnabled`, `InitializeCapabilities.explicitGatewayOauth`).
   - Enum widenings DorkOS reads loosely: `MessagePhase` + `partial_answer`; `CodexErrorInfo` + `flexUnavailable`, `tooManyDenials`, and `oneOf` → `anyOf` with an open catch-all (#49806); `PlanType` + `promax`.
   - `thread/rollback` removed from the protocol (#44915). DorkOS never used it.

3. **The vendored CLI changed shape**: the patched `zsh` resource is gone (#52160) and a GStreamer **voice runtime** is bundled (`codex-resources/voice/`, 25 new Mach-O files: one helper binary, 7 plugins, 17 dylibs). darwin-arm64 grows 290 MB → 341 MB unpacked (7 → 43 files); win32-x64 399 MB → 466 MB (8 → 47 files). This reaches the desktop app, which unpacks the whole vendor package out of asar.

---

## 🔴 Breaking

**None in the SDK's typed surface** (the only change is an added optional field).

### App-server: four new notification methods — compile/test-breaking for DorkOS by design

- **Versions**: `thread/attachment/updated` (attachments API, 0.155–0.162: #43927, #44330, #44350, #44564, #50094), `thread/prediction/updated` (#49480, #51884), `thread/readState/changed` (#52350, #52395, 0.163.0), `account/gatewayOAuth/changed` (explicit gateway OAuth, #47207, 0.157.0).
- **Affected**: `app-server/protocol/methods.ts` `SERVER_NOTIFICATION_METHODS`, `app-server/notification-mapper.ts` `NOTIFICATION_DISPOSITION`, `schema-snapshot.json`.
- **Effect**: `protocol-schemas.test.ts:212` (order-sensitive `toEqual`) and `protocol-snapshot.binary.test.ts` fail until the list and snapshot are updated; `notification-mapper.ts` fails to compile until each new method has a disposition. None of the four is something DorkOS reads; all four are `'ignored'`.

### App-server: `thread/rollback` removed — #44915 (0.156.0)

Deprecated API removed. DorkOS's `CLIENT_REQUEST_METHODS` never included it. **No impact.**

### CLI: `personality` feature removed, `friendly`/`pragmatic` no longer select a style — #44946, #45809, #51223

DorkOS never sends `personality`. **No impact.**

### CLI: patched zsh backend removed — #52160 (0.163.0)

`shell_zsh_fork` / `unified_exec_zsh_fork` are now ignored with a migration notice. DorkOS sets neither. The vendored `codex-resources/zsh` directory is gone. **No impact on the server; desktop bundle content changes (see Behavioral).**

### CLI: `tui.prompt_suggestions` and bundled `plugin-creator` skill removed — #48621, #48604 (0.159.0)

TUI-only. **No impact.**

---

## 🟡 Deprecated

- `TurnStartParams.personality` is now documented `@deprecated` (#45809). Unused by DorkOS.
- `mcpToolCall.mcpAppResourceUri` is now "legacy compatibility; prefer `mcpAppUi.resourceUri`" (#45805, #48764). DorkOS does not read it.
- `transcript_v2` feature marked deprecated; `remote_compaction_v2` and `guardian_ext` flags removed (behavior folded in: remote compaction is always on for supported providers, #44255, #44273).

---

## 🔵 Behavioral — no compiler catches these

### Instant interrupts on by default — #51812, #51835 (0.163.0)

`instant_interrupt` (still "under development") and `code_mode_interrupt` now default **true**: new user input preempts an in-flight model response instead of waiting for the next request. DorkOS's `turn/steer` (and `turn/start` on a busy thread, which steers) therefore lands _mid-response_: the current `agentMessage` can end early and the turn continues with the steer. Relevance: **medium** — the steer path the binary test covers (`app-server.binary.test.ts` "steers a running turn") should still pass, but a streamed message may be cut, which the chat UI should render as a normal shorter message.

### `partial_answer` message phase — #51241, #51249, #51260 (0.162.0)

`agentMessage.phase` can be `partial_answer` ("stable answer text that may be followed by more assistant output or tools"). DorkOS's notification mapper does not read `phase`, streams every `agentMessage` by item id, so more message items per turn simply render as more text. **Low**, but anything that ever starts treating "the last agentMessage" as the final answer must use `final_answer`.

### Model catalog and defaults

- GPT-6 Sol and GPT-6 Luna added (0.156.1 #47405, 0.157.0 #47332); **GPT-6.1 Sol becomes the bundled default** (0.159.1 #49323, 0.161.0 #49318). An agent with no explicit model now resolves to GPT-6.1 Sol (or the account's server default) instead of GPT-6-Astra.
- GPT-5.4 removed from bundled catalogs (#47932); retired entries removed with migration prompts kept (#44250); `ultrafast` tier removed from `gpt-5.6-sol` (#47130); base instructions excluded from the bundled catalog (#43604).
- **API-key model discovery on by default** (#44392 opt-in in 0.155.0 → #49807 stable and default in 0.161.0): API-key sign-ins now get a remote `model/list` catalog instead of only bundled models. The DorkOS model picker for API-key users will list a different set.
- Model catalog caches now carry a provider+auth **identity** (#43897, #43906): `models_cache.json` gains an optional `identity` field and an unscoped entry is a cache miss; an invalidated entry is marked with `fetched_at = DateTime::<Utc>::MIN_UTC`. Same filename, same 300 s TTL. `model-context-windows.ts` keeps working (`z.object` strips `identity`; a MIN_UTC date fails the freshness check and returns an empty map). The `client_version` mismatch still blanks enrichment for one ≤300 s window after the bump, as at every bump.
- `Model.availableAccessPrograms` added to `model/list` (Cyber programs). Stripped by `AppServerModelSchema`.
- Server-default respect for new threads continues (#50013, #50811, #50913; TUI-focused).

### Cyber access / Daybreak on by default — #49856, #49939, #53701, #53717 (0.161–0.163)

`cli_daybreak` and `api_key_cyber_access_programs` are now stable and default **true**. Routing still requires an eligible account, the OpenAI provider and advertised model support; on app-server, `ThreadStartParams.daybreakEnabled` "omitted or null leaves it unset" and `TurnStartParams.cyberAccessProgram` "omission preserves automatic behavior". DorkOS sends neither. Credits threads use a custom provider and are outside it. **Low**; worth knowing if a person asks why a security-flavored request was handled differently.

### Approval and sandbox tightening

- `write_stdin_approval` stable and on (#47799, 0.158.0): writing terminal input to a command running with elevated permissions now asks first. Under Ask first / Workspace write this can raise an extra `item/commandExecution/requestApproval` card. **Low-medium.**
- Approved commands keep explicit filesystem denials; `.aws` protected by default under writable roots (#48155, #48176, 0.159.0).
- Permission grants bound to the originating turn; background tasks keep their originating turn's permissions (#49880, #49353).
- Saved thread permissions restored on cold resume "while respecting explicit overrides" (#53150, #53419, #53424, 0.163.0). DorkOS sends `approvalPolicy` + `sandbox` explicitly on every load, so the explicit side wins.
- Sandbox hardening across macOS/Linux (read-only file handles, privileged sockets, Seatbelt TLS, network policy across redirects and DNS: #45984, #46500, #47389, #47407, #48565, #51650, #52661, #53506). Pure upside.

### Workspace trust

- #46328: `thread/start` no longer persists **implicit** trust for projectless directories (no project marker, git checkout or `.codex/`). DorkOS always sends an explicit in-memory `projects.<realpath>.trust_level` on writable loads, which is the mechanism the spike verified; this change narrows the case it guards against. **Low**, but it is the spike check to re-run (`app-server.binary.test.ts` covers the trust write for free).
- #44746 / #44732 folder-trust prompt rework, #47620 / #47924 portable project trust lookups, #49160 sessions outside a project with workspace defaults. TUI-facing or internal.

### Token usage

- #53670 (0.163.0): usage from `response.incomplete` turns is now added to cumulative totals without replacing the context baseline. Totals on a failed/incomplete turn can be higher than before; `last` (what `turn-context-usage.ts` reads) is not affected. The `TokenUsageBreakdown` schema is unchanged; `tui/src/token_usage.rs` (the source `turn-context-usage.ts` cites) is byte-identical between the two tags.
- #50442 native USD amounts in thread usage responses (not read by DorkOS).

### Process and lifecycle

- #44523: app-server stdio shutdown is bounded and Unix SIGTERM is handled gracefully; #51470 raises the managed app-server fd limit; #51872 global app-server config independent of launch directory; #47155 stale `thread/closed` after resume ignored; #50380 thread unload after disconnect during MCP startup fixed; #49084 running turns tracked incrementally. All passive improvements for DorkOS's long-lived per-home process.
- Daemon features (#47179 auto-start, #49426 analytics for daemon-launched servers) apply to interactive TUI launches, not to DorkOS's `app-server --stdio`.

### Vendored package contents (desktop)

`codex-resources/zsh` removed, `codex-resources/voice` added (GStreamer, Opus, GLib dylibs plus `codex-voice-host`). The desktop app unpacks `@openai/codex-darwin-arm64/**` and `@openai/codex-win32-x64/**` (`apps/desktop/electron-builder.yml:197-199`), so 25 more Mach-O files go through electron-builder signing and Apple notarization, and the installer grows by roughly 50 MB (mac) / 67 MB (win) unpacked.

---

## 🟢 Features

### SDK (exec fallback)

- `TurnOptions.cyberAccessProgram` (#49939). Not relevant while exec is the fallback.

### App-server protocol (reachable from DorkOS's transport)

- **Turn lineage**: `parentTurnId` / `rootTurnId` on `turn/start` and `Turn.rootTurnId` (#51415, #51402). Lets delegated work be attributed to the turn that caused it.
- **`subAgentActivity` carries the helper's resolved `model` and `reasoningEffort`** at creation.
- **Per-thread disabled plugins**: `disabledPluginIds` on `turn/start` and in thread load results (#44332, #44905).
- **Durable thread read state** (`thread/readState/changed`, `thread/read` → `readState`, `ThreadUnreadPosition`) (#52350, #52395).
- **Thread item lookup and anchored pagination** (`thread/items/read` / `thread/items/list` anchors) (#48151, #52637); `thread/list` exclusions (#51595).
- **Thread attachments API** (`thread/attachment/*`) (#44564, #50094).
- **MCP App UI metadata** on `mcpToolCall` items (`mcpAppUi.resourceUri`, `preferredModelDisplayMode`) (#45805, #48764).
- MCP elicitation params carry `_meta` (already observed live at 0.154 via a looser path); abandonment of unanswered elicitations signalled (#51611); subagents can raise elicitations (#46877).
- `TurnToolOutput.retain` — ask Codex to keep a tool output across compaction (#52937).
- Experimental prediction forks (`ThreadForkParams.experimentalPredictionMode`, #51884), `rollout/compress` endpoint (#46020), `memory/status`, Bedrock GovCloud check, user-verification cancel.
- Custom-provider capability overrides: `model_providers.<id>.capabilities.{external_web_access, remote_compaction}` (#50459, 0.162.0). Directly applicable to the `dorkos-credits` provider.

### MCP (passive)

Pre-registered OAuth client secrets (#47891), reconnect guidance on expired OAuth (#43947, #44359), refresh on 503 discovery (#44636), `/mcp login` (TUI), single-server status discovery (#48783), MCP result truncation in paginated history (#50458, #50470), tool pagination in legacy mode (#50035), rmcp 3.5.1 (#52972), elicitation cancellation reset on reconnect (#44238), stdio-only local servers on Unix (#47094), verified sandbox launcher for local MCP servers (#52182).

### TUI / not reachable

Fullscreen UI and transcript search, voice conversations, `/usage` dashboard, agent command center (pinning, filters, worktrees), managed worktree MCP tools (#50148, TUI-scoped), `/config`, leader key, Mermaid/equation rendering, themes, `/daybreak`, `/side`, `/daemon`. **None.**

---

## 🔧 Fixes (relevant)

- Streamed answers and plans preserved when turns fail, are interrupted or receive subagent completion events (#45549, #46867).
- Thread resume includes the latest committed history; earlier SQLite corruption detection with backups (#49599, #49701); SQLite stalls during connection setup fixed and init errors surfaced (#49032, #49102); background reclamation of log DB space (#49069).
- Prompts kept when pre-turn compaction fails (#44487).
- Command completion events include early output and report launch failures (#47529, #47665); local commands finish when a child keeps a pipe open (#52652).
- Retries honor server `Retry-After` (#49441, #50418, #51440); HTTP quota errors distinguished from rate limits (#44492).
- Unknown `CodexErrorInfo` variants accepted instead of failing (#49806).
- Unsent queued messages resume after reconnection without duplicates (#49105).
- Error wording: every message `app-server/protocol/errors.ts` classifies on (`Not initialized`, `thread not found`, `thread not loaded`, `no rollout found for thread id`, `is archived`, `no active turn to steer|interrupt`, `expected active turn id`, `requires experimentalApi capability`, `Server overloaded; retry later`) is still present in the 0.163.0 binary's strings, as are the usage-limit phrases `account-usage.ts` matches. #43961 switched protocol error messages to curly apostrophes; no DorkOS pattern contains an apostrophe.

## ⚡ Performance

Parallel read-only tools (#52245), cached plugin manifests and reused HTTP connections (#49099, #49100), fewer filesystem scans, symbols stripped from Linux/macOS binaries (#52178). Passive.

## ⚪ Internal

The large majority of the span: Guardian reviewer extraction and budgets, memory v2, voice/WebRTC/GStreamer, Windows sandbox and MXC, Python SDK publishing, Bazel, telemetry, credential brokerage, Code Mode, test stabilization. None touches the TS SDK beyond `cyberAccessProgram`, and the protocol effects are fully captured by the snapshot diff above.

---

## Alpha watch: 0.164.0-alpha.7

`dist/index.d.ts` and `dist/index.js` are **byte-identical** to 0.163.0 (d.ts sha256 `5b57ce41…`); the `rust-v0.164.0-alpha.7` release body is empty ("Release 0.164.0-alpha.7"). Nothing alpha-only to weigh; stay on stable 0.163.0.
