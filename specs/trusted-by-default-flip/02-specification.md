---
slug: trusted-by-default-flip
number: 261006-232018
created: 2026-10-06
status: specified
---

# Full-power defaults, with outsider protections pinned by tests

**Status:** Draft
**Author:** Claude (SPECIFY for Dorian Collier)
**Date:** 2026-10-06
**Linear:** DOR-2739
**Decision:** ADR `261006-225605` (PR #2618) and `.claude/rules/safe-defaults.md` as amended there
**Depends on:** DOR-2738 audit trail (`specs/audit-trail/02-specification.md` on its branch), the outsider pin tests (branch `dor-2739-outsider-pins`)
**Ideation:** [`01-ideation.md`](./01-ideation.md)

## 1. Overview

Fresh installs start Trusted: every in-circle permission area Allowed except Safety limits (kept at Ask with its floor, so loop guards stay exactly as they are until DOR-2745), Files & commands at Full autonomy, our agents free to message each other, agent-made schedules armed, connected apps shared with every agent, agent-written extensions approved. Existing installs move there once by a config migration, with a one-time notice and a one-click way back to Careful. An install that explicitly chose Careful keeps it.

Four protections do not move, and two of them get stronger first:

1. **Outsiders seed no power**, and (new) **power flows downstream, never up**: any turn another agent's message starts runs no looser than that agent's live level, and a stranger's message never runs looser than the runtime's prompting default, whatever the conversation's row says.
2. **Third-party code still needs a yes**: hook projection, global plugins, `marketplace.link`, Shapes, template agents, workspaces with effects, marketplace-origin extensions, package/Shape/file schedules.
3. **The perimeter stays Owner-only**: the `reach` floor, the config write policy for `auth`, `tunnel`, `mcp`, providers and credentials, marketplace sources, `extensions.trustedSources`, and the exposure guard.
4. **Irreversible actions in outside accounts are loud**: a 60-second cancel window everyone is told about, then the action runs and is recorded.

## 2. Vocabulary used in this spec

- **In-circle**: a person in the space, or one of our registered agents acting on a person's or another of our agents' instruction.
- **Outsider origin**: a relay binding (Telegram, Slack, webhook), a connector event, an external room author, an A2A peer, an unidentified external `/mcp` caller (`relay.external.mcp`), a `MCP_API_KEY` or per-user-key client.
- **Live level**: the mode a session's turn really runs at, read the way `runtimes/claude-code/mcp-tools/session-start-permission.ts` reads a calling chat (`runningPermissionMode` on the live session, then the stored row, then the runtime's declared default; fails closed to read-only).
- **Posture**: `trustPosture(config)` — new pure helper in `packages/shared/src/permissions/trust-posture.ts`: `'careful'` when `permissions.preset === 'careful'`, otherwise `'trusted'`. Every non-permission subsystem that changes behaviour in this spec (schedules, extensions, connectors, mesh seeding) reads this one function, so Careful turns all of them back to asking at once and there is one place to test it.

## 3. Before and after, every default

