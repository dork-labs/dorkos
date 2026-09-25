---
id: 260925-002601
title: DorkOS's own git gets full hardening; agent sessions get bare-repository and fsmonitor settings only
status: accepted
created: 2026-09-24
spec: null
superseded-by: null
---

# 260925-002601. DorkOS's own git gets full hardening; agent sessions get bare-repository and fsmonitor settings only

## Status

Accepted (DOR-2326).

## Context

A folder can be shaped like a git directory: `HEAD`, `objects/`, `refs/` and a `config` at its root. Git run anywhere inside it takes that `config` as the repository's own, and settings such as `core.fsmonitor` name a program git runs. So `git status` in such a folder ran code. A marketplace package could ship exactly that shape, and both DorkOS and agent sessions run git in package folders.

Git reads settings passed with `-c` or in its environment (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`) ahead of a repository's own. Three settings close the path:

- `safe.bareRepository=explicit`: git refuses a repository it only found by walking up from where it runs (git 2.38+).
- `core.fsmonitor=` (empty): no file-system monitor program. Empty rather than `false`, because before 2.36 git reads the value as a program's path and would run one named `false`.
- `core.hooksPath=/dev/null` (`NUL` on Windows): no hook program.

The environment form needs git 2.31. The repo's git floor is 2.25.

## Decision

One helper, `@dorkos/shared/git-hardening`, holds the settings in two sets.

**Git DorkOS runs itself gets all three**, as `-c` arguments on every call (status, the file list, the diff baseline, the workspace provider's reads, the rooms repo, the mesh manifest check, the marketplace fetch and the template clone), and in the environment too where `hardenedGitEnv()` builds it. `-c` works on every git version. DorkOS never needs a repository's hooks to read status, list files or fetch a package.

**Agent sessions get the first two only**, added to the environment every runtime child is spawned with (`runtimeEnvironment()`, for Claude Code, Codex and OpenCode). Hooks stay the person's: an agent commits and checks out in the person's own repositories, where their hooks (formatters, linters, pre-commit checks) are how they work, and turning them off would silently skip those checks for everything an agent does. Hooks run on commit, checkout and merge, not on reading a folder, and a package cannot plant one, because the install drops every `.git` it brings.

Workspace creation (`worktree add`, `clone`, `checkout -b` in the person's repository) changes their repository on their behalf, so it uses the session set and their `post-checkout` hook runs.

**The marketplace refuses the shape itself**, whatever git is installed: a package root holding `HEAD` with `objects/`, `refs/` or `packed-refs`, or a `.git` file saying `gitdir:` (except from a local folder, where that file is a worktree's own link), and, for agents, a root `config`, `worktrees/` or `packed-refs`. Staging drops every `.git` at any depth, and the content hash leaves them out.

**Git 2.38 is the minimum for full protection.** DorkOS reads `git --version` once at startup; below 2.38 it logs a plain warning, and the same line appears in `GET /api/health/deep` and `dorkos doctor`. On 2.31 to 2.37 sessions get the fsmonitor setting only; below 2.31 they get nothing, and DorkOS's own git gets fsmonitor and hooks.

## Consequences

### Positive

- Reading a folder can no longer run its program through git, for DorkOS or for any agent, on git 2.38 or later.
- A person's own repositories and hooks behave as before for their agents.
- One helper and one census of call sites, pinned by an exploit test that plants the folder and runs every path.

### Negative

- Git in a very large repository whose owner set up a file-system monitor checks for changes the slower way.
- Git run from inside a bare repository needs `--git-dir`. On git 2.38 to 2.44, git run from inside `.git` or `.git/modules/<name>` is refused too (2.45 relaxed that).
- Filters, diff and merge drivers, credential helpers and `core.sshCommand` are not overridden; on git older than 2.38 the marketplace's shape refusal is the only guard for them.
- The terminal (the person's own shell) is not hardened, on purpose.
