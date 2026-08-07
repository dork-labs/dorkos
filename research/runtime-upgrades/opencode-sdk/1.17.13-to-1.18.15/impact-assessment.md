# Impact Assessment: @opencode-ai/sdk 1.17.13 → 1.18.15

**Generated**: 2026-08-07
**Codebase root**: `apps/server/src/services/runtimes/opencode/`
**Abstraction boundary**: `AgentRuntime` interface, SDK imports ESLint-confined to this directory (Hard Rule 2, mirrors ADR-0089)
**Related ADRs**: 0255 (per-session runtime ownership), 0308 (managed `opencode serve` sidecar), 0310 (runtime-owned session storage)

## Summary

| Category                  | Count | Action Required                                       |
| ------------------------- | ----- | ----------------------------------------------------- |
| Breaking changes          | 0     | —                                                     |
| Deprecations              | 0     | —                                                     |
| Features (high relevance) | 0     | —                                                     |
| Features (medium/low)     | 3     | No code change; informational                         |
| Fixes touching our wraps  | 4     | Auto-resolved by bump (MCP reliability, msg ordering) |
| Surface-map drift items   | 4     | Config doc update recommended (not code)              |
| **Required code change**  | **1** | Bump `OPENCODE_PACKAGE_VERSION` pin in `provision.ts` |

**Overall upgrade risk**: Low
**Estimated total effort**: ~30 minutes (version bump + pinned-constant bump + conformance suite run + one live smoke turn per the bump checklist in `contributing/adding-a-runtime.md`)

## Breaking Changes 🔴

None. Confirmed by `.d.ts` diff of the packed 1.18.15 tarball against the installed 1.17.13 tree: every file reachable from DorkOS's `import ... from '@opencode-ai/sdk'` (the top-level export — `index.d.ts`, `client.d.ts`, `server.d.ts`, `gen/types.gen.d.ts`, `gen/sdk.gen.d.ts`, `gen/client.gen.d.ts`) is byte-for-byte identical between the two versions. No release note in the 23-release range describes a subtractive change to the REST/SSE contract DorkOS's client speaks.

The only type change anywhere in the tarball is in `dist/v2/gen/types.gen.d.ts` (the separate `@opencode-ai/sdk/v2` export subpath — a `subagent_depth` field addition and an `interleaved` union widening). Confirmed via grep that no file under `apps/server/src` imports `@opencode-ai/sdk/v2`, `/client`, `/server`, or any subpath other than the bare package specifier — this diff is unreachable from DorkOS's code and requires no action.

## Deprecations 🟡

None. See changelog's "watch item" note on the Desktop app's "legacy vs. current server" language — not a deprecation of anything DorkOS depends on today, but worth re-checking on the next bump in case the project starts formally deprecating the v1/legacy server protocol DorkOS's sidecar and SDK client both use.

## Features — Relevance Assessment

### Code-mode MCP adapter (1.17.14) — Relevance: Low

Lets a session run confined orchestration scripts against connected MCP tools. `OpenCodeMcpManager` (`mcp-manager.ts`) only registers/reads MCP servers (`client.mcp.add`, status polling) — it does not configure tool-execution modes. No dependency, no action.

### `subagent_depth` config + no-default-nesting (1.18.2) — Relevance: Low

Sidecar-side default behavior change (subagents no longer spawn nested subagents unless configured). `opencode-runtime.ts:814` already documents that "OpenCode agents are prompt-scoped, not a DorkOS-dispatchable subagent registry" — DorkOS neither configures nor relies on OpenCode's subagent nesting. Purely informational; a DorkOS OpenCode session's own prompts could be affected, but no DorkOS code path is.

### Modal provider auto-discovery (1.18.10), simplified xAI login (1.18.14) — Relevance: None

Provider-catalog and provider-auth changes that flow through the already-typed `ProviderListResponse` and OpenCode's own CLI-auth path (not a DorkOS-connected provider per `check-dependencies.ts`). No DorkOS code touches either.

## Fixes That Touch Code DorkOS Already Wraps 🔧

None of these required a code change (server-side-only, no type/contract shift), but each lands inside a subsystem DorkOS's adapter actively depends on — listed because the skill's relevance heuristic #1 ("does this touch something we already wrap?") applies:

