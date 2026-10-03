# Tasks: extension-agent-tools-and-skills

Generated from `specs/extension-agent-tools-and-skills/02-specification.md` (mode: full). Each phase is one PR. `03-tasks.json` is canonical.

## Order

- Phase 1 (registry) and task 2.1 (manifest) start in parallel; 4.1 needs only 2.1.
- Critical path: 1.1 → 2.3 → 3.1/3.2 → 5.1.
- Skills track: 2.1 → 4.1 → 4.2 / 4.3, independent of phases 1 and 3.
- Phase 1 task 1.3 depends on Decision for Dorian 2.

## Phase 1: Live registry

### Task 1.1: Add a live extension layer to the capability registry

- Size: large · Priority: high
- Depends on: none · Parallel with: none

Goal: `composeRegistry` (apps/server/src/services/core/capabilities/registry.ts) keeps composing and validating core domains at boot exactly as today (still throws on any core conflict), and the returned registry also accepts per-extension contributions at runtime.

Changes:

- New module `apps/server/src/services/core/capabilities/extension-contribution.ts` exporting:
  - `extensionDomainName(extensionId: string): string` → `'ext_' + extensionId.replaceAll('-', '_')` (injective because EXTENSION_ID_REGEX `/^[a-z0-9][a-z0-9-]*$/` forbids underscores).
  - `interface ExtensionToolSpec { name: string; title: string; description: string; tier: CapabilityTier; input: z.ZodObject; approvalDisplayFields?: readonly string[]; searchHint?: string; invoke: (input: unknown, ctx: CapabilityHandlerContext) => Promise<unknown> }`
  - `interface ExtensionContribution { owner: string /* extension id */; displayName: string; tools: readonly ExtensionToolSpec[] }`
  - `buildExtensionDefinitions(c: ExtensionContribution, area: PermissionAreaId): CapabilityDefinition[]` producing id `<domain>.<name>`, MCP toolName `<domain>__<name>`, `surfaces: { mcp: { toolName, servers: ['in-session'] } }`, `output: z.unknown()`, the given area, and NO preflight / forwardsApproval / inSessionCard / approvalSubject / areasForInput / readOnlyCarveOut / cli / http / annotation overrides. Attach `source: { kind: 'extension', id, name }` metadata.
- `CapabilityRegistry` gains:
  - `readonly capabilities` becomes a getter returning a frozen array: core (registration order) then contributions (contribution order); rebuilt only on change.
  - `contribute(c: ExtensionContribution): { ok: true; remove(): void } | { ok: false; reason: string }` — never throws. Refuses: an owner that already has a live contribution; any id or MCP tool name already claimed by core or another contribution (check all before adding anything: all-or-nothing). `remove()` is idempotent.
  - `onChange(listener: (version: number) => void): () => void`; version is a monotonically increasing integer bumped on every successful contribute/remove.
- `composeRegistry` throws if any CORE domain name starts with `ext_`.
- The lazily cached serialized catalog (`serializedCache`) is invalidated on every change; `catalogVersion` is recomputed from the full list (so it returns to the original value after a contribution is removed).
- `invoke` on an id that matches the `ext_` prefix but is not registered throws `CapabilityToolError` with message "That tool isn't available right now: its extension is stopped or restarting." (instead of the generic "no capability registered" Error). Core unknown ids keep today's behaviour.
- The gate inside `invoke` is unchanged: extension capabilities go through the same tier + permission enforcement and the same invocation observer.

Acceptance criteria / tests (registry.test.ts, new cases, each with a purpose comment):

1. contribute adds tools visible via get/capabilities/catalog; remove takes them away; catalogVersion differs while contributed and equals the original after remove.
2. duplicate id vs core → refused, registry unchanged; duplicate MCP tool name vs another contribution → refused, nothing from the second contribution added.
3. second contribute for the same owner while live → refused; after remove → accepted.
4. composeRegistry with a core domain named `ext_x` throws.
5. onChange fires once per contribute/remove with increasing versions; unsubscribe works.
6. invoke on a removed ext id → CapabilityToolError with the stopped/restarting message.
7. A built extension definition has none of the privileged optional fields (assert keys).
   Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.

### Task 1.2: Expose extension provenance and live changes on the catalog

- Size: small · Priority: medium
- Depends on: 1.1 · Parallel with: 1.3

Goal: everything that reads the catalog can say where a tool came from, and open clients learn when the catalog changed.

Changes:

- `packages/shared/src/capabilities.ts`: `SerializedCapability` gains optional `source?: { kind: 'extension'; id: string; name: string }` (Zod schema + type, TSDoc). Core capabilities omit it.
- `serializeCapability` in registry.ts emits `source` for extension definitions.
- `services/core/self-description/catalog-projection.ts`: compact and full projections carry `source` when present.
- Boot (apps/server/src/index.ts): subscribe to `capabilityRegistry.onChange` and broadcast `capabilities_changed { version }` on the unified `/api/events` stream (follow how `commands_changed` is broadcast). Add the event to the shared event schema.
- Client: the permissions page query and anything keyed on the catalog invalidate on `capabilities_changed` (TanStack Query invalidation in the existing events subscriber).

Tests: serializeCapability includes source for an extension definition and omits it for core; the catalog route returns source; an events-stream test sees capabilities_changed after a contribute. Purpose comments on each.
Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.

### Task 1.3: Add the Extension tools permission area

- Size: medium · Priority: high
- Depends on: 1.1 · Parallel with: 1.2

Goal (Decision for Dorian 2, recommended pick (a); if Dorian picks (b) replace this task with manifest-declared area validation against PERMISSION_AREA_IDS minus floor areas): every extension tool sits in one new area so a person can block, ask about or allow all extension tools at once, with per-tool overrides.

Changes:

- `packages/shared/src/permissions/permission-ids.ts`: add `'extensions'` to PERMISSION_AREA_IDS (not a floor area).
- `permission-areas.ts`: `{ id: 'extensions', label: 'Extension tools', description: 'Use tools that installed extensions add', floor: false, kind: 'state' }` (copy checked with writing-app-copy: dry, under 15 words).
- `permission-presets.ts`: careful = ask, balanced = allowed, full = allowed. Destructive actions still resolve to Ask through resolvePermission's existing destructive rule.
- The host passes area `'extensions'` to buildExtensionDefinitions (task 1.1).
- Config: no migration; a missing area resolves to the preset default. Verify with the adding-config-fields skill whether the permissions config schema enumerates areas; if it does, follow its migration checklist.
- Update the permission area census guard (`services/core/capabilities/__tests__/permission-area-census.test.ts`) deliberately, with a comment naming DOR-2685.
- Client permissions page: the new area renders from the shared list; its rows come from the live catalog and show the extension name from `source` (wire the label; full card styling lands in phase 5).

Tests: resolvePermission for area 'extensions' under each preset; a destructive action in an Allowed extensions area resolves to Ask; an agent override Blocked hides a fixture extension tool via resolveToolVisibility. Purpose comments.
Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.

## Phase 2: Manifest and lifecycle

### Task 2.1: Declare tools and skills in the extension manifest

- Size: medium · Priority: high
- Depends on: none · Parallel with: 1.1

Goal: `extension.json` can declare agent tools and skills, validated identically by discovery and by `dorkos marketplace validate`.

Changes in `packages/extension-api/src/manifest-schema.ts`:

- `ExtensionToolDeclarationSchema = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/), title: z.string().min(1).max(80), description: z.string().min(1).max(1024), tier: z.enum(['observe','act','destructive']), inputSchema: z.object({ type: z.literal('object') }).passthrough(), approvalDisplayFields: z.array(z.string()).optional(), timeoutSeconds: z.number().int().min(1).max(300).default(60) })`. The tool name must not contain `__`.
- `ExtensionManifestSchema` gains `tools: z.array(ExtensionToolDeclarationSchema).optional()` and `skills: z.array(z.string()).optional()` (each entry passes @dorkos/skills validateSlug — import the regex only if extension-api may depend on it; otherwise duplicate the slug regex with a comment and a test pinning equality).
- superRefine: tool names unique; `tools` requires `serverCapabilities`; every approvalDisplayFields entry is a key of inputSchema.properties; qualified length `'mcp__dorkos__ext_' + id.replaceAll('-','_') + '__' + name` ≤ 64 characters, with an error naming the tool and the budget.
- Export types `ExtensionToolDeclaration`. TSDoc on every export.
- `capabilities: { events }` unchanged.
- Check `packages/marketplace` validator uses this schema for extension packages; if it has its own copy, point it at this one.

