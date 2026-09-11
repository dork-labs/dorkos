# Impact Assessment: @opencode-ai/sdk 1.18.15 → 1.18.30

**Generated**: 2026-09-11
**Codebase root**: `apps/server/src/services/runtimes/opencode/`
**Abstraction boundary**: `AgentRuntime` interface, SDK imports ESLint-confined to this directory (Hard Rule 2, mirrors ADR-0089)
**Related ADRs**: 0255 (per-session runtime binding, first-write-wins), 0308 (managed `opencode serve` sidecar), 0310 (runtime-owned session storage)
**Companion**: `research/runtime-upgrades/opencode-sdk/1.18.15-to-1.18.30/changelog.md`

## Summary

| Category                                  | Count | Action Required                                               |
| ----------------------------------------- | ----- | ------------------------------------------------------------- |
| Breaking changes (our surface)            | 0     | —                                                             |
| Breaking changes (unreachable `/v2` only) | 1     | None — subpath we do not import, method we do not call        |
| Deprecations                              | 0     | —                                                             |
| Server-side behavioral changes 🟠         | 6     | **2 need live verification; no compiler catches any of them** |
| Features (high relevance)                 | 0     | —                                                             |
| Features (medium/low)                     | 4     | Informational; no code change                                 |
| Fixes touching code we wrap               | 7     | Auto-resolved by the bump                                     |
| Surface-map drift items                   | 8     | Config doc update recommended (not code)                      |
| **Required code changes**                 | **2** | Manifest pins ×3 + `OPENCODE_PACKAGE_VERSION`                 |

**Overall upgrade risk**: Low-to-moderate. Low on the compiler axis (zero type change, zero possible compile break); moderate on the behavioral axis, entirely because of item B1 below — an anchored regex in `subagent-mapper.ts` matched against upstream error text that 1.18.20 explicitly changed.

**Estimated total effort**: ~1.5 hours. ~20 min for the mechanical bump (3 manifests + the sidecar pin + `pnpm install`), ~20 min running the adapter suite and reading the subagent tests, ~30-45 min for one live cancel-a-subagent turn against a 1.18.30 sidecar to settle B1, ~10 min of doc/ADR touch-ups.

## Breaking Changes 🔴

**None on DorkOS's surface.** Confirmed by a full `.d.ts` diff of the packed 1.18.30 tarball against the installed 1.18.15 tree: every file reachable from a bare `@opencode-ai/sdk` import is byte-for-byte identical — `index.d.ts`, `client.d.ts`, `server.d.ts`, `process.d.ts`, `error-interceptor.d.ts`, `gen/types.gen.d.ts`, `gen/sdk.gen.d.ts`, `gen/client.gen.d.ts`, and everything under `gen/core/` and `gen/client/`. The `Event` union is still 32 members, `Part` still 2, and every one of the 17 named types DorkOS imports is unchanged. `package.json` differs only in `version`.

**No new `Event` or `Part` union members**, so there is no candidate missed event in `events/event-mapper.ts` or `events/global-event-hub.ts` from this range. Worth recording the exhaustiveness posture regardless, because it is the opposite of codex's: `event-mapper.ts:236-244` states in its own TSDoc that the ignore-list is "documented, not exhaustive-checked — the 32-member union plus wire-only extras like `server.heartbeat` make a `never` check counterproductive." **There is no `never` tripwire here.** A future SDK that adds an `Event` member would compile clean and be silently ignored; only the release notes and a live capture would reveal it. That is a deliberate, documented design choice (unlike ADR-0309's codex mappers, where the `never` check _is_ the intended tripwire) — but it means the type diff being empty is weaker evidence for this runtime than it would be for codex, and the behavioral section below carries correspondingly more weight.

The one formally breaking type change anywhere in the tarball is `GlobalUpgradeData.body.target` becoming required (`?: string` → `: string`) in `dist/v2/gen/types.gen.d.ts`. It is unreachable twice over: grep confirms zero `@opencode-ai/sdk/v2` (or any other subpath) imports anywhere in `apps`, `packages` or `scripts`, and DorkOS never calls `global.upgrade` — it provisions the sidecar itself with `npm install opencode-ai@<pin>` (`providers/provision.ts:121`). No action.

