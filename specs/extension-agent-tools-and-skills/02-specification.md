---
slug: extension-agent-tools-and-skills
id: 261003-200014
created: 2026-10-03
status: specified
linearIssue: DOR-2685
---

# Extensions give agents tools and skills

**Status:** Draft
**Author:** Claude Code (SPECIFY stage, /flow)
**Date:** 2026-10-03

## Overview

An extension can give the person's agents typed **tools** (registry capabilities projected as MCP
tools) and **skills** (`SKILL.md` packs). Both are declared in `extension.json`, appear when the
extension starts, and disappear when it stops — on unload, reload, disable, revoke and uninstall.
Tools join the one capability registry, so the approval gate, permissions, Activity attribution and
tool hiding treat them exactly like any capability of their tier. Skills ride the same Harness Sync
delivery a plugin's skills ride at the same scope (ADR 260706-192819).

## Background / Problem Statement

`composeRegistry` (`apps/server/src/services/core/capabilities/registry.ts:470`) folds every domain
into one frozen registry at boot and caches its catalog forever. The extension manifest's
`capabilities` block (`packages/extension-api/src/manifest-schema.ts:12`) is only the list of event
kinds an extension may subscribe to. No extension path registers a capability id or an MCP tool, so
an email extension cannot give agents typed mail tools: agents would have to call its HTTP routes or
write files, with no schema, no tier, no approval card and no Activity record. Nor can it ship the
skill that teaches an agent when to use those tools.

The motivating extension is the LifeOS mail extension (vault `0-System/mail-app/EXTENSION-PATH.md`),
built as a dev-linked extension (DOR-2696).

## Goals

- `extension.json` can declare `tools` (name, title, description, tier, input schema, display
  fields) and `skills`; the existing `capabilities` key keeps declaring events (see Decision for
  Dorian 3).
- The registry accepts an extension's capabilities when its server half starts and removes them when
  it stops, along every path that starts or stops it.
- The tools appear in every agent tool list built after they register — Claude Code in-process,
  Codex and OpenCode over the runtime listener — under the extension's namespace
  `ext_<id>__<tool>`, and leave every list built after they unregister.
- `registry.invoke` gates an extension tool exactly as it gates a core capability of the same tier
  and area: same refusal payloads, same approval hold, same Activity record.
- An extension's skills project into the harness while it runs and un-project when it stops.
- A recorded decision on destructive-tier extension tools.
- No step here makes DOR-2686 (out-of-process backends) harder: the handler contract is plain JSON
  in, plain JSON out, plus an abort signal.

## Non-Goals

- Out-of-process extension backends (DOR-2686). A synchronous infinite loop in a handler still
  stalls the server, as any in-process extension code can today.
- Extension-contributed hooks, slash commands, MCP resources or prompts.
- Advertising extension tools on the external `/mcp` endpoint, as CLI verbs or in the OpenAPI
  document. They stay reachable through the generic invoke route (`dorkos call ext_<id>.<tool>`)
  every capability already has.
- Showing an extension's tools in marketplace browse before install.
- Per-extension rate limits or circuit breakers.
- Any change to the always-loaded tool set or the auto-allow list (`DORKOS_AGENT_TOOLS`).

## Technical Dependencies

- `zod` 4.6.x (server pins `^4.6.2`, 4.6.5 installed): `z.fromJSONSchema` and `z.toJSONSchema`
  both present (checked 2026-10-03).
- `@anthropic-ai/claude-agent-sdk` in-process MCP server (`createSdkMcpServer`), with the known
  constraint in `tool-exposure.ts`: a `z.record` anywhere in any tool's input empties the whole
  server's `tools/list`.