Tests (packages/extension-api/src/**tests**): valid manifest with tools+skills parses; each refinement failure has a message naming the field; tools without serverCapabilities invalid; a 70-char qualified name invalid.
Run `pnpm vitest run packages/extension-api` and `pnpm --filter @dorkos/extension-api typecheck`.

### Task 2.2: Accept only listable tool input schemas

- Size: medium · Priority: high
- Depends on: 2.1 · Parallel with: 1.2, 1.3

Goal: a tool the host accepts is a tool the Claude Agent SDK can list. One record-shaped schema must never empty the whole `dorkos` tools/list (tool-exposure.ts: SDK 0.3.257+ with zod 4.5.3+ throws inside tools/list on any z.record).

New module `apps/server/src/services/extensions/extension-tool-schema.ts`:

- `checkToolInputSchema(json: unknown): { ok: true; zod: z.ZodObject } | { ok: false; reason: string }`.
- Allowed keywords: type (object, array, string, number, integer, boolean, null), properties, required, items, enum, const, description, default, minimum, maximum, minLength, maxLength, pattern, format, minItems, maxItems, anyOf, title, and additionalProperties only when exactly false. Refuse with a named reason: additionalProperties true or a schema, patternProperties, $ref, $defs, propertyNames, unknown keywords. Root must be type object.
- Convert with the host zod `z.fromJSONSchema`; walk the result and refuse any ZodRecord at any depth.
- Listability check: run the converted schema through `portableInputShape` (mcp-projection.ts) and the same zod→JSON Schema conversion the in-session server uses at tools/list (reuse the helper the tool-exposure test uses; if none is exported, export one from mcp-projection.ts). Any throw → refuse with "can't be listed: <message>".
- Discovery (`extension-discovery.ts` or the record builder) runs the check per declared tool and stores `record.toolChecks: { name, ok, reason? }[]`; a refused tool never reaches the lifecycle; siblings still load.

Tests: each refused keyword; a nested additionalProperties:{} deep in an array item refused; an accepted schema round-trips through the real listing conversion; a regression test where a refused schema sits beside valid tools and the real in-session tools/list (tool-exposure harness) still lists every core tool. Purpose comments.
Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.

### Task 2.3: Bind tool handlers through ctx.tools and contribute them at load

- Size: large · Priority: high
- Depends on: 1.1, 2.2 · Parallel with: none

Goal: an extension's declared tools register when its server half starts and are removed when it stops, on every path (boot, rescan, reloadExtension, enable/disable, approveToRun/revokeRunApproval, uninstall) — all of which go through ExtensionServerLifecycle.initialize/shutdown.

Public API (`packages/extension-api/src/extension-tools.ts`, re-exported from server-extension-api.ts):

```ts
export interface ToolsApi {
  handle(name: string, handler: ExtensionToolHandler): void;
}
export type ExtensionToolHandler = (
  input: unknown,
  call: ExtensionToolCall
) => unknown | Promise<unknown>;
export interface ExtensionToolCall {
  readonly signal: AbortSignal;
  readonly agentId: string | null;
}
```

`DataProviderContext` gains `readonly tools: ToolsApi` ("Probe with ctx.tools !== undefined"). `handle` throws for an undeclared name, a refused name, or a second handler for one name.

Server (`apps/server/src/services/extensions/extension-tools.ts` + lifecycle + extension-server-api-factory.ts):

- createDataProviderContext builds ctx.tools over the record's accepted tools.
- After register() settles successfully (not on timeout, not on throw), collect handlers. Declared-but-unhandled tools are dropped with a warning recorded on `record.toolsError` ("declares <name> but never handles it"). Call `registry.contribute` once with all handled tools; on refusal set `record.toolsError` to the reason and keep the extension running (do NOT touch record.status/serverError — DOR-1336 rule: a server-side problem must not pull a working client UI).
- Store the remove handle and an AbortController on ActiveServerExtension. `shutdown(id)`: call remove() FIRST, then abort the stop controller, then the existing teardown.
- Host-built invoke wrapper per tool: look up the live handler (none → CapabilityToolError "<extension name> isn't available right now."); compose an AbortSignal from the registry's per-call signal, a deadline of timeoutSeconds started now (the gate already ran, so approval wait is excluded), and the stop signal; agentId from context.identity when present else null. Throw/reject → CapabilityToolError("<extension name>: <message truncated to 500 chars>"), logged with the extension id, never an unhandled rejection. Deadline → "<extension name> didn't answer in N seconds." Stopped mid-call → "<extension name> stopped while this ran." and any late result discarded. Output: strings pass through; otherwise JSON.stringify; non-serializable → tool error; serialized size > 256 KB (named constant EXTENSION_TOOL_RESULT_MAX_BYTES) → tool error "<extension name> returned more than the agent can read."
- buildSourceKey adds a sha256 of canonical JSON of manifest.tools and manifest.skills, so a manifest-only edit restarts the extension.
- Expose the registry to the lifecycle through the constructor (boot wiring in index.ts after composeDorkOsCapabilityRegistry).
- GET /api/extensions records gain `tools: { name, title, tier, status: 'active' | 'refused', reason? }[]` (public record shape + shared schema).

Fixture: `apps/server/src/services/extensions/__fixtures__/agent-tools-ext/` with extension.json declaring one observe, one act, one destructive tool and one skill, and a server.ts handling them (echo, a counter, a delete-like no-op).

Tests (each with a purpose comment): tools contribute only after a successful register; register timeout contributes nothing; register throw contributes nothing; unhandled declared tool dropped with warning; handle(undeclared) throws; shutdown removes before cleanup runs (assert order) and aborts an in-flight call whose late result is discarded; handler throw → tool error with extension name; deadline → timeout error; sourceKey changes on a tools-only manifest edit and not on a whitespace-only edit; disable → tools gone; re-enable → back; gate parity: the act tool in a Blocked extensions area is refused exactly like a core act capability in a Blocked area; destructive without token → approval-required payload; with a granted token → runs; Activity observer records the act call.
Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.
Also update the server API docs in `EXTENSION_API_REFERENCE` (mcp-tools/extension-tools.ts) with ctx.tools and the manifest tools/skills fields.

## Phase 3: Agent tool lists

### Task 3.1: Relaunch warm Claude Code processes when the tool surface changes

- Size: medium · Priority: high
- Depends on: 2.3 · Parallel with: 3.2

Goal: a warm Claude Code process whose `dorkos` tool list differs from what a fresh launch would list is relaunched before its next dispatch, never mid-turn. Today launch-fingerprint.ts drops the in-process server's `instance`, leaving only `{type:'sdk', name}`, so a tool-list change (extension tools, or permission hiding) never reaches a warm process.

Changes:

- mcp-tools/index.ts: after building the tools array, compute `surfaceDigest` = sha256 of canonical JSON of the sorted list of { name, inputJsonSchema } and record it in an exported WeakMap keyed by the server instance (`dorkosToolSurfaceOf(instance)`). Nothing new is sent to the CLI.
- sessions/launch-fingerprint.ts: new pin `toolSurface` with disposition 'relaunch' in PIN_DISPOSITIONS, described from the sdk servers' recorded digests; document in the module doc and NOTES.md why it is relaunch (setMcpServers replacing an sdk server's tool list in place is not live-verified; house rule resolves unverified behaviour toward relaunch) and the condition for moving it to 'live' (a live test proving in-place replacement).
- Note in permission-tool-filter.ts's module doc that the "next turn" promise now holds under warm pumps too.

Tests (sessions/**tests**/launch-fingerprint.test.ts and a persistent-dispatch test using fake-persistent-cli/fake-pump-query): equal surfaces ride the warm process; a surface with one extra tool relaunches at the next dispatch; a change during a running turn takes effect only after it ends; a server.ts-only extension restart (same declarations) leaves the digest equal; a permission change hiding a tool relaunches. Purpose comments.
Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.

