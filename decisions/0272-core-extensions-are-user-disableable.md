---
number: 272
title: Core Extensions Are User-Disableable (No Locked Built-ins)
status: draft
created: 2026-06-13
spec: core-extensions
superseded-by: null
---

# 272. Core Extensions Are User-Disableable (No Locked Built-ins)

## Status

Draft (auto-extracted from spec: core-extensions)

## Context

The prior (documented-but-unimplemented) built-in model claimed bundled extensions were "always enabled" and not user-togglable. The Core Extensions tier must decide whether core extensions can be turned off, including Dork Hub which backs the `/marketplace` UI. Reference research showed Obsidian lets users disable every core plugin and VS Code lets users disable every built-in extension; neither locks bundled functionality on. This also aligns with DorkOS's "honest by design" principle — the user sees and controls what runs.

## Decision

All core extensions are user-disableable. Dork Hub ships `defaultEnabled: true` but remains toggleable; the `/marketplace` route degrades gracefully when it is disabled. A `canDisable: boolean` manifest field is reserved (default `true`); a future extension may set `canDisable: false` to render no toggle and stay always-on, enforced both in the settings UI and as a server-side `disable()` guard. No extension in the initial core set is locked.

## Consequences

### Positive

- Honest, Obsidian/VS-Code-consistent control surface; no hidden always-on code.
- Corrects the prior doc/code drift ("always enabled" claim) with real, matching behavior.
- The reserved `canDisable` flag leaves room for genuinely-required extensions without shipping that constraint prematurely.

### Negative

- A user can disable Dork Hub and lose marketplace access until re-enabled (mitigated by graceful `/marketplace` degradation and the toggle's discoverability).
- Two enforcement points (UI + server guard) must stay in sync for any future `canDisable: false` extension.