- `@modelcontextprotocol/sdk` `McpServer` (runtime listener, per request).
- `@dorkos/skills` parser/validator; `@dorkos/harness` installed-source scanner and projectors.
- Lands after DOR-2683 (PR #2518, adds `ctx.agent` to `DataProviderContext`) and DOR-2696 (dev link).

## Detailed Design

### Architecture changes

```
extension.json ──► ExtensionDiscovery ──► ExtensionRecord (manifest validated, tools pre-checked)
                                              │
            ExtensionServerLifecycle.initialize(id)                ExtensionManager (after every rescan)
              compile → register(router, ctx) ──► ctx.tools.handle()        │
              all declared tools handled? ──► registry.contribute(ext)     reconcile running skills
              shutdown(id) ──► contribution.remove() + abort in-flight      │
                                              │                     {dorkHome}/extensions/running-skills.json
                       CapabilityRegistry (frozen core + extension layer)   │
                       ├─ get / invoke (gate unchanged) / catalog (live)    Harness Sync source
                       └─ onChange ─► surface version                       ├─ project scope: .claude/skills, .agents/skills
                                              │                             └─ global scope: plugin path + global tiers
        ┌─────────────────────────────────────┼──────────────────────────┐
  createDorkOsToolServer (per launch)   agent runtime listener   permissions page / list_capabilities
  + warm-pump tool-surface pin          (per request)            (live catalog)
```

### 1. Registry: frozen core, live extension layer

`composeRegistry` keeps composing and validating the core domains exactly as today, and still
throws on a core conflict at boot. The returned `CapabilityRegistry` gains a second layer:

```ts
interface CapabilityRegistry {
  /** Every registered capability: core first, then extension contributions. A fresh frozen array per change. */
  readonly capabilities: readonly CapabilityDefinition[];
  get(id: string): CapabilityDefinition | undefined;
  invoke(id: string, input: unknown, context?: CapabilityInvocationContext): Promise<unknown>;
  catalog(): CapabilityCatalog;
  /**
   * Add one extension's capabilities. Never throws: a conflict comes back as a refusal the
   * caller reports on the extension. Replaces nothing — a second contribution under the same
   * owner is refused until the first is removed.
   */
  contribute(contribution: ExtensionContribution): ContributeResult;
  /** Called after every contribute/remove, with the new surface version. */
  onChange(listener: (version: number) => void): () => void;
}
type ContributeResult = { ok: true; remove(): void } | { ok: false; reason: string };
```

Rules, each enforced in code and pinned by a test:

- **Reserved namespace.** Contribution domains match `^ext_[a-z0-9_]+$`; core domains may never
  start with `ext_` (`composeRegistry` throws). The domain is the extension id with `-` → `_`
  (injective: `EXTENSION_ID_REGEX` forbids `_`).
- **Same claim tables.** A contribution is checked against the core and other contributions for
  duplicate ids and MCP tool names before anything is added; all of one extension's tools are added
  or none are.
- **Host-built definitions only.** `contribute` takes `ExtensionContribution` (owner id, display
  name, and a list of host-built tool specs), never a raw `CapabilityDefinition`. The host fills
  `area` (Decision 2), `surfaces: { mcp: { toolName, servers: ['in-session'] } }`, `output: z.unknown()`
  and `invoke`. An extension can never set `preflight`, `forwardsApproval`, `inSessionCard`,
  `approvalSubject`, `areasForInput`, `readOnlyCarveOut`, `cli`, `http`, or `annotations` overrides.
- **Live catalog.** The serialized-catalog cache and `catalogVersion` are invalidated on every
  change (the hash covers the full capability list, so it changes when the list does).
  `SerializedCapability` gains optional `source: { kind: 'extension'; id: string; name: string }`
  so the permissions page, `list_capabilities` and approval cards can say where a tool comes from.
- **Removal is final for new calls.** After `remove()`, `get` misses and `invoke` on that id answers
  a `CapabilityToolError`: "That tool isn't available right now: <name> is stopped or restarting."
  (copy reviewed under `writing-app-copy`), never the generic "no capability registered" throw.

Consumers already read the registry per call (`capabilitiesForMcpServer`, `permissionActions` at
`index.ts:1332`, `catalog()` in the catalog route and resource), so they become live with no change.
The docs composer (`composeCapabilityRegistryForDocs`) composes no extensions, so OpenAPI export and
every census guard built on it are unchanged by construction.

### 2. Manifest contract (`packages/extension-api/src/manifest-schema.ts`)

```jsonc
{
  "id": "mail-app",
  "serverCapabilities": { "serverEntry": "./server.ts" },
  "tools": [
    {
      "name": "send_message",              // ^[a-z][a-z0-9_]*$, unique in this manifest
      "title": "Send an email",            // card and permissions-page label
      "description": "Send an email from the person's mail account. …",
      "tier": "act",                       // observe | act | destructive (Decision 1)
      "inputSchema": { "type": "object", "properties": { … }, "required": ["to", "subject"], "additionalProperties": false },
      "approvalDisplayFields": ["to", "subject"],
      "timeoutSeconds": 60                 // optional, 1..300, default 60
    }
  ],
  "skills": ["triage-inbox"]               // directory names under <extension>/skills/
}
```

Manifest-level validation (Zod, in the shared schema, so `dorkos marketplace validate` and discovery
agree):

- `tools` requires a server entry (`serverCapabilities`); a proxy-only or client-only extension
  declaring tools is invalid with that reason.
- `approvalDisplayFields` must name top-level `inputSchema.properties` keys.
- Qualified name budget: `mcp__dorkos__ext_<id_underscored>__<name>` at most 64 characters (the
  conservative tool-name bound; implementation re-checks the current limit and keeps the stricter).
- `skills` entries match the skill slug rule (`@dorkos/skills` `validateSlug`).

Schema acceptance (host side, at discovery, so a bad tool is reported before any code runs):

- `inputSchema` must be a JSON Schema object with `type: "object"` at the root, drawn from a stated
  subset: `type` (object, array, string, number, integer, boolean, null), `properties`, `required`,
  `items`, `enum`, `const`, `description`, `default`, `minimum`/`maximum`, `minLength`/`maxLength`,
  `pattern`, `format`, `minItems`/`maxItems`, `anyOf`, and `additionalProperties: false`.
  `additionalProperties` set to `true` or a schema, `patternProperties`, `$ref`, and `propertyNames`
  are refused, because each converts to `z.record` (or worse) and one record empties the entire
  `dorkos` tool list.
- The host converts with its own `z.fromJSONSchema`, walks the result and refuses any `ZodRecord`,
  then runs the converted schema through the same `portableInputShape` + JSON-Schema conversion the
  in-session server performs at `tools/list`. **Property:** a tool the host accepts is a tool the
  SDK can list. A refusal names the tool and the reason on the extension's card; the extension's
  other tools still load.

The existing `capabilities: { events }` key is unchanged.

### 3. Server API (`packages/extension-api/src/server-extension-api.ts`)

```ts
interface DataProviderContext {
  // … existing, including ctx.agent from DOR-2683
  /** Handle the tools this extension declares in extension.json. Probe with `ctx.tools !== undefined`. */
  readonly tools: ToolsApi;
}
interface ToolsApi {
  /** Bind the handler for one declared tool. Throws for a name the manifest does not declare or one already handled. */
  handle(name: string, handler: ExtensionToolHandler): void;
}
type ExtensionToolHandler = (input: unknown, call: ExtensionToolCall) => unknown | Promise<unknown>;
interface ExtensionToolCall {
  /** Aborted when the call's deadline passes or the extension stops. */
  readonly signal: AbortSignal;
  /** The calling agent, when the call carries an agent identity; otherwise null. */
  readonly agentId: string | null;
}
```

`input` is already parsed against the declared schema. The return value must be JSON-serializable
(a string is passed through as text); anything else is a tool error. No session id, cwd, approval
token or identity token is exposed: an extension learns which agent called, nothing else.

### 4. Lifecycle (`services/extensions/extension-server-lifecycle.ts`)

- `createDataProviderContext` builds `ctx.tools` bound to the record's validated tool specs.
- After `register()` settles successfully (and not on timeout), the lifecycle checks every declared
  tool was handled. A declared-but-unhandled tool is dropped with a warning on the card
  ("declares send_message but never handles it"); the handled ones are contributed in one
  `registry.contribute` call. A refused contribution leaves the extension running without tools and
  says why on `record.serverError`'s sibling `record.toolsError` (so a working UI stays up, the
  DOR-1336 rule).
