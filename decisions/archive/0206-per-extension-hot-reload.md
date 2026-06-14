---
number: 206
title: Per-Extension Hot Reload via Deactivate-Reactivate Pattern
status: draft
created: 2026-03-26
spec: ext-platform-04-agent-extensions
superseded-by: null
---

# 0206. Per-Extension Hot Reload via Deactivate-Reactivate Pattern

## Status

Draft (auto-extracted from spec: ext-platform-04-agent-extensions)

## Context

When an agent edits an extension and triggers a reload, the system must update the running extension. Two approaches exist: full reload (deactivate all extensions, recompile all, reactivate all) or per-extension hot reload (deactivate only the changed extension, recompile it, reactivate it while others remain untouched).

VS Code does not support per-extension hot reload — it reloads the entire Extension Host process. Obsidian's community `pjeby/hot-reload` plugin demonstrates the per-extension approach: watch individual directories, debounce, call `disable()` then `enable()` for only the changed plugin.

The DorkOS client's `extension-context.tsx` already tracks cleanup (deactivation) functions per extension in a Map, making surgical deactivation feasible.

## Decision

Use per-extension hot reload. When `reload_extensions` is called with an `id` parameter, only that extension is deactivated, recompiled, and reactivated. Other extensions remain running with their state intact. The SSE `extension_reloaded` event carries the specific extension ID so the client targets only that extension.

## Consequences

### Positive

- One bad extension does not disrupt others during the agent's iteration cycle
- State in unmodified extensions is preserved across reloads (e.g., a dashboard card's fetched data persists)
- Faster reload cycle — only one extension to compile and reactivate vs. all of them
- Matches the content-hash cache design — only changed extensions need recompilation

### Negative

- More complex than full reload — must handle the case where the deactivated extension left side effects (DOM nodes, event listeners, timers)
- Potential for stale references if extensions interact with each other (mitigated: extension-to-extension dependencies are out of scope for v1)
- ESM dynamic import cache busting via `?t=timestamp` query parameter leaks module memory (acceptable for 10-50 reloads per session)
- Full reload remains available as a fallback (call `reload_extensions` without `id`)