| #   | Mechanism                                                                                                                 | Before (fresh / undecided install)                                   | After (Trusted)                                                                                 | Careful (opt-in)                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | `permissions.preset` schema default                                                                                       | `null` → hidden Unchanged table                                      | `'trusted'`                                                                                     | `'careful'` (unchanged table)                                                                   |
| 1   | Rooms                                                                                                                     | Blocked                                                              | Allowed                                                                                         | Ask                                                                                             |
| 1   | Tasks & schedules / Other agents / Messages / Extension tools / Own chat                                                  | Allowed                                                              | Allowed                                                                                         | Ask/Ask/Allowed/Ask/Allowed                                                                     |
| 1   | Chat connections                                                                                                          | Allowed                                                              | Allowed                                                                                         | Ask                                                                                             |
| 1   | Tools & packages                                                                                                          | Allowed (install card still shown)                                   | Allowed, and an install from a configured marketplace source runs without the card              | Ask                                                                                             |
| 1   | DorkOS settings                                                                                                           | Allowed                                                              | Allowed                                                                                         | Ask                                                                                             |
| 1   | Safety limits                                                                                                             | Blocked, floor                                                       | **Ask, floor kept** (loop guards untouched; revisit with DOR-2745)                              | Ask                                                                                             |
| 1   | Permissions                                                                                                               | Blocked, floor                                                       | Allowed, floor removed                                                                          | Ask                                                                                             |
| 1   | Reach & secrets                                                                                                           | Blocked, floor                                                       | Ask, floor kept (never Allowed)                                                                 | Blocked                                                                                         |
| 1   | Destructive post-rule (area-level Allowed → Ask)                                                                          | All destructive actions                                              | Only actions declared `consent: 'third-party-code'` (`mcp.add`, `mcp.update`)                   | Unchanged                                                                                       |
| 1   | `tasks_delete`, `mesh_unregister`, `marketplace.uninstall`, `mcp.import`                                                  | Ask                                                                  | Run, recorded                                                                                   | Ask                                                                                             |
| 1   | `operator.update_agent_boundaries` (Safety limits)                                                                        | Ask                                                                  | **Ask (Safety stays a floor)**                                                                  | Ask                                                                                             |
| 1   | `operator.update_agent_execution` (carries `describeApprovalChange`, so `alwaysAsks`)                                     | Ask                                                                  | **Ask (unchanged; `alwaysAsks` is out of scope)**                                               | Ask                                                                                             |
| 1   | Area-null destructive actions (perimeter / third-party code, list in §5.1)                                                | Ask                                                                  | **Ask (unchanged)**                                                                             | Ask                                                                                             |
| 2   | `runtimes.defaultTrustStop` schema default                                                                                | `null` → runtime's own (Claude Code / OpenCode ask; Codex read-only) | `'autonomy'`                                                                                    | `'ask'` (the Careful preset writes it)                                                          |
| 2   | Per-runtime `defaultTrustStop`, per-agent Files & commands                                                                | `null` / unset                                                       | **Unchanged** (`null` falls through to the global stop)                                         | Unchanged                                                                                       |
| 2   | Autonomy acknowledgement (`428 AUTONOMY_ACK_REQUIRED`, `ui.autonomyAcknowledgedAt`, `dorkos config acknowledge-autonomy`) | Required before any autonomy write                                   | Retired                                                                                         | Retired                                                                                         |
| 2   | Interactive, local room, extension-start sessions                                                                         | Seed configured stop                                                 | Same rule, now Full autonomy                                                                    | Ask                                                                                             |
| 2   | Agent DM turns (`agent-dm` origin)                                                                                        | `default` mode always                                                | min(receiver's configured stop, sender's stamped live level); absent stamp → `default`          | Ask                                                                                             |
| 2   | `session_start` from external `/mcp` with a registered agent's token                                                      | Capped at `acceptEdits`                                              | That agent's own configured stop                                                                | Ask                                                                                             |
| 2   | `session_start` from `MCP_API_KEY`, per-user keys, A2A, unidentified                                                      | `acceptEdits` cap                                                    | **Unchanged**                                                                                   | Unchanged                                                                                       |
| 2   | Bindings, connector events, external room authors, A2A, extension-message, schedule rows                                  | Seed nothing                                                         | **Unchanged** (pinned)                                                                          | Unchanged                                                                                       |
| 0   | Room turn started by an agent's post                                                                                      | Configured stop (on insert) or stored row                            | Also capped per turn at the poster's live level                                                 | Same cap                                                                                        |
| 0   | Room turn started by an external author into an existing conversation                                                     | Stored row's level (can be Full autonomy)                            | Capped per turn at the runtime's prompting default                                              | Same cap                                                                                        |
| 3   | Cross-project messaging (mesh)                                                                                            | Catch-all cross-namespace deny                                       | Open mesh (`* → *`) seeded once at boot                                                         | Seeded once too (Careful is about asking, not about who may talk); the switch stays in Topology |
| 4   | Agent-made schedule (MCP `tasks_create`, untrusted `POST /api/tasks`)                                                     | Parks at `pending_approval`, `schedule.parked` blocking notice       | Armed immediately, `schedule.armed_by_agent` notice with Pause and Open                         | Parks                                                                                           |
| 4   | Agent edit to a schedule our agent made                                                                                   | Re-parks (approval key)                                              | Re-keys and stays armed, recorded                                                               | Re-parks                                                                                        |
| 4   | Package / Shape / file-discovered schedules, and the `acceptEdits` content clamp                                          | Park + clamp                                                         | **Unchanged**                                                                                   | Unchanged                                                                                       |
| 5   | New connection                                                                                                            | No grants                                                            | Every agent at Read and write (Read where the app offers no write)                              | No grants                                                                                       |
| 5   | "Who can use it?" window after sign-in                                                                                    | Nothing preselected                                                  | Every agent + Read and write preselected                                                        | Nothing preselected                                                                             |
| 5   | Existing connection nobody shared (no level rows, no grants)                                                              | No grants                                                            | Every agent at Read and write, once, named in the notice with one-click narrowing (D1, decided) | Untouched                                                                                       |
| 6   | `connectors.execute_destructive` from a session whose live level never asks                                               | Approval card per call                                               | 60 s cancel window, everyone notified, then runs, recorded                                      | Card                                                                                            |
| 6   | Same, from a prompting session, an outsider-origin turn, or a no-chat `/mcp` caller                                       | Card                                                                 | **Card (unchanged)**                                                                            | Card                                                                                            |
| 7   | Extension created through `create_extension` (our agent's door)                                                           | Waits for approval to run                                            | Approved for this copy and its declared permissions, recorded                                   | Waits                                                                                           |
| 7   | Marketplace, untrusted-source, or hand-copied extension                                                                   | Waits                                                                | **Waits (unchanged)**                                                                           | Waits                                                                                           |
| 8   | Onboarding power step                                                                                                     | "Full power" vs "Keep asking me" door                                | Short statement: Continue / Keep asking me                                                      | —                                                                                               |
| 8   | Existing install that never answered, or chose Full or Balanced                                                           | —                                                                    | Moved to Trusted once, one-time notice                                                          | —                                                                                               |
| 8   | Existing install that chose Careful or "Keep asking me"                                                                   | —                                                                    | **Untouched, no notice**                                                                        | —                                                                                               |

Unchanged and pinned (not touched by any PR here): `dmPolicy` allowlist, approver allowlist, binding `permissionMode` default `'default'`, `canInitiate`, login, exposure guard, host guard, `/mcp` auth, rate limits, boundary, untrusted-text fencing, browser egress guard, global plugin consent, hook projection approval, source write policy, loop guards (DOR-2745).

## 4. Principle added: power flows downstream, never up (PR1)

`session_start` already holds it ("never higher than the starter", ADR `261004-235818`). Two other agent-to-agent hops do not, and both are reachable from a stranger's turn because `relay_send` and `post_to_room` are in `DORKOS_AGENT_TOOLS` (`runtimes/claude-code/messaging/interactive-handlers.ts:133`), auto-allowed even in a prompting mode.

### 4.1 A per-turn ceiling (as built)

- `MessageOpts.permissionCeiling?: TurnPermissionCeiling` (`packages/shared/src/agent-runtime.ts`): a level (`{ asks, reach, auto? }`) or `'runtime-default'`. Per turn, never stored, applied by every runtime with `clampModeToCeiling` (`packages/shared/src/permission-semantics.ts`): the session's own mode when the ceiling admits it, else the loosest trust-axis mode it admits, else the runtime default. Auto fits only under an Auto or never-asking ceiling.
- Claude Code: `AgentSession.turnPermissionCeiling` is assigned on every send; `turn-permission.ts` `turnPermissionMode()` is read by the launch (which sets the SDK mode; a warm process is moved by its fingerprint), by `canUseTool`, and by `session_start`'s `runningPermissionMode`, so a held turn cannot start a stronger child.
- Codex: `resolveTurnSettings` clamps the turn's mode (it decides the sandbox). OpenCode: the turn's `ApprovalRouting` carries the ceiling and each ask is answered at the clamped live mode.
- `TriggerTurnOpts` and the dispatcher pass `permissionCeiling` through.

### 4.2 Recording levels (`services/core/turn-power/turn-levels.ts`)

- `recordTurnLevels(runtime, storedModeOf)` wraps every runtime at the registry's registration seam and records the level each turn runs at (stored mode and per-send mode, stricter wins, unconfirmed Auto read as Default, then the ceiling).
- `RoomEntryWriter.writePost` calls `noteEntryLevel(entry.id, entry.sessionId)` before anything the post triggers is dispatched, so a post keeps the level of the turn that wrote it, not a later one. Both maps are in memory and bounded; anything missing reads as `'runtime-default'`.

### 4.3 Rooms

- `room-trigger.ts` `ceilingForEntry(authors, entry)` sets `RoomTurnRequest.permissionCeiling`: external or unresolvable author → `'runtime-default'` (new and existing conversations alike); agent author → the post's kept level, else `'runtime-default'`; local person or system → none. Posts made outside a turn in that room trigger nobody (existing rule), so every triggering agent post carries a session.

### 4.4 Relay

- `agent-handler.ts`: a sender that may not shape the turn (anything not `relay.human.*`, `relay.system.*`, `relay.bridge.*`: our agents, the A2A gateway `a2a-gateway`, `relay.external.mcp`) sends `permissionCeiling: 'runtime-default'`, so an existing conversation set looser cannot answer it looser. PR4 replaces that with min(receiver's configured stop, the sending agent's stamped turn level) for senders stamped `relay.agent.*` only.
- `SessionRuntimeBinder` now receives `from`. `adapter-factory.ts` binds `relayTurnOrigin(from)`: `agent-dm` for `relay.agent.*`, and a new `outside-sender` origin (seeds `'none'`) for everyone else, so a later change to agent DMs can never carry an A2A turn along.

### 4.5 Residuals (not closed by PR1)

- A chat binding's own conversation can be set looser in the app than the binding's mode; a binding turn is not ceilinged (its mode is a person's choice on the binding). Revisit with the binding UI.
- A message that joins a live turn as a steer runs at that turn's level. Rooms queue rather than steer, so a stranger's room message does not reach this.
- `POST /api/relay` lets a local caller claim a `relay.agent.*` sender (the local-trust residual; login is the boundary).
- A marketplace extension's message into a person's own Full autonomy chat (`extension-message` into an existing chat) runs uncapped. Bound it with the extension-trust work (PR4 §5.5).
- Claude Code `updateSession` (a person loosening a live session) moves a running, ceilinged query to the looser mode until the turn ends; the next turn re-applies the ceiling only if its sender sends one.
- The room context window shows earlier messages, strangers' included, to an agent answering a person; those are fenced as untrusted text, not ceilinged.
- Codex and OpenCode reach DorkOS tools over the external `/mcp` server, where the agent token names the agent but not the session. Their room posts therefore keep no level (held to the runtime default downstream), and their `session_start` keeps the `acceptEdits` no-chat cap. PR4 uses the agent's own configured stop for a registered agent token; a session-bound token would close it exactly.

### 4.6 Review round 1 (adversarial, 2026-10-07), fixed in PR1

- A gathered burst is decided over every message it answers (`TriggerTarget.answers`, `ceilingForEntries`), so a person writing last does not lift a stranger's bound; same for `externalAuthor`.
- A post's level is the stricter of the session that MADE the call (in-session `CapabilityHandlerContext.sessionId`) and the author's turn in the target room (`postLevelFor`), and nothing when the caller is unverified. A request body's `sessionId` is never a source.
- Codex carries the ceiling into background-work wake turns.
- `stricterLevel` combines unordered pairs; `clampModeToCeiling` never falls back to a mode looser than the ceiling; a list ceiling holds every bound.
- A runtime renaming a first room turn's session carries its level across (`aliasTurnLevel`).
- The registration-seam decorators moved to `core/runtime-seam/decorate-runtime.ts`.

## 5. Technical design for the flip

### 5.1 Permissions (PR4)

Files: `packages/shared/src/permissions/{permission-ids,permission-presets,permission-areas,resolve-permission,trust-posture}.ts`, `apps/server/src/services/core/capabilities/{permission-enforcement,capability-definition,tier-enforcement}.ts`, `apps/server/src/services/core/permissions/permission-service.ts`, `apps/server/src/services/marketplace-mcp/marketplace-capabilities.ts`, `apps/server/src/services/mesh/mcp-capabilities.ts`, `packages/cli/src/commands/permissions.ts`, client `features/permissions/{ui/PresetPicker.tsx,lib/permission-copy.ts,lib/permission-why.ts}`, `features/marketplace/lib/format-permissions.ts`.

- `PERMISSION_PRESETS` gains `'trusted'` (older builds tolerate the new enum value as skew: `config/widened-leaves.ts`). New frozen `TRUSTED` table: every area `'allowed'` except `safety: 'ask'` and `reach: 'ask'`; `actions: {}`; `filesStop: 'autonomy'`. `careful`, `balanced`, `full` stay frozen and parseable; the picker shows Trusted and Careful only. Balanced and Full are removed when the machinery collapses (not here).
- `presetTableFor(null)` returns `TRUSTED`; `UNCHANGED_PERMISSION_TABLE` and the `'unchanged'` `PermissionSource` are deleted (after the migration no stored `null` is left, and an absent in-circle value means full power under the amended rule 1). Its `rooms.merge` and `operator.update_agent_boundaries` action entries go with it.
- `permission-areas.ts`: `permissions.floor` → `false`. `safety` keeps its floor (operator call, 2026-10-06): the loop-guard limits in `config-write-policy.ts` (stakes filed under `safety`) stay operator-only exactly as today, and `operator.update_agent_boundaries` keeps asking. Revisit with DOR-2745. `permission-service.ts` `FLOOR_NEVER_ALLOWED` then fires for `safety` and `reach` (message rewritten to name those two).
- Destructive post-rule (`resolve-permission.ts:150`): applies only when the action declares `consent: 'third-party-code'`. New optional field on `CapabilityDefinition` and the hand-tool tier table (`services/core/mcp-tool-tiers.ts`), threaded into `ResolvePermissionInput`. Declared on `mcp.add` and `mcp.update` (both put a command DorkOS will run into every session of an agent). Not on `mcp.import` (the server already runs in the agent's own environment).
- `alwaysAsks` (`describeApprovalChange`, destructive extension tools) is unchanged: those cards exist to show old → new, and the actions carrying them (`operator.update_agent_execution`, `marketplace.link`, destructive extension tools) are reviewed in the machinery-collapse phase.
- Area-null destructive actions keep asking through the tier gate with no change: `marketplace.link`, `shapes.apply`, `harness.project_hooks` (`services/harness/hook-approval.ts`), global plugin activation (`marketplace/consent/ask-withheld-global-plugins.ts`), `TEMPLATE_CREATION_CAPABILITY_ID`, `workspaces.create_with_effects` (`marketplace-mcp/confirmation-provider.ts`), `connectors.execute_destructive` (handled in §5.6).
- Marketplace install from a configured source: `callerContext` (`marketplace-capabilities.ts:85-98`) also treats a `via: 'permission'` area-level Allowed as `preApproved` for `install` and `update`, when `trustPosture` is `'trusted'`. Sources are owner-chosen (`source-write-policy.ts` keeps agents out), so a configured source is a trusted one. The hooks and global plugins a package carries still ask separately (pinned by `outsider-protections.third-party-code.test.ts`).

### 5.2 Files & commands and the retired ritual (PR2 retires, PR4 flips)

PR2, retiring the acknowledgement (no default changes):

- Delete `services/core/approvals/autonomy-consent.ts` and every 428: `routes/sessions.ts:813`, `permission-service.ts:585,695`, `permission-undo.ts:330`, `config-write-policy.ts`, `operator/config-write.ts`, `session-store.ts`, `session-start-permission.ts` (`hasStandingAutonomyAck`), OpenAPI (`openapi-registry.ts`), `packages/shared/src/permission-semantics.ts` (`needsConsentRitual` and its four consumers), `packages/cli/src/{config-write.ts,config-commands.ts,commands/permissions.ts}` (the `acknowledge-autonomy` command is removed), client `features/chat/.../AutonomyConfirmDialog.tsx`, `use-autonomy-consent.ts`, `use-autonomy-acknowledgement.ts`, `use-trust-stop-writes.ts`, `use-set-permission.ts`, `use-session-status.ts`, `ChatStatusSection.tsx`, `FullPowerDoor.tsx` (stops writing the ack).
- Config: `ui.autonomyAcknowledgedAt` leaves the schema, is declared retired so the first write drops it, and leaves `SAFE_DEFAULTS`. PR2's migration deletes the key from disk.
- The relay binding dialog and the schedule form stop opening a consent dialog before Full autonomy; picking it is a normal choice, recorded by the audit trail.
- The unattended-autonomy banner and its creation confirm are removed in PR3 (§5.10).

PR4, the flip:

- `DefaultTrustStopSchema` (`packages/shared/src/config-schema.ts:1929`): the global leaf defaults to `'autonomy'`; the three per-runtime leaves keep `null`. Split the schema into a global and a per-runtime constant so the two defaults are explicit.
- `session_start` (`session-start-permission.ts`): for an external `/mcp` caller with no chat whose agent token resolves to one of our registered agents, the ceiling is that agent's own resolved Files & commands stop (`resolveFilesAndCommands`), not `NO_CHAT_CEILING_MODE`. Every other no-chat caller keeps `acceptEdits`.
- `resolveAgentDmMode` (§4.3) turns on.

### 5.3 Open mesh (PR4)

- New boot step `services/mesh/seed-open-mesh.ts`, run after mesh and relay are ready: if `permissions.trustedStoresAppliedAt` is `null`, call `topology.allowCrossNamespace('*', '*')` (the same write the door made through `PUT /api/mesh/topology/access`), then stamp. Runs once per install, fresh or upgraded, whatever the posture. A person who turns the switch off later keeps it off.
- `packages/mesh/src/topology.ts` defaults and the opt-in firewall (`packages/relay/src/access-control.ts`, `mesh_deny`, `TopologyPanel`, `OpenMeshSwitch`) are unchanged. ADR 0033 is superseded only in what the default is.

### 5.4 Schedules (PR4)

Files: `services/tasks/lifecycle/create-task.ts`, `services/tasks/approvals/task-approvals.ts`, `routes/tasks.ts`, `runtimes/claude-code/mcp-tools/task-tools.ts`, `services/notifications/notification-registry.ts`, client `features/schedule-approval`, `entities/attention`.

- `create-task.ts:487` and `:528`: park only when `!trusted && trustPosture(config) === 'careful'`. Keep `recordProposal` so the row still names the proposing agent and session. Write audit `schedule.armed_by_agent`.
- `TaskApprovals.settleApprovedWorkChange` (`task-approvals.ts:252-300`): for a row with no `origin: 'file'` under Trusted, an agent's change re-keys (`approvedContentKey`) like a person's (`routes/tasks.ts:599-602`) instead of parking. Rows with `origin: 'file'` (discovery, Shapes, packages) keep parking. `AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON` keeps re-asking for file rows only.
- `task-write-policy.ts` is unchanged: agents still cannot set `permissionMode` or `status`; an agent schedule runs at the operator's stop through `scheduled-run-power.ts`.
- New notification kind `schedule.armed_by_agent`: tier `notable`, storage `event`, subject `task`, title "`{agent}` scheduled `{task}`", body "Runs `{cadence}`. Pause it any time.", actions Pause (sets `enabled: false` through the existing task update path) and Open, `relay: 'never'`, dedupe `schedule:{taskId}`.
- Existing parked schedules stay parked: each is an open question to a person, and answering it for them is not a default.

### 5.5 Extensions (PR4)

- `services/extensions/extension-manager.ts` `createExtension` (:788-803): after scaffold and reload, when `trustPosture` is `'trusted'` and the scaffold created a NEW folder, write `approvedToRun += id`, `approvedSources[id] = approvedSourceOf(record)`, `approvedPermissions[id] = declaredSet(manifest)` through the same config writer the approve route uses, and write audit `extension.auto_approved` (actor, id, path, permissions). Skip when the id is in `extensions.dismissedApprovals` or when the scaffolder refused a squat (`extension-scaffolder.ts:108-130`).
- The approval stays path-bound and permission-bound, so a marketplace copy of the same id, a hand-copied folder, or a later widened manifest still waits (`extension-load-policy.ts:352,239`). `trustedSources` stays Owner-only.
- `extension-load-policy.ts` module doc: DOR-516's "an agent-scaffolded bundle must not self-approve" is retired for `create_extension` by ADR `261006-225605` item 5; say so where it is stated.

### 5.6 Connected apps (PR5)

Every-agent default:

- `connectors/authentication-flow-service.ts:325` (inside the connect transaction), for a brand-new connection only and when `trustPosture` is `'trusted'`: `recordAccessLevel(tx, { connectionId, subject: { kind: 'every_agent' }, level, createdBy, now })` from `execution/access-levels.ts:100-135`, `level` = `'read-write'` when the app's catalog offers write, else `'read'` (`connector-schemas.ts:164`). After commit, `reconciliationService.followCatalog(connectionId, …)` so grants exist now rather than within 12 hours, and `recordEveryAgentChange` (`every-agent-activity.ts`) records it. A reconnect never rewrites levels.
- The "Who can use it?" window preselects **Every agent** and **Read and write** under Trusted.
- Existing connections, once (boot step beside §5.3, same stamp): each connection with no level rows and no active grants gets the same level row (operator decision D1, 2026-10-06). Managed connections without `managedAuthority` are skipped (`reconciliation-service.ts:1505`). The boot step stores the list of apps it shared in `permissions.sharedAtUpgrade` (new, `string[]`, default `[]`, `NO_RISK`), which the notice reads (§5.8).

Cancel window for `connectors.execute_destructive`:

- **Design: a hold, not an undo.** Composio exposes no undo or trash (`packages/connector-providers` has none), and a sent email cannot be unsent, so the only honest window is before the action runs. The copy says "Cancel", never "Undo".
- Eligibility: the calling session's live level never asks (`asks === 'never'` on its runtime's descriptor), `trustPosture` is `'trusted'`, and the caller is an identified agent in a chat. Anything else (a prompting session, which every outsider-origin turn is; a no-chat `/mcp` caller; Careful) keeps today's card.
- Flow: the tier gate (`tier-enforcement.ts`) returns a new outcome `held` for an eligible call. `services/connectors/execution/destructive-hold.ts` records the hold (in memory, keyed by a new id, carrying the authority binding digest), raises notification `connector.destructive_pending` (tier `notable`, storage `standing`, title "`{agent}` will `{action}` in `{app}`", body "Runs in 60 seconds unless someone cancels.", actions Cancel and Open, `relay: 'never'`, web push on), writes audit `connector.destructive_held`, and waits `DESTRUCTIVE_HOLD_MS = 60_000` inside the tool call, reporting progress the way `capability-approval-hold.ts` does.
- Cancel: `POST /api/connectors/holds/:id/cancel` and capability `connectors.cancel_held_action` (tier `act`, both MCP servers). Anyone may cancel except the requesting agent. The tool returns `CANCELLED` naming who cancelled. Aborting the turn or stopping the session cancels the hold. A server restart drops it unexecuted (recorded `connector.destructive_dropped` at boot from the audit trail's open holds).
- Uncancelled: the gate returns `{ via: 'hold', holdId, authorityBindingDigest }`. `execution-broker.ts` `assertApprovalBinding` (:230-241) accepts `via: 'hold'` with the same digest check, at both call sites (:156, :338). The pending notification is replaced (same dedupe key) by `connector.destructive_executed` (tier `quiet`, storage `event`): "`{agent}` `{past-tense action}` in `{app}`". Audit `connector.destructive_executed` with outcome.

### 5.7 Config migration (PR4)

Key: the next free key above the newest `v*` tag at landing time (today `0.101.0`; `0.99.0` and `0.100.0` are taken). Pin it in `merged-migration-hashes.ts`. Body `applyTrustedPosture(store)` in `config-manager.ts`:

1. **Careful intent** = `permissions.preset === 'careful'`, or `preset == null && ui.fullPowerChoice === 'supervised'`. Then: set `preset: 'careful'` if it was `null`, set `ui.trustNoticeSeenAt` to now, change nothing else.
2. **Otherwise** (`null`, `'balanced'`, `'full'`, or a hand-written unknown):
   - `permissions.preset = 'trusted'`; `permissions.defaults` and every per-agent manifest override untouched (a person's own changes stay on top);
   - `runtimes.defaultTrustStop`: `null` or `'act'` → `'autonomy'`; `'ask'` kept (a person chose it on the dial); `'autonomy'` kept. Per-runtime leaves untouched;
   - `ui.trustNoticeSeenAt` stays `null`, so the notice shows.
3. Delete `ui.fullPowerDecidedAt` and `ui.fullPowerChoice` (both leave the schema; declared retired). `ui.autonomyAcknowledgedAt` is PR2's.
4. `permissions.trustedStoresAppliedAt` (new, `null`) is NOT set here: the boot steps in §5.3 and §5.6 set it, because the mesh store and SQLite are not in `config.json`.

Why respect an explicit Careful choice: the operator asked to "opt back into asking"; a person who already did so has answered the question the notice asks, and moving them would be the silent flip the ADR forbids. Why move Full and Balanced: both were answers to "how much should agents ask", and Trusted is what that answer now means; Balanced users lose the most asking, which is why the notice names the way back.

New config leaves: `ui.trustNoticeSeenAt: string | null` (default `null`, `NO_RISK`: it gates a notice, nothing else), `permissions.trustedStoresAppliedAt: string | null` (default `null`, `NO_RISK` bookkeeping).

`safe-defaults/default-verdicts.ts`: `permissions.preset` and `runtimes.defaultTrustStop` move from `SAFE_DEFAULTS` to `PERMISSIVE_DEFAULTS`, reason: "ADR 261006-225605: in-circle capability defaults to full power; every use is recorded by the audit trail (`audit_events`), and outsider-origin turns seed nothing (`permissionSeedForOrigin`)".

`safe-defaults/protected-state.ts` (rule 2, losing state must not lose a protection): a wipe now lands on Trusted, so carry across a recovery: `permissions.preset` when `'careful'`, `permissions.defaults` entries that are `'ask'` or `'blocked'`, and any `defaultTrustStop` leaf (global or per-runtime) holding `'ask'` or `'act'`.

Client copy for config keys: `contributing/configuration.md` defaults table, `config-disclosure.ts` entries for the new leaves.

### 5.8 The notice and onboarding (PR4)

Rail moment, replacing `features/full-power-door` (deleted) and `useFullPowerMomentDescriptor` (`widgets/moments/model/use-moments.tsx`): `features/trust-notice/ui/TrustNoticeMoment.tsx`, eligible when config loaded, onboarding over, `ui.trustNoticeSeenAt == null`, posture Trusted. Priority high.

> **Agents now work without asking**
> They edit files, run commands and use your connected apps on their own.
> Everything they do is recorded in Activity. Anyone can pause an agent.
> Messages and code from strangers still need your yes.
> [Got it] [Keep asking me] · What changed

- **Got it** writes `ui.trustNoticeSeenAt`.
- **Keep asking me** writes `PUT /api/permissions/preset careful` (which writes the `'ask'` stop), then `ui.trustNoticeSeenAt`. Toast: "Agents ask first again. Change it in Permissions."
- **What changed** links to `docs/guides/permissions.mdx#what-changed`.
- When `permissions.sharedAtUpgrade` is not empty (PR5), the notice adds a line naming the apps, "Shared with every agent: Gmail, Calendar", each with **Choose agents**, which opens that app's "Who can use it?" panel on **Only agents I pick**. PR4 ships the notice without the line; PR5 adds it.
- Every block ≤ 15 words (`pnpm check:copy-length`), `writing-app-copy` voice.

Onboarding: `features/onboarding/ui/OnboardingPowerStep.tsx` renders the same component with heading "How your agents work" and buttons Continue / Keep asking me; both write `ui.trustNoticeSeenAt` and `completeStep('power')`. No "decide later": there is nothing to decide later.

`entities/binding/ui/BindingDialog.tsx:143` (`defaultCanInitiate: fullPowerChoice === 'full'`): read `trustPosture` instead, so the dialog keeps preselecting what it preselects for a Full-power install today. `canInitiate` itself is out of scope.

Control Center (`widgets/control-center`) shows the posture as "Trusted" or "Careful" with a link to Permissions.

### 5.10 Agent-only caps and the unattended alarm come off (PR3)

Operator scope addition, 2026-10-06 (DOR-2753 is cancelled and folded in here). Full power is assumed for agents, tasks and schedules, so the alarm that says so and the caps that apply only to our own agents go.

Caps removed (each is a refusal that applies to our agents only; none protects against an outsider):

- `rooms.maxPostsPerTurn` (3) and `rooms.maxCanvasOpsPerTurn` (3): the refusal in `rooms/messages/room-posting.ts` (`TOO_MANY_POSTS_THIS_TURN`) and the canvas counterpart; the two config leaves are retired (declared retired, deleted by PR3's migration key), with their `config-write-policy.ts` stake lines, `default-verdicts.ts` entries, the `RoomsTab` dials and `.claude/rules/room-conduct.md` lines.
- The reaction budget (`rooms/reactions/reaction-budget.ts`, 20 per agent per room per hour): deleted with its refusal and wiring.
- The notify budget (`services/relay/notify-budget.ts`, 10 notes per agent per hour): deleted with its refusal in `relay_notify_user`.
- Kept, because they protect against outsiders or keep the machine healthy: the relay per-sender rate limiter and backpressure, `/mcp` and A2A rate limits, the bridged-chat allowlists, and every loop guard (cascade guard, room turn budgets, relay turn ceiling, envelope hop budget; DOR-2745).
- `meta/agent-etiquette.md` E8, E16b, E18a are rewritten so the mechanism is review plus notice: the standard stays, the transcript and the audit trail are how it is held, and nothing refuses.
- ADR `261006-225605`: "DOR-2753 removes them after the audit trail lands" becomes "DOR-2739 removes them"; ADR `260814-195522` (agents may react, bounded by a rate) joins its amended list with the retired clause "bounded by a rate", and that ADR's own Status names the amendment.

The unattended alarm removed entirely:

- Server: `services/core/unattended-autonomy/` and the route or event that feeds the banner.
- Client: `widgets/app-banner/ui/UnattendedAutonomyBanner.tsx` and its entry in `widgets/app-banner/model/use-app-banners.tsx`, `shared/ui/unattended-autonomy-dialog.tsx`, `features/unattended-autonomy`, `entities/unattended-autonomy`, the confirm in `TaskFormInner.tsx`, `ScheduleApprovalCard.tsx`, `use-schedule-approval-power.ts`, `BindingAdvancedSection.tsx`, `scheduled-run-consequence.tsx`, `consent-ritual-copy.ts` (whatever is left after PR2), the Control Center line (`widgets/control-center/ui/ControlCenterBody.tsx`), and the dev showcases (`BannerShowcases.tsx`, `TrustDialShowcases.tsx`).
- No outsider-fed binding notice is kept: the banner never stopped anything, and what protects a binding from strangers is its prompting default and the chat allowlists, both pinned by the outsider tests.

Agents create agents like people do:

- `create_agent` is already tier `act` in area `agents` and both creation routes are open to agents by design (DOR-1829); under Trusted the area is Allowed, so no card. The one remaining asymmetry is creating an agent from a marketplace template (`TEMPLATE_CREATION_CAPABILITY_ID`, area-null destructive): PR4 lets it run without a card when the template comes from a configured source, the same rule as installs; the template's hooks and global plugins still ask.

Vocabulary in every PR here: "access level" means Owner/Admin/Member/Guest; "role and responsibilities" is the job on a profile. New copy and docs never call access levels roles.

Tests (PR3): the post and canvas refusals are gone (an agent posts a fourth time in one turn and it lands); a fifth `relay_notify_user` in an hour is delivered; a twenty-first reaction lands; the per-sender rate limiter still rejects a flood; the cascade guard still stops a two-agent loop (unchanged test kept green); the banner query and route are gone (client test asserts no banner for an unattended Full autonomy schedule); creating a schedule at Full autonomy opens no confirm; migration test reads both retired room leaves removed from `config.json`.

### 5.9 Docs, meta, contributing

Each PR carries the prose for what it changes (`writing-for-humans`; app strings `writing-app-copy`), plus a changelog fragment.

- PR1 (done): `docs/self-hosting/threat-model.mdx`, `docs/concepts/rooms.mdx`, `docs/guides/relay-messaging.mdx`, `contributing/interactive-tools.md`.
- PR2: `docs/guides/cli-usage.mdx` (remove `acknowledge-autonomy`, :120-125), `docs/guides/tool-approval.mdx`, `docs/getting-started/configuration.mdx`, `contributing/configuration.md` (the 428 sections, :211-236, :1195), `contributing/api-reference.md` (three 428s), `packages/cli/README.md`.
- PR4: `docs/guides/permissions.mdx` (rewritten around Trusted vs Careful, the perimeter, a "What changed" section), `docs/guides/action-approvals.mdx` (shrinks to perimeter and third-party code), `docs/guides/tool-approval.mdx` (when agents still stop: outsider messages, AskUserQuestion, plan mode, Careful), `docs/guides/task-scheduler.mdx` (agent schedules run at once; package and file schedules wait), `docs/getting-started/configuration.mdx` (defaults), `docs/self-hosting/threat-model.mdx` and `securing-your-instance.mdx` (trusted agents, guarded perimeter), `docs/concepts/mesh.mdx`, `docs/guides/agent-coordination.mdx`, `docs/guides/agent-discovery.mdx` (open by default), `docs/integrations/extensions.mdx` (agent-made extensions run), `docs/integrations/mcp-server.mdx` (:135-158, which actions still ask), `docs/guides/agents.mdx` (:92), `docs/glossary.mdx`, `docs/getting-started/quickstart.mdx`, `README.md`, `meta/brand-foundation.md` (:61 security posture, :182 pending-approval line, :227), `meta/dorkos-litepaper.md` (:95, :158, :165), `contributing/agent-operator-surface.md`, `contributing/configuration.md`, `contributing/extension-authoring.md`, `contributing/architecture.md` (namespace isolation section), `contributing/shapes.md` (Shape schedules still park, unchanged wording checked), `contributing/INDEX.md`.
- PR5: `docs/connections/index.mdx` (:57-69, every agent by default, the cancel window), `docs/connections/composio.mdx` (:81-84), `contributing/managed-connections-operations.md`.
- Not changed, checked: `docs/guides/flow/*`. They describe the `/flow` plugin's own dials and its `flow-drain` schedule, which is package content and still waits for approval.
- `docs/api/**` regenerates from OpenAPI.

## 6. PR split, in landing order

| PR  | Title                                                                                                                                            | Loosens anything?            | May merge                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------- |
| PR1 | Power flows downstream: per-turn ceilings for room posts, external authors and relay messages; A2A gets its own `outside-sender` origin          | No, only narrows             | Any time; ideally with or right after the pin tests |
| PR2 | Retire the full-autonomy acknowledgement                                                                                                         | Yes (removes a consent step) | After DOR-2738 has landed                           |
| PR3 | Agent-only caps (posts, canvas, notify, reactions) and the unattended alarm come off; etiquette and ADR wording follow                           | Yes                          | After PR2                                           |
| PR4 | Trusted by default: preset, Full autonomy, open mesh, agent schedules, agent extensions, templates from configured sources, migration and notice | Yes                          | After PR3                                           |
| PR5 | Connected apps: shared with every agent, and a cancel window for irreversible actions                                                            | Yes                          | After PR4 (reads `trustPosture`)                    |

Each PR is green alone: PR1 ships with `resolveAgentDmMode` returning `undefined`; PR2 changes no default; PR2, PR3 and PR4 each open their own migration key; PR5 only reads PR4's helper and stamp.

## 7. Tests, and what each proves

Migration and config tests read the outcome off `config.json` on disk, never `get`/`getDot` (safe-defaults rule; DOR-1496).

### PR1 (as built; each shown to fail with its fix removed)

| Test                                                                                                           | Proves                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes/claude-code/__tests__/claude-code-runtime-interactive.test.ts` "a turn held to a permission ceiling" | A Full autonomy conversation launches a stranger's turn at Default and another agent's at Accept edits; the next turn without a ceiling runs at Full autonomy again (the session is never rewritten); a session already below stays.                                       |
| `runtimes/claude-code/messaging/__tests__/interactive-handlers.test.ts`                                        | Under a ceiling, `canUseTool` in a bypass session raises a card instead of allowing.                                                                                                                                                                                       |
| `runtimes/codex/__tests__/codex-runtime.test.ts`                                                               | A bypass thread held to the default runs read-only; without the ceiling, full access.                                                                                                                                                                                      |
| `runtimes/opencode/__tests__/directory-grants.test.ts` "under a turn ceiling"                                  | A bypass session's ask auto-approves without a ceiling and asks the person with one.                                                                                                                                                                                       |
| `runtimes/__tests__/turn-permission-ceiling.test.ts`                                                           | `clampModeToCeiling` against every runtime's real modes, including cross-runtime by declared level and the Auto rule.                                                                                                                                                      |
| `rooms/__tests__/room-turn-runner.test.ts` (existing-conversation case)                                        | A stranger's turn in an existing Full autonomy room conversation reaches the dispatcher with its ceiling; an agent's poster level travels; a person's message carries none.                                                                                                |
| `rooms/__tests__/room-power-downstream.test.ts` (agent-message case, real service and trigger)                 | Bo's turn from Ana's post is held to the level Ana's turn ran at; with nothing kept, to the runtime default; a person's message is unbounded.                                                                                                                              |
| `core/turn-power/__tests__/turn-levels.test.ts`                                                                | Levels recorded per turn (ceiling, unconfirmed Auto, per-send vs stored, bounded memory); a post keeps the level of the turn that wrote it; `ceilingForEntry` for stranger, unresolvable, person, agent; the stranger → Ana (Full autonomy) → Bo chain is held to Default. |
| `packages/relay/.../agent-turn-ceiling.test.ts`                                                                | Agent, A2A and external MCP senders carry `'runtime-default'`; a binding-shaped turn does not; the binder receives the stamped sender.                                                                                                                                     |
| `session/origin/__tests__/turn-origin.test.ts`, `turn-origin-call-sites.test.ts`                               | `outside-sender` seeds nothing; `relayTurnOrigin` calls only `relay.agent.*` an agent DM; the census knows the relay call site can produce both.                                                                                                                           |

### PR2

| Test                                                                                                               | Proves                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `routes/__tests__/sessions.test.ts`: `PATCH` to Full autonomy with no acknowledgement                              | 200, recorded by the audit observer; no 428 anywhere (grep guard below).                                 |
| `config-autonomy-ack-retired-migration.test.ts`                                                                    | Key deleted from `config.json` on disk; other `ui` leaves preserved.                                     |
| `scripts`-free guard in `permission-semantics` tests: `AUTONOMY_ACK_REQUIRED` absent from `apps/`, `packages/` src | The ritual is gone everywhere, not just on one route.                                                    |
| `cli/config-commands.test.ts`                                                                                      | `acknowledge-autonomy` is no longer a command; `config set runtimes.defaultTrustStop autonomy` succeeds. |
| Client `ChatStatusSection`, `use-trust-stop-writes`, `BindingDialog`, schedule form tests                          | Picking Full autonomy writes straight through, no dialog.                                                |

### PR4

| Test                                                                                                                                                                                                                          | Proves                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission-presets.test.ts`                                                                                                                                                                                                  | `TRUSTED` pinned literally; Careful, Balanced, Full unchanged byte for byte; `presetTableFor(null) === TRUSTED`.                                                                                  |
| `resolve-permission.test.ts`                                                                                                                                                                                                  | Destructive area-level Allowed runs unless `consent: 'third-party-code'`; `permissions` resolves Allowed; `safety` and `reach` never Allowed; `alwaysAsks` still asks.                            |
| `permission-service.test.ts`, `change-permission.test.ts`, `routes/__tests__/permissions.test.ts`, CLI `permissions.test.ts`                                                                                                  | `FLOOR_NEVER_ALLOWED` only for `safety` and `reach`.                                                                                                                                              |
| `config-write-policy.test.ts`                                                                                                                                                                                                 | Under Trusted, an agent's `config_patch` on a loop-guard path (`rooms.maxAgentDepth`, relay ceilings) still asks.                                                                                 |
| `tier-enforcement` tests with each area-null destructive id in §5.1 under Trusted                                                                                                                                             | Each still returns `approval_required`.                                                                                                                                                           |
| `mcp-capabilities` test                                                                                                                                                                                                       | `mcp.add` / `mcp.update` still ask under Trusted; `mcp.import` runs.                                                                                                                              |
| `marketplace-capabilities` test                                                                                                                                                                                               | Install from a configured source under Trusted runs with no confirmation token; under Careful asks; a package's hooks still raise the hook card.                                                  |
| `config-trusted-posture-migration.test.ts`, one case per row of §5.7 (null; full; balanced; careful; null + supervised; stop `act`/`ask`/`autonomy`; per-runtime `ask`; `defaults` with Ask entries)                          | Each outcome read off `config.json`; door fields gone; notice leaf as specified. Fails with the body deleted.                                                                                     |
| `migration-safety.test.ts`, `migration-append-only.test.ts`                                                                                                                                                                   | Key above the newest tag; pinned hash.                                                                                                                                                            |
| `protected-state.test.ts`: Ajv-invalid file on a Careful install with an `ask` stop                                                                                                                                           | After recovery: preset `careful`, stop `ask`, Ask defaults survive. Fails without the carryover.                                                                                                  |
| `default-verdicts.test.ts`                                                                                                                                                                                                    | New leaves classified; the two permissive entries carry reasons.                                                                                                                                  |
| `create-task` / `routes/tasks.test.ts` / `task-tools-file-first.test.ts`                                                                                                                                                      | Agent create under Trusted: `active`, audit `schedule.armed_by_agent`, notification with Pause; under Careful: `pending_approval`. Discovery/Shape/package create: parks and clamps under both.   |
| `task-approvals` test                                                                                                                                                                                                         | Agent edit to an agent-made row re-keys; to a file row parks.                                                                                                                                     |
| `extension-manager.test.ts`, `extension-agent-tools.integration.test.ts`                                                                                                                                                      | `create_extension` under Trusted runs without approval and records `extension.auto_approved`; a marketplace copy of the same id at another path waits; widened permissions re-ask; Careful waits. |
| `seed-open-mesh.test.ts`                                                                                                                                                                                                      | First boot writes `* → *` and stamps; second boot, after a person turned it off, leaves it off.                                                                                                   |
| `session-start-permission` test                                                                                                                                                                                               | Registered-agent token from `/mcp`: ceiling = that agent's stop; `MCP_API_KEY`/unidentified: `acceptEdits`.                                                                                       |
| Agent DM test (adapter + resolver)                                                                                                                                                                                            | Sender at Full autonomy → receiver at its configured stop; sender at `default` → `default`; no stamp → `default`.                                                                                 |
| `outsider-protections.*` pins                                                                                                                                                                                                 | All green with the defaults flipped: this is the test that makes the flip safe.                                                                                                                   |
| Client `TrustNoticeMoment.test.tsx`, `OnboardingPowerStep.test.tsx`, `use-moments.test.tsx`                                                                                                                                   | Shows once; Keep asking me writes Careful then the stamp; hidden for Careful.                                                                                                                     |
| e2e: replace `full-power-door.spec.ts` and `onboarding-power.spec.ts` with `trust-notice.spec.ts`; update `permissions/agent-permissions.spec.ts`, `permissions/full-power-preset.ts`, `fixtures/tasks-api.ts`, capture seeds | Real browser: fresh install shows the statement in onboarding; a seeded pre-flip config shows the notice once; Keep asking me lands on Careful.                                                   |

### PR5

| Test                                                                                                                                                    | Proves                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector-authentication-flow-service.test.ts`, `connection-store.test.ts` (replaces "A new connection starts ready: nobody holds access" at :168-177) | New connection under Trusted: an `every_agent` level row (`read-write` or `read`), grants after `followCatalog`; reconnect does not rewrite; Careful: none.                                                                        |
| `trusted-connections-backfill.test.ts`                                                                                                                  | Only connections with no level rows and no grants get the row; `permissions.sharedAtUpgrade` names them; stamped; idempotent.                                                                                                      |
| `TrustNoticeMoment.test.tsx` (PR5 case)                                                                                                                 | The shared apps are listed; Choose agents opens that app's panel.                                                                                                                                                                  |
| `destructive-hold.test.ts` (fake timers)                                                                                                                | Eligible call: notification raised, nothing dispatched before 60 s, dispatched after with `via: 'hold'`; cancel by a person or another agent → `CANCELLED`, never dispatched; cancel by the requester refused; turn abort cancels. |
| `execution-broker.test.ts`                                                                                                                              | `via: 'hold'` with a wrong digest → `CONNECTOR_APPROVAL_BINDING_MISMATCH`, at both checks.                                                                                                                                         |
| Same, prompting session / no-chat `/mcp` / Careful                                                                                                      | Still `approval_required`.                                                                                                                                                                                                         |
| `sdk-client` classification fixtures                                                                                                                    | Unchanged (classification is not touched).                                                                                                                                                                                         |

## 8. What is not done

- Loop guards and the Safety limits area: kept at Ask with the floor, and the loop-guard config fields stay operator-only. Revisit with DOR-2745.
- `canInitiate`; access levels (Owner/Admin/Member/Guest); person bars → access-level checks; collapsing presets, `request_permission`, arrival narrowing and the upgrade sweep; deleting the Balanced and Full tables.
- The cross-runtime carry-over cap (`session/fleet/carry-over-power.ts`), the `control_ui` refusal, `alwaysAsks` cards (so changing an agent's runtime or model still shows a card), NOPE.md as `act`.
- Arming schedules that are already parked, and approving extensions already waiting: both are open questions to a person.
- An injection-taint rule for connector actions (ask only when the turn read outside content). The cancel window is the chosen mitigation; taint is a possible follow-up.
- A real undo for services that offer one (Gmail trash restore): Composio exposes none today; the copy promises only Cancel.
- The local-trust residual: with login off, an agent with a shell can still call the person's HTTP routes, and `POST /api/relay` lets a `relay.human.*` sender shape a turn's mode. Login remains the boundary.

## 9. Corrections to the trust audit (`08`)

1. Its "agent DMs and our own session_start → configured stop" would launder a stranger's turn into Full autonomy through auto-allowed `relay_send`; it missed that room posts already do this and that external authors are only protected on a new row. PR1 exists for this.
2. An area-level Allowed never skips the marketplace install confirmation (`personAlreadySaidYes`); "Allowed from trusted sources" needs §5.1's change, not just a preset value.
3. There are twelve state areas (`own_chat` was added), and the hidden Unchanged table already Allows packages and settings; the strict parts are rooms and the three floors.
4. The destructive post-rule decides only eight area-bearing actions (one, `operator.update_agent_execution`, asks anyway through `alwaysAsks`); every perimeter and third-party-code destructive action has no area and asks on its own.
5. The flow guides need no rewrite: `flow-drain` is package content and still waits.
6. `mcp-tool-tiers.ts` lives at `services/core/mcp-tool-tiers.ts`, not under `capabilities/`.
7. Not in 08: a wipe after the flip would widen a Careful install, so the preset and stricter stops need carryover (§5.7).

## 10. Decisions

Made here, recorded for review:

- Trusted is a new preset id; Full, Balanced and Careful stay frozen. The picker offers Trusted and Careful.
- Careful or "Keep asking me" is respected at migration; undecided, Full and Balanced move.
- An explicit `'ask'` global stop survives the migration even when the areas move.
- The cancel window is a 60-second hold before the action, eligible only from a session that already never asks.
- Open mesh is seeded once for everyone, Careful included; the switch stays where it is.

Decided by the operator (2026-10-06):

- **D1. Existing connections at upgrade:** yes. A connection nobody was given access to becomes shared with every agent at Read and write, once. The notice names each app and offers one-click narrowing.
- **Safety limits:** stays at Ask with its floor in Trusted; loop-guard fields stay operator-only. Revisit with DOR-2745.
- The cancel window as designed in §5.6, and every call listed above.
