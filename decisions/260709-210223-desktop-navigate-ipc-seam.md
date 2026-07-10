---
id: 260709-210223
title: Desktop shell drives the client through a single `navigate` IPC channel
status: proposed
created: 2026-07-09
spec: desktop-macos-polish
superseded-by: null
---

# 260709-210223. Desktop shell drives the client through a single `navigate` IPC channel

## Status

Proposed

## Context

The desktop app is a thin Electron shell (~550 lines of main-process code) around `apps/client`; the original electron-desktop-app spec deliberately kept the shell free of product UI. Native macOS polish now requires the shell to open product surfaces: the Settings… menu item (Cmd+,), dock-menu actions, and `dorkos://` deep links all need to land the user on a specific client route. The alternatives were a native preferences window owned by the shell, per-feature IPC channels, or query-parameter reloads.

## Decision

We will expose exactly one main→renderer channel, `navigate`, carrying a client route path. The preload exposes `onNavigate(cb)` on `window.electronAPI`; the client app shell subscribes once and forwards to TanStack Router. Every shell-initiated navigation — menu items, dock menu, deep-link `open-url` — routes through this channel. The shell never grows its own product UI (no native preferences window).

## Consequences

### Positive

- The shell stays a thin adapter; product surfaces have one home (`apps/client`) across web, Obsidian, and desktop.
- One channel to type, test, and audit instead of a growing per-feature IPC surface.
- Deep links and menu items are trivially extensible: any new client route is immediately reachable.

### Negative

- Shell-initiated flows can only target what the client router exposes; a shell need with no corresponding route requires client work first.
- Route strings cross the IPC boundary untyped; a renamed client route silently breaks menu/deep-link targets unless covered by tests.
