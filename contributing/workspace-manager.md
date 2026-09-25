# WorkspaceManager

Server-managed isolated workspaces — one per unit of work (issue id / spec slug),
bound to agent sessions via `SessionOpts.cwd`. Graduates the operator-run `gtr`
worktree flow into a first-class server entity with collision-free port
allocation. Spec: `specs/workspace-manager/`. ADRs: [0283](../decisions/0283-workspace-provider-hexagonal-port.md),
[0284](../decisions/0284-server-is-the-port-authority.md). Builds on ADR-0043.

## The shape

```
packages/shared/src/workspace.ts          # the contract: Workspace entity, WorkspaceProvider
                                           # port, WorkspaceManager interface, DTOs, derivePorts
packages/db/src/schema/workspace.ts        # the `workspaces` derived-cache table
apps/server/src/services/workspace/
  workspace-store.ts                       # file-first write-through (sidecar manifest = truth)
  port-allocator.ts                        # lowest-free contiguous block (collisions impossible)
  providers/worktree.ts | clone.ts | git.ts# WorkspaceProvider impls + shared git + dirty-state
  hooks.ts                                 # Symphony's 4 hooks (.dork/workspace.json)
  port-env.ts                              # writes the allocated block into the workspace .env
  workspace-gate.ts                        # what a new workspace brings, and who sees it (DOR-2335)
  workspace-service.ts                     # the WorkspaceManager (ensure/list/resolve/remove/…)
  workspace-reconciler.ts                  # 5-min cache↔manifest sync
  worktree-scan.ts                         # read-only adoption scan of the root (DOR-1056)
  index.ts                                 # createWorkspaceSubsystem() + get/setWorkspaceManager()
apps/server/src/routes/workspaces.ts       # /api/workspaces
apps/client/src/layers/entities/workspace  # useWorktreeScan, useWorkspaceForSession
apps/client/.../features/status/GitStatusItem.tsx     # the session-view indicator
apps/client/.../widgets/workspaces         # the /workspaces page (read-only)
```

The app reads workspaces and never mutates them: `Transport` carries only
`scanWorktrees` and `resolveWorkspace`. Provisioning, pinning, and removal stay
HTTP-only (`POST /api/workspaces`, `/:id/pin`, `DELETE /:id`) for tools, scripts,
and the session `workspaceKey` rung — so no click in the UI can delete a
checkout another agent is working in (DOR-1056).

## Key seams

- **Binding is cwd.** A session is bound to a workspace by running its turn with
  `cwd = workspace.path`. There is **no `AgentRuntime` change**. The opt-in entry
  point is `workspaceKey` on `POST /api/sessions/:id/messages`: when present the
  server `ensure`s the workspace and overrides the turn's cwd + injects the port
  block. Absent → unchanged behavior.
- **Persistence is file-first (ADR-0043).** The sidecar `<root>/<projectKey>/<key>.workspace.json`
  is the source of truth; the `workspaces` table is a rebuilt cache. Always write
  the manifest before the DB; delete the manifest before the row.
- **Cleanup is conservative.** `remove`/`sweep` call `provider.isDirty` and refuse
  a workspace with uncommitted / untracked / unpushed work unless `force` is
  passed; `pinned` workspaces are exempt from `sweep`. The DELETE route returns a
  `200` with `{ removed:false, blocked:'dirty' }` (not a 409) so the client can
  escalate to a force-confirm.
- **A new workspace is shown before anything runs there (DOR-2335).** `ensure`
  takes a `WorkspaceGate` and refuses to make a workspace without one. A clone
  is staged in `<root>/.staging/` (no scan lists dot folders) and read there by
  `inspectWorkspace`. It records the harness configuration, each settings file
  written out, what the clone's skills run, every link, and the source
  `workspace.json` `after_create` and `before_remove` commands, which run from
  the server with no permission prompt. Then the gate decides:
  - **A person** is shown a workspace that brings anything (409
    `workspace_needs_review` on `POST /api/workspaces`) and sends back
    `approvedReviewHash`.
  - **An agent** gets a `workspaces.create` approval card for every clone and
    for a worktree whose source runs hooks. It retries with
    `confirmationToken`.
  - **A caller that cannot carry a token** remembers its pending card per
    workspace, so each turn does not raise another. These are the session
    `workspaceKey` turn and an agent's managed checkout.

  Only after the gate passes does the staged clone move into place, the
  `after_create` commands that were shown run, and the `before_remove` commands
  that were shown land on the manifest as `removeHooks`. Those are the only
  hooks `remove` runs. `before_run` and `after_run` are parsed but never run.
  - **A workspace made before `removeHooks` existed.** A person removing one
    whose source declares `before_remove` gets a 409
    `remove_hooks_need_review` listing the commands. They can run exactly
    those with `?approvedRemoveHooks=<reviewHash>`, or skip them with
    `?skipRemoveHooks=true`. Any other caller, and `sweep`, skips them. The
    result lists whatever was skipped in `skippedHooks`.
  - **A person's remembered worktree hooks.** A person's approval of their own
    worktree's hooks is kept in the operator-only hook decision list
    (`harness.approvedHooks`) as `<source real path>@workspace-<digest>`. The
    digest covers the provider and both hook lists. `dorkos harness hooks
--list` shows it, and `--revoke <folder>` forgets it. An unchanged hook set
    passes without asking; a changed command asks again. It never covers a
    clone and never applies to an agent.
  - **Card tiers.** A card that brings nothing is `workspaces.create` (`act`).
    One with settings, links, skill effects or hooks is
    `workspaces.create_with_effects` (`destructive`).
  - **Remembered cards.** They are keyed by the source's real path and the
    destination. After a restart, `ConfirmationProvider.reopen`
    (`ApprovalService.reissue`) rotates a fresh token onto the card still open
    for exactly the same request, instead of raising a second one.
  - **Boot.** `sweepStaging` clears `<root>/.staging/` before anything can
    stage.

- **Ports.** The server is the authority for managed workspaces (allocate block →
  write `.env`). `worktree-setup.sh`'s hash derivation is the offline fallback for
  plain `gtr` worktrees.

## Extending

- **A new provider** (`container`, `remote`): implement `WorkspaceProvider`
  (`create`/`remove`/`isDirty`) in `providers/`, add it to the enum + the
  `providers` map in `createWorkspaceSubsystem`. The generic layer is unchanged.
- **The v2 naming layer** (DOR-91): the entity already reserves `hostname`/`url`;
  populate them in the service + surface in the UI. No migration needed.

## Config

`config.workspace` (`UserConfigSchema`): `enabled`, `rootPath` (null →
`<dorkHome>/workspaces`), `portBase`, `portBlockSize`, `defaultProvider`,
`retentionCap`. Disabling it makes `getWorkspaceManager()` unset; the session
path degrades gracefully (uses the supplied cwd).
