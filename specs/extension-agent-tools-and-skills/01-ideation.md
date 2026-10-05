---
slug: extension-agent-tools-and-skills
id: 261003-200014
created: 2026-10-03
status: ideation
linearIssue: DOR-2685
---

# Extensions give agents tools and skills

**Slug:** extension-agent-tools-and-skills
**Author:** Claude Code (IDEATE stage, /flow)
**Date:** 2026-10-03

---

## 1) Intent & Assumptions

- **Task brief (DOR-2685, widened by Dorian 2026-10-03 17:46Z):** an extension can give agents
  typed tools and skills. Today `composeRegistry` folds every domain into one immutable registry
  at boot, the manifest's `capabilities` block is only the list of event kinds an extension may
  subscribe to, and no extension path registers a capability id or an MCP tool, so an email
  extension cannot give agents mail tools: they would have to call its HTTP routes or write files.
  **Done when** (verbatim from the ticket and its widening):
  - a manifest can declare `tools`, `capabilities` and `skills` (a tool: name, input schema, tier,
    display fields);
  - the capability registry accepts late registration at extension load and removes it at unload;
  - the tools appear in the agent tool list under the extension's namespace;
  - the approval gate treats extension tools like any capability of their tier;
  - skills are projected into the agent harness like a plugin's skills (ADR 260706-192819) and
    un-projected on unload;
  - a decision is recorded on whether extensions may register destructive-tier tools at all, or are
    capped at `act`.
  - Build order (Dorian): after DOR-2683 (`ctx.agent.send`, PR #2518) and the dev link (DOR-2696,
    spec `marketplace-dev-link`), before DOR-2686 (isolated extension backends).
- **Assumptions:**
  - The motivating case is real and near: the LifeOS mail extension (`0-System/mail-app/EXTENSION-PATH.md`
    in the vault), built as a dev-linked extension.
  - Extension server code keeps running in the DorkOS process (ADR 0213) until DOR-2686. Nothing here
    may make DOR-2686 harder: the tool handler contract must be one that can cross a process boundary
    (plain JSON in, plain JSON out, an abort signal).
  - A person's one-time approval to run an extension (DOR-516, `extension-load-policy.ts`) stays the
    trust boundary for its code. Tools and skills ride that approval; they add no second install card.
  - The agent-permissions model (fixed areas, per-action overrides, tiers) is the control a person
    has over what agents may call. Extension tools enter it rather than inventing a parallel one.
- **Out of scope:**
  - Running extension code out of process (DOR-2686).
  - Extension-contributed hooks, slash commands, or MCP resources/prompts. Only tools and skills.
  - Advertising extension tools on the external `/mcp` endpoint, the CLI verb table, or the OpenAPI
    document (they stay reachable through the generic `dorkos call <id>` / invoke route that every
    capability already has).
  - Marketplace browse showing an extension's tools before install (a follow-up once the manifest
    carries them).
  - A tool-call rate limit or circuit breaker for misbehaving extensions.

## 2) Pre-reading Log

- `apps/server/src/services/core/capabilities/registry.ts`: `composeRegistry` builds `byId` and
  three claim tables (MCP tool name, CLI verb, HTTP route), throws on any conflict, freezes the
  capability list, and caches the serialized catalog and its `catalogVersion` forever
  ("The registry is immutable"). `invoke` is the single gate (tier + permission, DOR-467).
- `services/core/self-description/dorkos-registry.ts`: one boot composer
  (`composeDorkOsCapabilityRegistry`) and one docs composer (`composeCapabilityRegistryForDocs`);
  the docs one is what the census guards, OpenAPI export and tool-exposure tests read.
- `services/core/capabilities/capability-definition.ts`: the definition carries `tier`, `area`,
  `surfaces`, `approvalDisplayFields`, and several powerful optional hooks (`preflight`,
  `forwardsApproval`, `inSessionCard`, `approvalSubject`, `areasForInput`) that an extension must
  never set.
- `services/core/capabilities/mcp-projection.ts`: `capabilitiesForMcpServer` reads
  `registry.capabilities` on every call, so a live registry flows into every tool list built after
  a change.
- `services/runtimes/claude-code/mcp-tools/index.ts`: `createDorkOsToolServer` is called per launch
  via `mcpServerFactory` (`index.ts:4002`) and builds the `dorkos` in-process server from the
  registry, minus `hiddenToolNames`.