- The contribution handle is stored on `ActiveServerExtension`. `shutdown(id)` calls `remove()`
  **first** (no new calls), then aborts every in-flight call's signal, then runs the existing
  cleanup. A handler that resolves after its extension stopped has its result discarded and the
  agent gets "<name> stopped while this ran."
- `buildSourceKey` adds a digest of the manifest's `tools` and `skills` declarations, so an edit to
  `extension.json` that changes neither the version nor `server.ts` still restarts the extension.
  Without this a manifest-only edit is ignored as "already running, unchanged".
- `register()` timeout, compile failure (previous version keeps serving, and keeps its tools) and
  approval refusal behave as today; tools follow whether a server instance is active.

Because every start/stop path in `ExtensionManager` (boot, rescan, `reloadExtension`, enable/
disable, `approveToRun`/`revokeRunApproval`, uninstall via rescan) goes through `initialize`/
`shutdown`, tools need no other hook.

### 5. Invocation wrapper (host-built `invoke`)

1. The registry has already split `approvalToken`, parsed input with the host Zod schema, and run the
   gate (tier + permission + destructive hold). Nothing extension-specific runs before the gate.
2. The wrapper looks up the live handler; none → the "stopped or restarting" error.
3. It calls the handler with an `AbortController` composed of the registry's per-call `signal`, the
   tool's deadline (`timeoutSeconds`, measured from after the gate, so a person's approval time does
   not count), and the extension's stop signal.
