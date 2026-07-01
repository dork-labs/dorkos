---
number: 304
title: File-Scoped Rollback for Marketplace Installs (Stage + Target Backup + Activate)
status: accepted
created: 2026-06-30
supersedes: 231
superseded-by: null
---

# 304. File-Scoped Rollback for Marketplace Installs (Stage + Target Backup + Activate)

## Status

Accepted (supersedes the rollback approach of ADR-0231).

## Context

ADR-0231 established the shared `runTransaction({ name, rollbackBranch, stage, activate })` engine that every marketplace install flow runs through. Its real transactional guarantee (an isolated `mkdtemp` staging directory plus a single atomic `rename` onto the install root via `atomicMove`) was sound and remains. Its optional rollback safety net was not:

- **Wrong repository.** The `rollbackBranch: true` path created a git backup branch in `process.cwd()` (the server's working directory, i.e. the DorkOS repo) and, on failure, ran `git reset --hard <branch>` there. Installs write to the install target (`<projectPath>/.dork/plugins/<name>` or `<dorkHome>/plugins/<name>`), which is a different location entirely. The rollback protected the wrong tree.
- **Cannot restore what it installs.** Installs write gitignored files under `.dork/`. A `git reset --hard` never touches ignored files, so even when it ran against the right tree it could not restore or remove the very files the install created.
- **Destructive footgun.** `git reset --hard` reverts every uncommitted tracked-file change in the whole worktree, not just the install destination. ADR-0231's own "Hazard" section documents this destroying four unrelated files during a test run. To avoid detonating it, every test that exercised a `rollbackBranch: true` flow had to mock `_internal.isGitRepo` to return `false` in `beforeEach` (enforced by convention, unenforceable by types). Miss the mock and a failure-path test silently wipes uncommitted work.

ADR-0231 flagged this and called for "a future hardening pass [that] should redesign the rollback path so it operates against a per-install subtree ... so the test gymnastics are no longer required." This ADR is that pass.

The insight is that no git is needed at all. The install target is a single directory. A crash-safe rollback for a single directory is a filesystem operation: move the existing target aside before activating, restore it if activation fails, delete it if activation succeeds. That works for gitignored files (it is pure `fs`), it is scoped to the actual install location, and it has no destructive reset.

## Decision

Rework the shared engine to be file-scoped and git-free. The new signature drops `rollbackBranch` and takes the install `target`:

```typescript
runTransaction<T>(opts: {
  name: string;
  target: string;
  stage: (staging: { path: string }) => Promise<void>;
  activate: (staging: { path: string }) => Promise<T>;
}): Promise<T>;
```

Lifecycle:

1. **Stage.** Create a `mkdtemp` staging dir under `os.tmpdir()` and run `stage`. A `stage` failure removes the staging dir and re-raises. No backup has been taken yet, so `target` is untouched.
2. **Backup.** If `target` already exists, move it aside to a uniquely-named sibling (`<target>.dorkos-bak-<timestamp>`) via `atomicMove`. A sibling keeps the backup on the same filesystem as `target`, so both the move-aside and any restore are a cheap atomic rename. A fresh install (target absent) takes no backup.
3. **Activate.** Run `activate`, which performs its single atomic `atomicMove(staging, target)` (and any follow-up such as extension enable or adapter registration).
   - **Success:** delete the backup (if any) and remove the staging dir. Both are best-effort and logged on failure; the install already landed.
   - **Failure:** remove any partially-written `target`; if a backup was taken, restore it onto `target` via `atomicMove`; remove the staging dir; re-raise the original error. Every cleanup and restore step is wrapped defensively so a cleanup error never masks the original transaction error.

All four install flows (`install-plugin`, `install-agent`, `install-skill-pack`, `install-adapter`) pass `target` and no longer pass `rollbackBranch`. The uninstall flow (`flows/uninstall.ts`) keeps its own staging + restore path unchanged, still sharing the `atomicMove` helper. The `InstallResult.rollbackBranch` field is removed from `types.ts`, the four flows, and the OpenAPI response mirror in `openapi-registry.ts`.

The git helpers (`isGitRepo`, `createBackupBranch`, `rollbackToBranch`, `deleteBackupBranch`) and the `BACKUP_BRANCH_PREFIX` are deleted. The `_internal` test-only export now surfaces only the filesystem helpers (`moveTargetAside`, `cleanupStaging`, `removePath`) so tests can simulate a cleanup or restore failure without corrupting the runner's temp dir.

### The transactional guarantee

The real guarantee was always the staging dir plus a single `atomicMove(staging, target)` in `activate`: either the package is fully installed and visible, or it never existed. This ADR extends that guarantee to reinstalls: because the previous target is moved aside before activation, a reinstall that fails mid-activate restores the previous installation byte-for-byte instead of leaving a half-overwritten directory. Overwrite installs, which the old design could not express safely (a pre-existing target blocked the rename), now succeed by design.

## Consequences

### Positive

- **Correctly scoped.** Rollback operates on the install target, not `process.cwd()`. It works for gitignored `.dork/` files that a `git reset` cannot touch.
- **No destructive reset.** `git reset --hard` is gone. A failure-path test can no longer wipe uncommitted work in the calling worktree.
- **No test gymnastics.** The mandatory `vi.spyOn(_internal, 'isGitRepo').mockResolvedValue(false)` convention is deleted. Flow, integration, and failure-path tests run against a temp `dorkHome` with no git mock at all.
- **Safe reinstalls.** Overwrite installs are now first-class: the prior installation is preserved through a failed activation and reaped on success.
- **Simpler surface.** No git subprocess calls, no branch bookkeeping, no `rollbackBranch` field threaded through the flows and the HTTP response.

### Negative

- **Backup lives next to the target.** The move-aside backup is a sibling of the install root for the duration of the transaction. On a hard crash mid-activate the process cannot restore it, leaving a `<target>.dorkos-bak-<ts>` directory behind. This is a visible, self-describing artifact (easy to spot and reap) rather than silent data loss, but a janitor sweep of `*.dorkos-bak-*` under the plugins root is a reasonable follow-up.
- **Two renames on an overwrite.** An overwrite install now does move-aside plus activate-move (plus a delete on success), where a fresh install does one. Both are atomic renames on the same filesystem; the cost is negligible.
- **`activate` is still assumed atomic.** As with ADR-0231, the contract that `activate` performs a single mutating rename is a convention, not enforced by types. A flow that runs several non-atomic mutations inside `activate` still weakens the guarantee; the target backup restores the directory but cannot undo external side effects (which is why the adapter flow keeps its own `removeAdapter` compensation).

## Alternatives Considered

- **Keep the git backup branch, scope it to a subtree** (e.g. `git worktree add` or an isolated temp repo, as ADR-0231 suggested). Rejected: it still cannot restore gitignored `.dork/` files, still assumes the install target is inside a git tree (global `~/.dork/` installs are not), and adds git-worktree machinery for a problem that is fundamentally a single-directory move.
- **Filesystem snapshot of the whole install root.** Rejected for the same reasons ADR-0231 rejected it: heavyweight and slow for large trees, with no benefit over moving the one target directory aside.
- **Copy the target aside instead of renaming it.** Rejected: a recursive copy is slower and non-atomic (torn-read hazard on a large tree), where a same-filesystem sibling rename is atomic and O(1). `atomicMove` already falls back to copy + remove only when the rename genuinely crosses devices (`EXDEV`).
