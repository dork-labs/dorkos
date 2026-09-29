# Agent Permissions — task breakdown

**Spec:** `specs/agent-permissions/02-specification.md`
**Slug:** `agent-permissions`
**Tracker:** DOR-2278 · project "Agent Permissions"
**Mode:** full
**Generated:** 2026-09-23T23:06:41.000Z

Four phases, each shipped as one stacked pull request by one implementer agent, in order. Inside a phase the tasks are the implementer's ordered checklist; `Parallel with` marks tasks that touch disjoint code and can be done in any order once their dependencies are met. Each phase ends with a verification task.

**Governing invariant: an agent never grants itself.** Every permission write needs a person's yes; the gate reads the permission fresh on every call; floor areas (Safety limits, Permissions, Reach & secrets) are never Allowed.

| Task | Title                                                                                                                   | Size                                              | Depends on                        | Parallel with  |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- | -------------- |
| 1.1  | Create the @dorkos/shared/permissions module: areas, schemas, presets and the pure resolver                             | large                                             | —                                 | —              |
| 1.2  | Add the permissions config section, manifest field, roomsManage read-time fold and the phase-1 config migration         | large                                             | 1.1                               | 1.3            |
| 1.3  | Declare an area on every capability and MCP tool, drop toolGroup, and add the area census                               | large                                             | 1.1                               | 1.2            |
| 1.4  | Put the permission decision inside the tier gate at its three choke points and delete the tool-group gate               | xl                                                | 1.2, 1.3                          | 1.5, 1.6       |
| 1.5  | Add rooms.archive (archive_room) as an agent capability in the Rooms area                                               | medium                                            | 1.3                               | 1.4, 1.6       |
| 1.6  | Add the permissions Activity category, the permission.changed event and a read-only history query                       | medium                                            | 1.1                               | 1.4, 1.5       |
| 1.7  | Build the permission service, the /api/permissions routes and the person bars; close every other write path             | xl                                                | 1.2, 1.6                          | 1.4            |
| 1.8  | Run the permission upgrade sweep at boot for roomsManage and the preset migration                                       | medium                                            | 1.7                               | 1.9            |
| 1.9  | Hide Blocked Rooms actions from the agent's tools and add the one context line                                          | medium                                            | 1.4                               | 1.8, 1.10      |
| 1.10 | Make the first-run door and onboarding power step write the permission preset                                           | small                                             | 1.7                               | 1.9, 1.11      |
| 1.11 | Add the client permissions entity hooks and the three-way switch primitive                                              | medium                                            | 1.7                               | 1.8, 1.9, 1.10 |
| 1.12 | Build the Rooms row, exceptions chip and apply dialog; add Settings and agent Permissions pages; remove ManageRoomsCard | xl                                                | 1.11                              | —              |
| 1.13 | Phase 1 verification: tests, e2e for DorkBot create_room, browser check, docs, changelog, knip                          | medium                                            | 1.4, 1.5, 1.8, 1.9, 1.10, 1.12    | —              |
| 2.1  | Replace the standing-grant answer with answer: once                                                                     | always on the grant route, and audit every answer | large                             | 1.13           | 2.3, 2.4 |
| 2.2  | Give ApprovalCard the three answers: Allow, Always allow, Deny                                                          | medium                                            | 2.1                               | 2.5            |
| 2.3  | Add permissions.request_access (request_permission) and permissions.list, with rate limits and the full context line    | xl                                                | 1.13                              | 2.1, 2.4       |
| 2.4  | Stop unattended turns from holding on an approval                                                                       | small                                             | 1.13                              | 2.1, 2.3       |
| 2.5  | Show the request card inside the room whose turn raised it                                                              | medium                                            | 2.2                               | 2.6            |
| 2.6  | Retire standing grants: table, service, config keys, routes, UI, with a config migration and upgrade events             | large                                             | 2.1                               | 2.5            |
| 2.7  | Phase 2 verification: request-card e2e, browser check, docs, changelog, knip                                            | medium                                            | 2.2, 2.3, 2.4, 2.5, 2.6           | —              |
| 3.1  | Assign the final area to every capability and MCP tool and tighten the census                                           | large                                             | 2.7                               | 3.2, 3.4       |
| 3.2  | Escalate operator.config_patch by input and let an approved change write through PERSON_APPROVED_AUTHORITY              | large                                             | 3.1                               | 3.3, 3.4       |
| 3.3  | Add permissions.change: an agent asking to change a permission, always a person's yes                                   | medium                                            | 3.1                               | 3.2, 3.4       |
| 3.4  | Retire the tier ceiling everywhere and fold tierCeiling and the four tool-group keys into permissions                   | xl                                                | 3.1                               | 3.2, 3.3       |
| 3.5  | Retire agentContext and the tool-group documentation switches; Blocked hides tools for every area                       | xl                                                | 3.4                               | 3.6            |
| 3.6  | Couple presets to the trust stop and add the per-agent Files & commands stop                                            | large                                             | 3.1                               | 3.5            |
| 3.7  | Add the preset picker, every area row, Files & commands row and individual action overrides to the Permissions UI       | xl                                                | 3.5, 3.6                          | 3.8, 3.9       |
| 3.8  | Turn the Control Center dial into the preset picker and add agent permission rows with Reset                            | medium                                            | 3.6                               | 3.7, 3.9       |
| 3.9  | Add dorkos permissions and dorkos agent permissions CLI commands                                                        | medium                                            | 3.6                               | 3.7, 3.8       |
| 3.10 | Phase 3 verification: migrations, tool lists on three runtimes, e2e, browser check, docs, changelog, knip               | large                                             | 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9 | —              |
| 4.1  | Add Undo for permission changes, with the conflict path and preset snapshots                                            | large                                             | 3.10                              | 4.3, 4.4       |
| 4.2  | Show a why line on every permission state                                                                               | medium                                            | 3.10                              | 4.1, 4.3, 4.4  |
| 4.3  | Show the effect preview on every surface that changes a default                                                         | small                                             | 3.10                              | 4.1, 4.2, 4.4  |
| 4.4  | Add the gentle Always allow suggestion after three Allows in seven days                                                 | medium                                            | 3.10                              | 4.1, 4.2, 4.3  |
| 4.5  | Phase 4 verification: tests, browser check, docs, changelog                                                             | medium                                            | 4.1, 4.2, 4.3, 4.4                | —              |

---

## Phase 1 — Foundation + Rooms (13 tasks)

### Task 1.1: Create the @dorkos/shared/permissions module: areas, schemas, presets and the pure resolver

- **Subject:** `[agent-permissions] [P1] Create the @dorkos/shared/permissions module: areas, schemas, presets and the pure resolver`
- **Size:** large · **Priority:** high
- **Depends on:** nothing
- **Parallel with:** —

Create a new module `packages/shared/src/permissions/` and publish it as the subpath `@dorkos/shared/permissions` (add the entry to the `exports` map in `packages/shared/package.json`, beside the existing ~96 subpaths; there is no root entry). This is the one place the permission model's vocabulary, preset tables and resolution rule live; server and client both import it. It carries the **full** model from day one (all ten state areas, all three presets, the Unchanged table), even though only Rooms is wired in phase 1.

### Files

```
packages/shared/src/permissions/
  permission-areas.ts        # area registry
  permission-schemas.ts      # states, ids, overrides, config + manifest shapes, API DTOs
  permission-presets.ts      # frozen preset tables + the hidden Unchanged table
  resolve-permission.ts      # resolvePermission, resolveFilesAndCommands (pure, no I/O)
  index.ts                   # barrel for the subpath
  __tests__/resolve-permission.test.ts
  __tests__/permission-presets.test.ts
```

### permission-schemas.ts (exact shapes)

```ts
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
 * one (the `workspace` precedent in mesh-schemas.ts: refusing the parse makes the
 * agent vanish from the fleet). Known-id and floor checks run on WRITE and the
 * resolver ignores unknown keys.
 */
export const PermissionOverridesSchema = z.object({
  areas: z.record(z.string(), PermissionStateSchema).default({}),
  actions: z.record(PermissionActionIdSchema, PermissionStateSchema).default({}),
});
```

Also export the agent-manifest shape (`AgentPermissionsSchema`: `areas?` record, `actions?` record, `filesAndCommands?: z.enum(PERMISSION_STOPS)` where `PERMISSION_STOPS` is imported from `packages/shared/src/permission-semantics.ts:52`) and the API DTOs the routes will use (`GET /api/permissions` response: preset, `defaults`, per-area `{ id, label, description, floor, kind, actions: [{ id, title, tier }], resolved: { state, source } }`, `exceptions[]` of `{ agentId, agentName, area, action?, state }`; `GET /api/agents/:id/permissions` response; the PATCH/PUT bodies with `surface`). Register the DTOs with `.openapi(...)` names so the OpenAPI generator picks them up. Do **not** use `z.record` anywhere that later becomes an in-session MCP tool input schema (claude-agent-sdk >=0.3.257 + zod >=4.5.3 empties `tools/list`); stored/HTTP shapes are fine.

### permission-areas.ts

One entry per area: `id`, `label`, `description` (user-facing, plain English for a smart 9th grader), `floor: boolean`, `kind: 'state' | 'trust-stop'`. Membership is **not** here: each action declares its own `area` (task 1.3). Exact copy:

| id            | Label             | Description                                                                          | Floor | Kind       |
| ------------- | ----------------- | ------------------------------------------------------------------------------------ | ----- | ---------- |
| `rooms`       | Rooms             | Make rooms, add or remove people, rename them, leave them, put them away             | no    | state      |
| `tasks`       | Tasks & schedules | Create, change, and delete scheduled tasks                                           | no    | state      |
| `agents`      | Other agents      | Set up, change, and remove agents, and sort the sidebar                              | no    | state      |
| `messages`    | Messages          | Message other agents, and message you                                                | no    | state      |
| `connections` | Chat connections  | Turn Telegram and Slack connections on or off, and change where chats go             | no    | state      |
| `packages`    | Tools & packages  | Install or remove packages, add or change MCP servers, build extensions              | no    | state      |
| `settings`    | DorkOS settings   | Change your everyday settings, like notifications and the sidebar                    | no    | state      |
| `safety`      | Safety limits     | Change reply limits, message caps, and an agent's safety boundaries                  | yes   | state      |
| `permissions` | Permissions       | Change what any agent is allowed to do                                               | yes   | state      |
| `reach`       | Reach & secrets   | Open this computer to the internet, change login, sign-ins, keys, and folders        | yes   | state      |
| `files`       | Files & commands  | How often the agent stops to check with you while editing files and running commands | no    | trust-stop |

(The lock glyph on floor rows is a UI concern; keep it out of the label string.) Export helpers `isFloorArea(id)`, `PERMISSION_AREAS` (readonly array in display order), `getPermissionArea(id)`.

### permission-presets.ts

One frozen table per preset plus the hidden **Unchanged** table used only while `permissions.preset` is `null`:

| Area         | Careful | Balanced | Full power | Unchanged                                    |
| ------------ | ------- | -------- | ---------- | -------------------------------------------- |
| rooms        | ask     | allowed  | allowed    | blocked                                      |
| tasks        | ask     | ask      | allowed    | allowed                                      |
| agents       | ask     | ask      | allowed    | allowed                                      |
| messages     | allowed | allowed  | allowed    | allowed                                      |
| connections  | ask     | ask      | allowed    | allowed                                      |
| packages     | ask     | ask      | ask        | allowed                                      |
| settings     | ask     | ask      | ask        | allowed                                      |
| safety       | ask     | ask      | ask        | blocked                                      |
| permissions  | ask     | ask      | ask        | blocked                                      |
| reach        | blocked | ask      | ask        | blocked                                      |
| files (stop) | `ask`   | `act`    | `autonomy` | none (the stored trust stop stays untouched) |

`Object.freeze` every table. Each table's doc comment says: **shipped preset values are frozen; changing one later is a config migration that first copies the old value into `permissions.defaults` for every install on that preset, so no preset ever silently widens** (`.claude/rules/safe-defaults.md`).

**Unchanged must reproduce today's behaviour exactly.** Today `rooms.merge` is NOT behind the `roomsManage` tool group (only `rooms.create/add_members/remove_members/update/leave` carry `toolGroup: 'roomsManage'`, `apps/server/src/services/rooms/room-capabilities.ts:1300,1410,1456,1504,1565`), so it runs on every install today. Putting `rooms.merge` in the Rooms area with Unchanged = Blocked would silently remove it from undecided installs. Give the Unchanged table an action-level entry `{ 'rooms.merge': 'allowed' }` (resolved with `source: 'unchanged'`) so Unchanged stays faithful; note this in the table's comment. (Decomposition-stage resolution of a spec gap; log it on the PR.)

### resolve-permission.ts

```ts
export type PermissionSource =
  | 'agent-action'
  | 'agent-area'
  | 'default-action'
  | 'default-area'
  | 'preset'
  | 'unchanged'
  | 'floor'
  | 'inactive';

export interface ResolvedPermission {
  area: PermissionAreaId;
  state: PermissionState;
  source: PermissionSource;
  /** The coarse answer every "why?" line starts from. */
  layer: 'agent' | 'default' | 'floor';
  /** True when the destructive rule turned an area-level Allowed into Ask. */
  destructiveAsk?: true;
}

export function resolvePermission(input: {
  area: PermissionAreaId;
  actionId: string;
  tier: CapabilityTier; // from packages/shared/src/capabilities.ts:35
  config: { preset: PermissionPreset | null; defaults: PermissionOverrides };
  agent?: AgentPermissions; // absent for an unidentified caller: agent layers skipped
  inactive?: boolean;
}): ResolvedPermission;
```

Precedence, first match wins:

1. `inactive` -> `blocked`, `source: 'inactive'` (a revoked/expired identity; carries forward `REVOKED_TIER_CEILING` and the tool-group gate's `!identity.inactive` rule).
2. `agent.actions[actionId]` -> `agent-action`.
3. `agent.areas[area]` -> `agent-area`.
4. `config.defaults.actions[actionId]` -> `default-action`.
5. `config.defaults.areas[area]` -> `default-area`.
6. preset table for `config.preset` -> `preset`; or the Unchanged table (action entry first, then area) when `preset === null` -> `unchanged`.

Then two post-rules, in this order:

- **Destructive rule:** if `tier === 'destructive'` and the state is `allowed` and it came from an **area-level** source (`agent-area`, `default-area`, `preset`, `unchanged` area entry) -> `ask` with `destructiveAsk: true`. Only an action-level Allowed (`agent-action`, `default-action`) lets a destructive action run without asking.
- **Floor clamp:** if the area is a floor area and the state is `allowed` -> `ask`, `source: 'floor'`, `layer: 'floor'`.

`layer` is `'agent'` for agent-* sources, `'floor'` for floor, otherwise `'default'` (inactive -> `'agent'`). Unknown keys in `areas`/`actions` (a newer build's area) are ignored.

```ts
export function resolveFilesAndCommands(input: {
  agent?: { filesAndCommands?: PermissionStop };
  perRuntime?: PermissionStop | null; // runtimes.<runtime>.defaultTrustStop
  global?: PermissionStop | null; // runtimes.defaultTrustStop
}): { stop: PermissionStop | null; source: 'agent' | 'runtime' | 'default' | 'runtime-own' };
```

Order: agent > perRuntime > global > `{ stop: null, source: 'runtime-own' }` (the runtime's own default).

Every export carries a TSDoc block description (Hard Rule 4: jsdoc rules are errors).

### Tests (each with a purpose comment; must be able to fail; never mock the resolver)

`resolve-permission.test.ts`:

- each layer beats every layer below it (6x matrix), and inside a layer the action beats the area;
- destructive rule: area-level Allowed on a destructive action -> Ask with `destructiveAsk`; action-level Allowed (agent or default) stays Allowed; `act`/`observe` unaffected;
- floor clamp at every layer (agent action, agent area, default action, default area) -> Ask with `source: 'floor'`;
- `inactive` beats an agent-action Allowed;
- unidentified (no `agent`) ignores agent layers;
- unknown area/action keys ignored;
- `preset: null` -> Unchanged values, including the `rooms.merge` action entry;
- `resolveFilesAndCommands` order and the `runtime-own` fallback.

`permission-presets.test.ts`: pins every table value literally (a comment says a failure here means a shipped preset changed and needs a protective migration); no floor area is `allowed` in any table; Unchanged equals today's behaviour (Rooms blocked except merge, floor areas blocked, everything else allowed).

### Acceptance criteria

- [ ] `import { resolvePermission } from '@dorkos/shared/permissions'` resolves from server and client after `pnpm --filter @dorkos/shared build`.
- [ ] Both test files pass: `pnpm vitest run packages/shared/src/permissions`.
- [ ] `pnpm --filter @dorkos/shared typecheck` and `lint` are clean (TSDoc on every export).

### Task 1.2: Add the permissions config section, manifest field, roomsManage read-time fold and the phase-1 config migration

- **Subject:** `[agent-permissions] [P1] Add the permissions config section, manifest field, roomsManage read-time fold and the phase-1 config migration`
- **Size:** large · **Priority:** high
- **Depends on:** 1.1
- **Parallel with:** 1.3

Give user config and the agent manifest a home for permissions, fold the legacy `enabledToolGroups.roomsManage` into it at read time, and migrate the first-run power choice into a preset. Follow the `adding-config-fields` skill and `contributing/configuration.md` end to end.

### 1. User config (`packages/shared/src/config-schema.ts`)

New top-level section. Declare it **twice** (per-field default AND in the object-literal default: the two-declaration rule; one feeds fresh installs, the other upgrades, and they silently disagree if you only write one):

```ts
permissions: z.object({
  /** The preset every area starts from. `null` = not chosen yet ("Unchanged"). */
  preset: PermissionPresetSchema.nullable().default(null),
  /** The changes a person made on top of the preset ("Full power, 2 changes"). */
  defaults: PermissionOverridesSchema.default({ areas: {}, actions: {} }),
  /** Server version the permission upgrade sweep last ran for; null = never. */
  upgradeSweptVersion: z.string().nullable().default(null),
}).default(() => ({ preset: null, defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null })),
```

`upgradeSweptVersion` is a decomposition-stage addition: the boot sweep (task 1.8) needs a stored "once per server version" marker and the section is the only writer-guarded home for it (the generic config PATCH will refuse `permissions.*`). Record this on the PR.

The global Files & commands value is NOT duplicated here: it stays `runtimes.defaultTrustStop` (and per-runtime leaves).

### 2. Agent manifest (`packages/shared/src/mesh-schemas.ts`, `AgentManifestSchema`)

```ts
permissions: z.object({
  areas: z.record(z.string(), PermissionStateSchema).optional(),
  actions: z.record(PermissionActionIdSchema, PermissionStateSchema).optional(),
  /** Per-agent trust stop, the "Files & commands" row. Absent = inherit. */
  filesAndCommands: z.enum(PERMISSION_STOPS).optional(),
}).optional(),
```

Deliberately **no** `.catch(undefined)`: an unparseable security control must be loud (the `tierCeiling`/`mcpServers` precedent, `mesh-schemas.ts:560-570`). Forward compatibility comes from the string keys.

**Read-time fold (`z.preprocess` on `AgentManifestSchema`, permanent).** Marketplace packages and copied/restored `.dork/agent.json` files will carry old fields forever; a manifest read is the one seam all of them pass. Phase 1 folds **only** `enabledToolGroups.roomsManage`:

- `roomsManage === true` -> `permissions.areas.rooms = 'allowed'`
- `roomsManage === false` -> `permissions.areas.rooms = 'blocked'` (the agent ToolsTab spreads the whole object, `features/agent-settings/ui/ToolsTab.tsx:391-396`, so an explicit `false` is a person's decision)
- absent -> nothing (inherit)
- then delete `roomsManage` from `enabledToolGroups` (and drop `enabledToolGroups` if it is now empty). `enabledToolGroups.{tasks,relay,mesh,adapter}` and `tierCeiling` are NOT touched in this phase; they keep their current meaning until phase 3.

**Fold per key, never gated on `permissions` being absent.** Write the fold so each legacy key is folded whenever it is present, and it only fills `permissions.areas.<area>` when that area is not already set (an explicit `permissions` value wins). Gating the whole fold on "permissions absent" would make phase 3's fold of `tasks/relay/mesh/adapter/tierCeiling` skip every agent that already gained a `permissions` object in phase 1. (Decomposition-stage resolution; record it on the PR.)

**`UpdateAgentRequestSchema`** (`mesh-schemas.ts:826-870`, a `.pick()`): do NOT add `permissions`. The generic agent PATCH must never write a permission. In phase 1 it must also refuse `enabledToolGroups.roomsManage` (task 1.7 adds the route-level refusal; here make the schema reject or strip it so the type no longer allows it). `tierCeiling` and the other four `enabledToolGroups` keys stay writable until phase 3 because the agent ToolsTab still writes them.

Remove `roomsManage` from `EnabledToolGroups` and delete `CapabilityToolGroupKey` (`mesh-schemas.ts:166-191`). Fix every compile error it causes (client `ToolsTab`'s `ManageRoomsCard` is deleted in task 1.12; if you land this first, delete the card's use of the key here and leave the card removal to 1.12 only if it still compiles, otherwise remove it now).

### 3. Config migration (`apps/server/src/services/core/config-manager.ts`, `CONFIG_MIGRATIONS`, ~line 3313)

The newest merged key is `'0.82.0'`. Open the next unreleased key (`'0.83.0'` today; check `packages/cli/package.json` version and the table at implementation time: a key must be <= the version it ships in, or an upgrader never runs it).

Body: `ui.fullPowerChoice === 'full'` -> `permissions.preset = 'full'`; `'supervised'` -> `'careful'`; `null` -> leave `preset: null`. It does **not** touch `runtimes.*defaultTrustStop`. `permissions` is a new top-level section, so `conf` pre-writes its defaults before migrations run: no absence guard (it would be unreachable); the key's once-per-upgrade semantics are the guard.

Pin the key's hash in `apps/server/src/services/core/__tests__/merged-migration-hashes.ts` in this same PR. Tests read `config.json` from disk (DOR-1496), not the in-memory store.

A config migration runs before the Activity service exists, so it emits nothing; the boot sweep (1.8) writes the `upgrade` event.

### Tests

- config-schema test: fresh default equals `{ preset: null, defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null }` from BOTH declarations.
- migration test, reading `config.json` from disk: `fullPowerChoice` `'full'` -> `'full'`; `'supervised'` -> `'careful'`; `null` -> `null`; trust stop untouched in all three.
- merged-migration-hashes pin present; migration-safety tests pass.
- manifest fold: `roomsManage: true` -> rooms allowed and key gone; `false` -> blocked; absent -> no `permissions`; `roomsManage: true` with an existing `permissions.areas.rooms: 'ask'` keeps `'ask'`; `enabledToolGroups.tasks: false` untouched in this phase; an unknown area key (`permissions.areas.future: 'allowed'`) parses.
- an invalid state value (`permissions.areas.rooms: 'yes'`) fails the parse loudly.

### Acceptance criteria

- [ ] An upgraded install with `ui.fullPowerChoice: 'full'` has `permissions.preset === 'full'` after boot; `'supervised'` -> `'careful'`; undecided stays `null`.
- [ ] A manifest with `roomsManage: true` reads as `permissions.areas.rooms === 'allowed'`; `false` reads as `'blocked'`.
- [ ] `pnpm vitest run packages/shared/src/__tests__/config-schema.test.ts apps/server/src/services/core/__tests__` passes, including `migration-safety` and the hash pin.

### Task 1.3: Declare an area on every capability and MCP tool, drop toolGroup, and add the area census

- **Subject:** `[agent-permissions] [P1] Declare an area on every capability and MCP tool, drop toolGroup, and add the area census`
- **Size:** large · **Priority:** high
- **Depends on:** 1.1
- **Parallel with:** 1.2

Move area membership onto each action (the codebase rule: one fact per tool, in one place, DOR-499; the same shape `toolGroup` has today) and make a missing area a compile error plus a census failure.

### Capability definitions

In `apps/server/src/services/core/capabilities/capability-definition.ts`:

- Delete `CapabilityToolGroup` (`:65`) and the optional `toolGroup?` field (`:210`).
- Add a **required** `area: PermissionAreaId | null` (import from `@dorkos/shared/permissions`) and `areaNote?: string`. `area: null` must be accompanied by a non-empty `areaNote` saying why it is always allowed; enforce it in conformance (below). TSDoc both fields.

Phase 1 assignments (final areas for everything else land in phase 3):

- `area: 'rooms'`: `rooms.create`, `rooms.add_members`, `rooms.remove_members`, `rooms.update`, `rooms.leave` (`apps/server/src/services/rooms/room-capabilities.ts:1285-1565`, today `toolGroup: 'roomsManage'`), `rooms.merge` (`:897`), and the new `rooms.archive` (task 1.5 adds it with `area: 'rooms'`).
- Every other capability (~64): `area: null` with a truthful `areaNote`. Use the spec's wording where one exists: conversation verbs `rooms.post`/`rooms.react` -> "conversation verbs never get a switch"; reads -> "reading"; `memory.write` -> "the agent's own memory"; `ui.*` -> "the agent's own window seat"; `connector.*`/`connectors.*` -> "connected accounts have their own grant model"; `mcp.poll_signin` -> "only continues a sign-in mcp.signin already started". For actions that will get an area in phase 3 (operator._, marketplace._, mcp.* writes), write `areaNote: 'Area assigned in agent-permissions phase 3'` so phase 3's census can assert none remain.
- Update the room-capabilities module doc (`:100-116`) that explains `toolGroup: 'roomsManage'`.

`serializeCapability` must emit `area` (so the capabilities catalog carries it as it carried `toolGroup`). Replace every `toolGroup` read in the codebase (grep `toolGroup`, `CapabilityToolGroup`, `roomsManage` across `apps/` and `packages/`), except the gate code that task 1.4 deletes.

### Hand-registered MCP tools (`apps/server/src/services/core/mcp-tool-tiers.ts:78,125`)

Add required `area: PermissionAreaId | null` and `areaNote?: string` to `interface McpToolTier`. The table already uses `satisfies Record<string, McpToolTier>`, so a missing area is a type error. In phase 1 every entry is `area: null` with `areaNote: 'Area assigned in agent-permissions phase 3'` (or 'always on' for `ping`, `get_server_info`, `get_session_count`, `get_agent`, `get_extension_api`, `list_extensions`, `get_extension_errors`, which stay area-less permanently). Do not touch `MCP_TOOL_GATE_GROUPS` yet (phase 3).

### Conformance (`packages/test-utils/src/capability-conformance.ts` and `apps/server/src/services/core/__tests__/mcp-tool-gate.test.ts`)

- A definition with `area: null` and no `areaNote` fails.
- `approvalDisplayFields` is required on **every action with an area** (they can all raise a card under Ask), not only on `destructive` ones; `approvalSubject` is required when the target is an opaque id (the DOR-1929 rule). Add display fields to the five room capabilities that lack them (e.g. `rooms.create`: name + members; `rooms.add_members`/`remove_members`: roomId + members with `approvalSubject: { field: 'roomId', kind: 'room' }`; `rooms.update`, `rooms.leave`, `rooms.merge` likewise). Add a `room` subject kind in `apps/server/src/services/core/approvals/approval-subject.ts` if absent. No secret-named field may be a display field (the summary is broadcast and readable by agents via `GET /api/approvals/pending`).

### Census test (new): `apps/server/src/services/core/capabilities/__tests__/permission-area-census.test.ts`

Walks `composeCapabilityRegistryForDocs()` (every domain, `dorkos-registry.ts`) plus `MCP_TOOL_TIERS` and asserts:

- every action has an area or a non-empty `areaNote`;
- every action in a floor area has `approvalDisplayFields`;
- no `observe` action is the only member of an area;
- `serializeCapability` output includes `area`;
- the Rooms area contains exactly the seven room actions above (pins the phase-1 membership);
- **phased assertion:** "every non-`files` area has at least one member" is written now but scoped to the areas with members this phase (`['rooms']`), with a comment that phase 3 widens it to all ten. (The spec's unconditional form cannot pass in phase 1 because only Rooms has members.)

### Acceptance criteria

- [ ] `grep -rn "toolGroup\|CapabilityToolGroup" apps packages --include=*.ts` returns only lines that task 1.4 deletes (or nothing if 1.4 has landed).
- [ ] Removing `area` from any capability or tool entry fails `pnpm --filter @dorkos/server typecheck`.
- [ ] `pnpm vitest run apps/server/src/services/core/capabilities/__tests__/permission-area-census.test.ts apps/server/src/services/core/__tests__/mcp-tool-gate.test.ts packages/test-utils` passes.

### Task 1.4: Put the permission decision inside the tier gate at its three choke points and delete the tool-group gate

- **Subject:** `[agent-permissions] [P1] Put the permission decision inside the tier gate at its three choke points and delete the tool-group gate`
- **Size:** xl · **Priority:** high
- **Depends on:** 1.2, 1.3
- **Parallel with:** 1.5, 1.6

Make the resolved permission part of `enforceCapabilityTier` (`apps/server/src/services/core/capabilities/tier-enforcement.ts:972`), so every surface is gated by construction, and remove the separate tool-group gate. This is the task that makes DorkBot's `create_room` run on a Full-power install.

### Where

`enforceCapabilityTier` has exactly three callers, pinned by `__tests__/gate-bypass-scan.test.ts`: `registry.invoke`, `authorizeCapability`, and `mcp-tool-gate.ts` (hand-registered tools). No fourth path may appear; the scan must still pin exactly three.

### New helper: `apps/server/src/services/core/capabilities/permission-enforcement.ts`

`resolveCallPermission({ action, identity }): Promise<ResolvedPermission | null>`

- returns `null` when the action's `area` is `null`;
- reads the calling agent's manifest **fresh from the file on every call**, never the SQLite cache (the cache has no column for it; the reasoning in `tool-group-grants.ts:5-21` carries over verbatim; copy it into this module's doc), plus the live config `permissions` section;
- with no agent identity (unidentified caller, and not a trusted caller) resolves with `agent` omitted: defaults only;
- `identity.inactive` -> pass `inactive: true`;
- a read that throws fails closed: return a Blocked resolution with `approvable: false` semantics (mirror `holdsGrant`, `tool-group-enforcement.ts:188-201`).

### Gate changes (`tier-enforcement.ts`)

- `TierEnforcementRequest` gains a **required** `permission: ResolvedPermission | null`. Each of the three callers calls `resolveCallPermission` first and passes it; a caller that forgets does not compile.
- Decision table (replaces the allow/ask branch at `:995-1055`; the binding, `ask()`, `consume()` and every refusal shape below it are unchanged):

```
if permission === null:            // no-area action: today's tier logic
  observe -> allowed; act -> allowed; destructive -> ask/consume (as today)
else switch permission.state:
  'allowed' -> allowed. A destructive call allowed this way is audited as
               capability.auto_approved with { via: 'permission', source }.
  'ask'     -> observe -> allowed; act/destructive -> the existing ask/consume flow
  'blocked' -> denied { reason: 'permission_blocked', approvable: false }  // phase 1
```

- `TierDeniedReason` (`:365-370`) gains `permission_blocked` and loses `tool_group_disabled`. (`tier_ceiling` stays until phase 3.) `GrantedApproval` (`:406-412`) gains `{ via: 'permission'; source: PermissionSource }` beside the existing standing-grant variant (standing grants retire in phase 2).
- **Phase-1 message for a Blocked refusal** (no `request_permission` tool exists yet): "Managing rooms is blocked for this agent. Ask the person if you need it." `approvable: false` in phase 1; phase 2 flips it to `!inactive` and names the request tool.
- **Coexistence in phase 1, stated explicitly:** the per-agent tier ceiling (`effectiveCeiling`, `:693`, applied at `:1001`) and standing grants (`resolveStandingGrant`, `:902`, used at `:1028`) keep working exactly as today; phase 3 removes the ceiling and phase 2 removes standing grants. Order: ceiling refusal first (as today), then the permission decision, then the standing-grant lookup only on the `ask` path of a destructive call. Write a test for the combination (an `observe`-ceiling agent is still refused `rooms.create` even on Full power).
- Trusted callers (a person through the app's own routes, `trusted-caller.ts:159-176`) keep bypassing the gate (`registry.ts:536, 562`).

### Delete the tool-group gate

Remove `enforceToolGroupGrant`, `ToolGroupGrantLookup`, `initToolGroupGate`, `manifestToolGroupGrants` (`capabilities/tool-group-enforcement.ts`, `tool-group-grants.ts`), the call at `registry.ts:536-547`, and the boot wiring in `apps/server/src/index.ts`. Delete their tests. No shim.

### Audit metadata

`capability.approval_required` / `capability.denied` / `capability.auto_approved` (`agent-identity/capability-gate-audit.ts:80-134`) gain `permission: { state, source }` in metadata (keep `tierCeiling` until phase 3 removes it).

### Tests (at all three choke points: registry, `authorizeCapability`, `mcp-tool-gate`)

- Blocked refuses with `permission_blocked` and mints no approval;
- Ask mints exactly one approval for an `act` action and lets an `observe` action through;
- Allowed runs;
- a revoked identity is Blocked and not approvable;
- a manifest read that throws fails closed;
- a no-area action keeps today's tier behaviour;
- a destructive action with an area-level Allowed asks; with an action-level Allowed runs and writes `auto_approved { via: 'permission' }`;
- `gate-bypass-scan.test.ts` still pins exactly three callers;
- **phase 1 outcome:** with config `permissions.preset: 'full'` and DorkBot's manifest carrying no `permissions`, `rooms.create` invoked as DorkBot runs (use the real `resolvePermission`, never a mocked one);
- with `preset: null` and no override, `rooms.create` is Blocked (Unchanged) and `rooms.merge` runs.

### Acceptance criteria

- [ ] `grep -rn "enforceToolGroupGrant\|tool_group_disabled\|initToolGroupGate" apps packages` is empty.
- [ ] `pnpm vitest run apps/server/src/services/core/capabilities apps/server/src/services/core/__tests__/mcp-tool-gate.test.ts` passes.
- [ ] `pnpm --filter @dorkos/server typecheck` and `lint` clean.

### Task 1.5: Add rooms.archive (archive_room) as an agent capability in the Rooms area

- **Subject:** `[agent-permissions] [P1] Add rooms.archive (archive_room) as an agent capability in the Rooms area`
- **Size:** medium · **Priority:** medium
- **Depends on:** 1.3
- **Parallel with:** 1.4, 1.6

Give agents a way to put a room away (DOR-2094). Archiving is a flag, not a delete: `applyRoomPatch` sets `archived: true`, `abandonHolds` ends what the room was waiting for (`apps/server/src/services/rooms/manage/room-updates.ts:222-226`), archived rooms leave lists (`room-store.ts:337-373`), and the owner can un-archive (`PATCH /api/rooms/:id` with `archived: false`; `createRoom`'s DM path already un-archives, `room-lifecycle.ts:225`). Today `archived` is reachable only from the operator-only `updateRoom` (`room-updates.ts:128-135`); `updateRoomFromTool` deliberately omits it (`:138-150`). Keep that omission.

### Service

New `RoomService.archiveRoomFromTool(roomId, callerAuthorId)`: a second, dedicated method (the shape DOR-1611 chose, so no future caller gets archive by a flag). It:

- requires the room to be visible to the caller and the caller on its roster;
- refuses a direct message with "A direct message stays until the person archives it." (the `rooms.leave` wording, `room-capabilities.ts:1560`);
- refuses a system room (the #team channel) via the `requireSystemRoomWritable` rule (`service/room-authority.ts`);
- posts the room's normal archive notice, then applies the archive through the same patch path `updateRoom` uses (holds abandoned, list removal).

### Capability

`rooms.archive` in `room-capabilities.ts`: tier `act`, `area: 'rooms'`, MCP name `archive_room`, input `{ roomId }`, `approvalDisplayFields: ['roomId']`, `approvalSubject: { field: 'roomId', kind: 'room' }` (the `room` kind added in task 1.3). The title/description agents read is plain and says archived rooms can be brought back by the person.

A new capability trips the claude-code tool-count guards on purpose (two count guards): update them, decide always-loaded vs deferred (recommend deferred: it is rare), and run `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/tool-exposure.test.ts` and the `services/runtimes/` tests. Regenerate any generated tool docs/catalog the census expects.

### Tests

- archive by a roster member of a visible room -> `archived: true`, holds abandoned, notice posted, room gone from lists;
- non-member / not visible -> refused; DM -> refused with the DM sentence; #team -> refused;
- the person un-archives through `PATCH /api/rooms/:id` afterwards;
- the capability is in the Rooms area (census) and Blocked under Unchanged.

### Acceptance criteria

- [ ] `pnpm vitest run apps/server/src/services/rooms apps/server/src/services/runtimes` passes including tool-count guards and tool-exposure.
- [ ] `archive_room` appears in the agent's tool list when Rooms is Allowed.

### Task 1.6: Add the permissions Activity category, the permission.changed event and a read-only history query

- **Subject:** `[agent-permissions] [P1] Add the permissions Activity category, the permission.changed event and a read-only history query`
- **Size:** medium · **Priority:** high
- **Depends on:** 1.1
- **Parallel with:** 1.4, 1.5

Create the audit trail every permission write lands in.

### Category `permissions` (four places, all in this change)

- Zod enum: `packages/shared/src/activity-schemas.ts:18-20`.
- DB text enum: `packages/db/src/schema/activity.ts:29-31` (currently `['tasks','relay','agent','config','system']`). This is a TypeScript-level enum on a SQLite text column; confirm with `drizzle-kit generate` that no SQL migration is emitted (if one is, commit it).
- `CATEGORY_CONFIG`: `apps/client/src/layers/entities/activity/model/activity-types.ts:38-45` (label "Permissions", an icon from the existing set).
- `CATEGORIES`: `apps/client/src/layers/features/activity-feed-page/ui/ActivityFilterBar.tsx:12` (adds the "Permissions" filter).

`ListActivityQuerySchema` (`activity-schemas.ts:61-73`) gains optional `resourceId`, applied in the activity query so per-agent history is a query, not a scan.

The `permissions` category is **exempt from the 30-day prune** (`apps/server/src/services/activity/activity-service.ts:198`): low volume, and a permission history that forgets cannot answer "who allowed this".

### `permission.changed` metadata schema (in `@dorkos/shared/permissions` or activity-schemas; one event per write, bulk included)

```ts
metadata: {
  changes: Array<{
    target: { kind: 'default' } | { kind: 'agent'; agentId: string; agentPath: string; agentName: string };
    key: { kind: 'preset' } | { kind: 'area'; area: PermissionAreaId } | { kind: 'action'; action: string; area: PermissionAreaId } | { kind: 'files' };
    before: string | null;   // state, stop, or preset; null = inherited / not set
    after: string | null;
  }>;
  surface: 'settings' | 'agent-page' | 'control-center' | 'request-card' | 'first-run' | 'agent-request' | 'api' | 'cli' | 'upgrade' | 'undo';
  attribution: 'signed-in' | 'local-trust' | 'agent-request-approved' | 'upgrade';
  approvalId?: string;
  undoOf?: string;
  presetSnapshot?: { preset: string | null; defaults: PermissionOverrides; trustStop: string | null };
}
```

`resourceId` on the event: the agent id for a single-agent change (so per-agent history queries work); for a bulk/default change, leave it unset and let the per-agent history query also match events whose `changes[].target.agentId` equals the agent (implement in `permission-history.ts`).

### Actor labels (honesty rule)

`actorType`/`actorLabel` follow `readActivityActor` (`apps/server/src/services/activity/activity-actor.ts:93-101`) with one rule: **with login off, a person write is labelled "Someone on this computer", never "You"**, and the history row's detail line reads "Login is off, so DorkOS can't confirm who made this change." With login on: "You (signed in as …)". An approved agent request: "DorkBot asked, you said yes". A migration/sweep: "Upgrade".

### History read: `apps/server/src/services/core/permissions/permission-history.ts`

`listPermissionHistory({ agentId?, before?, limit })` returns `permissions`-category events newest first. (Undo is phase 4.)

### Feed rendering

Add a renderer for `permission.changed` in the activity feed (one-line summary like "Rooms set to Allowed for everyone" / "security-auditor: Rooms Blocked"; bulk: "Rooms set to Allowed for everyone, and 2 agents updated"). Plain words.

### Tests

- category round-trips through Zod and DB; filter bar shows "Permissions";
- a `permissions` event older than 30 days survives the prune while a `config` one is removed;
- `resourceId` query returns only that agent's events, including bulk events that touched it;
- actor label is "Someone on this computer" with login off and never "You".

### Acceptance criteria

- [ ] `pnpm vitest run apps/server/src/services/activity packages/shared/src/__tests__ apps/client/src/layers/entities/activity apps/client/src/layers/features/activity-feed-page` passes.

### Task 1.7: Build the permission service, the /api/permissions routes and the person bars; close every other write path

- **Subject:** `[agent-permissions] [P1] Build the permission service, the /api/permissions routes and the person bars; close every other write path`
- **Size:** xl · **Priority:** high
- **Depends on:** 1.2, 1.6
- **Parallel with:** 1.4

One service owns every permission write; every mutating route proves a person where proof is possible; every other path that could write a permission is closed.

### Service: `apps/server/src/services/core/permissions/permission-service.ts` (+ `index.ts`)

`services/core` is an existing domain, so the AGENTS.md service-domain census does not change. Methods: `setDefaults`, `setPreset`, `setAgent`, `applyToAgents` (as an option on the first two). `undo` is phase 4. Each write:

- validates known area ids (`PERMISSION_AREA_IDS`) and known action ids (registry capabilities + `MCP_TOOL_TIERS` keys) and that an action's `area` is not `null`;
- refuses Allowed on a floor area or a floor-area action: 400 `FLOOR_NEVER_ALLOWED`;
- writes config through `ConfigManager` and manifests through `MeshCore.update` (file-first write-through, ADR-0043);
- emits exactly **one** `permission.changed` event (task 1.6 shape), with `surface` from the caller and `attribution` from the posture the route reports.

`setPreset(preset, { applyToAgents, surface })` in phase 1 writes `permissions.preset` and clears `permissions.defaults`. The trust-stop coupling (writing `runtimes.defaultTrustStop` through the autonomy consent door) is phase 3; do not add it here. Record `presetSnapshot` (preset, defaults, current `runtimes.defaultTrustStop`) on the event now so phase 4's Undo can restore it.

`applyToAgents: string[]`: those agents' overrides for the changed keys are removed in the same write, and the one event lists the default change plus every agent touched.

### Routes: `apps/server/src/routes/permissions.ts` (mount in the app; OpenAPI regenerated and `docs/api/openapi.json` committed; the openapi-fresh check reds otherwise)

| Method + path                       | Body / query                                                                            | Phase 1                                                                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/permissions`              | none                                                                                    | preset, changes, every area with its actions (id, title, tier; from the live registry + `MCP_TOOL_TIERS`), resolved default per area and action, `exceptions[]` (agents that differ, read from every registered agent's manifest file) |
| `PUT /api/permissions/preset`       | `{ preset, applyToAgents?: string[], surface }`                                         | yes (used by the first-run door, task 1.10)                                                                                                                                                                                            |
| `PATCH /api/permissions/defaults`   | `{ areas?: {[id]: state or null}, actions?: {...}, applyToAgents?: string[], surface }` | yes; `null` removes a change                                                                                                                                                                                                           |
| `GET /api/agents/:id/permissions`   | none                                                                                    | this agent's resolved state per area and action with source (`filesAndCommands` added in phase 3)                                                                                                                                      |
| `PATCH /api/agents/:id/permissions` | `{ areas?, actions?, surface }`                                                         | yes; `null` = back to default (`filesAndCommands` in phase 3)                                                                                                                                                                          |
| `GET /api/permissions/history`      | `?agentId&before&limit`                                                                 | yes (task 1.6's reader)                                                                                                                                                                                                                |

(`POST /api/permissions/history/:eventId/undo` is phase 4.)

**Person bars on every mutating route**, reusing the approval-decide helpers, never a third notion of "a person": `resolveDecisionAuthority(readCallerAuthority(req, res))` (`apps/server/src/services/core/approvals/decision-authority.ts:157-201`: refuses any caller presenting `X-DorkOS-Agent`, resolved or not, and any caller holding an approval token) and `requireOperatorCookieUnderLogin` (`lib/caller-authority.ts:224`: with login on only a session cookie counts, never a per-user API key, DOR-474). Record the posture on the event (`local-trust` with login off, `signed-in` with login on). Refusal body sentence: "Only a person can change permissions. Agents can ask with the request tool." (phase 1 may say "Agents can ask the person." until phase 2 adds the tool).

### Close every other path

- `PATCH /api/config` and `dorkos config set` refuse any `permissions.*` key: 400 `USE_PERMISSIONS_API`. `CONFIG_WRITE_POLICY` (`services/core/operator/config-write-policy.ts:233`) marks `permissions` `operator-only` as a second line.
- `PATCH /api/mesh/agents/:id` (`routes/mesh.ts:554-600`, which has **no caller guard today**) refuses a body carrying `permissions` or `enabledToolGroups.roomsManage` (400). The other four `enabledToolGroups` keys and `tierCeiling` stay writable until phase 3 (the agent ToolsTab still writes them).
- `AGENT_WRITE_POLICY` (`services/core/operator/agent-write-policy.ts:115`) marks `permissions` and its children `operator-only`, so `PATCH /api/agents/current` and `operator.update_agent` refuse it before parsing (`agent-updater.ts:280-283`).

### Client transport

Add the methods to the `Transport` interface (`packages/shared/src/transport.ts`) and implement in `HttpTransport` and `DirectTransport` (Obsidian); put the HTTP bodies in `apps/client/src/layers/shared/lib/transport/permission-methods.ts`. Update the mock Transport in `@dorkos/test-utils`.

### Tests (routes / security)

- every mutating route refuses `X-DorkOS-Agent` (resolved and unresolved), an `X-DorkOS-Approval` holder, and (login on) a per-user API key; allows a login-off caller and records `local-trust`;
- floor Allowed write -> 400 `FLOOR_NEVER_ALLOWED`; unknown area/action -> 400;
- `PATCH /api/config` with `permissions.preset` -> 400 `USE_PERMISSIONS_API`;
- `PATCH /api/mesh/agents/:id` with `permissions` or `enabledToolGroups.roomsManage` -> 400;
- `PATCH /api/agents/current` and `operator.update_agent` refuse `permissions`;
- `PATCH /api/permissions/defaults` with `applyToAgents: [a, b]` writes one `permission.changed` naming both agents and the default change, and removes their rooms overrides;
- `GET /api/permissions` lists exceptions correctly.

### Acceptance criteria

- [ ] An agent calling `PATCH /api/agents/:id/permissions` with its header is refused; so is `PATCH /api/mesh/agents/:id` with `permissions`.
- [ ] `docs/api/openapi.json` regenerated and committed.
- [ ] `pnpm vitest run apps/server/src/routes/__tests__ apps/server/src/services/core/permissions` passes.

### Task 1.8: Run the permission upgrade sweep at boot for roomsManage and the preset migration

- **Subject:** `[agent-permissions] [P1] Run the permission upgrade sweep at boot for roomsManage and the preset migration`
- **Size:** medium · **Priority:** high
- **Depends on:** 1.7
- **Parallel with:** 1.9

No manifest migration mechanism exists (`AgentManifestSchema` has no `schemaVersion`), and config migrations run before Activity exists. The boot sweep writes folded manifests back to disk and records what the upgrade changed.

### `apps/server/src/services/core/permissions/permission-upgrade-sweep.ts`

Runs once per server version, after the mesh and Activity services are up (wire it in `apps/server/src/index.ts` boot, after services init). Marker: `permissions.upgradeSweptVersion` (added in task 1.2); skip when it equals the running server version (in dev `SERVER_VERSION` is `0.0.0`; make sure the sweep still runs once per marker value and is idempotent).

1. For every registered agent whose manifest **file** still carries `enabledToolGroups.roomsManage`: write the folded manifest back through `MeshCore.update` (the read-time fold from task 1.2 produces it) and emit one `permission.changed` per agent with `surface: 'upgrade'`, `attribution: 'upgrade'`, actor "Upgrade", `changes: [{ target: agent, key: { kind: 'area', area: 'rooms' }, before: null, after: 'allowed' | 'blocked' }]`.
2. Emit one `permission.changed` for the config migration's effect when `permissions.preset` is non-null and no earlier upgrade event recorded it: `key: { kind: 'preset' }`, `before: null`, `after: preset`.
3. Write the marker.

Agents discovered later are folded on read and written back on their next manifest write (no extra code, but test it).

Structure the sweep so phases 2 and 3 can add steps (ended standing grants; `tierCeiling` and `agentContext` folds) without rewriting it: a list of step functions each returning the events it produced.

### Tests

- writes once: a second boot with the same version writes nothing and emits nothing (idempotent across restarts);
- one `upgrade` event per changed agent; unchanged agents produce none;
- a manifest with `roomsManage: false` ends as `permissions.areas.rooms: 'blocked'` on disk, `roomsManage` gone;
- a sweep that fails on one agent's file continues with the rest and logs the failure (no crash at boot).

### Acceptance criteria

- [ ] An agent with `roomsManage: true` keeps rooms after upgrade; `roomsManage: false` is Blocked; an install with no door answer is unchanged.
- [ ] `pnpm vitest run apps/server/src/services/core/permissions` passes.

### Task 1.9: Hide Blocked Rooms actions from the agent's tools and add the one context line

- **Subject:** `[agent-permissions] [P1] Hide Blocked Rooms actions from the agent's tools and add the one context line`
- **Size:** medium · **Priority:** medium
- **Depends on:** 1.4
- **Parallel with:** 1.8, 1.10

A Blocked action must not appear in the agent's tool list; one line per Blocked area tells the agent it exists and how to get it.

### The three builders

Filter out every action whose resolved state (task 1.4's `resolveCallPermission` / `resolvePermission` against the agent's manifest) is Blocked:

1. claude-code in-session server, built per query: `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts:292-337`, beside the existing per-session filter `loadsAgentToAgentTools` (`messaging/launch-resolver.ts:193-205`), using the manifest `launch-resolver.ts` already reads;
2. the runtime listener for Codex and OpenCode: `apps/server/src/services/runtimes/connector-mcp/agent-runtime-server.ts:21-39`;
3. the external `/mcp` server when the request carries an identity: `apps/server/src/services/core/mcp-server.ts:77-134`; with no identity, the defaults decide.

On the two surfaces with hand-registered tools (claude-code in-session and external `/mcp`), keep building the hidden handlers into a private map (not listed) so phase 2's `request_access` can reach them.

### The context line

Rendered once in `apps/server/src/services/runtimes/shared/` and used by all three adapters' context builders. Phase-1 text for Rooms: "Managing rooms is blocked for you. Ask the person if you need it." (Phase 2 replaces it with the `request_permission` wording.) One line per Blocked area; none when nothing is blocked. Changes take effect the next time the list is built (next turn); enforcement never waits, because the gate resolves on every call. A system-prompt change relaunches a warm session, as today.

### Tests

- each of the three builders omits `create_room` etc. for an agent with Rooms Blocked and lists them when Allowed;
- the context line appears exactly once for a Blocked Rooms and not otherwise;
- the claude-code tool-count guards and `tool-exposure.test.ts` pass; `context-tool-names.test.ts` (tool names as searchable endings) passes.

### Acceptance criteria

- [ ] With Rooms Blocked, none of the seven Rooms tools are in claude-code, Codex or OpenCode tool lists; with Allowed, all are.
- [ ] `pnpm vitest run apps/server/src/services/runtimes apps/server/src/services/core/__tests__/mcp-server*` passes.

### Task 1.10: Make the first-run door and onboarding power step write the permission preset

- **Subject:** `[agent-permissions] [P1] Make the first-run door and onboarding power step write the permission preset`
- **Size:** small · **Priority:** high
- **Depends on:** 1.7
- **Parallel with:** 1.9, 1.11

The phase-1 config migration maps `ui.fullPowerChoice` to a preset only once, at upgrade. A person who answers the Full-power door **after** upgrading (every fresh install, and every upgraded install that deferred) would get `fullPowerChoice: 'full'` but `permissions.preset: null` (Unchanged -> Rooms Blocked), and DorkBot's `create_room` would still fail. So in phase 1 the door itself must write the preset. (The spec schedules the door's preset write with the preset picker in phase 3; this task pulls just the write forward so the phase-1 outcome holds for every install. Log this assumption on the PR.)

### Changes

- `apps/client/src/layers/features/full-power-door/ui/FullPowerDoor.tsx`: after the existing accept write (`updateConfig.mutateAsync({ ui: { fullPowerDecidedAt, fullPowerChoice: 'full' }, ... })`, `:152-159`), call `PUT /api/permissions/preset` with `{ preset: 'full', surface: 'first-run' }`; decline (`fullPowerChoice: 'supervised'`) writes `{ preset: 'careful', surface: 'first-run' }`. Use the entities hook from task 1.11 (or the transport method directly if 1.11 has not landed; switch to the hook when it does). If the preset write fails, show the door's existing error state; the config write already succeeded, so a retry must be idempotent.
- The onboarding power stage (`features/onboarding/ui/OnboardingPowerStep.tsx`) hosts the same door component, so it inherits the write; confirm with a test.
- Defer writes nothing (unchanged).
- Leave `approvals.standingGrants` handling as is (phase 2 removes it).

### Tests

- `FullPowerDoor.test.tsx`: accept calls the preset write with `'full'`/`'first-run'`; decline with `'careful'`; defer writes nothing.
- Update `apps/e2e/tests/full-power-door.spec.ts:142-213` and `onboarding-power.spec.ts:141-218` if they assert request payloads.

### Acceptance criteria

- [ ] A fresh install that accepts Full power at the door has `permissions.preset === 'full'` and DorkBot's `create_room` runs with no settings change.

### Task 1.11: Add the client permissions entity hooks and the three-way switch primitive

- **Subject:** `[agent-permissions] [P1] Add the client permissions entity hooks and the three-way switch primitive`
- **Size:** medium · **Priority:** high
- **Depends on:** 1.7
- **Parallel with:** 1.8, 1.9, 1.10

Client data layer and the shared primitive every permission surface uses. FSD: hooks live in `entities/permissions` (a feature may not import another feature's model); the switch lives in `shared/ui`. Always import through barrels.

### `apps/client/src/layers/entities/permissions/`

```
model/use-permissions.ts          # GET /api/permissions
model/use-agent-permissions.ts    # GET /api/agents/:id/permissions
model/use-overriding-agents.ts    # derive agents that differ for an area (from exceptions[])
model/use-set-permission.ts       # PATCH defaults / PATCH agent / PUT preset (one hook, scope-aware)
model/use-permission-history.ts   # GET /api/permissions/history
index.ts
```

TanStack Query. Every mutation invalidates the permissions, agent-permissions and history queries (and the mesh agent query). A failed write leaves the cached value untouched (no optimistic flip that sticks) so the switch returns to where it was. `use-undo-permission.ts` is phase 4.

### `apps/client/src/layers/shared/ui/permission-state-switch.tsx`

A three-way segmented control: Blocked · Ask · Allowed. Props: `value`, `onChange`, `floor?: boolean` (offers only Blocked · Ask), `disabled`, `aria-label`. Built on shadcn/ui (new-york, neutral gray) and the Calm Tech system (`contributing/design-system.md`; `designing-frontend` + `styling-with-tailwind-shadcn` skills). Keyboard: arrow keys move, it is a radiogroup. Mobile: full-width with 44px targets. Colours never rely on red for Blocked (red is reserved for alarms, ADR `260822-235801`).

Add a Dev Playground showcase (`maintaining-dev-playground` skill).

### Tests (RTL + mock Transport via `TransportProvider`)

- switch: renders three options, floor renders two, arrow-key navigation, calls `onChange`;
- hooks: invalidation after a write; a failed write keeps the old value.

### Acceptance criteria

- [ ] `pnpm vitest run apps/client/src/layers/entities/permissions apps/client/src/layers/shared/ui` passes; `pnpm --filter @dorkos/client lint` clean (FSD rules).

### Task 1.12: Build the Rooms row, exceptions chip and apply dialog; add Settings and agent Permissions pages; remove ManageRoomsCard

- **Subject:** `[agent-permissions] [P1] Build the Rooms row, exceptions chip and apply dialog; add Settings and agent Permissions pages; remove ManageRoomsCard`
- **Size:** xl · **Priority:** high
- **Depends on:** 1.11
- **Parallel with:** —

The first user-facing surfaces. The same component renders the default layer and the agent layer; the only difference is where it writes.

### `apps/client/src/layers/features/permissions/`

```
ui/PermissionRow.tsx            # label, description, PermissionStateSwitch, source text, reset
ui/PermissionList.tsx           # scope: { kind: 'default' } | { kind: 'agent'; agentId }
ui/ExceptionsChip.tsx           # "2 agents differ ›" -> list with state + Reset each
ui/ApplyToOverridesDialog.tsx   # the global change question
index.ts
```

`PermissionList` takes `scope` and writes to the matching route. In phase 1 it renders only the Rooms row (drive the row list from the areas that have members in `GET /api/permissions`, so phase 3 lights up the rest with no component change).

**PermissionRow**, default scope: label, one-line description, switch, exceptions chip. Agent scope: the row reads "Same as everyone (Allowed)" until changed; a changed row shows a dot and "Reset to default" (writes `null`). Floor rows show a lock and offer only Blocked · Ask (no floor row is rendered in phase 1, but build it).

**ApplyToOverridesDialog** opens when a default (or the preset) changes while agents differ:

> **Rooms is now Allowed for everyone.** 2 agents are set differently:
> ☐ security-auditor: Blocked ☐ test-bot: Ask
> This affects 33 agents now.
> **[Keep their settings] [Update selected]**

Nothing is pre-checked. A floor area going up never pre-selects. "Affects N agents" counts agents that inherit the key. "Update selected" sends `applyToAgents`. One component for every area and the preset switch. Mobile: bottom sheet.

### Settings -> Permissions

New tab in `SETTINGS_TABS`, group "Agents & sessions" (`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:34-146`); add `'permissions'` to the `SettingsTab` union (`shared/model/app-store/app-store-panels.ts:15-29`); `?settings=permissions` deep link. `features/settings/ui/PermissionsTab.tsx` composes: the preset shown **read-only** at the top ("Full power" / "Careful" / "Not chosen yet. Your agents work as they did before." with a button that opens the Full-power door); then `PermissionList scope=default`; then a read-only History section (task 1.6's list; rows with actor label and time; no Undo yet); then "Your connected accounts have their own permissions. Manage them in Connections → Accounts." (link). Copy says, where Blocked is explained: "Blocked stops an agent that plays by the rules; it isn't a sandbox."

### Agent profile -> Permissions

New `ProfilePageId`, registry entry in `features/profile/ui/pages/registry.ts`, row in `profile-rows.ts:356-406` and in DorkBot's group (`:470-480`). `features/profile/ui/pages/PermissionsPage.tsx` composes `PermissionList scope=agent` plus that agent's history. For a runtime without DorkOS tools (`supportsMcp: false`): "This agent's runtime can't use DorkOS tools, so these settings don't change anything for it."

### Remove (no leftovers; knip-clean)

- `ManageRoomsCard` (`features/agent-settings/ui/ToolsTab.tsx:183-257`) and its use of `useToolNamesForGroup('roomsManage')` (`mcp-tool-groups.ts:118` entry for rooms).
- Settings' "Granted per agent" Manage rooms info card (`features/settings/ui/ToolsTab.tsx:182-211`).
- The agent ToolsTab's `ToolGroupRow` writes must no longer send `roomsManage` (the mesh PATCH refuses it now): build the patch from the four remaining keys only (`ToolsTab.tsx:369-396`).
  Grep `apps/e2e` for the removed copy ("Manage rooms", "Granted per agent") and update specs (browser specs assert literal strings; UI-copy breaks surface queue-only).

### Tests (RTL, mock Transport)

- `PermissionRow`: source text, reset writes `null`, floor offers two states;
- `ApplyToOverridesDialog`: nothing pre-checked, floor never pre-selected, effect count, "Update selected" sends the chosen ids;
- `ExceptionsChip`: count and per-agent Reset;
- Settings deep link `?settings=permissions` opens the tab (update `apps/e2e/tests/dialog-deep-link.spec.ts:5-26` if it enumerates tabs).

### Acceptance criteria

- [ ] Changing the Rooms default while agents differ opens the dialog with nothing checked; the write produces one `permission.changed` naming each agent touched.
- [ ] The agent's Permissions page shows "Same as everyone (Allowed)" on a Full-power install and a dot + Reset after an override.
- [ ] Works at 1440px and 390px widths.

### Task 1.13: Phase 1 verification: tests, e2e for DorkBot create_room, browser check, docs, changelog, knip

- **Subject:** `[agent-permissions] [P1] Phase 1 verification: tests, e2e for DorkBot create_room, browser check, docs, changelog, knip`
- **Size:** medium · **Priority:** high
- **Depends on:** 1.4, 1.5, 1.8, 1.9, 1.10, 1.12
- **Parallel with:** —

Close phase 1 as one shippable PR with no half-migrated state.

### E2E (`apps/e2e`, test-mode runtime; `browser-testing` skill)

New spec for the session `e687427b` scenario: an install with `ui.fullPowerChoice: 'full'` (so `permissions.preset: 'full'`) -> a DorkBot scenario calls `create_room` -> the room exists, no settings trip, no `tool_group_disabled`. Second scenario: set Rooms to Ask for DorkBot on its Permissions page -> `create_room` raises the existing approval card inline -> Allow -> the room exists and the turn finishes without a second message. Third: Settings -> Permissions, change the Rooms default while one agent differs -> the apply dialog shows it unchecked. Update existing specs that break (`full-power-door.spec.ts`, `onboarding-power.spec.ts`, `dialog-deep-link.spec.ts`, any spec asserting "Manage rooms" copy). Run long suites detached; rerun a failing file at `--workers=1` before believing a red.

### Targeted checks

```bash
pnpm --filter @dorkos/shared build
pnpm vitest run packages/shared/src/permissions packages/shared/src/__tests__
pnpm vitest run apps/server/src/services/core apps/server/src/services/rooms apps/server/src/services/runtimes apps/server/src/services/activity apps/server/src/routes
pnpm vitest run apps/client/src/layers/features/permissions apps/client/src/layers/entities/permissions apps/client/src/layers/features/settings apps/client/src/layers/features/profile apps/client/src/layers/features/full-power-door apps/client/src/layers/features/agent-settings
pnpm vitest run packages/test-utils
for p in @dorkos/shared @dorkos/server @dorkos/client @dorkos/db @dorkos/test-utils; do pnpm --filter $p typecheck && pnpm --filter $p lint; done
pnpm verify
pnpm knip   # after building dists; tool-group-enforcement, tool-group-grants, ManageRoomsCard leave nothing behind
```

Also: `gate-bypass-scan.test.ts` pins three callers; `migration-safety` and the merged-migration-hash pin pass; OpenAPI regenerated (`docs/api/openapi.json`) matches; vocab gate and banned-words gate clean (`scripts/check-vocab-gate.ts`, `scripts/check-banned-words.sh`: never "integration/connector/adapter/provider" in UI copy).

### Real browser check

Drive the running app (Vite dev on the worktree's alt ports) at **1440px and 390px**: Settings -> Permissions (Rooms row, preset read-only, history, accounts link), the exceptions chip, the apply dialog (bottom sheet on mobile), the agent Permissions page, the Rooms Ask card in chat. Screenshot evidence for the PR.

### Docs

- New `docs/guides/permissions.mdx` (writing-for-humans): presets, areas, the three states, the floor, Rooms, history; "Blocked stops an agent that plays by the rules; it isn't a sandbox"; login-off honesty ("Someone on this computer"). Register it in the docs nav and `contributing/INDEX.md` if docs coverage requires.
- `docs/getting-started/configuration.mdx`: the `permissions` section.
- `contributing/configuration.md`: the new section and its migration.
- `contributing/agent-operator-surface.md`: the gate at three choke points, the person bars, the login-off residual (an agent set stricter than the default that strips its token gets the default).

### Changelog

One fragment `changelog/unreleased/<id>-agent-permissions-rooms.md` (id from `.claude/scripts/id.ts`; valid `covers:` block; run `prettier --write` on it): user-facing, e.g. "On Full power, your agents can now make and manage rooms without a trip to Settings. A new Permissions page shows what agents may do, and which ones are set differently." Mention that agents can now archive rooms.

### ADRs

If the ADR step produced the new ADR for the permission model, mark ADR `260828-123331` superseded in its frontmatter and `decisions/manifest.json`.

### Acceptance criteria (phase 1)

- [ ] On an upgraded install with `ui.fullPowerChoice: 'full'`, DorkBot's `create_room` runs with no settings change (unit test + e2e), and the same holds for a fresh install that accepts Full power at the door.
- [ ] `roomsManage: true` agents keep rooms after upgrade; `roomsManage: false` is Blocked; an install with no door answer is unchanged (including `rooms.merge`).
- [ ] Setting Rooms to Ask for one agent makes its next `create_room` raise a card and, on Allow, finish in the same turn.
- [ ] Changing the Rooms default while agents differ opens the dialog with nothing checked; one `permission.changed` names each agent touched.
- [ ] An agent calling `PATCH /api/agents/:id/permissions` with its header, or `PATCH /api/mesh/agents/:id` with `permissions`, is refused.
- [ ] knip clean; no retired symbol remains.

---

## Phase 2 — The request card (7 tasks)

### Task 2.1: Replace the standing-grant answer with answer: once | always on the grant route, and audit every answer

- **Subject:** `[agent-permissions] [P2] Replace the standing-grant answer with answer: once | always on the grant route, and audit every answer`
- **Size:** large · **Priority:** high
- **Depends on:** 1.13
- **Parallel with:** 2.3, 2.4

Give every approval three answers: Allow (once), Always allow (this action, this agent), Deny, and record each answer.

### Route: `POST /api/approvals/:id/grant` (`apps/server/src/routes/approvals.ts:434-547`)

- Body `{ standing?: true }` becomes `{ answer: 'once' | 'always' }`, default `'once'` (Zod schema in shared; regenerate and commit `docs/api/openapi.json`).
- Both decision bars stay exactly as they are: `resolveDecisionAuthority` (`services/core/approvals/decision-authority.ts:157`) and `requirePersonToDecide` -> `requireOperatorCookieUnderLogin` (`lib/caller-authority.ts:224`).
- `'always'` is refused server-side with **409 `ALWAYS_NOT_OFFERED`** when the approval has no `requestedByPath` (unidentified requester), the action has no area, or the area is a floor area (`isFloorArea`). Hiding the button in the UI is not the check.
- On `'always'`: grant the approval **and** write `agent.permissions.actions[actionId] = 'allowed'` through the permission service (`permission-service.ts`, `setAgent`, `surface: 'request-card'`, `approvalId`) in one step, **before** the verdict fans out, so the resumed call and the new setting agree. That write emits its own `permission.changed`.
- The pending-approval DTO gains `alwaysOffered: boolean` (computed with the same three rules) and `area: PermissionAreaId | null`, so the client does not re-derive the rule.

### Answer audit

Replace the route's `approval.granted` / `approval.denied` Activity lines (`approvals.ts:319-333`) with one `permission.answered` event per answer in the `permissions` category:
`{ agentId?, agentPath?, action, area | null, answer: 'once' | 'always' | 'deny', approvalId, blockedRequest: boolean, posture }`, actor label per the honesty rule (login off: "Someone on this computer"). The feed renderer keeps reading the two old event types so existing history still renders; add a renderer for `permission.answered` ("You allowed DorkBot to create #proj-x once" / login off: "Someone on this computer allowed …").

### Tests

- `'once'` grants; `'always'` grants and writes the action override (manifest file shows it) with one `permission.answered` + one `permission.changed`;
- 409 on a floor area, on a no-area action, and on an approval without `requestedByPath`;
- deny produces exactly one `permission.answered` with `answer: 'deny'`;
- an agent-header caller still cannot decide (both bars unchanged);
- the verdict fan-out happens after the override write (order test).

### Acceptance criteria

- [ ] Every answer produces exactly one `permission.answered` event.
- [ ] `answer: 'always'` on a floor-area approval returns 409.
- [ ] `pnpm vitest run apps/server/src/routes/__tests__/approvals* apps/server/src/services/core/approvals` passes.

### Task 2.2: Give ApprovalCard the three answers: Allow, Always allow, Deny

- **Subject:** `[agent-permissions] [P2] Give ApprovalCard the three answers: Allow, Always allow, Deny`
- **Size:** medium · **Priority:** high
- **Depends on:** 2.1
- **Parallel with:** 2.5

The request card **is** the existing `ApprovalCard` (`apps/client/src/layers/features/approvals/ui/ApprovalCard.tsx:95`), extended, not a second component.

### Buttons

Today: Don't allow / Allow / "Allow, and stop asking about this for {window}" (standing grant, `:287-353`, `:338-368`). New, in this order: **Allow · Always allow · Deny**.

- **Allow**: `answer: 'once'`.
- **Always allow**: `answer: 'always'`; visually secondary to Allow so the one-time answer is the easy one. Shown only when the approval's `alwaysOffered` is true.
- On a floor-area approval, one line replaces the button: "Always allow isn't offered here. Changing this needs your yes every time."
- **Deny**.

Remove the "stop asking for {window}" button and all trust-window copy from the card (the server path is retired in task 2.7).

### Headline and collapse

Headline follows the action using the summary `describeGatedAttempt` already builds (`tier-enforcement.ts:753`): "**DorkBot wants to create #proj-lunar-metamorphosis** with you, @lifeos, @meeting-notes". A card from a blocked request (task 2.3 marks it `blockedRequest: true` with a `reason`) adds: "DorkBot is blocked from Rooms and is asking to be allowed. It says: …". After a yes the card collapses to one line: "Allowed once" / "Always allowed for DorkBot: create rooms".

### Everywhere it appears

The card renders inline in chat (`features/chat/ui/message/AssistantMessageContent.tsx:224-244`), the inbox (`InboxBell.tsx:405`), home (`PinnedTriageHeaderView.tsx:507`) and mobile (`MobileNowAttention.tsx:131`); all get the new buttons through the one component. Mobile: buttons stack vertically, Allow first, 44px targets.

### Tests (RTL)

- three answers call the grant with `once` / `always` / deny;
- `alwaysOffered: false` hides Always allow; floor variant shows the explanation line;
- collapse text after each answer;
- blocked-request card shows the reason line.
  Grep `apps/e2e` for "stop asking" / "Don't allow" and update specs.

### Acceptance criteria

- [ ] A floor-area card shows only Allow and Deny plus the explanation line.
- [ ] `pnpm vitest run apps/client/src/layers/features/approvals` passes.

### Task 2.3: Add permissions.request_access (request_permission) and permissions.list, with rate limits and the full context line

- **Subject:** `[agent-permissions] [P2] Add permissions.request_access (request_permission) and permissions.list, with rate limits and the full context line`
- **Size:** xl · **Priority:** high
- **Depends on:** 1.13
- **Parallel with:** 2.1, 2.4

A Blocked action is not in the agent's tool list, so the agent asks for it with a dedicated tool. The person approves exactly the call that will run.

### New capability domain `permissions`: `apps/server/src/services/core/permissions-capabilities.ts`

Register it in the registry composition (`dorkos-registry.ts`) like other domains.

**`permissions.request_access`**, MCP name `request_permission`, tier `act`, `area: null` with `areaNote: 'the way to ask past Blocked'`:

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

Use `catchall`, **not** `z.record`: a record in an in-session tool schema empties `tools/list` on claude-agent-sdk >=0.3.257 with zod >=4.5.3 (`runtimes/claude-code/mcp-tools/tool-exposure.ts`).

Handler:

1. Refuse unidentified callers (no agent to scope the request or rate limit to).
2. Resolve `action` among the actions this surface can run: registry capabilities everywhere (accept the capability id or its MCP name); hand-registered tools on the two surfaces that build them (claude-code in-session server and external `/mcp`), via the private map of hidden gated handlers built in task 1.9.
3. Validate `arguments` against that action's own input schema (400-style refusal on mismatch, naming the problem).
4. Rate limits, enforced **before** any approval is minted, keyed on the calling agent's path:
   - at most one pending blocked request per agent per area: a second returns the first's `awaiting_decision` payload (no second card);
   - after a Deny, the same agent asking for the same action within 24 hours -> refused `reason: 'recently_denied'`, `approvable: false`, no card;
   - at most 5 blocked requests per agent per hour across all areas.
     Keep the state in the approvals store (query pending/denied approvals with `blockedRequest: true`) rather than in memory, so a restart cannot reset it.
5. Invoke the target with `blockedRequest: true` and the `reason`. In the gate (`tier-enforcement.ts`), a Blocked state with `blockedRequest: true` mints an approval **bound to the target action and the hash of those exact arguments** (ADR `260725-133221`: the person approves exactly what will run) instead of refusing; the approval records `blockedRequest: true` and `reason`. The approval-required refusal propagates out of `request_access`, so the existing hold (`capability-approval-hold.ts`) holds `request_access`; on a grant it is re-invoked with the token, forwards it to the target, the gate consumes it for that binding (Blocked + a matching token -> allowed), and the target's real result comes back in the same turn.

### Gate and message changes

- `permission_blocked` refusals become `approvable: !inactive` (inactive identities stay not approvable, no card).
- Direct-call refusal message: "Rooms is blocked for this agent. You can ask the person with the tool ending in `request_permission`: name the action, pass the exact arguments, and say why." No card from a direct call.
- The context line (rendered in `runtimes/shared/`) becomes: "Rooms is blocked for you. If you need it, ask with the tool ending in `request_permission`, and say why." (substitute each Blocked area's label).

**`permissions.list`**, tier `observe`, `area: null` (`areaNote: 'an agent may read its own permissions'`): returns the calling agent's resolved state per area and per action it can see, with source. No input records.

### Tool-count guards

Each new capability trips the claude-code tool-count guards on purpose: update both guards, decide always-loaded (recommend `request_permission` always-loaded, since a Blocked agent must find it) vs deferred (`permissions.list`), and run `tool-exposure.test.ts` and all `services/runtimes/` tests. `approvalDisplayFields` for `request_access`: `['action', 'reason']`.

### Tests

- binding: a changed argument does not consume the token;
- resumes in the same turn through the hold (claude-code) and via late-verdict wake on Codex/OpenCode;
- all three rate limits; unidentified callers refused;
- direct call to a Blocked action: refused, message names the tool, no approval minted;
- an inactive identity gets `approvable: false` and no card;
- `permissions.list` returns the right states and sources.

### Acceptance criteria

- [ ] A Blocked agent asks with `request_permission`, the person taps Always allow, the original call runs in the same turn, and the tool is in the agent's list on its next turn.
- [ ] A second blocked request for the same area while one is pending creates no second card; a request after a Deny within 24 hours is refused without a card.

### Task 2.4: Stop unattended turns from holding on an approval

- **Subject:** `[agent-permissions] [P2] Stop unattended turns from holding on an approval`
- **Size:** small · **Priority:** medium
- **Depends on:** 1.13
- **Parallel with:** 2.1, 2.3

Now that `act` actions can ask, a scheduled run, relay binding or connector event must not sit in a ten-minute hold nobody is watching.

For origins whose policy is `none` in `apps/server/src/services/session/origin/turn-origin.ts:160-199` (scheduled task runs, relay bindings, connector events), the in-session hold (`capabilities/capability-approval-hold.ts`, cap `CAPABILITY_APPROVAL_HOLD_CAP_MS` at `:105`) and the hand-registered tool hold (`mcp-tool-gate.ts`, DOR-1930) return `approval_required` at once instead of holding. The card still goes to the inbox (`approval.pending` notification), and late-verdict delivery (`approvals/approval-verdict-delivery.ts:153-249`, ADR `260909-123910`) wakes the session when a person answers, because the approval records a `requestingSession`.

Thread the origin to the hold decision from the session's turn context; do not re-derive it from session ids.

### Tests

- a scheduled-run turn hitting an Ask-state action returns `approval_required` immediately (fake timers: no ten-minute wait) and the approval exists with `requestingSession`;
- granting it wakes the session with an `approval_verdict` block;
- an interactive turn still holds.

### Acceptance criteria

- [ ] `pnpm vitest run apps/server/src/services/core/capabilities apps/server/src/services/session` passes.

### Task 2.5: Show the request card inside the room whose turn raised it

- **Subject:** `[agent-permissions] [P2] Show the request card inside the room whose turn raised it`
- **Size:** medium · **Priority:** medium
- **Depends on:** 2.2
- **Parallel with:** 2.6

Today no approval card appears in rooms (`apps/client/src/layers/widgets/room-view` has none), and a room is exactly where Rooms requests come from.

- Server: an approval raised by a room turn is linked to its room through the room-session binding (`room_sessions`). Expose `roomId` on the pending-approval DTO (and on the `approval_pending` broadcast) when the requesting session is bound to a room. Note that room-turn sessions may carry placeholder ids in `room_sessions`: resolve through the binding the room-turn runner (`rooms/room-turn-runner.ts`) records, and test with a real room turn.
- Client: `widgets/room-view` renders the same `ApprovalCard` (from `features/approvals`, cross-feature UI composition is allowed in a widget) in the room timeline, **to the install's owner only** (not to other room members or remote community participants). Position it at the point in the timeline where the turn raised it; it collapses like everywhere else after an answer.
- The card still appears in the inbox and home as before.

### Tests

- a room turn raising a Rooms Ask approval renders the card in that room's timeline for the owner;
- it does not render for a non-owner view;
- answering in the room resolves it everywhere.

### Acceptance criteria

- [ ] Works at 1440px and 390px; `pnpm vitest run apps/client/src/layers/widgets/room-view` passes.

### Task 2.6: Retire standing grants: table, service, config keys, routes, UI, with a config migration and upgrade events

- **Subject:** `[agent-permissions] [P2] Retire standing grants: table, service, config keys, routes, UI, with a config migration and upgrade events`
- **Size:** large · **Priority:** high
- **Depends on:** 2.1
- **Parallel with:** 2.5

Always allow replaces standing grants (login-only, time-boxed). Remove the whole mechanism; leave no second path.

### Remove (server)

- `approval_grants` table (`packages/db/src/schema/approval-grants.ts:45`): Drizzle migration dropping it (generate with drizzle-kit; mind stacked-PR migration numbering).
- `ApprovalGrantService`, `standing-grant-posture.ts`, `standing-grant-settings.ts` in `apps/server/src/services/core/approvals/`.
- `resolveStandingGrant`, `StandingGrantLookup` and the standing-grant branch in `tier-enforcement.ts` (`:902`, `:1028`), and the `{ via: 'standing-grant'; grantId }` variant of `GrantedApproval`.
- `GET/DELETE /api/approvals/grants` (`routes/approvals.ts:375-409`); regenerate OpenAPI.
- `REQUIRES_LOGIN_CONFIG_PATHS` and the `approvals.*` entries in `CONFIG_WRITE_POLICY` (`config-write-policy.ts:1189`).
- `approvals.*` in `UserConfigSchema` (`packages/shared/src/config-schema.ts:2741-2794`), both declarations.

### Config migration

Delete `approvals.standingGrants`, `approvals.trustWindowMinutes`, `approvals.standingGrantsVoidBefore`, and `approvals` when empty. Key: the next key that ships in this phase's release. **If phase 1's key has not been released yet when this lands, extend that same unreleased key's body and re-pin its hash instead of opening a higher key**: a key above the release version never runs for upgraders (see the `'0.71.0'`/`'0.80.0'` notes in `config-manager.ts:3835-3890`). Add the three keys to the removed-keys tolerance the migration-safety guard expects (the `tolerateRetired…Keys` pattern), and pin the hash in `merged-migration-hashes.ts`. Tests read `config.json` from disk.

### End live grants at upgrade

Live standing grants are ended, not converted (they are time-boxed windows; converting them to permanent Always allow would widen what someone agreed to). Add a step to the boot sweep (`permission-upgrade-sweep.ts`) that, before the table is dropped (order the Drizzle migration and the sweep so the sweep can read the rows, or read them in the migration step and hand them to the sweep), emits one `upgrade` `permission.changed`-style event per live grant (actor "Upgrade", naming the agent and action, `after: null`). If the drop must run first, record the grants from the Drizzle migration into a one-shot JSON under the dork home and have the sweep read and delete it. Choose the simpler that is testable; document the choice in the module doc.

### Remove (client)

- The Control Center "Standing permissions" switch (`widgets/control-center/ui/ControlCenterSwitches.tsx:94-106`).
- `FullPowerDoor.tsx:144-179`: accept no longer writes `approvals.standingGrants: true`; delete the `loginOn` branch and its doc comment (`:93-113`).
- Any client hook/transport method for the grants routes; the card's trust-window copy (already removed in 2.2).
  Grep `apps/e2e` and capture shots (`control-center`, `full-power-door`) for "Standing permissions" and update.

### Tests

- migration from disk removes the three keys; hash pinned; migration-safety passes;
- sweep emits one `upgrade` event per live grant, idempotent;
- the gate no longer consults grants (a destructive Ask asks every time unless an action-level Allowed exists);
- knip finds nothing left of the grant code.

### Acceptance criteria

- [ ] `grep -rn "standingGrant\|approval_grants\|ApprovalGrantService\|trustWindowMinutes" apps packages` returns only the migration, the removed-keys list and changelog history.

### Task 2.7: Phase 2 verification: request-card e2e, browser check, docs, changelog, knip

- **Subject:** `[agent-permissions] [P2] Phase 2 verification: request-card e2e, browser check, docs, changelog, knip`
- **Size:** medium · **Priority:** high
- **Depends on:** 2.2, 2.3, 2.4, 2.5, 2.6
- **Parallel with:** —

Close phase 2 as one shippable PR.

### E2E (`apps/e2e`, test-mode runtime)

- Rooms at Ask -> the scenario calls `rooms.create` -> the card appears inline -> **Allow** -> the room exists and the turn finishes without a second message.
- **Always allow** -> a second `rooms.create` runs with no card, and the agent's Permissions page shows the override ("Rooms: Ask, except create rooms: Allowed").
- Rooms Blocked -> the scenario calls `request_permission` -> a card with the reason line -> Always allow -> the original call runs in the same turn.
- Floor-area card shows Allow and Deny only (seed a floor-area Ask approval through a test hook if no floor action is agent-reachable yet in phase 2).
- Update `control-center.spec.ts` and `full-power-door.spec.ts` for the removed Standing permissions switch.

### Targeted checks

```bash
pnpm vitest run apps/server/src/services/core apps/server/src/routes apps/server/src/services/runtimes apps/server/src/services/session apps/server/src/services/rooms
pnpm vitest run apps/client/src/layers/features/approvals apps/client/src/layers/widgets/room-view apps/client/src/layers/widgets/control-center apps/client/src/layers/features/full-power-door
for p in @dorkos/shared @dorkos/server @dorkos/client @dorkos/db; do pnpm --filter $p typecheck && pnpm --filter $p lint; done
pnpm verify && pnpm knip
```

Plus tool-count guards + `tool-exposure.test.ts`; migration-safety + hash pin; OpenAPI regenerated and committed; vocab + banned-words gates.

### Real browser check at 1440px and 390px

The inline card (three answers, collapse), the floor variant, the room-timeline card, the inbox card, the Control Center without the Standing permissions switch. Screenshots on the PR.

### Docs

- `docs/guides/action-approvals.mdx`: Always allow replaces standing permissions; `act` actions can now ask; asking past Blocked with `request_permission`; rate limits in plain words.
- `docs/guides/permissions.mdx`: the request card, the three answers, the floor line.
- `docs/getting-started/configuration.mdx`: `approvals.*` removed.

### Changelog

Fragment `changelog/unreleased/<id>-agent-permissions-request-card.md`: "When an agent needs more, it asks right in the chat or the room, and Always allow remembers your answer for that agent and that action. The old 'stop asking for a while' option is gone; any open windows ended when you upgraded."

### Acceptance criteria (phase 2)

- [ ] A Blocked agent asks with `request_permission`, the person taps Always allow, the original call runs in the same turn, and the tool is in the agent's list on its next turn.
- [ ] A floor-area card shows only Allow and Deny, and `answer: 'always'` on it returns 409.
- [ ] A second blocked request for the same area while one is pending creates no second card; a request after a Deny within 24 hours is refused without a card.
- [ ] Every answer produces exactly one `permission.answered` event.

---

## Phase 3 — Every area, presets, first run, Control Center; retire the tier ceiling and context switches (10 tasks)

### Task 3.1: Assign the final area to every capability and MCP tool and tighten the census

- **Subject:** `[agent-permissions] [P3] Assign the final area to every capability and MCP tool and tighten the census`
- **Size:** large · **Priority:** high
- **Depends on:** 2.7
- **Parallel with:** 3.2, 3.4

Replace every phase-1 placeholder `areaNote: 'Area assigned in agent-permissions phase 3'` with the final area. Tiers come from each definition.

### Registry capabilities

| Capability id                                                                                                        | Tier        | Area                                                |
| -------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| `rooms.create/add_members/remove_members/update/leave/archive/merge`                                                 | act         | `rooms` (already)                                   |
| `rooms.post`, `rooms.react`                                                                                          | act         | none: "conversation verbs never get a switch"       |
| `rooms.repo_status/read_history/search_history/list_member_rooms/search_member_rooms/get_room/find_room/read_canvas` | observe     | none: reading                                       |
| `operator.update_agent` (`operator-capabilities.ts:375`)                                                             | act         | `agents` (static, self-edits included)              |
| `operator.sidebar_add_to_group`, `operator.sidebar_remove_from_group`                                                | act         | `agents`                                            |
| `operator.update_agent_boundaries` (`:513`)                                                                          | destructive | `safety`                                            |
| `operator.config_patch` (`:572`)                                                                                     | act         | `settings` (escalates by input, task 3.2)           |
| `operator.activity_list/config_get/check_update/agents_recent_activity/feedback_draft`                               | observe     | none                                                |
| `marketplace.install`, `marketplace.create_package`                                                                  | act         | `packages`                                          |
| `marketplace.uninstall`                                                                                              | destructive | `packages`                                          |
| `marketplace.search/get/list_marketplaces/list_installed/recommend`                                                  | observe     | none                                                |
| `mcp.add`, `mcp.import`, `mcp.update`                                                                                | destructive | `packages`                                          |
| `mcp.remove/enable/disable/test/signin/set_client`                                                                   | act         | `packages`                                          |
| `mcp.poll_signin`                                                                                                    | act         | none: only continues a sign-in `mcp.signin` started |
| `mcp.list`, `mcp.browser_preset`                                                                                     | observe     | none                                                |
| `memory.write`                                                                                                       | act         | none: own memory                                    |
| `ui.control/screenshot/click/type/press/scroll/record_start/record_stop`                                             | act         | none: own window seat                               |
| `ui.state/read_canvas_document/read_console/read_network/wait_for/read_page`                                         | observe     | none                                                |
| `capabilities.list`                                                                                                  | observe     | none                                                |
| `connector.*`, `connectors.*` (all, incl. `execute_destructive`)                                                     | varies      | none: connected accounts have their own grant model |
| `permissions.list`, `permissions.request_access`                                                                     | observe/act | none                                                |
| `permissions.change` (task 3.3)                                                                                      | act         | `permissions`                                       |

### Hand-registered MCP tools (`mcp-tool-tiers.ts:125`)

| Tools                                                                                                                                                                                                               | Area             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ping`, `get_server_info`, `get_session_count`, `get_agent`, `get_extension_api`, `list_extensions`, `get_extension_errors`                                                                                         | none (always on) |
| `tasks_list`, `tasks_get_run_history`, `tasks_create`, `tasks_update`, `tasks_delete` (destructive)                                                                                                                 | `tasks`          |
| `relay_send`, `relay_send_and_wait`, `relay_send_async`, `relay_inbox`, `relay_list_endpoints`, `relay_register_endpoint`, `relay_unregister_endpoint`, `relay_get_trace`, `relay_get_metrics`, `relay_notify_user` | `messages`       |
| `relay_list_adapters`, `relay_enable_adapter`, `relay_disable_adapter`, `relay_reload_adapters`, `binding_list`, `binding_create`, `binding_delete`, `binding_list_sessions`                                        | `connections`    |
| `mesh_list`, `mesh_status`, `mesh_inspect`, `mesh_query_topology`, `mesh_discover`, `mesh_register`, `mesh_deny`, `mesh_unregister` (destructive), `create_agent`                                                   | `agents`         |
| `create_extension`, `reload_extensions`, `test_extension`                                                                                                                                                           | `packages`       |

Reads inside an area (`tasks_list`, `mesh_list`, …) are hidden and refused when the area is Blocked; they never ask (an `observe` action runs in an Ask area).

### Card fields

Every action that now has an area needs `approvalDisplayFields` (hand-registered tools declare card fields in the tier table), and `approvalSubject` where the target is an opaque id (DOR-1929). No secret-named display field (`config_patch` shows the changed paths, never values of secret paths).

### Census (`permission-area-census.test.ts`)

Widen "every non-`files` area has at least one member" to all ten areas; add "no action carries the phase-3 placeholder note"; keep the other assertions.

### Acceptance criteria

- [ ] The census passes with no `areaNote` left for an action that has an area in the tables above.
- [ ] Conformance and `mcp-tool-gate.test.ts` pass with display fields on every area action.

### Task 3.2: Escalate operator.config_patch by input and let an approved change write through PERSON_APPROVED_AUTHORITY

- **Subject:** `[agent-permissions] [P3] Escalate operator.config_patch by input and let an approved change write through PERSON_APPROVED_AUTHORITY`
- **Size:** large · **Priority:** high
- **Depends on:** 3.1
- **Parallel with:** 3.3, 3.4

`operator.config_patch` sits in DorkOS settings, but a patch touching a guarded path must ask in the stricter area.

### Input escalation

- `GatedAction` gains optional `areaForInput?(input): PermissionAreaId | null`, which may only return an area at least as strict as the static one (assert it in the gate: define strictness as floor areas > non-floor; a less strict return is ignored and logged). `resolveCallPermission` (`capabilities/permission-enforcement.ts`) uses it when present.
- `config_patch` implements it: a patch touching any path whose `CONFIG_WRITE_POLICY` entry (`services/core/operator/config-write-policy.ts:233`) is `operator-only` resolves in that entry's area (if several, the strictest; ties -> `permissions` > `reach` > `safety`).
- Every `operator-only` entry gains an `area: 'safety' | 'reach' | 'permissions'` column:
  - rooms/relay limits and concurrency -> `safety`;
  - `auth`, `tunnel`, MCP endpoint and key, credentials, `server.boundary`, data directories -> `reach`;
  - the four `defaultTrustStop` leaves and the consent stamps `ui.autonomyAcknowledgedAt`, `ui.fullPowerDecidedAt`, `ui.fullPowerChoice` -> `permissions`;
  - `permissions` itself -> `permissions` (and it stays unwritable through `config_patch` at all: `USE_PERMISSIONS_API`);
  - `agentContext` is retired in task 3.5 (drop its entry there).
- New census test: every `operator-only` entry has an area.

### Person-approved write

When a person approves such a call, the handler reads `context.approval` (already threaded, `registry.ts:591`) and writes through a new `PERSON_APPROVED_AUTHORITY` beside `OPERATOR_TOOL_AUTHORITY` (`services/core/operator/config-write.ts:190-199`) that clears the operator bar. Standing rule (`trusted-caller.ts` module doc): whoever may decide an approval may make the change, so an approved change removes no guarantee. Without an approval, `operator-only` paths stay refused for agents exactly as today. The autonomy consent door (`approvals/autonomy-consent.ts:75`, 428 `AUTONOMY_ACK_REQUIRED`) still applies to a trust-stop move to `autonomy`.

### Tests

- an agent's `config_patch` touching `tunnel` raises a card in Reach & secrets with no Always allow (`alwaysOffered: false`); Allow applies it via `PERSON_APPROVED_AUTHORITY`;
- a patch touching only ordinary paths resolves in `settings`;
- a mixed patch resolves in the strictest area;
- `areaForInput` returning a looser area is ignored;
- without an approval an agent still cannot write an `operator-only` path.

### Acceptance criteria

- [ ] An agent's `config_patch` touching `tunnel` raises a card in Reach & secrets with no Always allow; Allow applies it.

### Task 3.3: Add permissions.change: an agent asking to change a permission, always a person's yes

- **Subject:** `[agent-permissions] [P3] Add permissions.change: an agent asking to change a permission, always a person's yes`
- **Size:** medium · **Priority:** medium
- **Depends on:** 3.1
- **Parallel with:** 3.2, 3.4

Let an agent ask to change a permission for itself, another agent or everyone. Because it sits in a floor area it can never be Allowed, so every call is a person's decision.

In `apps/server/src/services/core/permissions-capabilities.ts`: `permissions.change`, tier `act`, `area: 'permissions'` (floor), MCP name `change_permission`. Input, explicit fields and **no records** (in-session schema rule):

```ts
{
  target: z.union([z.literal('everyone'), z.string().min(1)]).describe("'everyone' or an agent id"),
  area: PermissionAreaIdSchema.optional(),
  action: z.string().optional(),
  state: z.enum(['blocked', 'ask', 'allowed', 'default']),
}
```

Exactly one of `area`/`action` is required (refine). `'default'` removes the override. `approvalDisplayFields: ['target', 'area', 'action', 'state']`, `approvalSubject` for the agent target. On an approved call the handler writes through the permission service with `surface: 'agent-request'`, `attribution: 'agent-request-approved'`, `approvalId`; actor label "DorkBot asked, you said yes". Floor Allowed is still refused by the service (400 `FLOOR_NEVER_ALLOWED`, surfaced to the agent as a plain message).

Update the claude-code tool-count guards (decide deferred), run `tool-exposure.test.ts` and `services/runtimes/` tests.

### Tests

- every call asks (never runs without approval, even with a stored Allowed attempt, which the write path refuses anyway);
- Always allow is not offered (409 on `'always'`);
- approved call writes the change and one `permission.changed` with `agent-request-approved`;
- setting a floor area to Allowed is refused after approval with a clear message.

### Acceptance criteria

- [ ] `pnpm vitest run apps/server/src/services/core/permissions apps/server/src/services/runtimes` passes.

### Task 3.4: Retire the tier ceiling everywhere and fold tierCeiling and the four tool-group keys into permissions

- **Subject:** `[agent-permissions] [P3] Retire the tier ceiling everywhere and fold tierCeiling and the four tool-group keys into permissions`
- **Size:** xl · **Priority:** high
- **Depends on:** 3.1
- **Parallel with:** 3.2, 3.3

Remove the per-agent tier ceiling and the four documentation keys of `enabledToolGroups`, folding their meaning into per-agent area states.

### Read-time fold (extend the `z.preprocess` on `AgentManifestSchema` from phase 1; per key, never gated on `permissions` being absent; an explicitly set area wins)

- `enabledToolGroups.tasks/relay/mesh/adapter`: `true` -> `areas.{tasks, messages, agents, connections} = 'allowed'`; `false` -> `'blocked'`; absent -> nothing.
- `tierCeiling: 'observe'` -> every non-`files` area `'blocked'` (all ten); `'act'` -> nothing (destructive actions ask by the destructive rule); `'destructive'` or absent -> nothing.
- Then drop `enabledToolGroups` and `tierCeiling`.

Known residual (accepted at SPECIFY): blocking every area does not stop `rooms.post`, `rooms.react`, `memory.write` or the `ui.*` window-seat verbs (no area by design). The sweep's upgrade event and the changelog name the affected agents.

### Boot sweep step (`permission-upgrade-sweep.ts`)

For every agent whose file still carries `tierCeiling` or any `enabledToolGroups` key: write back the folded manifest through `MeshCore.update`, one `permission.changed` per agent (actor Upgrade). For `tierCeiling: 'observe'` agents, include a note in the event metadata that conversation verbs remain.

### Remove (no shim)

- Schema: `tierCeiling` (`packages/shared/src/mesh-schemas.ts:571-575`), `enabledToolGroups` and `EnabledToolGroups`; remove `enabledToolGroups` and `tierCeiling` from `UpdateAgentRequestSchema`'s `.pick()` (`:826-870`) and `tierCeiling` from `AgentManifestUpdate` (`:632, :648`). `PATCH /api/mesh/agents/:id` now refuses both keys (400).
- `AGENT_WRITE_POLICY`: delete the `tighten-only` class (its only member was `tierCeiling`, `agent-write-policy.ts:221`) and its per-field comparison (`agent-updater.ts:311-343`).
- DB: Drizzle migration dropping `agent_tokens.tier_ceiling` (`packages/db/src/schema/agent-identity.ts:50`).
- Identity: `tierCeiling` on `AgentIdentity` and its stamping (`agent-identity-service.ts:105-328`, `agent-token-env.ts:110-166`).
- Gate: `effectiveCeiling`, `DEFAULT_ANONYMOUS_TIER_CEILING`, `REVOKED_TIER_CEILING`, `CEILING_PHRASE`, `anonymousTierCeiling` (`tier-enforcement.ts:579-697`) and the `tier_ceiling` `TierDeniedReason`. Their intent is carried by the resolver's `inactive` rule and the defaults-only rule for unidentified callers; move the honest residual wording from `DEFAULT_ANONYMOUS_TIER_CEILING`'s doc into `permission-enforcement.ts`'s module doc (an agent set stricter than the default that strips its token gets the default; login closes it).
- Audit metadata swaps `tierCeiling` for `permission: { state, source }` only.
- CLI: `dorkos agent update --ceiling` (`packages/cli/src/commands/agent.ts:288-372`).
- Client: `TierCeilingCard` (`features/agent-settings/ui/ToolsTab.tsx:279-338`).

### Tests

- fold matrix: every legacy combination, including `tierCeiling: 'observe'`/`'act'`, `enabledToolGroups.relay: false`, a manifest with phase-1 `permissions.areas.rooms` plus legacy `tierCeiling: 'observe'` (rooms keeps its explicit value; others blocked);
- sweep: one upgrade event per changed agent, idempotent;
- gate: a revoked identity is Blocked, not approvable; an unidentified caller resolves on defaults;
- mesh PATCH refuses `tierCeiling` and `enabledToolGroups`.

### Acceptance criteria

- [ ] `tierCeiling: 'observe'` agents come out Blocked on every area, each with one `upgrade` event.
- [ ] `grep -rn "tierCeiling\|tier_ceiling\|effectiveCeiling\|TierCeilingCard\|--ceiling" apps packages` returns only migrations and the preprocess.

### Task 3.5: Retire agentContext and the tool-group documentation switches; Blocked hides tools for every area

- **Subject:** `[agent-permissions] [P3] Retire agentContext and the tool-group documentation switches; Blocked hides tools for every area`
- **Size:** xl · **Priority:** high
- **Depends on:** 3.4
- **Parallel with:** 3.6

`agentContext.*Tools` and the four `enabledToolGroups` documentation keys only ever left tool docs out of claude-code's system prompt; tools stayed callable (ADR `260726-171347`), and Codex/OpenCode never read them. Replace them with Blocked areas, which hide and refuse on every runtime.

### Config migration

For each `agentContext.{tasksTools, relayTools, meshTools, adapterTools}` that is `false` -> `permissions.defaults.areas.{tasks, messages, agents, connections} = 'blocked'`; then delete `agentContext`. Key: the next key that ships in this phase's release (**if the previous phase's key is still unreleased, extend that key's body and re-pin its hash** rather than opening a key above the release version). Pin the hash; add `agentContext` to the removed-keys tolerance; tests read `config.json` from disk for each of the 16 combinations (or a representative matrix covering each key false alone, all false, all true/absent).

The sweep (`permission-upgrade-sweep.ts`) emits one `permission.changed` (actor Upgrade, target default) for the areas this migration set, comparing what the migration left against a pre-migration snapshot. (Config migrations cannot emit; capture the snapshot in the migration into a one-shot marker the sweep reads, or compare `permissions.defaults` against the preset and attribute undiscovered `blocked` defaults present right after this version's first boot. Pick the testable option and document it.)

### Remove

- `agentContext` in `UserConfigSchema` (`config-schema.ts:2209-2216`, both declarations) and its `CONFIG_WRITE_POLICY` entry.
- `resolveToolConfig` and its readers: `runtimes/claude-code/tooling/tool-filter.ts:104-117`, `messaging/launch-resolver.ts:160-180`, `context-builder.ts:460-519`.
- `packages/shared/src/mcp-tool-groups.ts`: `MCP_TOOL_GATE_GROUPS`, `ToolGateGroup`, `TOOL_GATE_GROUP_DOMAIN`, `ToolDomainKey`, `toolNamesForDomain`, `SESSION_CORE_TOOL_*` (delete the module if nothing remains; update the shared `exports` map) and the two `_every*` compile-time assertions in `mcp-tool-tiers.ts`. The tier table is now the single per-tool table (`tier`, `title`, `area`, card fields). ADR-0071's implicit hierarchy (trace follows relay, binding follows adapter) is replaced by explicit membership.
- Client: both `ToolGroupRow`s (`features/agent-settings/ui/ToolsTab.tsx:83-145`, `features/settings/ui/tools/ToolGroupRow.tsx`), `TOOL_INVENTORY`/`CONFIG_KEY_MAP` (`features/settings/config/tool-inventory.ts`), `useAgentContextConfig` (`entities/config/model/use-agent-context-config.ts`), `useToolNamesForGroup`.

### Blocked hides tools, all areas

The three builders from phase 1 (claude-code in-session `mcp-tools/index.ts:292-337`, runtime listener `connector-mcp/agent-runtime-server.ts:21-39`, external `/mcp` `core/mcp-server.ts:77-134`) now filter every area's Blocked actions (registry capabilities and hand-registered tools), and the context builder emits one line per Blocked area for all three runtimes. Hidden hand-registered handlers remain in the private map for `request_permission`. If adding the filter to a runtime needs a new authoring step, document it in `contributing/adding-a-runtime.md`.

### Tests

- migration matrix from disk; hash pinned;
- a Blocked area's tools are absent from claude-code, Codex and OpenCode tool lists, and a direct call is refused;
- `context-tool-names.test.ts`, tool-count guards, `tool-exposure.test.ts` pass;
- knip finds nothing left.

### Acceptance criteria

- [ ] `agentContext.relayTools: false` comes out as Messages Blocked for everyone, recorded as one `upgrade` event.
- [ ] A Blocked area's tools are absent from claude-code, Codex and OpenCode tool lists.

### Task 3.6: Couple presets to the trust stop and add the per-agent Files & commands stop

- **Subject:** `[agent-permissions] [P3] Couple presets to the trust stop and add the per-agent Files & commands stop`
- **Size:** large · **Priority:** high
- **Depends on:** 3.1
- **Parallel with:** 3.5

### Preset writes the trust stop

`permission-service.ts` `setPreset` now also writes `runtimes.defaultTrustStop` to the preset's Files & commands stop (Careful `ask`, Balanced `act`, Full power `autonomy`) through the existing autonomy consent door: moving to `autonomy` without `ui.autonomyAcknowledgedAt` answers `428 AUTONOMY_ACK_REQUIRED` (`approvals/autonomy-consent.ts:75`) and nothing is written (preset included: all or nothing). Per-runtime trust-stop leaves are left alone and show as changes. The `presetSnapshot` on the event includes the previous stop. `PATCH /api/config` writes that change any `*.defaultTrustStop` leaf now emit `permission.changed` (`key: { kind: 'files' }`) through the existing consent door and operator bar (`config-write.ts:338-414`).

"Custom" is never stored: the API returns `changesCount` = entries in `permissions.defaults` + 1 if `runtimes.defaultTrustStop` differs from the preset's stop (+ per-runtime leaves that differ), so the UI can say "Full power, 2 changes".

### Per-agent Files & commands

- `PATCH /api/agents/:id/permissions` accepts `filesAndCommands: stop | null` and runs `hasStandingAutonomyAck` (`autonomy-consent.ts:116`) before storing `autonomy` (428 otherwise). `GET` returns it with its source.
- `apps/server/src/services/session/resolve-session-defaults.ts`: the stop at `:304-307` (`configured?.defaultTrustStop ?? runtimes?.defaultTrustStop ?? null`) becomes `resolveFilesAndCommands({ agent, perRuntime, global })`. Order: session / task / binding (their own records, unchanged) > agent > per-runtime > global. `readAgentExecutionDefaults` (`:144-161`) reads `permissions.filesAndCommands`. `resolveUnattendedDefaultStop` (`:411-420`) and `resolveUnattendedPermissionMode` (`:459-472`) gain an agent parameter threaded from `tasks/scheduled-run-power.ts:112` and `rooms/room-turn-runner.ts:604`. `describeExecutionDefaults` (`:536-582`) keeps showing global and per-runtime stops.
- Update the comment at `resolve-session-defaults.ts:13-14` ("A manifest has no trust level").

### Tests

- each preset sets the stop; `full` without ack -> 428 and nothing written; with ack -> written;
- `changesCount` math;
- resolution order: session > agent > runtime > global, including unattended task and room-turn paths;
- per-agent `autonomy` without ack -> 428.

### Acceptance criteria

- [ ] Choosing each preset sets every row to that preset's table and the trust stop follows through the autonomy consent door.

### Task 3.7: Add the preset picker, every area row, Files & commands row and individual action overrides to the Permissions UI

- **Subject:** `[agent-permissions] [P3] Add the preset picker, every area row, Files & commands row and individual action overrides to the Permissions UI`
- **Size:** xl · **Priority:** high
- **Depends on:** 3.5, 3.6
- **Parallel with:** 3.8, 3.9

Light up the full model in the UI.

### New components in `apps/client/src/layers/features/permissions/ui/`

- `PresetPicker.tsx`: Careful · Balanced · Full power, reading "Full power, 2 changes" when `changesCount > 0`, "Not chosen yet. Your agents work as they did before." when `preset === null`. Choosing a preset reuses `useTrustStopWrites`'s confirm flow (`features/settings/model/use-trust-stop-writes.ts:146-183`) for the autonomy ack, then opens `ApplyToOverridesDialog` when agents differ. Writes `PUT /api/permissions/preset`.
- `ActionOverrides.tsx`: "Show individual actions" under a row lists that area's actions (from `GET /api/permissions`), each with its own switch; destructive ones read "Ask (always asks unless you set it here)". An action with an override shows under its row even when collapsed ("Rooms: Ask, except create rooms: Allowed").
- Files & commands row: uses `TrustDial` (`shared/ui/trust-dial.tsx:47-51` labels "Ask first", "Act", "Full autonomy") in the same row shell, with inherit/override and the exceptions chip.

### Surfaces

- Settings -> Permissions: `PresetPicker` (no longer read-only), all ten area rows (floor rows with lock, Blocked · Ask only), Files & commands row, history, accounts link.
- Agent profile -> Permissions: all rows plus the agent Files & commands row. The existing "Tools & MCP" profile page keeps only the MCP servers card and is renamed **MCP servers** (`features/profile/ui/pages/registry.ts`, `profile-rows.ts`); update `apps/e2e` page objects (`McpOAuthSigninPage.ts` uses `profilePage=tools`).
- First-run: `FullPowerDoor.tsx` accept/decline keep writing the preset (phase 1); the onboarding power step (`features/onboarding/ui/OnboardingPowerStep.tsx:75`) shows the three presets if the design calls for it (the door stays the one-time consent moment; do not add a second consent write).
- Remove the settings `ToolsTab` sections the retired switches left empty; if the tab is now empty, remove it and update `?settings=tools` deep links (`apps/e2e/tests/dialog-deep-link.spec.ts:5-26`).

Mobile: rows stack label over switch; full-width switch, 44px targets; chip, dialog and popovers as bottom sheets; single scrolling column on the profile page.

### Tests (RTL)

- `PresetPicker`: "N changes", autonomy confirm path, apply dialog when agents differ;
- floor rows offer two states; `ActionOverrides` shows collapsed overrides and destructive hint;
- Files & commands row inherit/reset.

### Acceptance criteria

- [ ] Choosing each preset in Settings sets every row to that preset's table.
- [ ] Works at 1440px and 390px.

### Task 3.8: Turn the Control Center dial into the preset picker and add agent permission rows with Reset

- **Subject:** `[agent-permissions] [P3] Turn the Control Center dial into the preset picker and add agent permission rows with Reset`
- **Size:** medium · **Priority:** medium
- **Depends on:** 3.6
- **Parallel with:** 3.7, 3.9

Control Center stays a summary (operator decision: no per-area switches).

- The trust dial (`apps/client/src/layers/widgets/control-center/ui/ControlCenterDial.tsx`) becomes the preset picker (Careful · Balanced · Full power, with "N changes"), keeping the autonomy confirm flow. Reuse `PresetPicker` from `features/permissions` (widget composing a feature is allowed).
- The overrides ledger (`OverridesLedger.tsx`, `model/use-overrides-ledger.ts:84-191`) gains an `agent-permission` row kind ("security-auditor: Rooms Blocked"; action overrides "DorkBot: create rooms Allowed"), each with a one-tap **Reset** (the ledger's first reset action; it writes `null` through `PATCH /api/agents/:id/permissions`, `surface: 'control-center'`). Existing row kinds keep their deep links.
- "Edit permissions ›" opens Settings -> Permissions (`?settings=permissions`).
- The Standing permissions switch is already gone (phase 2); confirm.

### Tests

- ledger shows agent rows and Reset writes the right body;
- dial selects presets with the confirm flow.
  Update `apps/e2e/tests/control-center.spec.ts:64-170` (dial radio -> preset) and the `control-center` capture shot.

### Acceptance criteria

- [ ] Reset from the ledger removes the override and emits one `permission.changed` with `surface: 'control-center'`.

### Task 3.9: Add dorkos permissions and dorkos agent permissions CLI commands

- **Subject:** `[agent-permissions] [P3] Add dorkos permissions and dorkos agent permissions CLI commands`
- **Size:** medium · **Priority:** medium
- **Depends on:** 3.6
- **Parallel with:** 3.7, 3.8

In `packages/cli/src/commands/`:

- `dorkos permissions list` (preset, changes, each area's state, exceptions), `dorkos permissions set <area|action> <blocked|ask|allowed>`, `dorkos permissions set --preset <careful|balanced|full>`, `dorkos permissions reset <area|action>`, `dorkos permissions history [--agent <id>] [--limit n]`.
- `dorkos agent permissions <agent> [set <area|action> <state> | reset <area|action> | set files <ask|act|autonomy>]`.

All call the HTTP routes (`GET/PUT/PATCH /api/permissions…`, `/api/agents/:id/permissions`) with `surface: 'cli'`; they never write config or manifests directly. Server refusals print the server's sentence (floor, 428 autonomy ack with the instruction to acknowledge in the app, person-bar refusal when run with an agent token). Help text in plain words. `--ceiling` is already removed (task 3.4); `dorkos config set permissions.*` prints the `USE_PERMISSIONS_API` message pointing at `dorkos permissions`.

### Tests

- each subcommand sends the right request; refusal messages print; `--preset full` without ack prints the ack instruction.

### Acceptance criteria

- [ ] `pnpm vitest run packages/cli` passes; `pnpm --filter dorkos typecheck` and `lint` clean.

### Task 3.10: Phase 3 verification: migrations, tool lists on three runtimes, e2e, browser check, docs, changelog, knip

- **Subject:** `[agent-permissions] [P3] Phase 3 verification: migrations, tool lists on three runtimes, e2e, browser check, docs, changelog, knip`
- **Size:** large · **Priority:** high
- **Depends on:** 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9
- **Parallel with:** —

Close phase 3 as one shippable PR.

### E2E

- Settings -> Permissions: pick each preset; rows match the preset table; Full power goes through the autonomy confirm.
- Change a default with an agent differing -> apply dialog.
- Update `control-center.spec.ts:64-170`, `full-power-door.spec.ts:142-213`, `onboarding-power.spec.ts:141-218`, `dialog-deep-link.spec.ts:5-26`, `McpOAuthSigninPage.ts`; capture shots `control-center`, `full-power-door`. Grep `apps/e2e` for every retired string (Tools & MCP, Manage rooms, tier ceiling copy, tool-group row labels, Standing permissions) before pushing.

### Targeted checks

```bash
pnpm --filter @dorkos/shared build
pnpm vitest run packages/shared apps/server/src/services/core apps/server/src/services/runtimes apps/server/src/services/session apps/server/src/services/tasks apps/server/src/services/rooms apps/server/src/routes
pnpm vitest run apps/client/src/layers/features/permissions apps/client/src/layers/features/settings apps/client/src/layers/features/profile apps/client/src/layers/features/agent-settings apps/client/src/layers/widgets/control-center apps/client/src/layers/features/full-power-door apps/client/src/layers/features/onboarding
pnpm vitest run packages/cli packages/test-utils packages/db
for p in @dorkos/shared @dorkos/server @dorkos/client @dorkos/db dorkos @dorkos/test-utils; do pnpm --filter $p typecheck && pnpm --filter $p lint; done
pnpm verify && pnpm knip
```

Census (no placeholder notes), operator-only config census, tool-count guards, `tool-exposure.test.ts`, `context-tool-names.test.ts`, migration-safety + hash pins, OpenAPI regenerated, vocab + banned-words gates.

### Real browser check at 1440px and 390px

Settings -> Permissions (all rows, floor locks, Files & commands, individual actions), agent Permissions page, MCP servers page, Control Center preset dial and ledger rows with Reset, the Reach & secrets card for a `config_patch` touching `tunnel`.

### Docs

- `docs/guides/permissions.mdx`: complete (all areas, presets and their table, the floor, Files & commands per agent, the CLI).
- `docs/guides/tool-approval.mdx`: the Files & commands row, per agent.
- `docs/guides/agents.mdx:92`: Tools & MCP page -> Permissions + MCP servers.
- `docs/getting-started/configuration.mdx`: `agentContext` removed; `permissions` complete.
- `contributing/configuration.md`, `contributing/agent-operator-surface.md` (input escalation, `PERSON_APPROVED_AUTHORITY`), `contributing/adding-a-runtime.md` if a tool-list step was added; the `adding-config-fields` skill's examples if they cite `agentContext`.
- Mark ADR `260726-171347` and ADR-0071 superseded (frontmatter + `decisions/manifest.json`).

### Changelog

Fragment `changelog/unreleased/<id>-agent-permissions-presets.md`: pick Careful, Balanced or Full power and every area follows; agents can ask to change settings and permissions, and you decide each time. **Name the narrowing for Careful installs** (Tasks, Other agents, Chat connections and Rooms now ask) and the retirement of the per-agent tier ceiling and the context switches, and that agents limited to "observe" now have every area Blocked but can still post and react in conversations.

### Acceptance criteria (phase 3)

- [ ] Choosing each preset sets every row to that preset's table; the trust stop follows through the autonomy consent door.
- [ ] `tierCeiling: 'observe'` agents come out Blocked on every area; `agentContext.relayTools: false` comes out as Messages Blocked for everyone; each is one `upgrade` event.
- [ ] A Blocked area's tools are absent from claude-code, Codex and OpenCode tool lists.
- [ ] An agent's `config_patch` touching `tunnel` raises a card in Reach & secrets with no Always allow; Allow applies it.
- [ ] The census passes with no `areaNote` left for an action that has an area.

---

## Phase 4 — Delight: undo, why, effect preview, gentle suggestion (5 tasks)

### Task 4.1: Add Undo for permission changes, with the conflict path and preset snapshots

- **Subject:** `[agent-permissions] [P4] Add Undo for permission changes, with the conflict path and preset snapshots`
- **Size:** large · **Priority:** high
- **Depends on:** 3.10
- **Parallel with:** 4.3, 4.4

Mistakes should be cheap. Every `permission.changed` row gets Undo.

### Server

- `apps/server/src/services/core/permissions/permission-history.ts` + `permission-service.ts` `undo(eventId, { force })`.
- Route `POST /api/permissions/history/:eventId/undo` with `{ force?: boolean }`, behind the same person bars as every mutating permission route (`resolveDecisionAuthority(readCallerAuthority(req, res))` + `requireOperatorCookieUnderLogin`). Regenerate OpenAPI.
- Undo writes the inverse of the event's `changes` (the `before` values) as a **new** `permission.changed` with `surface: 'undo'` and `undoOf: <eventId>`. It is audited like any change.
- **Conflict:** for each entry, if the current value differs from the recorded `after`, it is a conflict. Without `force`, return 409 `UNDO_CONFLICT` listing the conflicting entries (target, key, current, recorded after, the value Undo would write) and apply nothing. With `force`, apply every entry. For a **bulk** event, apply every entry that still matches and report the ones that changed since (`skipped[]` in the response), unless `force`.
- **Preset switch:** undoing an event with `presetSnapshot` restores preset, `defaults` and the trust stop from it (the trust stop through the autonomy consent door: a 428 is returned to the caller unchanged).
- `permission.answered` events have no Undo (409 `NOT_UNDOABLE`); an Always allow's own `permission.changed` row does.
- Floor rule still applies (an Undo can never write Allowed on a floor area; such an entry is skipped and reported).

### Client

- `entities/permissions/model/use-undo-permission.ts`.
- `features/permissions/ui/PermissionHistory.tsx`: Undo on each `permission.changed` row (Settings history and agent history). On 409 conflict: "This has changed since. Set it back to Ask anyway?" (use the real value) with Cancel / Set it back, which retries with `force`. After a bulk undo with skips: "Undid 3 changes. 1 had changed since and was left alone."
- CLI: `dorkos permissions history` shows event ids; add `dorkos permissions undo <eventId> [--force]`.

### Tests

- inverse write + new event with `undoOf`;
- conflict without force -> 409 and nothing written; with force -> written;
- bulk: matching entries undone, changed ones reported;
- preset snapshot restore incl. trust stop and 428 path;
- answered rows not undoable; agent header refused.

### Acceptance criteria

- [ ] Undo of a bulk change restores every entry that still matches and reports the ones that changed since.

### Task 4.2: Show a why line on every permission state

- **Subject:** `[agent-permissions] [P4] Show a why line on every permission state`
- **Size:** medium · **Priority:** medium
- **Depends on:** 3.10
- **Parallel with:** 4.1, 4.3, 4.4

Never a mystery state again. `apps/client/src/layers/features/permissions/ui/PermissionWhy.tsx`, triggered by `ProvenanceChip` (`apps/client/src/layers/shared/ui/provenance-chip.tsx`, which exists and has no production user yet).

Hovering or tapping any state opens the source, built from the `ResolvedPermission` (`source`, `layer`, `destructiveAsk`) and the latest matching history event for that key (from `GET /api/permissions/history`, filtered by target + key). Examples:

- "Allowed, from the default (Full power). Changed by you on Sep 23 from the request card."
- "Ask, because deleting always asks unless you set it here." (destructiveAsk)
- "Ask. This is a locked area, so it can never be Allowed." (floor)
- "Blocked, because this agent's access was turned off." (inactive)
- login off: "Changed by someone on this computer on Sep 23. Login is off, so DorkOS can't confirm who."

Server: if the latest-change lookup is too chatty from the client, add `lastChange` (event id, actor label, time, surface) per area/action to `GET /api/permissions` and `GET /api/agents/:id/permissions`; compute it from Activity in one query.

Wire it into every surface that shows a state: `PermissionRow` (default + agent), `ActionOverrides`, the Files & commands row, the exceptions chip list, and the Control Center ledger rows. Mobile: bottom sheet.

### Tests (RTL)

- each source renders its sentence; the latest change is named with its actor label and surface; floor and destructive variants.

### Acceptance criteria

- [ ] Every state on every surface has a why line naming its source and last change.

### Task 4.3: Show the effect preview on every surface that changes a default

- **Subject:** `[agent-permissions] [P4] Show the effect preview on every surface that changes a default`
- **Size:** small · **Priority:** medium
- **Depends on:** 3.10
- **Parallel with:** 4.1, 4.2, 4.4

The count "This affects N agents now" exists in `ApplyToOverridesDialog` since phase 1. Show it on every surface that changes a default or the preset: `PresetPicker` in Settings, the Control Center preset dial, `ActionOverrides` default switches, the area rows in Settings (inline under the switch while changing, or in the confirm step), and the CLI `dorkos permissions set` output ("Affects 33 agents."). N counts agents that inherit the changed key (not overriding it). Compute it from `GET /api/permissions` (`exceptions[]` + total registered agents) in one shared helper in `entities/permissions` (`useAffectedAgentCount(key)`), so all surfaces agree.

### Tests

- helper math with overrides at agent-area vs agent-action level;
- each surface shows the count before commit.

### Acceptance criteria

- [ ] Every surface that changes a default shows the same "affects N agents" count before the change is committed.

### Task 4.4: Add the gentle Always allow suggestion after three Allows in seven days

- **Subject:** `[agent-permissions] [P4] Add the gentle Always allow suggestion after three Allows in seven days`
- **Size:** medium · **Priority:** low
- **Depends on:** 3.10
- **Parallel with:** 4.1, 4.2, 4.3

After a person answers **Allow** (once) three times in seven days for the same agent and action, the **next** (fourth) card for it highlights Always allow with one line: "You've allowed this 3 times this week". Never a badge, never a nag.

### Server

- When minting a pending approval, compute `suggestAlways: boolean` on the DTO: true when `alwaysOffered` is true, and there are at least three `permission.answered` events with `answer: 'once'` for the same `agentPath` + `action` in the last 7 days, and no `permission.suggestion_dismissed` event exists for that agent + action.
- `POST /api/approvals/:id/dismiss-suggestion` (person bars as on the grant route) records `permission.suggestion_dismissed` (`permissions` category, metadata `{ agentId, agentPath, action }`). Regenerate OpenAPI.

### Client

- `ApprovalCard`: when `suggestAlways`, Always allow gets the highlighted treatment (still after Allow in order) with the line above and a small "Not now" link that calls dismiss and removes the highlight.

### Tests

- the suggestion appears on the fourth card, not the third;
- never again for that agent + action after "Not now";
- never on a floor-area card or an unidentified requester;
- Deny and Always allow answers do not count toward the three.

### Acceptance criteria

- [ ] The suggestion appears on the fourth card, not the third, and never again after "Not now".

### Task 4.5: Phase 4 verification: tests, browser check, docs, changelog

- **Subject:** `[agent-permissions] [P4] Phase 4 verification: tests, browser check, docs, changelog`
- **Size:** medium · **Priority:** high
- **Depends on:** 4.1, 4.2, 4.3, 4.4
- **Parallel with:** —

Close phase 4 as one shippable PR.

### E2E

- Change Rooms default -> History -> Undo -> the default is back; change it, change it again elsewhere, Undo the first -> the conflict prompt; Set it back applies.
- Answer Allow three times for the same agent/action -> the fourth card shows the suggestion; Not now -> gone on the fifth.

### Targeted checks

```bash
pnpm vitest run apps/server/src/services/core/permissions apps/server/src/routes apps/server/src/services/core/approvals
pnpm vitest run apps/client/src/layers/features/permissions apps/client/src/layers/entities/permissions apps/client/src/layers/features/approvals apps/client/src/layers/widgets/control-center
pnpm vitest run packages/cli
for p in @dorkos/shared @dorkos/server @dorkos/client dorkos; do pnpm --filter $p typecheck && pnpm --filter $p lint; done
pnpm verify && pnpm knip
```

OpenAPI regenerated; vocab + banned-words gates.

### Real browser check at 1440px and 390px

History with Undo and the conflict prompt; why popovers (hover on desktop, tap/bottom sheet on mobile) on Settings rows, agent rows, action overrides, ledger rows; effect preview on preset picker and dial; the suggestion on the card.

### Docs

- `docs/guides/permissions.mdx`: history and Undo (including "changed since"), the why line, the suggestion.

### Changelog

Fragment `changelog/unreleased/<id>-agent-permissions-undo-why.md`: "Every permission change can be undone from history. Tap any setting to see why it is what it is and who last changed it. If you keep allowing the same thing, the card offers to remember it."

### Acceptance criteria (phase 4)

- [ ] Undo of a bulk change restores every entry that still matches and reports the ones that changed since.
- [ ] Every state on every surface has a why line naming its source and last change.
- [ ] The suggestion appears on the fourth card, not the third, and never again after "Not now".