## Server-Side Behavioral Changes 🟠 (no compiler catches these)

This is the category that matters for this SDK, per `runtime-deps.json`'s own `upgrade_notes` ("most behavior lives in the sidecar, so release notes about the server can matter more than client-visible API changes even when no imported type changed"). Six items; two need verification.

### B1 — Subagent failure text changed, and our classifier is a fully-anchored regex ⚠️ **verify**

**1.18.20**: "Surface failed subagent tool calls with a resumable `task_id`" and "Surface resumable subagent failures instead of returning an empty result."

`events/subagent-mapper.ts:130-140` decides whether a finished subagent card reads `stopped` (the user cancelled) or `failed` (it broke):

```ts
return SUBAGENT_STOPPED_PATTERN.test(error.trim()) ? 'stopped' : 'failed';
```

and `SUBAGENT_STOPPED_PATTERN` (`:77-78`) is **fully anchored** against four exact strings:

```
/^(?:(?:task )?cancelled|tool execution (?:aborted|interrupted|failed: task cancelled))$/i
```

If 1.18.20's "surface resumable failures instead of an empty result" appends or prefixes anything to that error text — a resumption hint naming the new `task_id` is exactly the shape a release note like this describes — the anchors stop matching and **an ordinary user cancellation is painted as a failure**. That is not hypothetical: the TSDoc directly above the pattern (`:70-76`) records that this precise bug already shipped once ("Anchoring on the last one alone (as this first shipped) painted an ordinary stop as a failure"). The metadata escape hatch checked first (`SUBAGENT_INTERRUPTED_METADATA_KEY`, `:135-138`) covers the interrupted case and would mask the regression on the cancel path _if_ the sidecar still sets it, which is itself unverified at 1.18.30.

Note the vocabulary collision while reading this: DorkOS's own `taskId` is `part.callID` (`subagent-mapper.ts:178`), the parent's tool-call id. Upstream's new `task_id` is a _resumption handle_, a different thing in a different place. Nothing needs renaming, but do not read the release note as describing the field DorkOS already keys on.

- **Effort to verify**: ~30-45 min. One live turn against a 1.18.30 sidecar that spawns a subagent and cancels it; capture the JSONL and read the `task` part's `state.error` and `state.metadata`. The fixture convention already exists (`__tests__/fixtures/live-cancel.jsonl`, cited at `subagent-mapper.ts:236`), so a fresh capture drops straight in.
- **Effort to fix if confirmed**: ~30 min — widen the pattern from anchored-exact to anchored-prefix and add the new shape to the existing fixture-backed tests.

### B2 — Provider header and chunk timeouts now default to five minutes ⚠️ **watch**

**1.18.27**: "Default provider header timeouts to five minutes so slow model startups fail less often" and "Default streamed chunk timeouts to five minutes, with `false` supported to disable them." The `/v2` type diff confirms the mechanism: `headerTimeout` lost "Provider integrations may set defaults" in favor of an explicit `(default: 300000)`, and `chunkTimeout` went from `number` to `number | false` with the same default and a new description — "If no chunk arrives within this window, the request is aborted."

Previously these were unset or provider-supplied. Now every provider request has a hard ceiling on silence. Two consequences:

- **Net positive, most of the time**: a hung provider now fails in five minutes with an error DorkOS can render, instead of holding the turn open indefinitely. `events/session-event-mapper.ts`'s `openCodeErrorCopy` will surface it as a generic execution error; it will not match `MODEL_UNAVAILABLE_PATTERNS` (correctly — a timeout is not a missing model).
- **New failure mode for very slow turns**: a model that thinks for more than five minutes without emitting a chunk now has its request aborted where it previously did not. Deep-reasoning models on loaded providers are the realistic case.