### Task 3.2: Guard extension tools in every tool list

- Size: medium · Priority: high
- Depends on: 2.3 · Parallel with: 3.1

Goal: prove extension tools reach and leave every agent tool list, and can never slip into a privileged set.

Tests to add (no production change expected; if one fails, fix the cause):

- Core never uses the namespace: no capability id in composeCapabilityRegistryForDocs() starts with 'ext_'; no core or hand-registered in-session tool name starts with 'ext_' or contains '__' (handRegisteredInSessionTools).
- With the agent-tools-ext fixture contributed: none of its tool names (qualified via inSessionToolName) is in ALWAYS_LOADED_TOOLS, AGENT_TO_AGENT_TOOLS, DORKOS_AGENT_TOOLS, READ_ONLY_TOOLS (interactive-handlers.ts) or READ_ONLY_MCP_TOOL_NAMES; each has area 'extensions' (or the Decision 2(b) area) and a non-empty searchHint.
- Real in-session tools/list (the tool-exposure.test.ts harness through createDorkOsToolServer) lists the fixture tools after contribute and not after remove; likewise createAgentRuntimeMcpServer (Codex/OpenCode listener) per request.
- hiddenToolNames: an agent with the extensions area Blocked does not see the fixture tools in either list, and the gate still refuses a direct invoke.
- The existing count guards (tool-exposure toHaveLength, context-tool-names advertised.size) stay unchanged — assert in a comment why (docs registry composes no extensions).
  Run `pnpm vitest run apps/server/src/services/runtimes/` and `pnpm vitest run apps/server/src/services/core` and the full server suite.

