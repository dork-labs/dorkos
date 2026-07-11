---
id: 260711-142049
title: 'Diff base: per-session pre-edit snapshot over git working tree'
status: proposed
created: 2026-07-11
spec: diff-viewer
superseded-by: null
---

# 260711-142049. Diff base: per-session pre-edit snapshot over git working tree

## Status

Proposed

## Context

The diff viewer (DOR-212) auto-opens a per-hunk review surface whenever the attached session's
agent edits a file, but agent edits land directly on disk before the server ever observes them —
by the time a `tool_call` event arrives, the bytes are already written. Three candidate diff bases
were considered: **git working tree vs HEAD** (conflates the agent's edits with the operator's own
pre-existing uncommitted changes — the operator would be asked to "reject" their own work — and
doesn't work in a non-git cwd); **reconstructing the pre-edit content from the tool-call stream**
(`Edit`/`MultiEdit` inputs carry reversible `old_string`/`new_string`, but `Write` carries only the
new full content, so a `Write`-first file has no recoverable pre-image; also brittle across
interleaved user edits); and a **server-captured pre-edit snapshot** scoped to the session.

## Decision

We will use a per-session pre-edit snapshot, keyed `(sessionId, absPath)`, as the diff base. The
server captures the current on-disk bytes the first time an edit-family tool (`Edit`, `Write`,
`MultiEdit`, `NotebookEdit`) is about to touch a path with no snapshot yet in that session
(first-touch-wins); every later edit to the same file keeps the same baseline. The primary capture
point is the claude-code adapter's PreToolUse hook, which reads the file synchronously before the
SDK applies the edit. When no pre-tool snapshot exists, a fallback ladder resolves the baseline:
reverse-apply `new_string`→`old_string` from the first observed `Edit`/`MultiEdit` against current
disk; otherwise `git show HEAD:<path>` if the file is git-tracked; otherwise an empty baseline (the
whole file reads as added). Baselines are stored as `Buffer` (binary-safe from day one), live in an
in-memory per-session map, are never persisted across a server restart, and are dropped when the
session's stream closes. Git HEAD is exposed only as an explicit, user-toggled secondary "compare
against: Last commit" mode — it is never the default diff base.

## Consequences

### Positive

- Precisely isolates the attached session's own agent edits from the operator's pre-existing
  uncommitted changes — the operator is never asked to review or "reject" their own work.
- Works identically in git and non-git working directories, unlike a git-HEAD-based diff.
- Stable across a sequence of edits to the same file: first-touch-wins keeps one true "before"
  state for the whole session instead of drifting with every subsequent write.
- Binary-safe from day one, so image diff (Chunk B) needs no new capture path — only a byte-serving
  endpoint and a renderer.

### Negative

- Introduces a new stateful server domain (`services/diff/edit-baseline.ts`) and a bookkeeping
  concept — per-session ephemeral baselines — that has no precedent elsewhere in the codebase.
- Baselines are lost on server restart; a restarted session silently degrades to the
  reconstruct/HEAD/empty fallback ladder rather than the precise pre-tool capture. This is an
  accepted, documented loss of precision, not a bug, but it means diff fidelity is not guaranteed
  to survive a server bounce mid-session.
- Depends on the claude-code runtime exposing a synchronous pre-tool hook that can read the file
  before the edit applies. Other runtimes (Codex, OpenCode) fall back to the lower-fidelity
  reconstruction/HEAD ladder until — or unless — they gain an equivalent seam.