**Relationship to `specs/ask-parks-on-timeout`**: that spec's §14 names, as the one live check it owes, "whether the OpenCode sidecar expires an unanswered `Permission`" (`messaging/approvals.ts`). B2 does **not** settle it. `chunkTimeout` governs the sidecar↔provider stream, and during an approval park there is no provider stream in flight — the model already emitted the tool call and the sidecar is waiting on DorkOS. So the park question stays open, and the spec's statement that "nothing in the SDK surface settles it" remains true at 1.18.30. Recording that explicitly so a future reader does not mistake B2 for the answer.

- **Effort**: none required. Watch item; if operators start reporting five-minute turn failures, this is the cause and `chunkTimeout: false` in the sidecar config is the escape hatch.

### B3 — Wider network-error retry and unknown-finish-reason tolerance

**1.18.20/1.18.21**: provider responses ending in `finish_reason: network_error` are retried; more variants (`network-error`, `network_error`) are retried; xAI capacity/unavailability stream errors are retried; a model reporting an unknown finish reason now continues instead of stopping early.

Fewer `session.error` events reach `events/session-event-mapper.ts:mapSessionError`, and fewer turns end short. Strictly an improvement to code DorkOS wraps. Paired with **1.18.17**'s retry cap + jitter, the latency profile of a flaky turn changes: fewer total retries, spread wider. No code change; tests that assert on error copy are unaffected because the errors simply arrive less often.

### B4 — Tool-call timing corrected mid-run

**1.18.26**: "Tool call timing now stays accurate when tools update their metadata while still running" (upstream fixed a `time.start` reset). `events/subagent-mapper.ts:220` computes `durationMs: toolState.time.end - run.startedAt` from `state.time.start` (`:82-83`), and `events/part-event-mapper.ts` reads tool timing for progress beats. Durations that were silently wrong become right. No code change; if any test pins a duration derived from a live fixture captured before 1.18.26, it may need re-capture.

### B5 — Permission metadata narrowed for `apply_patch`

**1.18.26**: "`apply_patch` no longer emits an empty move path in permission metadata." `messaging/approvals.ts` reads only `toolName` off an approval (`:100`, `:143`, `:181`, `:367`, `:388`) and never the move path, so there is no impact — but it is a change to permission-flow payloads, which is the category ADR-0240's discipline says to look at deliberately rather than assume. Looked at; no action.

Related and explicitly _not_ ours: **1.18.20**'s "Answer permission requests triggered by subagents during `opencode run`" fixes the `opencode run` CLI path. DorkOS drives the server API through `OpencodeClient`, never `opencode run`.

### B6 — Cost calculation no longer breaks on malformed pricing

**1.18.19**: "Ignore malformed model pricing instead of breaking usage cost calculation." `events/session-event-mapper.ts:139` and `:149` read `assistant.cost` straight onto `costUsd` in the `session_status` event DorkOS shows the user. A model whose pricing metadata was malformed previously broke the whole usage calculation; it now degrades. Direct reliability win in a surface DorkOS renders. No code change.

## Features — Relevance Assessment

No high-relevance features. This range is overwhelmingly corrective: 59 Core bullets, of which only four are additive.

### Cloudflare AI Gateway native passthroughs (1.18.19) — Relevance: None

New provider routing flows through the already-typed `ProviderListResponse` that `providers/models.ts` projects. A new entry in a catalog, nothing more.

### Azure Entra ID sign-in via Azure CLI (1.18.24, fixed 1.18.25) — Relevance: Low

An OpenCode-CLI-side auth path. DorkOS's connect flow covers OpenRouter/Ollama/direct-provider (`providers/check-dependencies.ts`, `services/runtimes/connect/credentials.ts`) and does not drive Azure. Informational only.

### Copilot session-ID interaction header (1.18.28) — Relevance: None

Provider-side request telemetry, invisible to DorkOS's client.

### Astra system prompt + `gpt-6` model recognition (1.18.29, 1.18.30) — Relevance: None

Model-catalog items. `providers/models.ts` projects whatever the catalog returns.

### One near-miss worth naming: `/connect` authenticated-provider display (1.18.19)

`specs/opencode-connect-overhaul` root cause #1 is that `checkAuthState` shells out to `opencode auth list`, which only sees the OpenCode CLI's own `auth.json` — which DorkOS never writes. 1.18.19's "Properly show authenticated providers in `/connect`" sounds adjacent but fixes the interactive `/connect` **command's** display, not `auth list`'s output or the underlying credential-store split. It does not move that spec. Flagging it because the title is close enough to mislead a skim.