## Phase 4: Skills

### Task 4.1: Publish the running extensions' skills ledger

- Size: medium · Priority: high
- Depends on: 2.1 · Parallel with: 1.1, 2.2

Goal: one derived file says which extension skills should be projected right now, so the server and a terminal `dorkos harness sync` plan the same thing.

Changes:

- New `packages/harness/src/sources/running-extension-skills.ts`: Zod schema + reader for `{dorkHome}/extensions/running-skills.json`: `{ version: 1, extensions: [{ id, scope: 'global' | 'local', projectRoot?: string /* local only, absolute */, skillsDir: string /* absolute */, skills: string[], devLink?: string }] }`. Reader: absent or unparseable → empty list with a recorded warning, never a throw.
- New `apps/server/src/services/extensions/running-skills-ledger.ts`: `reconcileRunningSkills(records, config)` selects extensions that are enabled, `mayRunExtensionCode`, valid, compatible, the running copy for their id, and declare skills; skillsDir = path.join(record.runPath ?? record.path, 'skills'); keep only declared skills whose `<skillsDir>/<name>/SKILL.md` exists. Write atomically (temp + rename) only when the content changed; return the set of affected scopes/project roots (old ∪ new).
- ExtensionManager: call reconcile after every rescan settles (boot, reload, enable/disable, approve/revoke, uninstall), then trigger projection: runAutoProjection-equivalent for each affected local project root (respect harness.autoSync), and the global refresh (task 4.3) for global scope. Best-effort: failures log a warning, never throw into the request path.
- devLink: set when the record is dev-linked (dev-link registry from DOR-2696; if that field is not available yet, omit and leave a typed optional).

Tests: enabled+approved extension with a skill appears; disabled, unapproved, invalid, shadowed copies do not; trusted copy uses runPath; a declared skill missing on disk is omitted; unchanged set performs no write (assert mtime); deleting the file and rescanning rewrites it. Purpose comments.
Run `pnpm vitest run apps/server/src/services/extensions packages/harness`.

### Task 4.2: Project extension skills like a plugin's at project scope

- Size: medium · Priority: high
- Depends on: 4.1 · Parallel with: none

Goal: a local-scope extension's skills appear as `.claude/skills/<id>__<skill>` and `.agents/skills/<id>__<skill>` symlinks, exactly as a project-scoped plugin's (ADR 260706-192819), and are swept when the extension stops.

Changes in packages/harness:

- `scanInstalledSources` reads the ledger (dorkHome is already an input) and surfaces each local entry whose projectRoot equals the repo root being synced as an InstalledPlugin with `kind: 'extension'`, name = extension id, skills only (no commands, hooks, tasks), skill dir = skillsDir/<name>. Parse each SKILL.md with @dorkos/skills; invalid → ProjectionWarning, dropped.
- installed-projector: extension-kind packages project skills through the same symlink path as plugins; never commands/hooks.
- Collision: if a plugin package already plans `<id>__<skill>`, the plugin wins; the extension's is dropped with a warning naming both sources.
- Orphan sweep: a ledger entry removed or whose skillsDir is gone → its links are swept (existing sweep, verify).
- devLink entries are labelled `(dev link: <path>)` in the plan, `dorkos harness sync --check` output and services/harness/status.ts, matching the dev-link spec's plugin labelling.
- CLI parity: `dorkos harness sync` (packages/cli) passes dorkHome so it reads the same ledger; add a test that a terminal sync on a dorkHome whose ledger lists an extension skill plans no removal of it.