- `services/runtimes/claude-code/sessions/launch-fingerprint.ts` + `claude-code/NOTES.md`: a warm
  pump pins launch options; `mcpServers` is compared by declared config with `instance` dropped. For
  the in-process `dorkos` server that leaves only `{type:'sdk', name}`, so **a change to the
  server's tool list is invisible to a warm process** until something else relaunches it. Unverified
  live behaviour is resolved toward relaunch by house rule.
- `services/runtimes/connector-mcp/agent-runtime-server.ts`: Codex and OpenCode reach a per-request
  `McpServer` built from the same registry (`in-session` audience) on the loopback listener, so they
  see a registry change on their next `tools/list`.
- `services/runtimes/claude-code/mcp-tools/tool-exposure.ts`: tools defer behind ToolSearch except
  the always-loaded set; **any `z.record` in any in-session input schema empties `tools/list` for
  the whole server** (SDK 0.3.257+ with zod 4.5.3+). That is the sharpest risk in accepting
  author-supplied schemas.
- `services/runtimes/claude-code/messaging/interactive-handlers.ts`: `DORKOS_AGENT_TOOLS` is the
  hand-written auto-allow list; everything else on `dorkos` falls to the permission-mode table.
- `services/core/external-mcp/tool-security.ts`: the tokenless read-only carve-out is fail-closed;
  a tool is guarded unless it opts in.
- `packages/shared/src/permissions/*`: ten fixed areas (`rooms` … `reach`), per-action overrides
  keyed `domain.verb` (`^[a-z0-9_]+(\.[a-z0-9_]+)?$`); `resolvePermission` treats every tier alike
  except `destructive`, which turns Allowed into Ask. `permissionActions(capabilityRegistry)` is read
  per call (`index.ts:1332`), so a live registry reaches the permissions page and tool hiding.
- `packages/extension-api/src/manifest-schema.ts`: `capabilities` = `{ events?: [...] }`; manifest
  object is non-strict (unknown keys dropped). `EXTENSION_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/` (no
  underscores, so `-`→`_` is injective).
- `packages/extension-api/src/server-extension-api.ts` (+ DOR-2683 branch): `DataProviderContext`
  gains `ctx.agent` there; ctx is the natural home for a tool-handler seam.
- `services/extensions/extension-server-lifecycle.ts`: `initialize` (idempotent by `sourceKey`,
  compiles before teardown, `register()` bounded by `REGISTER_TIMEOUT_MS = 15_000`) and `shutdown`
  are the single choke point every path reaches (boot, rescan, reload, enable/disable, approve/
  revoke, uninstall — `extension-manager.ts`). `buildSourceKey` hashes path, runPath, version,
  serverEntryPath, dataProxy and the server bundle hash — **not** the rest of the manifest.
- `services/extensions/extension-load-policy.ts`: approval is per artifact; "an update from the SAME
  approved source keeps its approval". Promoting dev-loop tools to `destructive` was rejected there
  for routine-card harm.
- `services/extensions/extension-discovery.ts`: four install places (global, project, and each
  carried inside a plugin), one running copy per id, trusted copies run from a verified snapshot
  (`record.runPath`).
- `decisions/260706-192819-harness-native-plugin-delivery.md`, `packages/harness/src/sources/installed.ts`,
  `plan/installed-projector.ts`, `plan/global-projector.ts`, `services/harness/auto-project.ts`:
  project-scoped plugin skills become `<pkg>__<name>` symlinks under `.claude/skills` and
  `.agents/skills`; global ones reach DorkOS Claude sessions through SDK plugin activation
  (`refreshActivatedPlugins`, consent-gated) and other tools through the global tiers only once
  `harness.global` is answered; uninstall prunes through the orphan sweep. The projector currently
  drops a plugin's `extensions/` layer ("UI extensions run inside DorkOS, not in a harness").
- `specs/marketplace-dev-link/02-specification.md` §5–6 and Q9: the dev-link watcher calls
  `reloadExtension(id)` on any change under `.dork/extensions/<id>/**`; "Late-registered extension
  tools and skills (DOR-2685). When it lands, it rides the same reload."
- Research: `research/20260329_extension_server_side_capabilities.md`,
  `20260326_extension_point_registry_patterns.md`, `20260304_mcp_tool_naming_conventions.md`,
  `20260330_claude_code_mcp_lazy_loading_tool_search.md`, `mcp-tool-injection-patterns.md`. None
  covers extension-contributed agent tools; no new external research needed.

## 3) Codebase Map

- **Primary components/modules:** `services/core/capabilities/registry.ts` (becomes core + live
  extension layer); `services/extensions/extension-server-lifecycle.ts` (register/unregister);
  `services/extensions/extension-manager.ts` (reconcile skills after each rescan);
  `packages/extension-api/src/{manifest-schema,server-extension-api}.ts` (contract);
  `services/runtimes/claude-code/sessions/launch-fingerprint.ts` (warm-process staleness);
  `packages/harness/src/sources/installed.ts` + projectors (skills delivery).