4. A throw or rejection becomes `CapabilityToolError` carrying the handler's message (truncated to
   500 characters) prefixed with the extension name; the error is logged with the extension id and
   never propagates as an unhandled rejection. A deadline overrun answers "<name> didn't answer in
   N seconds."
5. Output: JSON-serialized into the MCP text envelope (`invokeCapabilityAsMcpResult`). A result
   larger than 256 KB serialized is replaced by a tool error ("<name> returned more than the agent
   can read"); the cap is a named constant beside the wrapper.

### 6. Agent tool lists

- **Claude Code.** `createDorkOsToolServer` already maps `capabilitiesForMcpServer(registry,
'in-session')`, so extension tools join the `dorkos` server with the same context resolver,
  approval hold and `hiddenToolNames` filter. They defer behind ToolSearch with a mechanically
  derived `searchHint`; none is ever always-loaded and none is added to `DORKOS_AGENT_TOOLS`, so in
  `default` mode the runtime asks about them exactly as it asks about any non-listed DorkOS tool.
- **Warm processes.** `launch-fingerprint.ts` gains a `toolSurface` pin: a digest of the sorted
  names and input JSON Schemas of every tool on the `dorkos` server the factory built (recorded in a
  `WeakMap` keyed by the server instance, so nothing new reaches the CLI). Disposition `relaunch`:
  a differing surface reaps and relaunches before the next dispatch, never mid-turn. It may move to
  `live` (`setMcpServers`) only after a live test shows the CLI replaces an sdk server's tool list in
  place — the house rule for unverified live behaviour (`claude-code/NOTES.md`). This also closes
  the same gap for permission changes that hide or reveal tools (`permission-tool-filter.ts` promises
  "the next turn"; under a warm pump today it means "the next relaunch").
- **Codex / OpenCode.** `createAgentRuntimeMcpServer` is built per request from the live registry,
  so the next `tools/list` carries the change. No code change; a test pins it.
- **Teaching.** No new prompt block. An extension teaches its tools through its own skills; the
  authoring guide tells skill authors to name tools by their bare name (`ext_mail_app__send_message`)
  because the qualified spelling differs per runtime.

### 7. Skills

**Which skills project:** those of every extension that is enabled, may run
(`mayRunExtensionCode`), valid, compatible, and the running copy for its id — read from the running
copy's directory (`record.runPath ?? record.path`, so a trusted copy projects from its verified
snapshot). An extension with no server half can ship skills; the approval it needs is the same one.

**The ledger.** After every rescan, `ExtensionManager` reconciles that set into
`{dorkHome}/extensions/running-skills.json` (atomic write, only when it changed):

```jsonc
{ "version": 1, "extensions": [
  { "id": "mail-app", "scope": "global" | "local", "projectRoot": "/abs/path" /* local only */,
    "skillsDir": "/abs/run/path/skills", "skills": ["triage-inbox"], "devLink": "/abs/target" /* when dev-linked */ }
] }
```

and then triggers projection: `runAutoProjection` for each affected project root (local scope), and
the global path for global scope (below). The ledger, not live server state, is what the harness
reads, so `dorkos harness sync` from a terminal produces the same plan and its orphan sweep never
removes a running extension's skills. A ledger entry whose `skillsDir` no longer exists contributes
nothing, so its projections are swept.

**Harness source.** `@dorkos/harness` `scanInstalledSources` gains a third source alongside global
and project plugins: ledger entries, surfaced as `InstalledPlugin`s with `kind: 'extension'`, the
extension id as the package name, and only skills (no commands, hooks or tasks). Each listed skill is
parsed with `@dorkos/skills`; an invalid one is dropped with a projection warning.

**Delivery, matching a plugin at the same scope:**

- **Local scope** → project projection, symlinks `.claude/skills/<id>__<skill>` and
  `.agents/skills/<id>__<skill>`, exactly as a project plugin.