Tests: project with ledger entry → both links planned; entry removed → links swept; collision → plugin kept + warning; invalid SKILL.md → warning; services/harness/**tests** suites stay green (watch project-agent-workspace pack-inventory pins). Purpose comments.
Run `pnpm vitest run packages/harness apps/server/src/services/harness`.

### Task 4.3: Deliver global extension skills through the global plugin path

- Size: medium · Priority: medium
- Depends on: 4.1 · Parallel with: 4.2

Goal: a global-scope extension's skills reach agents exactly as a global plugin's do: the global projector tiers (only where harness.global was answered) and, for DorkOS Claude Code sessions, SDK plugin activation.

Changes:

- packages/harness global-projector: include global ledger entries as extension-kind packages (skills only) in the three tiers, same collision rule (plugin wins).
- Server: for each global ledger entry, maintain a generated plugin root `{dorkHome}/cache/extensions/skill-plugins/<id>/` containing `.claude-plugin/plugin.json` ({ "name": "<id>", "version": "<manifest version>" }) and a `skills` symlink to the entry's skillsDir; remove roots no longer in the ledger. `ClaudeCodeRuntime.refreshActivatedPlugins` appends these roots to activatedPlugins (they are already consented: the extension's run approval is the consent). Growing the set rides reloadPlugins; shrinking already relaunches warm processes (DOR-2306) — add a test proving an unloaded extension's skill plugin is gone from the next launch.
- Call refreshActivatedPlugins after a reconcile that changed global entries.

Tests: global entry → plugin root generated and included; entry removed → root deleted and excluded; harness.global unanswered → no user-tier links but DorkOS Claude sessions still get the plugin root; answered → links planned. Purpose comments.
Before pushing: `pnpm vitest run apps/server/src/services/core`, `pnpm vitest run apps/server/src/services/runtimes/`, `pnpm vitest run apps/server/src/services/extensions`, then `pnpm --filter @dorkos/server test -- --run` and `pnpm verify`. Rebuild `@dorkos/shared` first if imports resolve stale.

## Phase 5: Surfaces and docs

### Task 5.1: Show extension tools and skills where people decide about them

- Size: medium · Priority: medium
- Depends on: 2.3, 4.1, 1.2 · Parallel with: 5.2

Goal: a person sees what an extension gives agents before and after approving it, and where each tool sits in permissions.

Changes (apps/client, FSD layers; follow writing-app-copy: no "we", ≤15 words per block, run `pnpm check:copy-length`):

- Settings → Extensions card: one line "Gives agents 3 tools and 1 skill" (pluralised), expandable to rows: tool title + tier label (observe → "Reads", act → "Acts", destructive → "Asks you first") and skill names; refused tools/dropped skills show their reason in muted text.
- Extension approval row/card (Activity inbox, extension.approval) lists the same summary so the person sees tools and tiers before first run. Server side: include the tool/skill summary in the approval payload.
- Permissions page: extension tool rows show "from <extension name>" using catalog `source`.
- Destructive approval card for an extension tool: title is the tool title, subtitle "from <extension name>" (read source from the capability; extend the card view model, not the generic gate).
- Grep apps/e2e for any Settings→Extensions strings you change; update browser specs in the same PR.
- Dev Playground: add a showcase for the card's tools list if the card already has one (maintaining-dev-playground skill).

Tests: RTL tests for the card summary (0, 1, many; refused reason), approval card subtitle, permissions row label. Purpose comments.
Run `pnpm vitest run apps/client` targeted files and `pnpm --filter @dorkos/client typecheck`.

### Task 5.2: Document extension tools and skills

- Size: small · Priority: medium
- Depends on: 2.3, 4.2 · Parallel with: 5.1

Goal: authors and people can learn the feature without reading source.

Changes:

- contributing/extension-authoring.md: "Giving agents tools" and "Shipping skills" sections: manifest fields with a complete example (mail-style send_message tool), the JSON Schema subset and why (one record schema would hide every DorkOS tool), naming (`ext_<id>__<tool>`; tell skill authors to name tools by bare name because the qualified spelling differs per runtime), tiers and what each means for cards, errors/timeouts/256 KB cap, the stop/restart behaviour, and the dev-link loop.
- docs/integrations/extensions.mdx (writing-for-humans; no "integration/connector/adapter/provider" as user-facing nouns; never "mission control"/"cockpit"): what it means when an extension gives agents tools and skills, where to see them, how to block them in permissions.
- contributing/architecture.md: registry paragraph — frozen core, live extension layer.
- Confirm EXTENSION_API_REFERENCE (task 2.3) matches the shipped types.
- Changelog fragment in changelog/unreleased/ (id from .claude/scripts/id.ts, covers: block per changelog/README.md), plain language: "Extensions can now give your agents tools and skills."
- Run scripts/check-banned-words.sh and `pnpm exec tsx scripts/check-vocab-gate.ts` (or the typecheck workflow equivalent) locally.
- After merge: /adr:from-spec to promote design-decisions.md D1–D7 that still hold.
