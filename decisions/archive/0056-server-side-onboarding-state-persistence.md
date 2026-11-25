---
number: 56
title: Persist Onboarding State Server-Side in Config
status: archived
created: 2026-03-01
spec: first-time-user-experience
superseded-by: null
---

# 56. Persist Onboarding State Server-Side in Config

## Status

Draft (auto-extracted from spec: first-time-user-experience)

## Context

Onboarding progress (which steps are completed, skipped, or dismissed) must persist across browser sessions, different browsers, and different clients (web, potential future Obsidian integration). Client-side storage (localStorage) would scope state to a single browser, causing users to see the onboarding flow again when switching devices or clearing browser data.

## Decision

We will store onboarding state in the existing server-side config file (`~/.dork/config.json`) under an `onboarding` key with the schema: `{ completedSteps: string[], skippedSteps: string[], dismissedAt: string | null, startedAt: string | null }`. This extends the existing `UserConfigSchema` and uses the existing `PATCH /api/config` endpoint — no new routes or storage mechanisms needed.

## Consequences

### Positive

- Onboarding state is shared across all clients and browsers automatically
- Leverages existing config infrastructure (ConfigManager, Zod validation, atomic writes)
- State survives browser cache clears, device switches, and reinstalls
- First-run detection works via existing `configManager.isFirstRun`

### Negative

- State is per-installation, not per-user (fine for single-user DorkOS but wouldn't scale to multi-user)
- Config file grows slightly with onboarding metadata
- No offline-first capability — client must reach the server to check onboarding state
