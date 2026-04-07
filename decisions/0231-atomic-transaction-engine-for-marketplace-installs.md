---
number: 231
title: Atomic Transaction Engine for Marketplace Installs (Stage + Backup Branch + Activate)
status: draft
created: 2026-04-06
spec: marketplace-02-install
extractedFrom: marketplace-02-install
superseded-by: null
---

# 231. Atomic Transaction Engine for Marketplace Installs (Stage + Backup Branch + Activate)

## Status

Draft (auto-extracted from spec: marketplace-02-install)

## Context

A marketplace install touches many places at once: it clones a package, compiles extension code, copies SKILL.md files into one or more destination directories, mutates `.dork/relay/adapters.json`, registers agents in the mesh, and updates the installed-package manifest. Any of those steps can fail. Without a transactional discipline, a half-installed package leaves the user in an unrecoverable state — secrets prompted but not stored, a registry mutated but the files missing, an agent registered against a directory that does not exist.

The existing `template-downloader.ts` had already established a working pattern for atomic git-clone-then-rename. The marketplace needs the same guarantee, but generalised across four flows (plugin / agent / skill-pack / adapter), each with its own definition of "activate".

Three transactional strategies were considered:

- **Per-flow ad hoc try/finally** — Every install flow rolls its own staging and cleanup. Highest flexibility but copy-pasted error paths and inconsistent rollback semantics. Rejected for the same reason all four flows share `transaction.ts`: rollback correctness must be a single shared concern.
- **Filesystem snapshot library** (e.g. `fs-extra` based) — Snapshot the entire install root before the operation, restore on failure. Heavyweight, slow for large `~/.dork` trees, and offers no story for git-tracked project files.
- **Generic stage + activate engine with optional git backup branch** — A single `runTransaction({ name, rollbackBranch, stage, activate })` primitive. `stage` builds the package contents in an isolated `mkdtemp` staging directory. `activate` performs the single mutating operation (typically an atomic `rename` onto the install root). On any thrown error from `stage` or `activate`, the staging directory is removed and (if `rollbackBranch: true` and CWD is a git working tree) `git reset --hard` restores the working tree to a backup branch created at the start of the transaction.

## Decision

Implement a single shared transaction engine at `apps/server/src/services/marketplace/transaction.ts` exposing one function:

```typescript
runTransaction<T>(opts: {
  name: string;
  rollbackBranch: boolean;
  stage: (staging: { path: string }) => Promise<void>;
  activate: (staging: { path: string }) => Promise<T>;
}): Promise<T & { rollbackBranch?: string }>;
```

Lifecycle: create temp staging dir → optional git backup branch → `stage` → `activate` → cleanup. On any thrown error from `stage` or `activate`, the staging dir is removed and the backup branch (if any) is restored before the original error is re-raised. Cleanup errors on the success path are logged but never fail the transaction — the install already succeeded; the leftover temp dir is a janitorial concern, not a correctness one.

All four install flows (`install-plugin`, `install-agent`, `install-skill-pack`, `install-adapter`) go through this primitive. The uninstall flow (`flows/uninstall.ts`) implements its own staging+rollback because its semantics differ — it stages the _existing_ installation into a temp dir, runs side-effect cleanup, restores preserved data, and only then commits — but it shares the same EXDEV-safe `atomicMove` helper for the rename steps. The `atomicMove` helper at `lib/atomic-move.ts` provides the cross-device rename used inside every `activate` callback and inside the uninstall stage/restore steps.

### Hazard: `git reset --hard` is destructive across the entire worktree

The git backup branch path uses `execFile('git', ['reset', '--hard', branch], { cwd: process.cwd() })`. **In a development worktree this resets every uncommitted tracked-file change in the entire repository** — not just the install destination. During Session 1 this destroyed additive edits to four unrelated files (`template-downloader.ts`, `mesh-schemas.ts`, `agent-creator.ts`, `apps/server/package.json`) because failure-path tests legitimately exercised the rollback path against the live worktree. Untracked files survived (the new `services/marketplace/` directory), but every modified tracked file silently reverted.

Consequently:

1. Any Vitest test that exercises `runTransaction({ rollbackBranch: true })` MUST mock `transactionInternal.isGitRepo` to return `false` in `beforeEach`. The shared marketplace test fixtures and integration helpers do this by default.
2. `install-adapter.ts` deliberately passes `rollbackBranch: false` because the only mutation is a single JSON file edit — git rollback would be more dangerous than the failure mode.
3. A future hardening pass should redesign the rollback path so it operates against a per-install subtree (e.g. `git stash --include-untracked` scoped to the install root, or run inside an isolated temp git repo) so the test gymnastics are no longer required.

## Consequences

### Positive

- All four install flows share one rollback discipline. New flows added in spec 03 / spec 05 only need to define `stage` and `activate`.
- Failure mode is uniform: either the package is fully installed and visible, or it never existed. No partial state survives a crash.
- The `name` parameter feeds both the staging directory suffix and the backup branch name, so leftover artifacts are easy to find and reap with a single prefix glob (`dorkos-install-*`, `dorkos-rollback-*`).
- The `_internal` test-only export makes the git interaction stub-able without monkey-patching `node:child_process`.

### Negative

- The git backup branch is a footgun in a live worktree (see Hazard above). Future flows MUST honour the test mock convention or risk destroying unrelated work during failure-path tests.
- Backup-branch creation runs even when the install will not modify any git-tracked files, costing one `git rev-parse` and one `git branch` per install when CWD is a repo. Negligible in practice but worth flagging.
- Cleanup-on-success failures only log a warning. A pathological case (full disk, permission flip mid-install) can leave staging directories behind. The cache prune flow does not currently sweep `${tmpdir}/dorkos-install-*` — adding that to a janitor task is a follow-up.
- The contract that `activate` performs a single mutating operation is a convention, not enforced by types. A flow author who runs multiple non-atomic mutations inside `activate` weakens the rollback guarantee.

## Alternatives Considered

- **Per-flow try/finally** — Rejected. Three of the four flows need identical setup/cleanup; sharing reduces the surface where rollback bugs can hide.
- **Filesystem snapshot** — Rejected. Heavy, no story for project-tracked files, and the existing template-downloader pattern already proves the staging+rename approach is sufficient.
- **`git worktree add` instead of a backup branch** — Considered for the rollback safety net. A scratch worktree would isolate the destructive `git reset --hard` from the live working tree and side-step the hazard above. Rejected for v1 because it adds a new dependency on git worktree semantics that DorkOS does not yet use elsewhere; flagged as the natural next step when the rollback path is hardened.
