---
number: 108
title: Centralized Shortcut Registry as Single Source of Truth
status: proposed
created: 2026-03-11
spec: shortcut-discoverability
superseded-by: null
---

# 108. Centralized Shortcut Registry as Single Source of Truth

## Status

Proposed

## Context

DorkOS has ~15 keyboard shortcuts scattered across 8 component files. Each component defines its own key combo, display string, and platform detection independently. This makes it impossible to auto-generate a shortcuts reference panel, leads to inconsistent display formatting, and means adding or changing a shortcut requires touching multiple files. Industry-standard apps (Linear, GitHub, Figma) use centralized registries that drive both shortcut behavior and documentation from a single source.

## Decision

Define all shortcut metadata in a `SHORTCUTS` constant object in `shared/lib/shortcuts.ts`. Each entry includes `id`, `key` (normalized format like `mod+shift+n`), `label`, `group`, and optional `scope`. Helper functions `formatShortcutKey()` and `getShortcutsGrouped()` derive platform-specific display strings and categorized lists from this constant. All UI surfaces (inline button hints, command palette hints, the `?` reference panel) read from the registry rather than defining shortcut strings inline.

Existing shortcut handlers (`useEffect` + `addEventListener`) are NOT migrated to a library. The registry centralizes metadata and display — not behavior. Handlers continue to live in their respective components.

## Consequences

### Positive

- Adding a shortcut to the registry automatically surfaces it in the `?` panel, command palette, and any button that references it
- Platform-specific display (`⇧⌘N` vs `Ctrl+Shift+N`) is computed in one place
- Duplicate `isMac` detection eliminated (5 instances → 1 shared constant)
- Type-safe: `SHORTCUTS.NEW_SESSION` catches typos at compile time

### Negative

- Shortcut handlers remain decoupled from the registry — changing a key combo requires updating both the registry entry and the handler's `useEffect`. This is a deliberate trade-off: a full keybinding system (like VS Code's) is overengineered for ~15 shortcuts
- The registry is a client-side constant, not user-configurable. Custom keybindings would require a different architecture