- **Global scope** → the same two routes a global plugin takes: the global projector's tiers (only
  where `harness.global` is answered), and, for DorkOS Claude Code sessions, SDK plugin activation:
  the server writes a generated plugin root `{dorkHome}/cache/extensions/skill-plugins/<id>/`
  (`.claude-plugin/plugin.json` + a `skills` link to the running copy's `skills/`) and
  `refreshActivatedPlugins` includes it. Shrinking that set already relaunches a warm process
  (DOR-2306); growing it rides `reloadPlugins`.

**Collisions.** `<id>__<skill>` can equal a plugin's `<pkg>__<skill>` when a plugin carries an
extension of the same name (Flow does). The plugin's skill wins deterministically; the extension's is
dropped with a projection warning naming both. Skill content edits need no re-projection (links);
adding or removing a skill changes the ledger and re-projects.

### 8. Dev link interaction (DOR-2696)

The dev-link watcher calls `reloadExtension(id)` on any change under `.dork/extensions/<id>/**`.
With `buildSourceKey` covering the `tools`/`skills` declarations, that one call re-registers tools
(remove → register → contribute), republishes the ledger and re-projects. A ledger entry for a
dev-linked copy carries `devLink`, so `dorkos harness sync --check` and the harness status list mark
those skills `(dev link: <path>)`, as the dev-link spec does for plugin skills. Hot reload therefore
costs one tool-surface change per save that touches the tool declarations; edits to `server.ts`
alone restart the extension but leave the surface digest equal, so warm processes are not relaunched.

### 9. Census guards

The existing count guards (`mcp-tools/__tests__/tool-exposure.test.ts`, `messaging/__tests__/
context-tool-names.test.ts`, `capability-conformance.test.ts`, `tool-security.test.ts`,
`mcp-tool-gate.test.ts`, `permission-area-census.test.ts`) read the docs registry, which composes no
extension, so they do not move — except the area census if Decision 2(a) adds an area. New guards:

- no core capability id starts with `ext_`, and no core or hand-registered tool name starts with
  `ext_` or contains `__`;
- with a fixture extension loaded, none of its tools is in `ALWAYS_LOADED_TOOLS`,
  `DORKOS_AGENT_TOOLS`, `READ_ONLY_TOOLS` or the read-only carve-out, and each carries the host area;
- a fixture extension's tool appears in a real in-session `tools/list` and in a runtime-listener
  `tools/list`, and is gone from both after `shutdown`;
- a schema that would convert to `z.record` is refused at discovery and the real `tools/list` still
  answers with every core tool.

### Code structure & file organization

```
packages/extension-api/src/
  manifest-schema.ts                 + ExtensionToolDeclarationSchema, tools, skills
  extension-tools.ts                 (new) ToolsApi, ExtensionToolHandler, ExtensionToolCall
  server-extension-api.ts            + ctx.tools
apps/server/src/services/core/capabilities/
  registry.ts                        + extension layer, contribute, onChange, live catalog
  extension-contribution.ts          (new) ExtensionContribution type, domain naming, host definition builder
apps/server/src/services/extensions/
  extension-tool-schema.ts           (new) JSON Schema subset check, fromJSONSchema, listability check
  extension-tools.ts                 (new) ctx.tools binding, invoke wrapper, in-flight abort
  extension-server-lifecycle.ts      contribute after register, remove on shutdown, sourceKey digest
  extension-server-api-factory.ts    ctx.tools
  running-skills-ledger.ts           (new) reconcile + atomic write + projection trigger
  extension-manager.ts               call the ledger reconcile after each rescan
apps/server/src/services/runtimes/claude-code/
  sessions/launch-fingerprint.ts     + toolSurface pin
  mcp-tools/index.ts                 record surface digest per server instance
  mcp-tools/extension-tools.ts       EXTENSION_API_REFERENCE gains ctx.tools + manifest tools/skills
packages/harness/src/sources/
  installed.ts                       + ledger source (kind: 'extension')
  running-extension-skills.ts        (new) ledger reader (shared by server and CLI)
packages/shared/src/
  capabilities.ts                    + SerializedCapability.source
  permissions/permission-ids.ts      + 'extensions' area (only if Decision 2(a))
```

### API changes

- `GET /api/capabilities/catalog` and `list_capabilities`: entries may carry `source`; the list is
  live. Extension capabilities are invocable at `POST /api/capabilities/:id/invoke` like any other.
- `GET /api/extensions` records gain `tools: { name, title, tier, status: 'active' | 'refused',
reason? }[]` and `skills: { name, status: 'projected' | 'dropped', reason? }[]`.
- SSE `/api/events`: `capabilities_changed { version }` on every contribute/remove, so open
  permissions pages and Settings re-fetch.

### Data model changes

No database change. One new derived file, `{dorkHome}/extensions/running-skills.json`, rebuildable
from the extension records at any time (deleting it is a supported recovery: the next rescan writes it
again). If Decision 2(a): `permissions` config accepts the new area id (no migration: a missing area
resolves to its preset default).

## User Experience

- **Author.** Declares tools and skills in `extension.json`, calls `ctx.tools.handle` in
  `server.ts`, saves. On a dev link the tools appear on the next turn of any agent session; a bad
  schema shows on the extension's card in Settings → Extensions naming the tool and the reason.
- **Person approving an extension.** The approval card and the Settings card list what it gives
  agents: "Gives agents 3 tools and 1 skill", expandable to each tool's title and a plain tier label
  (Reads / Acts / Asks you first). No new card is added for tools.
- **Person managing permissions.** Extension tools appear as rows on the permissions page under their
  area (Decision 2), each labelled with the extension's name, settable to Blocked / Ask / Allowed
  like any action.
- **Agent.** Finds the tools through ToolSearch or `list_capabilities`, or is taught by the
  extension's skill. A destructive call raises the same inline approval card as any destructive
  capability, titled with the tool's title and "from <extension name>". A refused or failed call
  returns a sentence, never a stack.
- **Error and exit paths.** Extension stops mid-call → "<name> stopped while this ran." Extension
  restarting → "isn't available right now". Handler throws → its message, prefixed. Deadline →
  "didn't answer in N seconds." Disable/uninstall → tools and skills gone from the next list and the
  next projection.

## Testing Strategy

- **Unit tests:**
  - Registry: contribute/remove round trip; refusal on duplicate id and duplicate tool name against
    core and against another extension (all-or-nothing); core `ext_` domain throws at boot;
    `catalogVersion` changes on contribute and returns to the original value after remove;
    `invoke` on a removed id gives the "stopped or restarting" error; an extension definition cannot
    carry `preflight`/`forwardsApproval`/etc. (type-level and runtime).
  - Gate parity: a fixture `act` tool in a Blocked area is refused; `destructive` without a token
    returns the approval-required payload; with a granted token it runs; the Activity observer
    records an `act` call — each compared to a core capability with the same tier and area.
  - Schema acceptance: each refused keyword is refused with its reason; an accepted schema survives
    the real listing conversion; `approvalDisplayFields` naming a missing property is invalid.
  - Lifecycle: tools contribute only after a successful `register()`; timeout contributes nothing;
    declared-but-unhandled is dropped with a warning; `handle` of an undeclared name throws;
    `shutdown` removes before cleanup and aborts in-flight; a late result is discarded; manifest-only
    edit changes `sourceKey`.
  - Fingerprint: equal surfaces ride; a changed surface relaunches; a `server.ts`-only change leaves
    the digest equal.
  - Ledger: enabled+approved extension appears; disabled, unapproved, invalid, shadowed copies do
    not; trusted copy uses `runPath`; unchanged set writes nothing.
  - Harness: ledger source projects `<id>__<skill>` at project scope; missing `skillsDir` sweeps;
    plugin-vs-extension collision keeps the plugin's skill and warns.
- **Integration tests:** a fixture extension under `apps/server/src/services/extensions/__fixtures__`
  with one tool per tier and one skill, loaded through `ExtensionManager`; assert the real in-session
  `tools/list` (the tool-exposure harness) and runtime-listener `tools/list` before load, after load,
  after disable; assert a CLI-side `dorkos harness sync --check` on the same dorkHome plans no
  removal of its skill.
- **E2E tests:** none in this spec's phases; the existing extension browser specs must stay green
  (Settings card copy changes — grep `apps/e2e` for strings before pushing).
- **Mocking strategy:** no model calls. The registry, lifecycle and harness tests run real code over
  temp dorkHomes; the warm-pump test uses the existing `fake-persistent-cli` / `fake-pump-query`.
- Every implementer runs `pnpm vitest run apps/server/src/services/runtimes/` and
  `pnpm vitest run apps/server/src/services/core` and `services/harness/`, then
  `pnpm --filter @dorkos/server test -- --run`, before pushing (census blast radius).

## Performance Considerations

- `capabilities` and the catalog are rebuilt only on change (extension start/stop), not per read.
- Schema conversion and the listability check run once per discovery, not per call.
- A tool-surface change relaunches each warm Claude Code process once at its next dispatch, which
  costs its prompt cache. Changes are rare (install, update, enable/disable, a dev-link save that
  touches declarations); a `server.ts`-only save does not relaunch.
- Ledger writes are atomic and skipped when nothing changed.

## Security Considerations

- **Trust boundary unchanged.** An extension's code needs a person's one-time approval to run;
  its tools and skills exist only while that holds. A tool adds nothing the extension's code could
  not already do in-process; what it adds is a way for an **agent** to trigger that code, and that
  is exactly what the gate and the permission area govern.
- **Declared tiers are the author's claim.** The host cannot prove a tool marked `observe` only
  reads. The approval card shows every tool with its tier before the code first runs, the area lets
  a person block all of an extension's tools at once, and an `observe` tool in a Blocked area is
  refused like any other (tier only special-cases `destructive`). Updates from the same approved
  source keep their approval (`extension-load-policy.ts`), so a later version can add tools; the
  Settings card shows them, and destructive calls still card every time.
- **No privileged definition fields.** Extensions cannot set preflight hooks, approval forwarding,
  in-session cards, alternate approval subjects, input-dependent areas, the tokenless read-only
  carve-out, or extra surfaces.
- **No auto-allow.** Extension tools are never added to `DORKOS_AGENT_TOOLS` or `READ_ONLY_TOOLS`.
- **Schema hygiene.** The subset and the listability check stop one extension from emptying every
  agent's DorkOS tools.
- **Least data.** The handler learns the calling agent's id and nothing else (no session id, cwd,
  tokens).
