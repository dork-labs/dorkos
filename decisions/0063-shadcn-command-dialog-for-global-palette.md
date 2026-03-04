---
number: 63
title: Use Shadcn CommandDialog for Global Agent Command Palette
status: proposed
created: 2026-03-03
spec: agent-centric-ux
superseded-by: null
---

# 63. Use Shadcn CommandDialog for Global Agent Command Palette

## Status

Proposed

## Context

DorkOS needs a fast, keyboard-driven way to switch between agents and access features. The Shadcn Command component (wrapping cmdk) is already installed at `layers/shared/ui/command.tsx` but unused. Alternative approaches include building a custom palette from scratch or adopting a third-party library like kbar. The existing inline slash command palette (`features/commands/`) serves a different purpose (contextual command completion in chat input) and uses custom motion.div, not cmdk.

## Decision

Use the already-installed Shadcn Command component wrapped in a `ResponsiveDialog` (Dialog on desktop, Drawer on mobile) as a global command palette. Mount at `App.tsx` level with `Cmd+K` / `Ctrl+K` keyboard binding. The palette is a separate FSD feature module (`features/command-palette/`) distinct from the existing inline slash palette (`features/commands/`). Agents are the primary content, with frecency-sorted recent agents in the zero-query state.

## Consequences

### Positive

- Zero new dependencies (cmdk already installed via Shadcn)
- Industry-standard keyboard shortcut (Cmd+K) familiar to users of Linear, GitHub, Slack
- Built-in fuzzy filtering, keyboard navigation, focus trapping via cmdk + Radix Dialog
- Mobile support via existing ResponsiveDialog pattern (bottom Drawer)

### Negative

- Two palette systems coexist (global Cmd+K and inline `/` in chat) — may confuse users initially
- cmdk's built-in filter may not perfectly match agent search needs (mitigated: `keywords` prop covers path/description matching)