- **Shared dependencies:** `@dorkos/shared/capabilities` (catalog shape), `@dorkos/shared/permissions`
  (areas), `@dorkos/skills` (SKILL.md parse/validate), zod 4.6 (`z.fromJSONSchema` exists, checked).
- **Data flow:** `extension.json` `tools` → host validates and converts each input schema to host
  Zod → `register()` binds handlers through `ctx.tools.handle` → lifecycle contributes the
  extension's capabilities to the registry → every tool list built afterwards (Claude per launch,
  Codex/OpenCode per request) carries them → `registry.invoke` validates, gates, calls the handler
  under a deadline → MCP envelope. Skills: manifest `skills` → server publishes the running set →
  Harness Sync projects / sweeps.
- **Feature flags/config:** none new for the feature; the permission area (if added) lands in the
  permission presets; `harness.autoSync` and `harness.global` keep governing projection.
- **Potential blast radius:** the registry's immutability assumption (catalog cache, version hash);
  every tool-list builder; the warm-pump fingerprint; census guards in
  `services/runtimes/claude-code/**` and `services/core/**`; harness orphan sweep (a CLI sync that
  does not know about extension skills would delete them); permissions page.

## 5) Research

- **Potential solutions — registry:**
  1. _Mutable registry with a reserved extension layer._ Core domains composed and frozen exactly
     as today; a second layer accepts and removes per-extension contributions, checked against the
     core claim tables. One `get/invoke/catalog`, so the gate is untouched. Pro: one choke point,
     every consumer becomes live for free. Con: the "immutable" contract and catalog cache change.
  2. _A separate extension registry beside the core one._ Pro: core untouched. Con: every consumer
     (tool lists, catalog, permissions, invoke route) has to learn to merge two registries; the gate
     would exist twice. Rejected.
- **Potential solutions — where the tools live in the tool list:**
  1. _On the `dorkos` server, named `ext_<id>__<tool>`._ Same context resolver, approval hold,
     hidden-tools filter and runtime listener as every capability. Con: one bad schema could empty
     the whole server's `tools/list` — closed by a load-time listability check.
  2. _One MCP server per extension._ Natural isolation and namespace. Con: a second identity/hold
     seam, multiple listener routes for Codex/OpenCode, and the registry's MCP claim table would need
     server-qualified keys. Rejected for v1.
- **Potential solutions — schema:** declare JSON Schema in the manifest and convert with host
  `z.fromJSONSchema` (reviewable before code runs, one Zod copy) vs Zod defined in `server.ts`
  (foreign Zod copy, invisible until code runs). Manifest wins.
- **Potential solutions — skills:** reuse the installed-plugin projection with a published
  "running extension skills" ledger as a new source, vs SDK-only injection (ADR 260706-192819
  already retired that for project scope). Ledger wins: the CLI's `dorkos harness sync` reads the
  same file, so it never sweeps a running extension's skills.
- **Recommendation:** registry option 1, tool placement option 1, manifest JSON Schema, skills via
  ledger + existing projection, warm processes relaunch at the next dispatch when their tool surface
  changed. Detailed in `02-specification.md`.

## 6) Decisions

| #   | Decision                                   | Choice                                                                           | Rationale                                                                                    |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | Registry shape                             | Frozen core + live extension layer behind the same interface                     | One gate, every consumer live; core conflicts still throw at boot                            |
| 2   | Tool placement and naming                  | `dorkos` server, `ext_<id_underscored>__<tool>`; capability id `ext_<id>.<tool>` | Reuses identity, holds, hiding, runtime listener; id fits the permission action pattern      |
| 3   | Where a tool's schema comes from           | JSON Schema in `extension.json`, converted by the host                           | Reviewable before code runs; host owns the one Zod copy and the listability check            |
| 4   | Warm Claude Code processes                 | Tool-surface pin, relaunch at the next dispatch (never mid-turn)                 | `setMcpServers` replacing an sdk server's tools is not live-verified; house rule is relaunch |
| 5   | Skills delivery                            | Same path a plugin's skills take at the same scope, via a published ledger       | ADR 260706-192819; CLI sync parity; sweep un-projects                                        |
| 6   | Destructive tier, area, `capabilities` key | Recommendations recorded; put to Dorian in the spec                              | Product-owner calls                                                                          |

Next step: SPECIFY.