- **MCP reliability** (`mcp-manager.ts`, `mcp-status.ts` — DOR-893's managed-injection and status-surfacing code): 1.17.14 fixed paginated MCP tool catalogs losing metadata; 1.18.8 fixed MCP reconnection after expired SDK sessions (including concurrent requests) and honored configured MCP OAuth callback ports; 1.18.9 restored MCP SDK client compatibility after a transient 1.18.x regression; 1.18.11 fixed MCP SSE connections getting stuck in reconnect loops. `mcp-status.ts:37` already carries OAuth-registration-state handling (DOR-893) — this run of fixes directly hardens the subsystem behind it. Given the just-shipped MCP OAuth program (DOR-982, PR #850), this cluster of fixes is a genuine reliability upgrade for a feature area DorkOS just finished building on.
- **Session/directory routing** (the single-sidecar, per-request-directory model ADR-0308 decided on): 1.17.14 fixed session lists matching equivalent instance directories; 1.18.6 fixed branch-specific repository cache bleed.
- **Message/history ordering** (`session-mapper.ts`, `log-backed-history.ts`): 1.18.15 fixed chronological message ordering for imported/legacy message IDs, made revert/fork use real chronology, and fixed compaction dropping earlier tool-call history in summaries.

## ADR Conflicts

None. Nothing in this range changes session-storage ownership (ADR-0310 still holds: OpenCode's SQLite store stays opaque, read only via SDK), the single-sidecar-per-request-directory model (ADR-0308), or per-session runtime binding (ADR-0255).

One doc-only note: **ADR-0308's Status line literally pins the version** — "Accepted (implemented in spec: additional-agent-runtimes, `@opencode-ai/sdk@1.17.13`)". This isn't a conflict, but the upgrade PR should update that line to `1.18.15` (or generalize it) so the ADR doesn't read as stale the moment this bump lands.

## TODO/FIXME/HACK/WORKAROUND Scan

`grep -rn "TODO\|FIXME\|HACK\|WORKAROUND" apps/server/src/services/runtimes/opencode/ --include="*.ts"` (excluding tests): **zero matches.** One undocumented-as-such workaround exists and is worth flagging because this upgrade doesn't fix it: `event-mapper.ts:71-88` manually declares `EventMessagePartDelta`, documented in its own TSDoc as "the true text-increment wire event at v1.17.13, published on every `text-delta`/`reasoning-delta` but ABSENT from the SDK's generated `Event` union." Confirmed still true at 1.18.15 — `message.part.delta` does not appear in either version's `gen/types.gen.d.ts` (files are identical). No action needed; noting it stays necessary so a future bump doesn't silently assume it's obsolete.

## Sidecar Compatibility

**This is the part of the upgrade that actually needs a code change.** The SDK is only the HTTP client; the `opencode serve` binary ships as the separate `opencode-ai` npm package, resolved by `resolveOpenCodeBinaryPath()` (`check-dependencies.ts:116`) in this order: configured `runtimes.opencode.binaryPath` (authoritative) → an on-demand provisioned install → `opencode` on `PATH`.

**Pinned/provisioned path** — `provision.ts:31` hardcodes `export const OPENCODE_PACKAGE_VERSION = '1.17.13'`, installed via `npm install --prefix <dork-home>/runtimes/opencode opencode-ai@1.17.13` when DorkOS provisions the CLI on demand (ADR-0317). The file's own TSDoc says this is "pinned to match the `@opencode-ai/sdk` already depended on by the server... Reversible: a future SDK bump updates this in lockstep." **This constant must be bumped to `1.18.15` as part of this upgrade** — it is the one required code change, and it's exactly the kind of trivial, direct, same-behavior config-passthrough the `upgrading-runtime-dependencies` skill says belongs in the main upgrade spec (not a separate one).

**Configured or PATH-resolved binaries — no version gate at all.** `checkCliBinary()` (`check-dependencies.ts:126`) runs `opencode --version` and reports it as `satisfied` purely on successful execution; there is no check that the reported version falls in any supported range. A user who set `runtimes.opencode.binaryPath` to an old global install, or who has an old `opencode` on `PATH` from before this upgrade, will keep working unless the wire contract actually changed underneath them — and per the `.d.ts` diff above, it hasn't, across this entire 1.17.13–1.18.15 window. There is currently no mechanism that would even detect a sidecar running, say, 1.10.0 or a hypothetical future 2.0.0 with a genuinely incompatible contract.

**Practical supported range statement**: given the confirmed-identical top-level type surface across all 23 releases in this window, the 1.18.15 client is wire-compatible with any `opencode-ai` sidecar from 1.17.13 through 1.18.15 on the endpoints/events DorkOS actually calls. Compatibility outside that window is unverified — neither this research pass nor DorkOS's own code checks it. The provisioned-install path is the only one DorkOS controls end-to-end and should be kept in lockstep (the fix above); the `binaryPath`/`PATH` paths are an open trust boundary that pre-dates this upgrade and isn't newly introduced by it.

## Surface-Map Drift (`runtime-deps.json` → actual imports)

`grep -r "import.*from '@opencode-ai/sdk'" apps/server/src --include="*.ts"` (15 files, including tests) was cross-checked against every named type import. Four drift items, none blocking, config not edited per instructions:

1. **`createOpencodeClient` is used only in `server-manager.ts`** (and its test), not `opencode-runtime.ts` as the map's grouping implies. `opencode-runtime.ts` imports only the `OpencodeClient` _type_, never the factory function.
2. **`OpencodeClient` (type) is imported far more broadly** than the map's "`→ server-manager.ts, opencode-runtime.ts`" suggests: also `mcp-manager.ts`, `mcp-status.ts`, and five test files (`session-map.test.ts`, `mcp-status.test.ts`, `global-event-hub.test.ts`, `opencode-runtime.test.ts`, `conformance.test.ts`, `agent-context.test.ts`, `server-manager.test.ts`).
3. **`ToolPart` is also imported in `session-mapper.ts`**, not just the event-mapper.ts/global-event-hub.ts group the map lists it under. Conversely, `global-event-hub.ts` itself imports only `GlobalEvent` — none of the other six types in that group (`Event`, `AssistantMessage`, `Permission`, `SessionStatus`, `Todo`, `ToolPart`) are actually used there; those six are `event-mapper.ts`-only.
4. **Three MCP-related types are missing from the map entirely**: `McpStatus`, `McpLocalConfig`, `McpRemoteConfig` (imported in `mcp-status.ts` and `mcp-server-config.ts`). Given this upgrade's fix cluster concentrates in MCP reliability (see above), and MCP is DorkOS's most recently-active integration surface on this runtime, this is the drift item most worth closing — a future config maintainer reading only `sdk_surface_map` would not know these types, or the two files that import them, exist.
5. **`ProviderListResponse` is also imported in `opencode-runtime.ts`**, not just `models.ts`.

Recommendation for whoever next edits `runtime-deps.json`: expand the `opencode-sdk.sdk_surface_map` to list `OpencodeClient` and `ProviderListResponse` against their full file sets, split the `event-mapper.ts`/`global-event-hub.ts` grouping since they don't share the same six types, and add an MCP-types entry (`McpStatus, McpLocalConfig, McpRemoteConfig → mcp-status.ts, mcp-server-config.ts`).

## Dependency / Version-Pin Check

- `apps/server/package.json:45`: `"@opencode-ai/sdk": "^1.17.13"` — the only pin location for the SDK itself (unlike claude-agent-sdk, there is no root `pnpm.overrides` or `packages/cli` pin for this package).
- `provision.ts:31`: `OPENCODE_PACKAGE_VERSION = '1.17.13'` — the sidecar pin, must move to `1.18.15` in lockstep (see Sidecar Compatibility above).
- `opencode-ai` (sidecar) publishes in lockstep with `@opencode-ai/sdk` — every version in this range has a matching sidecar version published within ~1 minute, confirming both ship from the same monorepo release.

## No Action Required

- 19 of 23 releases: provider/model-routing fixes and Desktop/TUI-only changes, none touching DorkOS code.
- 1.18.0/1.18.1 (the minor-version bump): zero Core-section notes — entirely Desktop v2 layout migration. Confirms the minor bump carried no intentional server/API break.