## Fixes That Touch Code DorkOS Already Wraps 🔧

None required a code change, but each hardens a subsystem this adapter actively depends on (skill relevance heuristic #1). Most are itemized above as B3–B6; the remainder:

- **Compaction** (`messaging/compaction-model.ts`, and the `session.compacted` branch of `events/event-mapper.ts:167`): 1.18.17 made compaction keep complete recent turns and produce clearer summaries for smaller models. DorkOS surfaces compaction to the user and resolves the compaction model itself, so summary quality is user-visible through code we own.
- **Config parsing** (`mcp/mcp-server-config.ts`, which builds the `config` body for `client.mcp.add`): 1.18.16 ignores unknown top-level config fields instead of failing config parsing, and 1.18.24 lets V1 read supported V2 config fields. Both make a config DorkOS or the user writes more forgiving of field drift. Low impact today because DorkOS registers MCP servers over the API rather than by writing `opencode.json`, but it removes a whole class of hard-fail.
- **Claude 5 stale thinking blocks** (1.18.26) and **Anthropic `blockBinding` limited to Claude 5.1+** (1.18.27): sessions no longer fail after a prompt or tool change, and older Anthropic deployments stop rejecting requests. DorkOS mutates the tool set per turn (MCP injection), so the stale-thinking-block class is one this adapter can genuinely provoke.

## ADR Conflicts

None.

- **ADR-0255** (per-session runtime binding, first-write-wins): untouched — nothing in this range changes how a session is created or identified.
- **ADR-0308** (managed sidecar): untouched in substance, but its **Status line and its own changelog need a line appended**. It currently reads `Accepted (implemented in spec: additional-agent-runtimes, `@opencode-ai/sdk@1.18.15`)` (`decisions/0308-*.md:14`) with a dated `2026-08-07` note at `:16` recording the previous bump. The upgrade PR should update `:14` to `1.18.30` and append a matching note. This is exactly the maintenance the previous pass established; keep the pattern.
- **ADR-0310** (runtime-owned session storage): untouched — OpenCode's store stays opaque, read only through the SDK.

## TODO/FIXME/HACK/WORKAROUND Scan

`grep -rn "TODO\|FIXME\|HACK\|WORKAROUND" apps/server/src/services/runtimes/opencode --include="*.ts"`: **zero matches**, tests included.

The three hand-typed wire shapes remain, and all three remain necessary — none is obsoleted by this bump, because the generated types did not move at all:

1. `EventMessagePartDelta` (`events/part-event-mapper.ts:39`) — the real text-increment wire event, still absent from the 32-member generated `Event` union at 1.18.30.
2. `EventPermissionAsked` / `EventPermissionReplied` (`events/session-event-mapper.ts`) — hand-typed against the live wire because the generated `permission.updated` / `permission.replied` members contradict what the shipped sidecar sends (DOR-1147). `events/event-mapper.ts:88-99` `Exclude`s both generated members from `OpenCodeWireEvent` precisely so the mapper cannot compile against a payload the sidecar has never sent.

**The forward-looking risk these create is the sharpest thing in this report.** All three are pinned to the _observed 1.18.15 wire_, not to a generated type, so no type diff can ever validate them — including this one. Several file headers now carry stale version stamps against which they were verified: `events/event-mapper.ts:5-7` says "SOURCE OF TRUTH: SDK v1.17.13 generated types", `runtime-constants.ts:5-22` and `sessions/session-mapper.ts:97` cite `1.17.13` / `1.18.15`, and `sessions/session-mapper.ts:115` records a "live-verified 2026-08-25 on 1.18.15" observation. Those stamps should be re-dated only for what the bump actually re-verifies — do not blanket-rewrite `1.18.15` → `1.18.30` in comments, because that would claim live verification this upgrade has not performed.

## Sidecar Compatibility

The SDK is only the HTTP client; the `opencode serve` binary ships as the separate `opencode-ai` npm package, resolved by `resolveOpenCodeBinaryPath()` (`providers/check-dependencies.ts:114-127`) in this order: a configured `runtimes.opencode.binaryPath` (authoritative — missing means "report the dependency missing", never "silently probe something else"), then the on-demand provisioned install, then `opencode` on `PATH` (ADR-0316).

**Supported sidecar binary range for the 1.18.30 client**: the top-level generated type surface has not changed across **1.17.13 → 1.18.30** (38 releases, verified by two consecutive byte-level diffs), so on the endpoints and events DorkOS actually calls, the 1.18.30 client is wire-compatible with any `opencode-ai` sidecar in `1.17.13 ≤ v ≤ 1.18.30`. Two honest caveats on that statement:

1. It covers the _generated_ contract only. The three hand-typed wire shapes above are pinned to the observed 1.18.15 wire and are outside what any diff can certify. Nothing in the 15 release notes suggests they moved, but that is absence of evidence.
2. Behaviorally the range is not uniform even where it is type-compatible — B1 and B2 are exactly the kind of change that makes a 1.18.19 sidecar and a 1.18.30 sidecar behave differently under an identical client. "Wire-compatible" is not "interchangeable".

**Must `OPENCODE_PACKAGE_VERSION` move? Yes — and not for wire-compatibility reasons.** `providers/provision.ts:32` holds `export const OPENCODE_PACKAGE_VERSION = '1.18.15'`, and the pin is load-bearing in three places, all of which treat it as the truth:

- `ensureProvisionedOpenCodeVersion` (`provision.ts:99-104`) re-provisions in place whenever the installed version differs from the pin (DOR-1034). Leave the pin at 1.18.15 and every provisioned user is actively held at 1.18.15 — they get none of B2–B6, and the upgrade only reaches people who manage their own binary.
- `warnIfVersionDrifted` (`check-dependencies.ts:141-155`) logs a warning whenever a `PATH`- or `binaryPath`-resolved binary reports anything other than the pin. Leave the pin behind and every user who upgraded their own `opencode` to 1.18.30 starts getting a spurious drift warning about the version they are correctly on.
- That same function returns the pin as `requiredVersion` on the readiness check, which the client displays. A stale pin makes DorkOS tell the user, in the UI, that it requires a version it does not.

This has hardened since the previous pass, which recorded "no version gate at all" — drift is now surfaced (as a warning and a `requiredVersion`, never as a blocking `status`), which is the right shape for binaries DorkOS does not own. But it also means a stale pin is now _visible_ to users rather than merely inert.

**A guard that is claimed but does not exist.** `scripts/__tests__/dependabot-lockstep-families.test.ts:86-89` comments that the opencode sidecar "is provisioned at runtime from `OPENCODE_PACKAGE_VERSION` in `apps/server/src/services/runtimes/opencode/provision.ts`, **which that file's own test keeps in step with this SDK**." No such assertion exists: `__tests__/provision.test.ts` and `__tests__/check-dependencies.test.ts` both import `OPENCODE_PACKAGE_VERSION` and build every expectation _from_ it, so they pass at any value. **Nothing in the repo fails if the sidecar pin and the SDK manifest range disagree.** The comment also names a path that no longer exists — the file moved to `providers/provision.ts`. Worth a small follow-up: either add the parity assertion the comment already promises (read `@opencode-ai/sdk` out of `apps/server/package.json`, strip the `^`, compare to `OPENCODE_PACKAGE_VERSION`) or correct the comment. The assertion is the better answer and is ~15 minutes; it would have made this bump self-enforcing.

Two smaller staleness items in the same area: `__tests__/check-dependencies.test.ts:126` carries the inline comment `// the pin is OPENCODE_PACKAGE_VERSION (1.18.15)`, which goes stale on this bump (the test itself stays correct — it uses `1.17.13` as the drifted value, which remains drifted). And `provision.ts:27-31`'s TSDoc already states the lockstep rule correctly ("a future SDK bump updates this in lockstep"); no edit needed there.

## Dependency / Version-Pin Check

Every place the 1.18.15 pin lives (lockfile and `research/` excluded; `.claude/worktrees/` copies excluded as transient):

| Location                                                               | Current                                | Move to     |
| ---------------------------------------------------------------------- | -------------------------------------- | ----------- |
| `apps/server/package.json:50`                                          | `"@opencode-ai/sdk": "^1.18.15"`       | `^1.18.30`  |
| `apps/desktop/package.json:39`                                         | `"@opencode-ai/sdk": "^1.18.15"`       | `^1.18.30`  |
| `packages/cli/package.json:70`                                         | `"@opencode-ai/sdk": "^1.18.15"`       | `^1.18.30`  |
| `apps/server/src/services/runtimes/opencode/providers/provision.ts:32` | `OPENCODE_PACKAGE_VERSION = '1.18.15'` | `'1.18.30'` |

All three manifests must move together — `scripts/__tests__/dependabot-lockstep-families.test.ts` declares `@opencode-ai/sdk` a single-member lockstep family and enforces version parity across every importer, which is what stops the lockfile splitting into two resolutions (the failure mode that comment records for `@anthropic-ai/sdk`). This matches `contributing/adding-a-runtime.md` § "Bumping a pinned SDK".

Doc-only touch-ups the bump should carry: `decisions/0308-*.md:14` + a dated note at `:16`; `__tests__/check-dependencies.test.ts:126`'s inline comment. Deliberately **not** swept: the `1.17.13` / `1.18.15` stamps in `events/event-mapper.ts:5-7`, `runtime-constants.ts:5-22`, and `sessions/session-mapper.ts:97,115` — those record when a shape was _live-verified_, and rewriting them without re-verifying would be a false claim.

## Surface-Map Drift (`runtime-deps.json` → actual imports)

The map has drifted badly, and mostly not because imports changed — because **the adapter directory was reorganized into subdirectories** (`events/`, `sessions/`, `mcp/`, `messaging/`, `providers/`) since the map was written. Every path in the current map is wrong as a path. Verified against all 28 files with an `@opencode-ai/sdk` import (13 production, 15 test). Config not edited, per instructions; exact corrections:

1. **`Permission` is not imported at all** and should be removed from the map. DorkOS deliberately excludes the generated permission members (`events/event-mapper.ts:88-99`) and hand-types `EventPermissionAsked`/`EventPermissionReplied` instead (DOR-1147). Leaving `Permission` in the map advertises a dependency that was removed on purpose — the single most misleading entry.
2. **Every file path needs its new directory prefix**: `event-mapper.ts` → `events/event-mapper.ts`, `global-event-hub.ts` → `events/global-event-hub.ts`, `session-mapper.ts` → `sessions/session-mapper.ts`, `mcp-manager.ts`/`mcp-status.ts` → `mcp/…`, `models.ts`/`provision.ts`/`check-dependencies.ts` → `providers/…`, `mcp-server-config.ts` → `mcp/mcp-server-config.ts`.
3. **Four imported types are missing from the map entirely**: `FilePart` (`events/part-event-mapper.ts:23`), `SessionMessagesResponse` (`messaging/compaction-model.ts:26`), plus `ToolState` and `ReasoningPart`/`TextPart`/`UserMessage` in the fixtures file (`__tests__/opencode-sse-fixtures.ts:37`, test-only — include or exclude by whatever convention the map adopts, but be consistent).
4. **`Event` is imported by three files, not one**: `events/event-mapper.ts`, `events/session-event-mapper.ts`, `events/part-event-mapper.ts`. The map attributes it to `event-mapper.ts` alone.
5. **The `event-mapper.ts` grouping is wrong at the type level**, not just the path level. `AssistantMessage`, `SessionStatus` and `Todo` live in `events/session-event-mapper.ts`; `ToolPart` lives in `events/part-event-mapper.ts`, `events/subagent-mapper.ts` and `sessions/session-mapper.ts`; `event-mapper.ts` itself imports only `Event` and `GlobalEvent`.
6. **`OpencodeClient` reaches six production files**, not the two the map names: `server-manager.ts`, `opencode-runtime.ts`, `mcp/mcp-manager.ts`, `mcp/mcp-status.ts`, `sessions/session-mapper.ts`, `messaging/compaction-model.ts` (plus nine test files).
7. **`McpStatus` is `mcp/mcp-status.ts`-only**; `McpLocalConfig`/`McpRemoteConfig` are in both `mcp/mcp-status.ts` and `mcp/mcp-server-config.ts`. The map groups all three together.
8. **`createOpencodeClient` is `server-manager.ts`-only** (and its test) — already correct, carried forward from the previous pass's finding.

Suggested replacement `sdk_surface_map` (production files only):

```
createOpencodeClient      → server-manager.ts
OpencodeClient            → server-manager.ts, opencode-runtime.ts, mcp/mcp-manager.ts,
                            mcp/mcp-status.ts, sessions/session-mapper.ts,
                            messaging/compaction-model.ts
Event                     → events/event-mapper.ts, events/session-event-mapper.ts,
                            events/part-event-mapper.ts
GlobalEvent               → events/event-mapper.ts, events/global-event-hub.ts
AssistantMessage, SessionStatus, Todo → events/session-event-mapper.ts
ToolPart                  → events/part-event-mapper.ts, events/subagent-mapper.ts,
                            sessions/session-mapper.ts
FilePart                  → events/part-event-mapper.ts
Session, Message, Part    → sessions/session-mapper.ts
SessionMessagesResponse   → messaging/compaction-model.ts
ProviderListResponse      → providers/models.ts, opencode-runtime.ts
McpStatus                 → mcp/mcp-status.ts
McpLocalConfig, McpRemoteConfig → mcp/mcp-status.ts, mcp/mcp-server-config.ts
```

A note for whoever edits `runtime-deps.json`: the map is a _hand-maintained_ index of a directory that gets reorganized, and this is the second consecutive pass to report drift on it. Consider whether a test that derives the map from the imports (or merely asserts every listed path exists) would be cheaper than re-auditing it every bump.

## Verification Plan

Per `contributing/adding-a-runtime.md` § "Bumping a pinned SDK" and the skill's universal gates:

1. Bump the three manifests + `OPENCODE_PACKAGE_VERSION`; `pnpm install`.
2. `pnpm vitest run apps/server/src/services/runtimes/opencode` — the full adapter suite including `runtimeConformance`. Expected green; a red here would be a genuine surprise given the identical type surface.
3. `pnpm --filter @dorkos/server typecheck` — cannot fail on this bump (zero type change), but it is the cheap proof of that claim.
4. **The live leg, which is the only thing that settles B1**: one real turn against a provisioned 1.18.30 sidecar that spawns a subagent and cancels it mid-run. Capture the JSONL, read the parent `task` part's `state.error` and `state.metadata`, and confirm `subagentFailureStatus` still returns `stopped`. `scripts/harness-smoke/run.sh opencode` is the existing paid path (`DORKOS_HARNESS_SMOKE=1` + `OPENROUTER_API_KEY`, `--max-usd` default $0.50); a free local-model run via `DORKOS_OPENCODE_LIVE=1` also exercises the wire if the model can drive a subagent.
5. Optional but cheap: re-capture `__tests__/fixtures/live-cancel.jsonl` from step 4 so the fixture reflects the pinned sidecar rather than a 1.18.15 one.

**Rollback criteria**: revert all four pins if the adapter suite reds, or if B1 confirms a mis-classification that cannot be fixed in the same PR. Rollback is a clean four-line revert plus `pnpm install` — there is no migration, no schema change, and no persisted state that a 1.18.30 sidecar writes which a 1.18.15 one cannot read (upstream's own 1.18.19 note, "Preserved compatibility with existing v1 databases", covers the store).

## No Action Required

- 39 of the 59 Core bullets are provider/model-routing fixes (Bedrock, Azure, Cloudflare AI Gateway, xAI, Copilot, Cerebras, Vertex, GitLab, Qwen, Kimi, DeepSeek, Meta/Muse, MERGE Gateway) that flow through the already-typed `ProviderListResponse` with no DorkOS code path.
- All 15 Desktop/TUI bullets — none reachable from a server-side SDK client.
- The `/v2` subpath type changes, including the one formally breaking one.
