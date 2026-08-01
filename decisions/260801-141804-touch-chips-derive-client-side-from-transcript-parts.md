---
id: 260801-141804
title: Touch chips derive client-side from transcript parts, append-then-merge
status: draft
created: 2026-08-01
spec: chat-touch-chips
superseded-by: null
---

# 260801-141804. Touch chips derive client-side from transcript parts, append-then-merge

## Status

Draft (auto-extracted from spec: chat-touch-chips)

## Context

The chat transcript needs a turn-level record of every file, URL, and command an agent touched — live while tools run, durable after tool cards auto-hide. The data (tool names, inputs, results, statuses) already rides the normalized `MessagePart[]` stream to every client. A cross-product survey (`research/20260801_touched_file_chip_ui_patterns.md`) found the dominant convention is one entry per target with net state, and documented Cursor's confirmed bug: deduping from "currently tracked state" silently drops real edits when the tracker's notion of pending changes drifts from the write stream.

## Decision

Touch chips are a pure client-side derivation: `accumulateTouchChips(parts)` folds every tool-call part in order into one deduplicated chip per target (append-then-merge), with verb precedence (delete > create > edit) and an in-place read→edit upgrade. No server or schema changes; replay/hydration can never disagree with the transcript because the chips are a function of it. URL chips use locally hashed letter tiles — the cockpit makes no third-party favicon requests.

## Consequences

### Positive

- Zero server work; works identically across all three runtimes and on transcript replay.
- Dedup can never silently lose an edit — every event is folded, none are tracked as mutable state.
- No privacy leak from favicon services; no network dependency in the transcript UI.

### Negative

- Chip fidelity is capped by what each runtime already forwards (Codex `file_change` carries no diff content, so its edit chips have no diffstat; OpenCode subagent activity is invisible until its adapter maps `subtask` parts).
- Bash-based deletions are detected by best-effort `rm` argv parsing, which can miss exotic forms.
