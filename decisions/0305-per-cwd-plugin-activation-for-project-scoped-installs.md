---
number: 305
title: Per-cwd plugin activation for project-scoped installs
status: accepted
created: 2026-07-02
spec: marketplace-scoped-install-visibility
superseded-by: null
---

# 0305. Per-cwd plugin activation for project-scoped installs

## Status

Accepted (implemented in spec: marketplace-scoped-install-visibility)

## Context

Claude runtime plugin activation used a single global `activatedPlugins`
array, scanned from `<dorkHome>/plugins` only and applied to every session
regardless of cwd. A plugin installed to a specific agent
(`<projectPath>/.dork/plugins/<name>`) therefore never reached the SDK: with
flow installed only on an agent, that agent's cwd reported zero flow commands
(empirically isolated). Harness auto-projection deliberately skips the
claude-code harness on the assumption the SDK covers it, so nothing
compensated.

## Decision

Resolve the SDK `options.plugins` array per session cwd at dispatch time:
merge the global activated set with `<cwd>/.dork/plugins/*` (directories
bearing a package manifest), deduplicated by directory basename with the
project-scoped copy winning — the install directory name IS the package name,
so basename comparison is exact. The same merged resolution feeds the
command-warm probe, and a project-scoped install/uninstall drops that cwd's
cached SDK command list (after the live-session reload) so the palette
re-warms with the new set. The filesystem is scanned fresh on every dispatch:
no per-cwd cache exists to invalidate, and the walk is one readdir plus a
manifest stat per local package on a non-hot path.

## Consequences

### Positive

- Agent-scoped installs actually function for their agent's sessions —
  commands, skills, and hooks arrive with the next message or palette warm.
- No cache-coherence machinery: fresh scans cannot go stale, and the
  behavior works for any directory, registered agent or not.
- A scoped install of an already-global package cleanly shadows the global
  copy instead of double-registering with the SDK.

### Negative

- One readdir per message dispatch and per cold-cache palette fetch
  (negligible, but nonzero).
- Sessions opened in a _subdirectory_ of an agent's project do not inherit
  its local plugins (exact-cwd match only); a git-root walk-up is a captured
  polish item.
- Live sessions launched before a scoped install only pick it up on their
  next message — `reload_plugins` re-reads the init-time plugin set and
  cannot add new entries.
