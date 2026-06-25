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
  workspace-service.ts                     # the WorkspaceManager (ensure/list/resolve/remove/…)
  workspace-reconciler.ts                  # 5-min cache↔manifest sync
  index.ts                                 # createWorkspaceSubsystem() + get/setWorkspaceManager()
apps/server/src/routes/workspaces.ts       # /api/workspaces
apps/client/src/layers/entities/workspace  # useWorkspaces, useWorkspaceForSession
apps/client/.../features/status/GitStatusItem.tsx     # the session-view indicator
apps/client/.../widgets/workspaces         # the /workspaces page
apps/client/.../features/workspace-management         # pin + dirty-safe remove
```

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