- **Skills are prompt content.** They project only for an approved, enabled extension, from the
  verified snapshot when there is one, and un-project on stop. They never project commands or hooks.

## Documentation

- `contributing/extension-authoring.md`: tools and skills section, schema subset, naming, error
  behaviour, the dev-link loop.
- `docs/integrations/extensions.mdx` (user-facing, `writing-for-humans`): what it means when an
  extension gives agents tools and skills, where to see and block them. Uses "connection"/"service"
  vocabulary rules; no "integration" as a noun in prose.
- `EXTENSION_API_REFERENCE` in `mcp-tools/extension-tools.ts` (served by `get_extension_api`).
- `contributing/architecture.md` registry paragraph: core is frozen, extensions are a live layer.
- Changelog fragment in `changelog/unreleased/`.
- Promote `design-decisions.md` entries with `/adr:from-spec` after implementation.

## Implementation Phases

- **Phase 1 — Live registry.** Extension layer, `contribute`/`remove`/`onChange`, live catalog and
  version, `source` on serialized capabilities, `ext_` reservation, the extension permission area
  per Decision 2, `capabilities_changed` event. No extension wiring yet.
- **Phase 2 — Manifest and lifecycle.** `tools`/`skills` in the manifest schema, schema subset +
  listability check at discovery, `ctx.tools`, contribute/remove in the lifecycle, invoke wrapper,
  `sourceKey` digest, fixture extension, `GET /api/extensions` tool statuses.
