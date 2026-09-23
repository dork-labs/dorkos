---
slug: agent-permissions
id: 260923-223844
created: 2026-09-23
status: specified
tracker: DOR-2278
---

# Agent Permissions: one default for everyone, a few agents set differently

**Status:** Draft
**Author:** Claude (SPECIFY stage, with Dorian's decisions of 2026-09-23)
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md) (the design and the operator's decisions; this document carries it forward and grounds it in code, it does not re-open it)

## Overview

Today an agent's powers are set by three unrelated gates plus a fourth dial, each with its own shape, and none of them can be set once for everyone. This spec replaces the per-agent tool-group gate (`roomsManage`), the per-agent tier ceiling, the global and per-agent context switches (`agentContext.*Tools` / `enabledToolGroups.{tasks,relay,mesh,adapter}`), and the login-only standing grants with **one permission model**:

- **Areas** (Rooms, Tasks & schedules, Other agents, …): plain-language groups of things an agent can do.
- **Three states**: **Blocked**, **Ask**, **Allowed**.
- **One default for everyone**, set by a **preset** (Careful · Balanced · Full power), with **per-agent overrides** and, for a few actions, **per-action overrides**.
- **One resolver**, **one gate** (inside the existing tier gate, at its three choke points), **one audit trail**, **one set of UI parts**.
- **Ask is built on the approval machinery that already exists**: the same approval record, the same in-session hold that resumes the call in the same turn, the same late-verdict delivery that wakes an idle session, the same card. What changes is _what decides whether to ask_: the resolved permission, not only the capability's tier.

One sentence, for the user: **pick how much power your agents have; when one needs more, it asks right where you're working, and your answer is remembered.**

## Background / Problem Statement

Evidence (session `e687427b-61fc-4a5d-b889-48e2067730fe`): DorkBot was asked to make a channel for a project. `create_room` came back `tool_group_disabled`, and DorkBot handed the job back: "open DorkBot's settings, go to the Tools tab, turn on Manage rooms, and tell me to go again."

Grounded in code, the problem has five parts:

1. **The only per-agent gate that refuses has no global default and no approval path.** `enforceToolGroupGrant` (`apps/server/src/services/core/capabilities/tool-group-enforcement.ts:213-246`) refuses with `approvable: false` unless the agent's own manifest says `enabledToolGroups.roomsManage === true` (`tool-group-grants.ts:39-46`). ADR `260828-123331` made "absent means off, no global twin" a rule. On an install where the person chose Full power, every agent still cannot make a room.
2. **Three gates, three shapes.** The tool-group gate (on/off, fails closed, `registry.ts:536-547`), the tier ceiling (`observe/act/destructive`, `tier-enforcement.ts:1001-1022`, `mesh-schemas.ts:571-575`), and tier approval (destructive-only, `tier-enforcement.ts:1045-1047` returns `allowed` for every `act` call before any ask). The trust stop is a fourth, separate thing with no per-agent layer (`resolve-session-defaults.ts:13-14`: "A manifest has no trust level").
3. **The context switches say they restrict and do not.** `agentContext.*Tools` and the four `enabledToolGroups` documentation keys only leave tool docs out of the system prompt; the tools stay registered and callable (`packages/shared/src/mcp-tool-groups.ts` module doc; ADR `260726-171347`). Only claude-code even reads them (`tool-filter.ts:104`; Codex and OpenCode never call `resolveToolConfig`).
4. **A refusal dead-ends the conversation.** Nothing lets a person say "yes" to a `tool_group_disabled` or `tier_ceiling` refusal; both are `approvable: false`. Standing grants ("stop asking") exist only for destructive calls and only with login on (`approvals.ts` module doc; `standing-grant-posture.ts`).
5. **Changes leave no trail.** Agent manifest PATCHes emit no Activity event (`routes/mesh.ts:554-600`), `PATCH /api/config` only logs (`routes/config.ts:538-551`, `writer: { kind: 'unattributed' }`), and `PATCH /api/mesh/agents/:id` has **no caller guard at all**, so any local program can write `roomsManage: true`.

Kai (10 agents, 5 projects) will not visit 35 settings pages. Priya wants one rule she can read in the source.

## Goals

- One model: areas × Blocked/Ask/Allowed × default + per-agent override (+ per-action override where risk differs), resolved by one pure function and enforced at one gate.
- A preset sets every area at once; Full power gives agents far more room than today; a floor keeps three areas from ever being Allowed.
- **Phase 1 outcome that must hold:** on an install whose first-run pick was Full power, DorkBot's `create_room` succeeds with no settings trip.
- Ask never dead-ends: the card appears where the person is, the answer is **Allow** (once), **Always allow** (this action, this agent), or **Deny**, and the agent continues on its own after a yes.
- Blocked hides the area's tools from the agent's context, leaving one line that says it can ask; it can still ask once, rate-limited.
- Every permission change and every answer is audited, attributed honestly (with login off DorkOS never claims to know it was "you"), and undoable from history.
- Retire, with migrations, everything this replaces. No second path left alongside.

## Non-Goals

- **Connected-account grants** (Accounts under Composio & Nango) stay on their own grant and approval flow. The Permissions page links to them. A follow-up issue is being filed (operator decision 6). Every `connector.*` / `connectors.*` capability carries no area.
- **DOR-2096** (push/PR/publish from unattended turns has no gate), **DOR-2159** (artifact-bound capabilities cannot be standing), **DOR-2112** (files area and ROOM.md in every room).
- **Multi-user roles.** One operator per install.
- **Schedule arming.** An agent-created schedule still parks at `pending_approval` until a person arms it (`services/tasks/task-write-policy.ts`, `task-store.ts:500`), on every preset. That gate protects future unattended runs and is DOR-2096's neighbour, not part of this model.
- **Per-area switches in the Control Center** (operator decision 7: summary only).
- **Moving `ExecutionExceptionsStrip` onto the shared exceptions chip.** Possible later; not required here.

## Technical Dependencies

No new libraries. Built on:

- Zod 4 schemas in `@dorkos/shared` (new subpath `@dorkos/shared/permissions`, added to `packages/shared/package.json` `exports`).
- `conf` semver-keyed config migrations (`apps/server/src/services/core/config-manager.ts:3313` `CONFIG_MIGRATIONS`; guide `contributing/configuration.md`, skill `adding-config-fields`). The newest merged key is `'0.82.0'` (`config-manager.ts:4046-4051`), so this work opens **the next unmerged key at implementation time (`'0.83.0'` today)** and pins it in `apps/server/src/services/core/__tests__/merged-migration-hashes.ts` in the same PR.
- Drizzle (SQLite): one migration drops `agent_tokens.tier_ceiling` (`packages/db/src/schema/agent-identity.ts:50`) and one drops the `approval_grants` table (`packages/db/src/schema/approval-grants.ts:45`).
- The approvals primitive (`apps/server/src/services/core/approvals/`), the in-session hold (`capabilities/capability-approval-hold.ts`), and late-verdict delivery (`approvals/approval-verdict-delivery.ts`, ADR `260909-123910`).
- Client: React 19, TanStack Query, shadcn/ui, the existing `ApprovalCard`, `TrustDial`, and `ProvenanceChip` (`shared/ui/provenance-chip.tsx`, which exists and has no production user yet).

## Detailed Design

### D1. Areas

An **area** is a plain-language group of actions. The registry lives in `packages/shared/src/permissions/permission-areas.ts`. Each entry: `id`, `label`, one-line `description` (user-facing, writing-for-humans), `floor: boolean`, `kind: 'state' | 'trust-stop'`, and its value in each preset.

**Refinement of the ideation, and why.** The ideation put each area's capability ids inside the area registry. This spec puts the membership on the **action** instead: every capability declares `area` on its definition, and every hand-registered MCP tool declares `area` in `MCP_TOOL_TIERS`. That is the codebase's standing rule for per-tool facts (one fact per tool, in one place, no list restating it; `mcp-tool-tiers.ts` module doc, DOR-499), and it is the same shape `toolGroup` has today (`capability-definition.ts:210`). The client never holds a list; it reads each area's actions from `GET /api/permissions`, derived on the server from the live registry and the tool table.

**Two areas are added to the ideation's first cut, because decision 5 needs them.** Retiring `agentContext.relayTools` and `agentContext.adapterTools` (and their per-agent twins) with a faithful migration needs somewhere for an "off" to land. So:

- **Messages**: agents messaging each other, and messaging the person (the old Messaging switch).
- **Chat connections**: turning Telegram/Slack connections on and off, and chat routes (the old "Connection management" switch). User-facing name follows ADR `260804-021140` (a Telegram or Slack hookup is a _connection_).

| id            | Label              | Description (UI copy)                                                                | Floor | Kind       |
| ------------- | ------------------ | ------------------------------------------------------------------------------------ | ----- | ---------- |
| `rooms`       | Rooms              | Make rooms, add or remove people, rename them, leave them, put them away             | no    | state      |
| `tasks`       | Tasks & schedules  | Create, change, and delete scheduled tasks                                           | no    | state      |
| `agents`      | Other agents       | Set up, change, and remove agents, and sort the sidebar                              | no    | state      |
| `messages`    | Messages           | Message other agents, and message you                                                | no    | state      |
| `connections` | Chat connections   | Turn Telegram and Slack connections on or off, and change where chats go             | no    | state      |
| `packages`    | Tools & packages   | Install or remove packages, add or change MCP servers, build extensions              | no    | state      |
| `settings`    | DorkOS settings    | Change your everyday settings, like notifications and the sidebar                    | no    | state      |
| `safety`      | Safety limits 🔒   | Change reply limits, message caps, and an agent's safety boundaries                  | yes   | state      |
| `permissions` | Permissions 🔒     | Change what any agent is allowed to do                                               | yes   | state      |
| `reach`       | Reach & secrets 🔒 | Open this computer to the internet, change login, sign-ins, keys, and folders        | yes   | state      |
| `files`       | Files & commands   | How often the agent stops to check with you while editing files and running commands | no    | trust-stop |

`files` is the one justified exception to the three states (operator decision 3): its values are the existing trust stops (`'ask' | 'act' | 'autonomy'`, `packages/shared/src/agent-runtime.ts:66`), shown with the existing `TrustDial` labels ("Ask first", "Act", "Full autonomy", `shared/ui/trust-dial.tsx:47-51`), because it governs the runtime's own prompts, not DorkOS actions. It shares the row component, the inherit/override pattern, the exceptions chip, the apply dialog, and the audit trail.

### D2. Every action mapped to an area

Rule for what gets **no area** ("always allowed"): reading; the agent's own conversation and memory; its own app window; and anything already governed by another grant (connected accounts). A no-area action keeps exactly today's tier behaviour (observe and act run; destructive asks), so nothing on this list gets looser.

Rule for **reads inside an area** (`tasks_list`, `mesh_list`, …): they are hidden with the area when it is Blocked, and a direct call is refused. Reads never ask: in an Ask area an `observe` action runs. (Otherwise Blocked would be a switch that looks like it restricts and does not, the ADR-0070 defect.)

**Registry capabilities (70 today; 4 added by this spec, marked ★).** Tier from the definition.

| Capability id                                                                                                                                                                                       | Tier                    | Area          | Note                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `rooms.create`, `rooms.add_members`, `rooms.remove_members`, `rooms.update`, `rooms.leave` (`room-capabilities.ts:1285-1565`)                                                                       | act                     | `rooms`       | today `toolGroup: 'roomsManage'`                                                                 |
| ★ `rooms.archive`                                                                                                                                                                                   | act                     | `rooms`       | DOR-2094, see D12                                                                                |
| `rooms.merge` (`:897`)                                                                                                                                                                              | act                     | `rooms`       | per the ideation's Rooms list                                                                    |
| `rooms.post`, `rooms.react`                                                                                                                                                                         | act                     | none          | conversation verbs never get a switch (`room-capabilities.ts:100-116`, room-participation §10.2) |
| `rooms.repo_status`, `rooms.read_history`, `rooms.search_history`, `rooms.list_member_rooms`, `rooms.search_member_rooms`, `rooms.get_room`, `rooms.find_room`, `rooms.read_canvas`                 | observe                 | none          | reading                                                                                          |
| `operator.update_agent` (`operator-capabilities.ts:375`)                                                                                                                                            | act                     | `agents`      | static area, self-edits included (see Open Question 8)                                           |
| `operator.sidebar_add_to_group`, `operator.sidebar_remove_from_group`                                                                                                                               | act                     | `agents`      | ideation: "sidebar groups"                                                                       |
| `operator.update_agent_boundaries` (`:513`)                                                                                                                                                         | destructive             | `safety`      | NOPE.md is a safety boundary                                                                     |
| `operator.config_patch` (`:572`)                                                                                                                                                                    | act                     | `settings`    | **escalates by input**, see D6                                                                   |
| `operator.activity_list`, `operator.config_get`, `operator.check_update`, `operator.agents_recent_activity`, `operator.feedback_draft`                                                              | observe                 | none          | reading / drafting                                                                               |
| `marketplace.install`, `marketplace.create_package`                                                                                                                                                 | act                     | `packages`    |                                                                                                  |
| `marketplace.uninstall`                                                                                                                                                                             | destructive             | `packages`    |                                                                                                  |
| `marketplace.search`, `marketplace.get`, `marketplace.list_marketplaces`, `marketplace.list_installed`, `marketplace.recommend`                                                                     | observe                 | none          |                                                                                                  |
| `mcp.add`, `mcp.import`, `mcp.update`                                                                                                                                                               | destructive             | `packages`    |                                                                                                  |
| `mcp.remove`, `mcp.enable`, `mcp.disable`, `mcp.test`, `mcp.signin`, `mcp.set_client`                                                                                                               | act                     | `packages`    | `mcp.test` runs the server's command                                                             |
| `mcp.poll_signin`                                                                                                                                                                                   | act                     | none          | only continues a sign-in `mcp.signin` already started; asking on every poll would be noise       |
| `mcp.list`, `mcp.browser_preset`                                                                                                                                                                    | observe                 | none          |                                                                                                  |
| `memory.write`                                                                                                                                                                                      | act                     | none          | the agent's own memory                                                                           |
| `ui.control`, `ui.screenshot`, `ui.click`, `ui.type`, `ui.press`, `ui.scroll`, `ui.record_start`, `ui.record_stop`                                                                                  | act                     | none          | the agent's own window seat (spec `canvas-agent-seat`)                                           |
| `ui.state`, `ui.read_canvas_document`, `ui.read_console`, `ui.read_network`, `ui.wait_for`, `ui.read_page`                                                                                          | observe                 | none          |                                                                                                  |
| `capabilities.list`                                                                                                                                                                                 | observe                 | none          |                                                                                                  |
| `connector.list_toolkits`, `connector.recommend`, `connectors.list_granted_connections`, `connectors.list_granted_operations`, `connectors.request_connection`, `connectors.get_connection_request` | observe                 | none          | Accounts: own grant model (decision 6)                                                           |
| `connectors.execute_read`, `connectors.execute_write`, `connectors.execute_destructive`                                                                                                             | observe/act/destructive | none          | Accounts: own grant model; `execute_destructive` keeps the tier ask                              |
| ★ `permissions.list`                                                                                                                                                                                | observe                 | none          | an agent may read its own permissions (D9)                                                       |
| ★ `permissions.request_access`                                                                                                                                                                      | act                     | none          | the way to ask past Blocked (D8)                                                                 |
| ★ `permissions.change`                                                                                                                                                                              | act                     | `permissions` | an agent asking to change a permission; floor, so always a person's yes (D9)                     |

**Hand-registered MCP tools (42, `apps/server/src/services/core/mcp-tool-tiers.ts:125`).**

| Tools                                                                                                                                                                                                               | Area          | Old switch it replaces                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ping`, `get_server_info`, `get_session_count`, `get_agent`, `get_extension_api`, `list_extensions`, `get_extension_errors`                                                                                         | none          | always on                                                                                                                                |
| `tasks_list`, `tasks_get_run_history`, `tasks_create`, `tasks_update`, `tasks_delete` (destructive)                                                                                                                 | `tasks`       | `tasks`                                                                                                                                  |
| `relay_send`, `relay_send_and_wait`, `relay_send_async`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`, `relay_unregister_endpoint`, `relay_get_trace`, `relay_get_metrics`, `relay_notify_user` | `messages`    | `relay` (and `trace`; `relay_notify_user` moves here from the `binding` group because it is a message to the person, not a route change) |
| `relay_list_adapters`, `relay_enable_adapter`, `relay_disable_adapter`, `relay_reload_adapters`, `binding_list`, `binding_create`, `binding_delete`, `binding_list_sessions`                                        | `connections` | `adapter` (and `binding`)                                                                                                                |
| `mesh_list`, `mesh_status`, `mesh_inspect`, `mesh_query_topology`, `mesh_discover`, `mesh_register`, `mesh_deny`, `mesh_unregister` (destructive), `create_agent`                                                   | `agents`      | `mesh` (`create_agent` was always on)                                                                                                    |
| `create_extension`, `reload_extensions`, `test_extension`                                                                                                                                                           | `packages`    | always on                                                                                                                                |

`MCP_TOOL_GATE_GROUPS`, `ToolGateGroup`, `TOOL_GATE_GROUP_DOMAIN`, `ToolDomainKey`, `toolNamesForDomain` and `SESSION_CORE_TOOL_*` in `packages/shared/src/mcp-tool-groups.ts` are deleted; the two `_every*` compile-time assertions in `mcp-tool-tiers.ts` go with them (the tier table is now the single per-tool table, carrying `tier`, `title`, `area`, card fields). ADR-0071's implicit hierarchy (trace follows relay, binding follows adapter) is replaced by explicit membership.

**The census (fails when an action lacks an area).**

- `CapabilityDefinition.area: PermissionAreaId | null` is a **required** field (replacing `toolGroup?`), so the compiler is the first census. `null` must be accompanied by `areaNote: string` (why it is always allowed); a definition with `area: null` and no note fails conformance.
- `McpToolTier.area: PermissionAreaId | null` is required on every `MCP_TOOL_TIERS` entry (`satisfies Record<string, McpToolTier>` makes a missing one a type error), with the same `areaNote` rule.
- `apps/server/src/services/core/capabilities/__tests__/permission-area-census.test.ts` walks `composeCapabilityRegistryForDocs()` (every domain, `dorkos-registry.ts`) plus `MCP_TOOL_TIERS` and asserts: every action has an area or a note; every non-`files` area has at least one member; no `observe` action is the only member of an area; every action in a floor area has `approvalDisplayFields`; `serializeCapability` emits `area` (so the catalog carries it, as it carries `toolGroup` today).

### D3. The three states and what each one does

| State       | Tool in the agent's context?                                                                         | A direct call                                                                                                               | Can the agent ask?                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Allowed** | yes                                                                                                  | runs                                                                                                                        | n/a                                                                        |
| **Ask**     | yes                                                                                                  | `observe` runs; `act`/`destructive` mint an approval and raise the request card (the existing `ask()` flow)                 | yes, every call                                                            |
| **Blocked** | no; one line per area instead: "You can ask for Rooms with the tool ending in `request_permission`." | refused, `reason: 'permission_blocked'`, `approvable: true`, message names the request tool; **no card from a direct call** | yes, deliberately, through `permissions.request_access` (D8), rate-limited |

**The destructive rule.** A `destructive` action whose state comes from an **area-level** setting (an area default, an agent's area override, or the preset) reads **Allowed as Ask**. Only an explicit **action-level** Allowed (an Always allow, or a person setting that one action in "Show individual actions") lets a destructive action run without asking. This keeps today's guarantee ("destructive means a person has to say yes first", `capability-definition.ts:108-113`) true on every preset, and it is what the ideation's "Tasks: Allowed; delete asks" and "Other agents: Allowed; unregister asks" mean, expressed as one rule instead of a list.

**The floor.** A floor area can be Blocked or Ask, never Allowed, at every layer (default, agent, action). Always allow is never offered for an action in a floor area. The resolver clamps a stored Allowed to Ask (`source: 'floor'`) as a second line; the write paths refuse to store one in the first place.

**Inactive identity.** A revoked or expired agent identity (`AgentIdentity.inactive`) resolves every area to Blocked, not approvable, and gets no card. This carries forward both `REVOKED_TIER_CEILING` (`tier-enforcement.ts:676-680`) and the tool-group gate's `!identity.inactive` rule (`tool-group-enforcement.ts:220-230`).

### D4. Data model

New module `packages/shared/src/permissions/` (subpath `@dorkos/shared/permissions`): `permission-areas.ts`, `permission-schemas.ts`, `permission-presets.ts`, `resolve-permission.ts`.

```ts
// permission-schemas.ts
export const PERMISSION_STATES = ['blocked', 'ask', 'allowed'] as const;
export const PermissionStateSchema = z.enum(PERMISSION_STATES).openapi('PermissionState');
export type PermissionState = z.infer<typeof PermissionStateSchema>;

/** The ten areas that take a state. `files` is separate: it takes a trust stop. */
export const PERMISSION_AREA_IDS = [
  'rooms',
  'tasks',
  'agents',
  'messages',
  'connections',
  'packages',
  'settings',
  'safety',
  'permissions',
  'reach',
] as const;
export const PermissionAreaIdSchema = z.enum(PERMISSION_AREA_IDS);
export type PermissionAreaId = z.infer<typeof PermissionAreaIdSchema>;

export const PERMISSION_PRESETS = ['careful', 'balanced', 'full'] as const;
export const PermissionPresetSchema = z.enum(PERMISSION_PRESETS);

/** A capability id (`domain.verb`) or a hand-registered tool name (no dot). */
export const PermissionActionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)?$/);

/**
 * Stored overrides. Keyed by plain string ON PURPOSE, not by the enum: a manifest
 * written by a newer build that knows an extra area must still parse on an older
 * one (the `workspace` precedent in mesh-schemas.ts — refusing the parse makes the
 * agent vanish from the fleet). Known-id and floor checks run on WRITE (D10) and
 * the resolver ignores unknown keys.
 */
export const PermissionOverridesSchema = z.object({
  areas: z.record(z.string(), PermissionStateSchema).default({}),
  actions: z.record(PermissionActionIdSchema, PermissionStateSchema).default({}),
});
```

**User config** (`packages/shared/src/config-schema.ts`, a new top-level section; declared per-field AND in the object-literal default, the two-declaration rule):

```ts
permissions: z.object({
  /** The preset every area starts from. `null` = not chosen yet (D5, "Unchanged"). */
  preset: PermissionPresetSchema.nullable().default(null),
  /** The changes a person made on top of the preset ("Full power, 2 changes"). */
  defaults: PermissionOverridesSchema.default({ areas: {}, actions: {} }),
}).default(() => ({ preset: null, defaults: { areas: {}, actions: {} } })),
```

The global value of `files` is **not** duplicated here: it stays `runtimes.defaultTrustStop` (+ per-runtime leaves, `config-schema.ts:2595, 1483, 2642, 2673`), which the preset writes (D5).

**Agent manifest** (`packages/shared/src/mesh-schemas.ts`, `AgentManifestSchema`; absent means inherit everything):

```ts
permissions: z.object({
  areas: z.record(z.string(), PermissionStateSchema).optional(),
  actions: z.record(PermissionActionIdSchema, PermissionStateSchema).optional(),
  /** Per-agent trust stop — the "Files & commands" row. Absent = inherit. */
  filesAndCommands: z.enum(PERMISSION_STOPS).optional(),
}).optional(),
```

Deliberately **not** `.catch(undefined)`: a security control that cannot be parsed must be loud, the `tierCeiling`/`mcpServers` precedent (`mesh-schemas.ts:560-570`). The forward-compatibility need is met by string keys instead.

`permissions` is **not** added to `UpdateAgentRequestSchema`'s `.pick()` (`mesh-schemas.ts:826-870`), and `enabledToolGroups` and `tierCeiling` are removed from it: the generic agent PATCH can no longer write any permission. Permission writes have their own routes (D10). `AgentManifestUpdate` drops `tierCeiling` (`:632, :648`).

**Legacy manifest fields** (`enabledToolGroups`, `tierCeiling`) are read by a `z.preprocess` on `AgentManifestSchema` that folds them into `permissions` when `permissions` is absent, then drops them (D13). The preprocess is permanent, and that is justified: marketplace agent packages and copied or restored `.dork/agent.json` files will carry the old fields for as long as they exist, and a manifest read is the only seam every one of them passes.

**Resolver** (`resolve-permission.ts`, pure, no I/O; the server and the client both call it):

```ts
export type PermissionSource =
  | 'agent-action' // this agent, this one action (e.g. Always allow)
  | 'agent-area' // this agent, the whole area
  | 'default-action' // everyone, this one action
  | 'default-area' // everyone, the whole area (a change on top of the preset)
  | 'preset' // the preset's own value
  | 'unchanged' // preset not chosen yet: today's behaviour (D5)
  | 'floor' // clamped from Allowed by the floor
  | 'inactive'; // the agent's access was turned off or ran out

export interface ResolvedPermission {
  area: PermissionAreaId;
  state: PermissionState;
  source: PermissionSource;
  /** The coarse answer every "why?" line starts from. */
  layer: 'agent' | 'default' | 'floor';
  /** True when the destructive rule (D3) turned an area-level Allowed into Ask. */
  destructiveAsk?: true;
}

export function resolvePermission(input: {
  area: PermissionAreaId;
  actionId: string;
  tier: CapabilityTier;
  config: { preset: PermissionPreset | null; defaults: PermissionOverrides };
  /** Absent for an unidentified caller: agent layers are skipped (D11). */
  agent?: AgentPermissions;
  inactive?: boolean;
}): ResolvedPermission;
```

Precedence, first match wins:

1. `inactive` → `blocked` (`source: 'inactive'`).
2. `agent.actions[actionId]` → `agent-action`.
3. `agent.areas[area]` → `agent-area`.
4. `config.defaults.actions[actionId]` → `default-action`.
5. `config.defaults.areas[area]` → `default-area`.
6. preset table for `config.preset`, or the **Unchanged** table when `preset` is `null` → `preset` / `unchanged`.

Then: the destructive rule (area-level Allowed on a `destructive` action → Ask, `destructiveAsk: true`), then the floor clamp (Allowed in a floor area → Ask, `source: 'floor'`). The agent layer beats the default layer, and inside each layer the action beats the area (the ideation's `agent override ?? global default ?? built-in`).

A second function covers the trust-stop row:

```ts
export function resolveFilesAndCommands(input: {
  agent?: { filesAndCommands?: PermissionStop };
  perRuntime?: PermissionStop | null; // runtimes.<runtime>.defaultTrustStop
  global?: PermissionStop | null; // runtimes.defaultTrustStop
}): { stop: PermissionStop | null; source: 'agent' | 'runtime' | 'default' | 'runtime-own' };
```

### D5. Presets

`permission-presets.ts` holds one frozen table per preset plus the hidden **Unchanged** table used only while `permissions.preset` is `null`.

| Area               | Careful   | Balanced | Full power    | Unchanged (preset not chosen)                           |
| ------------------ | --------- | -------- | ------------- | ------------------------------------------------------- |
| Rooms              | Ask       | Allowed  | Allowed       | Blocked (today: `roomsManage` absent means off)         |
| Tasks & schedules  | Ask       | Ask      | Allowed       | Allowed                                                 |
| Other agents       | Ask       | Ask      | Allowed       | Allowed                                                 |
| Messages           | Allowed   | Allowed  | Allowed       | Allowed                                                 |
| Chat connections   | Ask       | Ask      | Allowed       | Allowed                                                 |
| Tools & packages   | Ask       | Ask      | Ask           | Allowed (the marketplace's own confirmation still runs) |
| DorkOS settings    | Ask       | Ask      | Ask           | Allowed                                                 |
| Safety limits 🔒   | Ask       | Ask      | Ask           | Blocked (today: operator-only paths are refused)        |
| Permissions 🔒     | Ask       | Ask      | Ask           | Blocked                                                 |
| Reach & secrets 🔒 | Blocked   | Ask      | Ask           | Blocked                                                 |
| Files & commands   | Ask first | Act      | Full autonomy | (the stored trust stop, untouched)                      |

Destructive actions ask on every preset (D3). "Unchanged" reproduces today's effective behaviour exactly, so an upgraded install whose person never answered the first-run door changes nothing until they do; the UI says so ("Not chosen yet. Your agents work as they did before.") and offers the three presets.

**Choosing a preset** writes `permissions.preset`, clears `permissions.defaults` (the "changes"), and writes `runtimes.defaultTrustStop` to the preset's Files & commands stop (through the existing autonomy consent door: moving to `autonomy` without `ui.autonomyAcknowledgedAt` answers `428 AUTONOMY_ACK_REQUIRED`, `approvals/autonomy-consent.ts:75`; the client reuses `useTrustStopWrites`'s confirm flow, `features/settings/model/use-trust-stop-writes.ts:146-183`). Per-runtime trust stop leaves are left alone and show as changes.

"Custom" is never stored. The UI derives "Full power, 2 changes" from `defaults` plus any difference between `runtimes.defaultTrustStop` and the preset's stop.

**Preset tables are frozen.** Changing a shipped preset's value in a later release is a config migration that first writes the old value into `permissions.defaults` for every install on that preset (a protective carryover; `.claude/rules/safe-defaults.md`), so no preset silently widens. `permission-presets.test.ts` pins every table with a comment saying so.

### D6. The gate

**Where.** `enforceCapabilityTier` (`tier-enforcement.ts:972`) already has exactly three callers, pinned by `__tests__/gate-bypass-scan.test.ts`: `registry.invoke`, `authorizeCapability`, and `mcp-tool-gate.ts` (the hand-registered tools). The permission decision joins it there, so every surface is gated by construction and no fourth path appears.

- `TierEnforcementRequest` gains a **required** `permission: ResolvedPermission | null` (`null` for a no-area action). Required, not optional, so a caller that forgets it does not compile.
- Each caller resolves it first with one new async helper, `resolveCallPermission({ action, identity })` in `capabilities/permission-enforcement.ts` (new). It reads the agent's manifest **fresh on every call**, from the file, never the SQLite cache (the reasoning of `tool-group-grants.ts:5-21` carries over verbatim: the cache has no column for it), plus the live config. A read that throws fails closed to Blocked with `approvable: false`, as `holdsGrant` does today (`tool-group-enforcement.ts:188-201`).
- **`operator.config_patch` escalates by input.** `GatedAction` gains an optional `areaForInput?(input): PermissionAreaId | null` that may only return an area at least as strict as the static one. `config_patch` uses it: a patch touching any path whose `CONFIG_WRITE_POLICY` entry (`operator/config-write-policy.ts:233`) is `operator-only` resolves in that entry's area. Every `operator-only` entry gains an `area: 'safety' | 'reach' | 'permissions'` column (rooms/relay limits and concurrency → `safety`; `auth`, `tunnel`, MCP endpoint and key, credentials, `server.boundary` and the data directories → `reach`; `agentContext` is retired; the four `defaultTrustStop` leaves and the consent stamps `ui.autonomyAcknowledgedAt`, `ui.fullPowerDecidedAt`, `ui.fullPowerChoice` → `permissions`). A census test fails when an `operator-only` entry has no area. `permissions.*` itself is not writable through `config_patch` at all (D10).
- When a person approves such a call, the handler reads `context.approval` (already threaded, `registry.ts:591`) and writes through a new `PERSON_APPROVED_AUTHORITY` beside `OPERATOR_TOOL_AUTHORITY` (`config-write.ts:190-199`) that clears the operator bar. This is the standing rule that makes the trusted-caller escape safe (`trusted-caller.ts` module doc): whoever may decide an approval may make the change, so an approved change removes no guarantee.

**What the gate decides** (replaces `tier-enforcement.ts:995-1055`; the binding, `ask()`, `consume()`, and every refusal shape below it are unchanged):

```
if permission === null:                       // no-area action: today's tier logic
  observe → allowed; act → allowed; destructive → ask/consume (as today)
else switch permission.state:
  'allowed' → allowed. A destructive call allowed this way is audited as
              `capability.auto_approved` with { via: 'permission', source } (it
              replaces today's `via: 'standing-grant'`, so "DorkOS did not ask you"
              still leaves a line).
  'ask'     → observe → allowed; otherwise the existing ask/consume flow
              (formerly reachable only for destructive).
  'blocked' → if a granted token from a blocked request (D8) is presented and
              consumes for this exact binding → allowed; otherwise denied
              { reason: 'permission_blocked', approvable: !inactive }.
```

`TierDeniedReason` (`tier-enforcement.ts:365-370`) loses `tier_ceiling` and `tool_group_disabled` and gains `permission_blocked`. `GrantedApproval` (`:406-412`) replaces `{ via: 'standing-grant'; grantId }` with `{ via: 'permission'; source: PermissionSource }`. `effectiveCeiling`, `DEFAULT_ANONYMOUS_TIER_CEILING`, `REVOKED_TIER_CEILING`, `CEILING_PHRASE`, `anonymousTierCeiling`, `resolveStandingGrant` and `StandingGrantLookup` are deleted; their protective intent is carried by the resolver's `inactive` rule and by D11.

Trusted callers (a person acting through the app's own routes, `trusted-caller.ts:159-176`) keep bypassing the gate, as today (`registry.ts:536, 562`).

**Every action that can now ask needs a card.** Conformance (`packages/test-utils/src/capability-conformance.ts`, `__tests__/mcp-tool-gate.test.ts`) today requires `approvalDisplayFields` only on `destructive` actions. It now requires it on **every action with an area** (they can all raise a card under Ask), and `approvalSubject` on any whose target is an opaque id (the DOR-1929 rule). Without this, an `act` action's card would fall back to "every top-level field", which is safe but unreadable.

**Unattended turns.** A scheduled run, a relay binding, or a connector event (origins with policy `none` in `session/origin/turn-origin.ts:160-199`) does not hold: the gate returns `approval_required` at once, the card goes to the inbox, and late-verdict delivery wakes the session when a person answers (the existing path for sessions that recorded a `requestingSession`). A ten-minute hold inside an unattended run would stall work nobody is watching.

### D7. Ask and the request card, on the existing machinery

Nothing new is built for asking. The existing chain, cited:

1. The gate's `ask()` records an approval bound to the capability and a hash of its exact input (`tier-enforcement.ts:1132-1175`, `approvals/approval-service.ts:508-576`, 2-hour TTL at `:78`), broadcasts `approval_pending` and raises the `approval.pending` notification.
2. **Claude Code, in session:** the tool call HOLDS for up to ten minutes (`CAPABILITY_APPROVAL_HOLD_CAP_MS`, `capability-approval-hold.ts:105`), pushes the card inline (`capability_approval_required` stream event), awaits the decision, and on a grant re-invokes itself with the token so the real result comes back **in the same turn** (`mcp-projection.ts:481-507`). Hand-registered tools hold the same way (`mcp-tool-gate.ts`, DOR-1930).
3. **After the hold gives up, or on Codex/OpenCode** (whose runtime listener registers registry capabilities with a `sessionId`, `connector-mcp/agent-runtime-server.ts:33-39`, but wires no hold): the verdict is delivered by **waking the requesting session** with an `approval_verdict` context block, queued if the session is busy (`approval-verdict-delivery.ts:153-249`, ADR `260909-123910`). The agent retries with its token.
4. Sessionless surfaces (external `/mcp`, HTTP) keep the token-and-retry flow.

That is the "continues on its own after a yes" the ideation asks for; this spec's job is to make it reachable for `act` actions and for Blocked areas, and to add the third answer.

**The card.** The request card **is** the existing `ApprovalCard` (`apps/client/src/layers/features/approvals/ui/ApprovalCard.tsx:95`), extended, not a second component. Its three buttons today are Don't allow / Allow / "Allow, and stop asking about this for {window}" (standing grant, `:287-353`). They become:

- **Allow**: this one call.
- **Always allow**: this action, for this agent, from now on. Shown only when the approval recorded `requestedByPath` (an identified agent), the action has an area, and the area is not a floor area. On a floor area one line replaces it: "Always allow isn't offered here. Changing this needs your yes every time."
- **Deny**.

Headline copy follows the action: "**DorkBot wants to create #proj-lunar-metamorphosis** with you, @lifeos, @meeting-notes" (the summary sentence already built by `describeGatedAttempt`, `tier-enforcement.ts:753`). A card from a blocked request (D8) adds the reason the agent gave: "DorkBot is blocked from Rooms and is asking to be allowed. It says: …".

**Where it appears.** Everywhere it does today: inline in chat (`features/chat/ui/message/AssistantMessageContent.tsx:224-244`), the inbox (`InboxBell.tsx:405`), home (`PinnedTriageHeaderView.tsx:507`), mobile (`MobileNowAttention.tsx:131`). **New:** inside a room, for a request raised by that room's turn (resolved through the room-session binding), rendered in the room timeline to the install's owner only. Today no approval card appears in rooms (`widgets/room-view` has none), and a room is exactly where Rooms requests come from.

**Deciding.** `POST /api/approvals/:id/grant` (`routes/approvals.ts:434-547`) replaces its `{ standing?: true }` body with `{ answer: 'once' | 'always' }` (default `'once'`). Both decision bars stay exactly as they are (`resolveDecisionAuthority`, `decision-authority.ts:157`; `requirePersonToDecide` → `requireOperatorCookieUnderLogin`, `lib/caller-authority.ts:224`). `'always'` is refused server-side (409 `ALWAYS_NOT_OFFERED`) when the approval has no `requestedByPath`, the action has no area, or the area is a floor area; the UI hiding the button is not the check. On `'always'` the route grants the approval **and** writes `agent.permissions.actions[actionId] = 'allowed'` through the same permission service Settings uses (D10), in one step, before the verdict fans out, so the resumed call and the new setting agree.

**Answer audit.** The route's `approval.granted` / `approval.denied` lines (`approvals.ts:319-333`) become one `permission.answered` event per answer (D14). An `'always'` answer also writes the `permission.changed` event for the override it created.

### D8. Blocked, and asking past it

A Blocked action is not in the agent's tool list (D15), so the agent asks with **`permissions.request_access`** (MCP name `request_permission`), a registry capability with no area, tier `act`:

```ts
input: z.object({
  action: z.string().describe('The action you want, by the tool name you were told about'),
  arguments: z
    .object({})
    .catchall(z.unknown())
    .describe('The exact arguments you would call it with'),
  reason: z.string().min(1).max(500).describe('One or two sentences: why you need it now'),
});
```

(`catchall`, not `z.record`: a record in an in-session tool schema empties `tools/list` on claude-agent-sdk ≥0.3.257 with zod ≥4.5.3; `runtimes/claude-code/mcp-tools/tool-exposure.ts`.)

Its handler resolves `action` among the actions this surface can run (registry capabilities everywhere; hand-registered tools on the two surfaces that build them, the claude-code in-session server and the external `/mcp` server, which keep a private map of the gated handlers they did not list), validates `arguments` against that action's own input schema, and invokes it with `blockedRequest: true`. For a Blocked action the gate then mints an approval **bound to the target action and the hash of those exact arguments** (the rule of ADR `260725-133221` holds: the person approves exactly what will run) instead of refusing. The approval-required refusal propagates out of `request_access`, so the existing hold holds `request_access`; on a grant it is re-invoked with the token, forwards it to the target, the gate consumes it for that binding, and the target's real result comes back in the same turn. The three answers mean what they mean everywhere (Allow runs this call; Always allow sets the action to Allowed for this agent, which also brings the tool back into its list; Deny). A floor area offers Allow and Deny.

**Rate limit (never a loop).** Enforced in the handler before any approval is minted, keyed on the calling agent's path:

- at most **one pending blocked request per agent per area**; a second returns the first's `awaiting_decision` payload;
- after a **Deny**, the same agent asking for the same action within **24 hours** is refused with `reason: 'recently_denied'`, `approvable: false`, and no card;
- at most **5 blocked requests per agent per hour** across all areas.

Unidentified callers cannot use `request_access` (there is no agent to scope the request or the rate limit to).

A direct call to a Blocked action (an agent that knows the name, or reached it through the CLI) is refused with the message: "Rooms is blocked for this agent. You can ask the person with the tool ending in `request_permission`: name the action, pass the exact arguments, and say why." No card is minted from a direct call.

DOR-2093 ("no approval path past the ceiling") is absorbed here: every refusal an agent can meet now has a way to ask.

### D9. Agent-facing permission tools

- **`permissions.list`** (`observe`, no area): the calling agent's resolved state per area and per action it can see, with source. Lets an agent explain a refusal instead of guessing, and pick Ask-state actions knowing a card will follow.
- **`permissions.change`** (`act`, area `permissions`, floor): an agent asking to change a permission ("set test-bot's Rooms to Allowed", "make Tasks Ask for everyone"). Explicit fields, no records: `{ target: 'everyone' | agentId, area?: PermissionAreaId, action?: string, state: PermissionState | 'default' }`. Because its area is a floor area it can never be Allowed, so every call is a person's yes; the approved write goes through the permission service with `surface: 'agent-request'`.

Each new capability trips the claude-code tool-count guards on purpose (two count guards; decide always-loaded vs deferred per tool) and needs `tool-exposure.test.ts` run.

### D10. Write paths (person-only)

**One service owns every permission write.** `apps/server/src/services/core/permissions/permission-service.ts` (new; `services/core` is an existing domain, so the service-domain census in AGENTS.md does not change): `setDefaults`, `setPreset`, `setAgent`, `applyToAgents`, `undo`. Each write validates known area/action ids, refuses Allowed on a floor area or a floor-area action (400 `FLOOR_NEVER_ALLOWED`), refuses `'always'`-shaped writes an answer could not have made, writes (config through `ConfigManager`; manifests through `MeshCore.update`, file-first write-through, ADR-0043), and emits exactly one `permission.changed` event.

**HTTP routes** (`apps/server/src/routes/permissions.ts`, new; OpenAPI regenerated and committed):

| Method + path                                 | Body / query                                                                            | Purpose                                                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/permissions`                        | —                                                                                       | preset, changes, every area with its actions (id, title, tier), resolved default per area and action, and the agents that differ (`exceptions[]`) |
| `PUT /api/permissions/preset`                 | `{ preset, applyToAgents?: string[], surface }`                                         | choose a preset (D5)                                                                                                                              |
| `PATCH /api/permissions/defaults`             | `{ areas?: {[id]: state \| null}, actions?: {...}, applyToAgents?: string[], surface }` | change defaults; `null` removes a change                                                                                                          |
| `GET /api/agents/:id/permissions`             | —                                                                                       | this agent's resolved state per area and action, with source, plus `filesAndCommands`                                                             |
| `PATCH /api/agents/:id/permissions`           | `{ areas?, actions?, filesAndCommands?: stop \| null, surface }`                        | per-agent overrides; `null` = back to default                                                                                                     |
| `GET /api/permissions/history`                | `?agentId&before&limit`                                                                 | permission events from Activity                                                                                                                   |
| `POST /api/permissions/history/:eventId/undo` | `{ force?: boolean }`                                                                   | undo one change (D14)                                                                                                                             |

`applyToAgents` is the apply-to-overrides dialog's selection: those agents' overrides for the changed keys are removed in the same write, so they follow the new default. One event records the default change and every agent it touched.

**Every mutating route clears the same two bars the approval decide route clears**, reusing the helpers rather than inventing a third notion of "a person": `resolveDecisionAuthority(readCallerAuthority(req, res))` (refuses any caller presenting `X-DorkOS-Agent`, resolved or not, and any caller holding an approval token; `decision-authority.ts:157-201`) and `requireOperatorCookieUnderLogin` (with login on, only a session cookie counts, never a per-user API key, DOR-474). The route records the posture the bars reported on the event.

**Every other path is closed:**

- `PATCH /api/config` and `dorkos config set` refuse any `permissions.*` key (400 `USE_PERMISSIONS_API`), so the audit cannot be bypassed through the generic config writer. `CONFIG_WRITE_POLICY` marks `permissions` operator-only as a second line.
- `PATCH /api/mesh/agents/:id` can no longer carry `permissions`, `enabledToolGroups` or `tierCeiling` (removed from `UpdateAgentRequestSchema`). Today that route has **no caller guard** (`routes/mesh.ts:554-600`), which is how any local program can write `roomsManage: true` now; this closes that for permissions.
- `AGENT_WRITE_POLICY` (`operator/agent-write-policy.ts:115`) marks `permissions` and its children `operator-only`, so `PATCH /api/agents/current` and `operator.update_agent` refuse it before parsing (`agent-updater.ts:280-283`). The `tighten-only` class loses its only member (`tierCeiling`, `:221`) and is deleted with its per-field comparison (`agent-updater.ts:311-343`).
- **Files & commands**: the global stop stays writable through `PATCH /api/config` (its existing consent door and operator bar, `config-write.ts:338-414`), so that path emits `permission.changed` whenever a patch changes any `*.defaultTrustStop` leaf. The per-agent stop is written only through `PATCH /api/agents/:id/permissions`, which runs the same autonomy consent check (`hasStandingAutonomyAck`, `autonomy-consent.ts:116`) before storing `autonomy`.
- **CLI:** `dorkos permissions [list|set|reset|history]` and `dorkos agent permissions <agent> [set|reset]` call these routes. `dorkos agent update --ceiling` (`packages/cli/src/commands/agent.ts:288-372`) is removed.

### D11. Unidentified callers

A caller that presents no agent identity and is not a trusted caller (an external `/mcp` client with no token, `dorkos call` from a terminal without `DORKOS_AGENT_TOKEN`) resolves against the **defaults only**: agent layers are skipped, Always allow is never offered, and `request_access` is refused. This keeps the tier gate's doctrine that identity is never what decides _whether_ to gate (`tier-enforcement.ts` module doc, "The TIER decides whether to gate"). The residual, stated as honestly as `DEFAULT_ANONYMOUS_TIER_CEILING` states it today (`tier-enforcement.ts:579-611`): an agent set **stricter** than the default that strips its own token gets the default. That is the same `local-trust` residual the ceiling and `roomsManage` carry now, with the same remedy, turning on login. See Open Question 1.

### D12. `rooms.archive` (DOR-2094)

Archiving is a flag, not a delete: `applyRoomPatch` sets `archived: true`, `abandonHolds` ends what the room was waiting for (`services/rooms/manage/room-updates.ts:222-226`), archived rooms leave lists (`room-store.ts:337-373`), and the owner can un-archive (`PATCH /api/rooms/:id` with `archived: false`; `createRoom`'s DM path already un-archives, `room-lifecycle.ts:225`). Today `archived` is reachable only from the operator-only `updateRoom` (`room-updates.ts:128-135`); `updateRoomFromTool` deliberately omits it (`:138-150`).

New: `RoomService.archiveRoomFromTool(roomId, callerAuthorId)`, a second method (the shape DOR-1611 chose, so no future caller gets archive by a flag), reachable only from the `rooms.archive` capability (tier `act`, area `rooms`, MCP name `archive_room`). It requires the room to be visible to the caller and the caller on its roster; refuses a direct message ("a direct message stays until the person archives it", as `rooms.leave` says, `room-capabilities.ts:1560`) and a system room (the #team channel, the `requireSystemRoomWritable` rule, `service/room-authority.ts`); and posts the room's normal archive notice. `approvalDisplayFields: ['roomId']` with `approvalSubject: { field: 'roomId', kind: 'room' }` (a `room` subject kind is added to `approvals/approval-subject.ts` if not present).

### D13. Migrations and retirements

**Config migrations**, in `CONFIG_MIGRATIONS`, one key per phase's release (each takes the next unmerged key at implementation time; `'0.83.0'` is next today). `permissions` is a new top-level section, so `conf` pre-writes its defaults before migrations run and an absence guard would be unreachable (`adding-config-fields` skill); each key's once-per-upgrade semantics are the guard. Each key is pinned in `merged-migration-hashes.ts` in its own PR, and its tests read `config.json` from disk (DOR-1496).

- **Phase 1 key:** `ui.fullPowerChoice === 'full'` → `permissions.preset = 'full'`; `'supervised'` (the careful pick) → `'careful'`; `null` → leave `preset: null` (Unchanged until the person passes the door, D5). It does **not** touch `runtimes.*defaultTrustStop`: if the stored stop differs from the preset's, the UI shows it as a change and nothing moves.
- **Phase 2 key:** delete `approvals.standingGrants`, `approvals.trustWindowMinutes`, `approvals.standingGrantsVoidBefore` (and `approvals` when empty); add the three to the removed-keys handling the migration-safety guard expects.
- **Phase 3 key:** for each `agentContext.{tasksTools, relayTools, meshTools, adapterTools}` that is `false` → `permissions.defaults.areas.{tasks, messages, agents, connections} = 'blocked'`; then delete `agentContext`.

A config migration runs before the Activity service exists, so it emits nothing itself. The boot sweep (below) compares what the migration left against what it found and writes the `upgrade` events.

**Manifest migration.** No manifest migration mechanism exists (`AgentManifestSchema` has no `schemaVersion`). Two parts, which together cover every manifest:

- **Read-time fold** (`z.preprocess` on `AgentManifestSchema`, permanent, justified in D4): when `permissions` is absent,
  - `enabledToolGroups.roomsManage === true` → `areas.rooms = 'allowed'`; `=== false` → `'blocked'` (the ToolsTab spreads the existing object, `features/agent-settings/ui/ToolsTab.tsx:391-396`, so an explicit `false` is a person's decision, never an accident); absent → nothing (inherit);
  - `enabledToolGroups.{tasks, relay, mesh, adapter}`: `true` → that area `'allowed'`, `false` → `'blocked'`, absent → nothing;
  - `tierCeiling: 'observe'` → every non-`files` area `'blocked'`; `'act'` → nothing (destructive actions ask by the D3 rule, which is the ideation's "act becomes delete-asks"); `'destructive'` or absent → nothing;
  - then drop both legacy keys.
- **Boot sweep** (`services/core/permissions/permission-upgrade-sweep.ts`, once per server version, marker `permissions.upgradeSweptAt`): for every registered agent whose file still carries a legacy key, write the folded manifest back through `MeshCore.update` and emit one `permission.changed` event per agent with actor `upgrade`; then one `permission.changed` for the config migration's changes (preset + area defaults), also actor `upgrade`. Agents discovered later are folded on read and written back on their next manifest write.

**Retirements (removed, not kept alongside):**

| What                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                                                                                                                                                                                                                                                                                                                            | Replaced by                                   | Phase |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----- |
| `enforceToolGroupGrant`, `ToolGroupGrantLookup`, `initToolGroupGate`, `manifestToolGroupGrants`, `CapabilityToolGroup`, `toolGroup?`                                                                                                                                                                                                                                                   | `capabilities/tool-group-enforcement.ts`, `tool-group-grants.ts`, `capability-definition.ts:65, 210`, `registry.ts:536-547`, `index.ts` boot wiring                                                                                                                                                                                                              | the permission gate (D6)                      | 1     |
| `EnabledToolGroups.roomsManage`, `CapabilityToolGroupKey`, `useToolNamesForGroup('roomsManage')`                                                                                                                                                                                                                                                                                       | `mesh-schemas.ts:166-191`, `mcp-tool-groups.ts:118`                                                                                                                                                                                                                                                                                                              | `permissions.areas.rooms`                     | 1     |
| `ManageRoomsCard` + Settings' "Granted per agent" info card                                                                                                                                                                                                                                                                                                                            | `features/agent-settings/ui/ToolsTab.tsx:183-257`; `features/settings/ui/ToolsTab.tsx:182-211`                                                                                                                                                                                                                                                                   | Rooms row                                     | 1     |
| standing grants: `approval_grants` table, `ApprovalGrantService`, `standing-grant-posture.ts`, `standing-grant-settings.ts`, `approvals.*` config, `REQUIRES_LOGIN_CONFIG_PATHS`, `GET/DELETE /api/approvals/grants`, the card's "stop asking for {window}" button, the Control Center "Standing permissions" switch, `approvals.standingGrants: true` in the Full-power door's accept | `approvals/`, `routes/approvals.ts:375-409`, `config-schema.ts:2741-2794`, `config-write-policy.ts:1189`, `ApprovalCard.tsx:338-368`, `ControlCenterSwitches.tsx:94-106`, `FullPowerDoor.tsx:144-179`                                                                                                                                                            | Always allow (per agent, per action)          | 2     |
| `tierCeiling` (manifest, token column, identity field, token stamping, CLI flag, `TierCeilingCard`, `effectiveCeiling`, anonymous/revoked ceilings)                                                                                                                                                                                                                                    | `mesh-schemas.ts:571-575`, `agent-identity.ts:50`, `agent-identity-service.ts:105-328`, `agent-token-env.ts:110-166`, `agent.ts:288-372`, `ToolsTab.tsx:279-338`, `tier-enforcement.ts:579-697`                                                                                                                                                                  | per-agent Blocked areas + the `inactive` rule | 3     |
| `agentContext.*Tools`, `enabledToolGroups.{tasks,relay,mesh,adapter}`, `resolveToolConfig`, `ToolGroupRow` (both), `TOOL_INVENTORY`/`CONFIG_KEY_MAP`, `useAgentContextConfig`, `MCP_TOOL_GATE_GROUPS` and friends                                                                                                                                                                      | `config-schema.ts:2209-2216`, `tool-filter.ts:104-117`, `launch-resolver.ts:160-180`, `context-builder.ts:460-519`, `features/agent-settings/ui/ToolsTab.tsx:83-145`, `features/settings/ui/tools/ToolGroupRow.tsx`, `features/settings/config/tool-inventory.ts`, `entities/config/model/use-agent-context-config.ts`, `packages/shared/src/mcp-tool-groups.ts` | Blocked areas hide tools (D15)                | 3     |

ADR `260828-123331` is **superseded** (its "no global twin" worry dissolves once the default and the override live in one resolver with one audit trail). ADR `260726-171347` (toggles gate context, not access) and ADR-0071 (implicit tool-group hierarchy) are superseded by D3/D15 and D2.

### D14. Audit, history, undo

**New Activity category `permissions`** (so history is one filter, and the Activity page gets a "Permissions" filter). Adding a category touches four places, all in this change: the Zod enum (`packages/shared/src/activity-schemas.ts:18-20`), the DB text enum (`packages/db/src/schema/activity.ts:29-31`), `CATEGORY_CONFIG` (`entities/activity/model/activity-types.ts:38-45`), and `CATEGORIES` (`features/activity-feed-page/ui/ActivityFilterBar.tsx:12`). `ListActivityQuerySchema` (`:61-73`) gains `resourceId` so per-agent history is a query, not a scan. The `permissions` category is **exempt from the 30-day prune** (`activity-service.ts:198`): the volume is tiny and a permission history that forgets is not an audit trail.

**`permission.changed`** (one event per write, bulk included):

```ts
metadata: {
  changes: Array<{
    target: { kind: 'default' } | { kind: 'agent'; agentId: string; agentPath: string; agentName: string };
    key: { kind: 'preset' } | { kind: 'area'; area: PermissionAreaId } | { kind: 'action'; action: string; area: PermissionAreaId } | { kind: 'files' };
    before: string | null;   // state, stop, or preset; null = inherited / not set
    after: string | null;
  }>;
  surface: 'settings' | 'agent-page' | 'control-center' | 'request-card' | 'first-run'
         | 'agent-request' | 'api' | 'cli' | 'upgrade' | 'undo';
  attribution: 'signed-in' | 'local-trust' | 'agent-request-approved' | 'upgrade';
  approvalId?: string;   // request card / agent request
  undoOf?: string;       // the event this undid
  presetSnapshot?: { preset: string | null; defaults: PermissionOverrides; trustStop: string | null }; // on preset switches, so Undo can restore it
}
```

`actorType`/`actorLabel` follow `readActivityActor` (`services/activity/activity-actor.ts:93-101`) with one honesty rule: **with login off, a person write is labelled "Someone on this computer", never "You"**, and the history row carries "Login is off, so DorkOS can't confirm who made this change." With login on it is "You (signed in as …)". An agent's approved request is labelled "DorkBot asked, you said yes". A migration is "Upgrade". This follows `decision-authority.ts`'s rule that inventing a check an agent could satisfy and calling it proof "would be worse than the gap". (The ideation's "an HTTP write that did not come through the app is recorded as unverified" cannot be built honestly: with login off nothing tells the app from `curl`. So every login-off write is unverified, and says so.)

**`permission.answered`** (one per card answer, replacing the decide route's `approval.granted` / `approval.denied`): `{ agentId?, agentPath?, action, area | null, answer: 'once' | 'always' | 'deny', approvalId, blockedRequest: boolean, posture }`. The feed renderer keeps reading the two old event types for history.

Uses stay where they are: `capability.approval_required` / `capability.denied` / `capability.auto_approved` (`agent-identity/capability-gate-audit.ts:80-134`) and `capability.invoked` / `capability.failed` (`capability-attribution.ts:62`; the ideation said these did not exist in production; they do). Their metadata swaps `tierCeiling` for `permission: { state, source }`. Together: what could it do (changes), what did it do (uses).

**History view.** Settings → Permissions → History and the agent's Permissions page → History: a timeline of `permissions` events, newest first, with the "why" line on each. **Undo** on each `permission.changed` row writes the inverse of its `changes` (`before` values) as a new event with `surface: 'undo'` and `undoOf`. If a key has changed since (current value ≠ recorded `after`), Undo shows "This has changed since. Set it back to Ask anyway?" and applies only with `force`. A bulk event undoes every entry that still matches. Undoing a preset switch restores `presetSnapshot`. `permission.answered` rows have no Undo (an answer already happened); an Always allow's own `permission.changed` row does.

### D15. Blocked hides tools

The three places that build an agent's tool list filter out every action whose resolved state is Blocked for that agent, and the context builder adds one line per Blocked area:

- claude-code in-session server, built per query (`runtimes/claude-code/mcp-tools/index.ts:292-337`), beside the existing per-session filter `loadsAgentToAgentTools` (`launch-resolver.ts:193-205`);
- the runtime listener for Codex and OpenCode (`runtimes/connector-mcp/agent-runtime-server.ts:21-39`);
- the external `/mcp` server when the request carries an identity (`core/mcp-server.ts:77-134`); with no identity, the defaults decide.

The line, rendered once in `runtimes/shared/` for all three adapters: "Rooms is blocked for you. If you need it, ask with the tool ending in `request_permission`, and say why." Changes take effect the next time the list is built (the next turn); enforcement never waits for that, because the gate resolves fresh on every call. A system-prompt change relaunches a warm session, as it does today.

Hidden actions are still built (not listed) on the two surfaces with hand-registered tools, so `request_access` can reach them (D8).

### D16. Files & commands (per-agent trust stop)

`resolveSessionDefaults` (`services/session/resolve-session-defaults.ts:217-312`) resolves the stop at `:304-307` as `configured?.defaultTrustStop ?? runtimes?.defaultTrustStop ?? null`. It becomes `resolveFilesAndCommands({ agent, perRuntime, global })`: **session / task / binding** (their own records, unchanged) **> agent > per-runtime > global**. `readAgentExecutionDefaults` (`:144-161`) reads `permissions.filesAndCommands` from the manifest. The unattended resolvers, `resolveUnattendedDefaultStop` (`:411-420`) and `resolveUnattendedPermissionMode` (`:459-472`), gain an agent parameter, threaded from their callers `tasks/scheduled-run-power.ts:112` and `rooms/room-turn-runner.ts:604`. `describeExecutionDefaults` (`:536-582`) and the Runtimes tab keep showing the global and per-runtime stops; an agent's own stop shows on its Permissions page and in the exceptions chip.

## User Experience

Four layers of disclosure; most people live in the first.

**1. One choice.** First run (onboarding power step, `features/onboarding/ui/OnboardingPowerStep.tsx:75`; the Full-power door moment, `FullPowerDoor.tsx`), the Control Center, and Settings all offer **Careful · Balanced · Full power**. The door's accept writes `permissions.preset: 'full'` alongside its existing flips (and no longer writes `approvals.standingGrants`); decline writes `'careful'`. After any change the picker reads "Full power, 2 changes".

**2. Areas.** Settings → **Permissions** (a new tab in `SETTINGS_TABS`, group "Agents & sessions", `features/settings/ui/SettingsDialog.tsx:34-146`; id added to the `SettingsTab` union, `shared/model/app-store/app-store-panels.ts:15-29`; `?settings=permissions` deep link). The preset picker on top, then one row per area: label, one-line description, a three-way switch (Blocked · Ask · Allowed), and an **exceptions chip** ("2 agents differ ›") that opens the list of agents set differently, each with its state and a Reset. Floor rows show a lock and offer only Blocked · Ask. Files & commands uses the trust dial. A link at the bottom: "Your connected accounts have their own permissions. Manage them in Connections → Accounts." History sits in a section at the bottom.

**3. One agent.** The agent's profile gets a **Permissions** page (new `ProfilePageId`, registry entry in `features/profile/ui/pages/registry.ts`, row in `profile-rows.ts:356-406` and DorkBot's group `:470-480`). Same rows, each reading "Same as everyone (Allowed)" until changed; a changed row shows a dot and "Reset to default". The existing "Tools & MCP" page keeps only the MCP servers card and is renamed **MCP servers**. For a runtime without DorkOS tools (`supportsMcp: false`), the DorkOS rows show one line instead: "This agent's runtime can't use DorkOS tools, so these settings don't change anything for it." Files & commands still applies.

**4. Specific actions.** "Show individual actions" under a row lists that area's actions (from `GET /api/permissions`), each with its own switch; destructive ones read "Ask (always asks unless you set it here)". An action with an override shows under its row even when collapsed ("Rooms: Ask, except create rooms: Allowed").

**The global change question.** Changing a default, or the preset, while agents differ opens `ApplyToOverridesDialog`:

> **Rooms is now Allowed for everyone.** 2 agents are set differently:
> ☐ security-auditor: Blocked ☐ test-bot: Ask
> This affects 33 agents now.
> **[Keep their settings] [Update selected]**

Nothing is pre-checked. A floor area going up never pre-selects (and it can only go up to Ask). "Affects 33 agents" counts the agents that inherit the key. One component serves every area and the preset switch.

**The request card.** See D7. Buttons in the order **Allow · Always allow · Deny**, Always allow visually secondary to Allow so the one-time answer is the easy one. After a yes the card collapses to one line ("Allowed once" / "Always allowed for DorkBot: create rooms") and the agent carries on in the same turn when it was holding.

**Why?** Hovering or tapping any state opens the source, built from `ResolvedPermission` and the latest matching history event: "Allowed, from the default (Full power). Changed by you on Sep 23 from the request card." Reuses `ProvenanceChip` (`shared/ui/provenance-chip.tsx`) as the trigger.

**Gentle suggestion.** After a person answers **Allow** three times in seven days for the same agent and action, the next card for it highlights Always allow with one line ("You've allowed this 3 times this week"). Dismissing it (a small "Not now") stops it for that agent and action; recorded as a `permission.suggestion_dismissed` event and computed server-side into the pending approval (`suggestAlways: boolean`). Never a badge.

**Control Center (summary only).** The trust dial (`widgets/control-center/ui/ControlCenterDial.tsx`) becomes the preset picker, keeping the autonomy confirm flow. The overrides ledger (`OverridesLedger.tsx`, `model/use-overrides-ledger.ts:84-191`) gains an `agent-permission` row kind ("security-auditor: Rooms Blocked"), each with a one-tap Reset (the ledger's first reset action; existing row kinds keep their deep links). "Edit permissions ›" opens Settings → Permissions. The Standing permissions switch is removed.

**Mobile.** Rows stack label over switch; the three-way switch is full-width with 44px targets; the exceptions chip, the apply dialog and the "why" popover open as bottom sheets; the request card's buttons stack vertically, Allow first. The profile Permissions page is a single scrolling column.

**Errors and exits.** A write refused by the person bar shows the server's sentence ("Only a person can change permissions. Agents can ask with the request tool."). A failed write leaves the switch where it was and says "Couldn't save. Try again." Undo conflicts ask before applying.

**UI copy rules.** Plain words for a smart 9th grader (writing-for-humans). Never "integration", "connector", "adapter" or "provider" in UI copy (Connections / Accounts / chat connection). The vocab gate (`scripts/check-vocab-gate.ts`) and banned-words gate run over it.

## Code structure & file organization

```
packages/shared/src/permissions/
  permission-areas.ts        # area registry (id, label, description, floor, kind)
  permission-schemas.ts      # states, ids, overrides, config + manifest shapes, API DTOs
  permission-presets.ts      # frozen preset tables + Unchanged
  resolve-permission.ts      # resolvePermission, resolveFilesAndCommands (pure)
  index.ts                   # subpath @dorkos/shared/permissions

apps/server/src/services/core/permissions/
  permission-service.ts      # the one writer (config + manifests), emits permission.changed
  permission-upgrade-sweep.ts
  permission-history.ts      # history reads + undo
  index.ts
apps/server/src/services/core/capabilities/
  permission-enforcement.ts  # resolveCallPermission (async, fresh manifest read)
  tier-enforcement.ts        # decision table (D6)
apps/server/src/services/core/permissions-capabilities.ts  # permissions.list/request_access/change (domain "permissions")
apps/server/src/routes/permissions.ts

apps/client/src/layers/entities/permissions/
  model/ use-permissions.ts, use-agent-permissions.ts, use-overriding-agents.ts,
         use-set-permission.ts, use-permission-history.ts, use-undo-permission.ts
  index.ts
apps/client/src/layers/shared/lib/transport/permission-methods.ts
apps/client/src/layers/shared/ui/permission-state-switch.tsx   # the three-way switch primitive
apps/client/src/layers/features/permissions/
  ui/ PermissionRow.tsx, PermissionList.tsx, ExceptionsChip.tsx, ApplyToOverridesDialog.tsx,
      PresetPicker.tsx, PermissionHistory.tsx, PermissionWhy.tsx, ActionOverrides.tsx
  index.ts
apps/client/src/layers/features/settings/ui/PermissionsTab.tsx        # composes features/permissions UI
apps/client/src/layers/features/profile/ui/pages/PermissionsPage.tsx  # composes features/permissions UI
apps/client/src/layers/features/approvals/ui/ApprovalCard.tsx         # three answers
apps/client/src/layers/widgets/room-view/…                            # room request card
apps/client/src/layers/widgets/control-center/…                       # preset picker + agent ledger rows
```

FSD: hooks live in `entities/permissions` (features may not import another feature's model); UI parts live in `features/permissions`, which settings, profile, approvals and the Control Center widget compose (cross-feature UI composition is allowed, `.claude/rules/fsd-layers.md`). "Layers 2 and 3 are one component": `PermissionList` takes a `scope: { kind: 'default' } | { kind: 'agent'; agentId }` and writes to the matching route.

## Testing Strategy

Each test carries a purpose comment and must be able to fail.

- **Unit (shared):** `resolve-permission.test.ts`: the full precedence matrix (each layer beats the ones below it; action beats area within a layer), the destructive rule (area-level Allowed → Ask; action-level Allowed stays Allowed), the floor clamp at every layer, `inactive`, unidentified (agent layers ignored), unknown area/action keys ignored. `permission-presets.test.ts`: tables pinned; no floor area Allowed in any table; Unchanged equals today's behaviour.
- **Census:** `permission-area-census.test.ts` (D2); the operator-only config census (D6); conformance requires `approvalDisplayFields` on every area action.
- **Gate (server):** at all three choke points (registry, `authorizeCapability`, `mcp-tool-gate`): Blocked refuses with `permission_blocked` and mints nothing; Ask mints one approval for `act` and lets `observe` through; Allowed runs; a revoked identity is Blocked and not approvable; a lookup that throws fails closed; `gate-bypass-scan.test.ts` still pins exactly three callers; `rooms.create` for DorkBot on a `full` preset runs (the phase 1 outcome, as a test).
- **Request flow:** `request_access` binds to the target and its arguments (a changed argument does not consume the token), resumes in the same turn through the hold, respects all three rate limits, is refused for unidentified callers; `answer: 'always'` writes the action override and is refused (409) on a floor area, a no-area action, and an approval with no `requestedByPath`.
- **Routes / security:** every mutating permission route refuses `X-DorkOS-Agent` (resolved or not), an `X-DorkOS-Approval` holder, and (login on) an API key; allows login-off callers and records `local-trust`; `PATCH /api/config` refuses `permissions.*`; `PATCH /api/mesh/agents/:id` refuses `permissions`/`enabledToolGroups`/`tierCeiling`; `PATCH /api/agents/current` and `operator.update_agent` refuse `permissions`; a floor Allowed write is refused.
- **Migrations:** config key `'0.83.0'` for each `fullPowerChoice` value and each `agentContext` combination, reading `config.json` from disk; hash pin; the manifest fold for every legacy combination (including `roomsManage: false`, `tierCeiling: 'observe'`/`'act'`); the boot sweep writes once, emits one `upgrade` event per changed agent, and is idempotent across restarts.
- **Tool hiding:** each of the three list builders omits Blocked actions and emits the one line; the claude-code tool-count guards and `tool-exposure.test.ts` (new tool schemas) pass; `context-tool-names.test.ts` (tool names as searchable endings).
- **Audit:** one `permission.changed` per write including bulk; attribution labels by posture; Undo inverse, conflict path, preset snapshot restore; `permissions` events survive the prune.
- **Client (RTL, mock Transport):** `PermissionRow` (source text, reset, floor offers two states), `ApplyToOverridesDialog` (nothing pre-checked, floor never pre-selected, effect count), `ApprovalCard` (three answers, floor variant, suggestion line), `PresetPicker` ("N changes"), Control Center agent rows with reset.
- **E2E (`apps/e2e`):** the request card end to end on the test-mode runtime: Rooms at Ask → the scenario calls `rooms.create` → the card appears inline → Allow → the room exists and the turn finishes without a second message; Always allow → a second call runs with no card and the agent's Permissions page shows the override. Settings → Permissions changes a default with the apply dialog. Existing specs to update: `control-center.spec.ts:64-170` (dial radio → preset), `full-power-door.spec.ts:142-213`, `onboarding-power.spec.ts:141-218`, `dialog-deep-link.spec.ts:5-26` (`?settings=tools` section), `McpOAuthSigninPage.ts` (`profilePage=tools` → MCP servers page), capture shots `control-center` and `full-power-door`. Grep `apps/e2e` for every retired string before pushing (browser specs assert literal copy).
- **Mocking:** `FakeAgentRuntime` and the test-mode runtime for sessions; an in-memory approvals service for gate tests; the real `resolvePermission` everywhere (never mocked; a mocked resolver would only encode the hypothesis).

## Performance Considerations

- One warm manifest `readFile` + Zod parse per gated call on an area action: the same cost `roomsManage` pays today (`tool-group-grants.ts:15-21`), now on more actions. Reads (`observe`) in Allowed/Ask areas still pay it; acceptable because nothing on the room-turn hot path is an area action (`rooms.post`/`rooms.react` have none). If profiling shows it, cache by `(path, mtime)`; never cache without invalidation.
- `GET /api/permissions` reads every registered agent's manifest to compute exceptions (the DB cache has no column for it). Tens of files per request, cached client-side by TanStack Query and invalidated on every permission write.
- Tool-list filtering happens once per list build, on the manifest `launch-resolver.ts` already reads.
- Asking on `act` actions adds cards. The presets keep high-frequency verbs out of Ask (Messages is Allowed on every preset; conversation verbs have no area), and Always allow plus the suggestion keep repeat cards rare.

## Security Considerations

**Invariant: an agent never grants itself.** Enforced in layers, each independently:

1. The gate decides from the resolved permission, read fresh from the file on every call.
2. Every permission write path requires positive proof of a person where proof is possible: the decide route's two bars, reused on every permission route (D10). Agents presenting `X-DorkOS-Agent`, resolved or not, and requesters holding an approval token are refused in every posture; with login on only a session cookie counts.
3. The agent-reachable manifest and config writers refuse `permissions` outright (write policies), and the generic mesh PATCH can no longer carry it, closing the unguarded path that exists today (`routes/mesh.ts:554-600`).
4. `permissions.change` sits in a floor area, so an agent's own route to a permission change is always a person's yes; `request_access` and Always allow are bound to an identified agent and a person's decision.
5. The floor is checked on write, clamped on read, and Always allow on it is refused by the server, not just hidden.

**Login off, stated honestly.** With login off there is no cryptographic difference between the person in the app and a program on the same machine running `curl` without its agent header (`decision-authority.ts` module doc; `room-authority.ts`, DOR-505). An adversary with shell access can therefore decide its own card, choose Always allow, or write a permission directly. This spec **adds no new reach** for that adversary: it can do all of this today (decide approvals, and write `roomsManage` through the unguarded mesh PATCH). What changes: every such write is now recorded as "Someone on this computer" with the posture, shows in history with Undo, and the "why" line says it was unverified. What closes it: turning on login. User-facing copy must say "Blocked stops an agent that plays by the rules; it isn't a sandbox" wherever Blocked is explained, and never promise containment (the same rule `DEFAULT_ANONYMOUS_TIER_CEILING`'s doc imposes today).

**Standing grants were login-only for a reason, and that reason is kept.** They were restricted because a login-off decision cannot prove a person (`standing-grant-posture.ts`). Always allow works with login off because it is scoped to one action for one agent, recorded as unverified, visible and undoable, and gives a shell adversary nothing it lacks today. It is not a time window that silently outlives a posture: it is a setting, and it shows up in the agent's Permissions page.

**Unidentified callers** get the defaults, never an agent's override or Always allow (D11); residual in Open Question 1.

**Card content.** Every area action declares `approvalDisplayFields` (and no secret-named field), because the summary is broadcast on the event stream and returned by `GET /api/approvals/pending`, which agents can read (`capability-definition.ts:121-143`).

**Rate limits** on blocked requests (D8) keep a prompt-injected agent from flooding the person with cards.

## Documentation

- New guide `docs/guides/permissions.mdx`: presets, areas, the three states, the floor, the request card, history and Undo, login-off honesty. Writing-for-humans.
- Update `docs/guides/action-approvals.mdx` (Always allow replaces standing permissions; act actions can ask), `docs/guides/tool-approval.mdx` (the Files & commands row, per-agent), `docs/guides/agents.mdx:92` (Tools & MCP page → Permissions + MCP servers), `docs/getting-started/configuration.mdx` (`permissions`, removed `agentContext`/`approvals`).
- `contributing/configuration.md` (new section + migration), `contributing/agent-operator-surface.md` (the gate, the person bars, the residual), `contributing/adding-a-runtime.md` if the tool-list filter needs a runtime step, the `adding-config-fields` skill's examples if they cite `agentContext`.
- Regenerate and commit `docs/api/openapi.json` for the new routes.
- Changelog: one fragment per phase in `changelog/unreleased/<id>-<slug>.md`, user-facing ("Agents can make rooms on Full power without a trip to Settings", "When an agent needs more, it asks right in the chat, and Always allow remembers your answer", …). Phase 3's fragment names the narrowing for Careful installs and the retirement of the tier ceiling and the context switches.

## Implementation Phases

Each phase ships on its own and leaves no half-migrated state.

### Phase 1: Foundation + Rooms

- `@dorkos/shared/permissions` with the **full** area registry, schemas, presets, and resolver (D1, D4, D5).
- `area` required on every capability and every `MCP_TOOL_TIERS` entry. In this phase only `rooms` members carry an area; every other action declares `area: null` with an `areaNote` (their final areas land in phase 3). Census test in place.
- Config `permissions` + migration key (preset from `ui.fullPowerChoice`); manifest `permissions` + read-time fold of `roomsManage`; boot sweep for `roomsManage`.
- The gate (D6) at all three choke points; `enforceToolGroupGrant` and `toolGroup` removed.
- `rooms.archive` (D12).
- Permission service + routes + person bars (D10); the mesh PATCH closed for `permissions`/`enabledToolGroups.roomsManage`.
- `permissions` Activity category, `permission.changed`, read-only history list.
- Tool hiding for Blocked actions + the one context line (D15; in this phase the line reads "Managing rooms is blocked for you. Ask the person if you need it."). Until phase 2 adds `request_access`, a `permission_blocked` refusal is `approvable: false` and its message names the person, not the tool.
- The manifest fold in this phase handles `roomsManage` only; `tierCeiling` and the four documentation keys keep their current meaning until phase 3 retires them together.
- UI: `PermissionStateSwitch`, `PermissionRow`, `ExceptionsChip`, `ApplyToOverridesDialog`; Settings → Permissions with the Rooms row and the preset shown read-only with a link to the door when not chosen; agent Permissions page with the Rooms row; `ManageRoomsCard` and Settings' Manage rooms info card removed. Ask in Rooms uses the existing card (Allow / Don't allow).

**Acceptance:**

- On an upgraded install with `ui.fullPowerChoice: 'full'`, DorkBot's `create_room` runs with no settings change (automated test + the e2e scenario from session `e687427b`).
- An agent with `roomsManage: true` keeps rooms after upgrade; one with `roomsManage: false` is Blocked; an upgraded install with no door answer is unchanged.
- Setting Rooms to Ask for one agent makes its next `create_room` raise a card and, on Allow, finish in the same turn.
- Changing the Rooms default while agents differ opens the dialog with nothing checked; the write produces one `permission.changed` event naming each agent touched.
- An agent calling `PATCH /api/agents/:id/permissions` with its header, or `PATCH /api/mesh/agents/:id` with `permissions`, is refused.

### Phase 2: The request card

- `ApprovalCard` → Allow / Always allow / Deny; `answer: 'once' | 'always'`; server-side refusal of `'always'` where not offered; `permission.answered`.
- `permissions.request_access` + rate limits + the full context line (D8).
- `permissions.list` (D9).
- The room request card (D7). Unattended origins skip the hold (D6).
- Standing grants retired (D13 table) with their config keys dropped in the config migration of this phase's release, live grants ended at upgrade with an `upgrade` event (Open Question 3), the `approval_grants` table dropped.

**Acceptance:**

- A Blocked agent asks with `request_permission`, the person taps Always allow, the original call runs in the same turn, and the tool is in the agent's list on its next turn.
- A floor-area card shows only Allow and Deny, and `answer: 'always'` on it returns 409.
- A second blocked request for the same area while one is pending creates no second card; a request after a Deny within 24 hours is refused without a card.
- Every answer produces exactly one `permission.answered` event.

### Phase 3: Every other area, presets, first run, Control Center; retire the tier ceiling and the context switches

- Final areas for every action (D2); `config_patch` input escalation + operator-only config areas + `PERSON_APPROVED_AUTHORITY` (D6); `permissions.change` (D9).
- Preset picker (Settings, Control Center, door, onboarding), preset switch writes the trust stop through the consent door; agent `filesAndCommands` + resolution order (D16).
- Control Center: preset dial, agent rows with Reset in the ledger, Standing permissions switch gone.
- Retire `tierCeiling` everywhere (token column dropped), `agentContext.*Tools`, the four documentation keys, `resolveToolConfig`, both `ToolGroupRow`s, `MCP_TOOL_GATE_GROUPS`; migrate them (D13). Tools & MCP page → MCP servers. `dorkos permissions` CLI; `--ceiling` removed.

**Acceptance:**

- Choosing each preset sets every row to that preset's table; the trust stop follows through the autonomy consent door.
- `tierCeiling: 'observe'` agents come out Blocked on every area; `agentContext.relayTools: false` comes out as Messages Blocked for everyone; each is one `upgrade` event.
- A Blocked area's tools are absent from claude-code, Codex and OpenCode tool lists.
- An agent's `config_patch` touching `tunnel` raises a card in Reach & secrets with no Always allow; Allow applies it.
- The census passes with no `areaNote` left for an action this spec puts in an area.

### Phase 4: Delight

- Undo from history (D14), including the conflict path and preset snapshots.
- "Why?" on every state (`PermissionWhy` via `ProvenanceChip`).
- The effect preview ("affects 33 agents") in the apply dialog (count exists from phase 1; phase 4 adds it to every surface that changes a default).
- The gentle suggestion (three Allows in seven days).

**Acceptance:**

- Undo of a bulk change restores every entry that still matches and reports the ones that changed since.
- Every state on every surface has a why line naming its source and last change.
- The suggestion appears on the fourth card, not the third, and never again after "Not now".

## Open Questions

None open. Every question is resolved below, kept as an audit trail.

~~**Unidentified callers and stricter agents**~~ (RESOLVED)
**Context:** An agent set stricter than the default (say Rooms Blocked while the default is Allowed) that strips its own token gets the default.
**Answer:** accept and document, exactly like today's anonymous ceiling residual; login closes it. The alternative (unidentified callers capped at Ask everywhere) would put a card in front of the person's own `dorkos call` and every tokenless MCP client.
**Decided by:** Operator, 2026-09-23.

~~**`tierCeiling: 'observe'` migration widens conversation verbs**~~ (RESOLVED)
**Context:** Blocking every area does not stop `rooms.post`, `rooms.react`, `memory.write` or the window-seat `ui.*` verbs, which have no area by design (nothing mutes an agent inside a conversation).
**Answer:** accept; name the affected agents in the phase 3 upgrade event and changelog. Expected to affect very few installs.
**Decided by:** Accepted at SPECIFY (recommended option).

~~**Live standing grants at upgrade**~~ (RESOLVED)
**Context:**
**Answer:** end them at upgrade (one `upgrade` event each) rather than convert: they are time-boxed windows, and turning them into permanent Always allow settings would widen what someone agreed to.
**Decided by:** Accepted at SPECIFY (recommended option).

~~**Two areas added**~~ (RESOLVED)
**Context:** (Messages, Chat connections) so the retired context switches have somewhere to land.
**Answer:** add them as specified.
**Decided by:** Accepted at SPECIFY (recommended option).

~~**Careful narrows supervised installs**~~ (RESOLVED)
**Context:** Mapping `'supervised'` to Careful (decision 4) makes Tasks, Other agents, Chat connections and Rooms ask where they ran (or, for Rooms, were blocked) before.
**Answer:** follow decision 4 and announce it in the changelog; the person can pick Balanced in one tap.
**Decided by:** Follows operator decision 4 (first-run pick).

~~**Rooms request card inside rooms**~~ (RESOLVED)
**Context:** (new surface, phase 2).
**Answer:** yes: a Rooms request raised by a room turn otherwise surfaces only in the inbox, away from the conversation that caused it.
**Decided by:** Accepted at SPECIFY (recommended option).

~~**Blocked also refuses reads in the area**~~ (RESOLVED)
**Context:** (`tasks_list`, `mesh_list`).
**Answer:** yes; hidden-but-callable is the defect ADR-0070 shipped.
**Decided by:** Accepted at SPECIFY (recommended option).

~~**`operator.update_agent` on the agent itself**~~ (RESOLVED)
**Context:** sits in Other agents, so on Careful an agent asks before editing its own description or SOUL.md.
**Answer:** keep areas static for this spec (one fact per action); revisit with an input-based rule only if Careful users report noise.
**Decided by:** Accepted at SPECIFY (recommended option).

~~**Standing grants vs Always allow under login off (ideation, "confirm the login-off threat model").**~~ (RESOLVED)
**Answer:** Always allow works with login off; standing grants are retired.
**Rationale:** Security review against the code: a shell adversary can already decide approvals and write `roomsManage` through the unguarded mesh PATCH with login off, so Always allow adds no reach; it is scoped to one action and one agent, labelled unverified, and undoable. This spec also closes the mesh PATCH path for permissions (D10, Security).

~~**Connector grants (Accounts): fold in or link?**~~ (RESOLVED)
**Answer:** Link; out of scope (operator decision 6). Every `connector.*`/`connectors.*` capability has no area.
**Rationale:** Accounts already have per-agent grants and their own approval flow.

~~**Blocked + tool visibility.**~~ (RESOLVED)
**Answer:** Blocked hides the area's tools and leaves one line (operator decision 5); implemented at all three tool-list builders (D15).
**Rationale:** Retires `agentContext.*Tools` and the four documentation keys, which only ever reached claude-code.

~~**Where does Ask live: a new system or the existing approvals?**~~ (RESOLVED)
**Answer:** The existing approvals: the gate's `ask()`, the hold, the verdict delivery and `ApprovalCard` (D6, D7).
**Rationale:** All three pieces already exist and already resume the agent; only "when to ask" changes.

~~**Where does area membership live?**~~ (RESOLVED)
**Answer:** On each action (capability definition, tool tier table), not in the area registry (D1).
**Rationale:** One fact per tool in one place (DOR-499); the compiler becomes the census.

~~**Undecided installs.**~~ (RESOLVED)
**Answer:** `preset: null` resolves through the Unchanged table, which reproduces today's behaviour until the person answers the door (D5).
**Rationale:** Decision 4 asked for the honest choice; any preset guessed for them would widen or narrow without consent.

~~**Permission history retention.**~~ (RESOLVED)
**Answer:** The `permissions` Activity category is exempt from the 30-day prune.
**Rationale:** Low volume; an audit trail that forgets after a month cannot answer "who allowed this".

## Related ADRs

- **Superseded:** `260828-123331` (first hard tool filter at `registry.invoke`, no global twin); `260726-171347` (tool-group toggles gate context, not access); `0071` (implicit tool-group hierarchy).
- **Kept and relied on:** `260725-133221` (approvals bind to the exact action shown); `260909-123910` (a late verdict wakes the session that asked); `260912-190915` (approvals expire on a sweep and the agent is told); `260822-235759` (consent-led default flipping); `260822-235801` (green means full power); `0320` (optional local login); `260801-035912` (a permission decision is recorded for every session); `260803-233420` (managed MCP server trust model); `260804-021140` (Connections vocabulary).
- **Candidates for new ADRs** (drafted at the ADR step): one permission model replacing the tool-group gate and tier ceiling; permission decisions ride the tier gate's three choke points; area membership lives on the action; Always allow as a per-agent per-action setting replacing standing grants; login-off attribution is labelled unverified; the destructive-asks rule; the floor.

## References

- Ideation: [`specs/agent-permissions/01-ideation.md`](./01-ideation.md); tracker DOR-2278; absorbed DOR-2093; includes DOR-2094.
- Specs: `rooms-management-tools`, `full-power-defaults`, `agent-trust`, `agent-approval-settings`, `approvals-resume-inline`, `approval-verdict-delivery`, `room-participation`, `canvas-agent-seat`.
- Code (starting points): `apps/server/src/services/core/capabilities/{registry,tier-enforcement,tool-group-enforcement,capability-approval-hold,mcp-projection,trusted-caller}.ts`; `services/core/mcp-tool-{tiers,gate}.ts`; `services/core/approvals/{decision-authority,approval-service,approval-verdict-delivery,standing-grant-posture}.ts`; `routes/{approvals,config,mesh}.ts`; `lib/caller-authority.ts`; `services/core/operator/{config-write-policy,agent-write-policy,agent-updater,config-write}.ts`; `services/session/resolve-session-defaults.ts`; `runtimes/claude-code/{mcp-tools/index,messaging/launch-resolver,tooling/tool-filter}.ts`; `packages/shared/src/{mesh-schemas,config-schema,activity-schemas,mcp-tool-groups}.ts`; client `features/{agent-settings,settings,approvals,full-power-door}`, `widgets/control-center`.
- Prior art (ideation §5): iOS/macOS in-context permission prompts; Claude Code allow/ask/deny; Google Workspace / GitHub base permissions with overrides; browser site settings; macOS "Recently changed".
