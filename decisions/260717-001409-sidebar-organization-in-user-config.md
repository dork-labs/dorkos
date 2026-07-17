---
id: 260717-001409
title: Sidebar organization state lives in server user config, not localStorage or agent manifests
status: proposed
created: 2026-07-17
spec: agent-sidebar-organization
superseded-by: null
---

# 260717-001409. Sidebar organization state lives in server user config, not localStorage or agent manifests

## Status

Proposed

## Context

User-defined agent groups, pinned agents, per-group sort modes, and collapse state need a durable home. Three candidates existed: browser localStorage (how `pinnedAgentPaths` worked), a field on `AgentManifestSchema`/`.dork/agent.json` (file-first per ADR-0043), or a new `ui.sidebar` section in `UserConfigSchema` (`~/.dork/config.json`). Slack's users documented the failure mode of client-local preference storage: sort preferences silently reset per device while server-persisted sections are trusted; the DorkOS cockpit is routinely opened from multiple browsers and the desktop app against one server.

## Decision

We will store all sidebar organization state in `UserConfigSchema.ui.sidebar` (`SidebarPrefsSchema`), written through the existing validated `PATCH /api/config` with a semver-keyed conf migration. Clients always write the complete `ui.sidebar` object because `deepMerge` replaces arrays wholesale. The legacy localStorage pin store is migrated once client-side (localStorage key presence is the migration flag) and then deleted. Agent manifests were rejected because a group is a personal cockpit preference, not a property of the agent — a manifest field would leak one operator's filing system into `.dork/agent.json` and drag in ADR-0043 write-through obligations for pure UI state.

## Consequences

### Positive

- Organization survives browser switches, reinstalls, and the web/desktop split — it syncs everywhere the instance is used
- One governed schema + migration path (`adding-config-fields`) instead of ad-hoc localStorage keys
- Whole-object writes make concurrent-client behavior deterministic (last write wins per section)

### Negative

- Obsidian embedded mode cannot persist it (DirectTransport `updateConfig` is a no-op) — acceptable because the embedded shell never renders `DashboardSidebar`
- Every organization interaction is a config PATCH; optimistic cache updates are required to keep interactions at 0ms perceived latency