- **Phase 3 — Agent tool lists.** Tool-surface pin for warm pumps, census guards, real `tools/list`
  integration tests (in-session and runtime listener).
- **Phase 4 — Skills.** Ledger, harness source, project and global delivery, collisions, CLI parity,
  dev-link labelling.
- **Phase 5 — Surfaces and docs.** Settings and approval card listings, permissions-page rows with
  extension names, approval-card attribution, `EXTENSION_API_REFERENCE`, guides, docs page,
  changelog.

## Decisions for Dorian

1. **May an extension register destructive-tier tools?**
   - (a) **Yes.** Every call to one waits for a person's approval, bound to that call's exact input,
     like every destructive capability. The approval card names the extension.
   - (b) No, cap extensions at `act`.
   - **Pick: (a).** Capping does not make a mail extension safer: its "delete all mail" tool would
     simply be declared `act` and run with no card, or not exist. Allowing `destructive` is what
     lets an honest author ask for a card. The extension's code is already trusted in-process, so
     the tier is a control over agents, not over the extension.
2. **Which permission area do extension tools sit in?**
   - (a) **One new area, "Extension tools"**, with each tool as its own row (per-action override,
     labelled with the extension's name). Preset defaults: Careful = Ask, Balanced = Allowed,
     Full = Allowed (destructive still asks in all three).
   - (b) The author picks one of the ten existing areas in the manifest.
   - **Pick: (a).** A person can block every extension tool in one move, the author cannot file a
     mail tool under an area the person already allowed, and the permissions page tells the truth
     about where a tool came from.
3. **What does "a manifest can declare `capabilities`" mean?**
   - (a) **`tools` is the one declaration**: each tool is a registry capability and its MCP tool. The
     existing `capabilities` key keeps declaring event subscriptions.
   - (b) Add a second kind, capabilities without an MCP tool (CLI/HTTP-only verbs), beside `tools`.
   - **Pick: (a).** Every capability already has the generic invoke route, so a tool is reachable
     from `dorkos call` too; a no-tool capability would be a verb agents cannot see.

## Open Questions

1. ~~Late-registered tool and a running session: when does it see it? (RESOLVED)~~
   **Answer:** at its next turn, never mid-turn. Claude Code builds the `dorkos` server per launch and
   a warm process relaunches when its tool surface differs; Codex/OpenCode list per request.
   **Rationale:** mid-turn tool-list changes are not verified for any runtime, and a turn boundary is
   the existing unit for every other launch-option change.
2. ~~One MCP server per extension, or the `dorkos` server? (RESOLVED)~~
   **Answer:** the `dorkos` server, names `ext_<id>__<tool>`.
   **Rationale:** reuses identity resolution, the approval hold, hiding and the runtime listener; the
   blast-radius risk is closed by the load-time listability check instead.
3. ~~Name collisions? (RESOLVED)~~
   **Answer:** impossible across extensions (one running copy per id, ids map injectively) and
   against core (`ext_` reserved, `__` banned in core names); within a manifest, duplicate names are
   invalid; a residual conflict is a refused contribution, never a crash.
   **Rationale:** structural guarantees over runtime arbitration.
4. ~~An extension crashing inside a handler? (RESOLVED)~~
   **Answer:** throw/reject/timeout become a tool error naming the extension; the server keeps
   running; the extension keeps running. A synchronous hang is DOR-2686's to solve.
   **Rationale:** matches how a core capability's failure reaches the agent.
5. ~~Tool input validation? (RESOLVED)~~
   **Answer:** the registry parses input against the host-converted schema before the gate and the
   handler, as for every capability.
   **Rationale:** one validation path.
6. ~~Should an update that adds tools ask again? (RESOLVED)~~
   **Answer:** no; approval stays per artifact and source as today. New tools show on the Settings
   card; destructive calls still card each time; the area can block them.
   **Rationale:** a per-update card is the routine-card harm `extension-load-policy.ts` already
   refused, and a tool does not widen what the extension's code can do.
7. ~~External `/mcp`? (RESOLVED)~~
   **Answer:** not in v1 (`servers: ['in-session']`).
   **Rationale:** smallest surface; external clients can be added once the tokenless carve-out
   question is answered for third-party tools (it would be fail-closed regardless).
8. ~~Global extension skills when `harness.global` was never answered? (RESOLVED)~~
   **Answer:** DorkOS Claude Code sessions still get them through SDK plugin activation; other tools
   and the external CLI get them only after the question is answered — exactly a global plugin's
   behaviour.
   **Rationale:** ADR 260706-192819 parity; no new consent question.

## Related ADRs

- `decisions/260706-192819-harness-native-plugin-delivery.md` — skills delivery path.
- `decisions/0303-harness-sync-multi-source-projection.md` — the multi-source projector the ledger
  joins.
- `decisions/0213-directus-style-server-extension-registration.md` — in-process `register(router, ctx)`;
  the premise DOR-2686 revisits, and the shape `ctx.tools.handle` follows.
- Draft decisions for this spec: `design-decisions.md` (D1–D7).

## References

- Linear DOR-2685; siblings DOR-2683 (PR #2518), DOR-2696 (`specs/marketplace-dev-link/`),
  DOR-2686.
- `specs/capability-registry/`, `specs/agent-permissions/` (areas, D15 hiding),
  `specs/persistent-session-runtime/` (launch fingerprint), `specs/harness-sync-global/`.
- `apps/server/src/services/runtimes/claude-code/NOTES.md` (live vs relaunch verdicts).
- Research: `research/20260329_extension_server_side_capabilities.md`,
  `research/20260304_mcp_tool_naming_conventions.md`,
  `research/20260330_claude_code_mcp_lazy_loading_tool_search.md`.
