# Task Breakdown: First Time User Experience (FTUE)

Generated: 2026-03-01
Source: specs/first-time-user-experience/02-specification.md
Last Decompose: 2026-03-01

## Overview

Comprehensive onboarding system for DorkOS spanning CLI installation through web client use and module activation. A 3-step guided first-run flow produces tangible output at each step (discovers agents, creates schedules, configures adapters). Features enabled by default. Rich empty states serve as permanent fallback.

## Phase 1: Foundation

### Task 1.1: Invert Feature Flags to Enabled-by-Default

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2

Change `createFeatureFlag()` default from `false` to `true`. Update relay-state, mesh-state, index.ts, config-schema, CLI defaults. Test that absence of env var means enabled, `=false` disables.

### Task 1.2: Add Onboarding State Schema and Config Integration

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1

Add `OnboardingStateSchema` (completedSteps, skippedSteps, dismissedAt, startedAt) to shared config-schema. Wire into config-manager and verify PATCH /api/config handles partial onboarding updates.

### Task 1.3: Create Filesystem Discovery Scanner Service

**Size**: Large | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.2

New `discovery-scanner.ts` service with async generator scanning home directory for agent markers (CLAUDE.md, .claude/, .cursor/, .github/copilot, .dork/agent.json). Yields candidate/progress/complete events. 30-second timeout. Exclusion patterns. Uses `execFile` for git commands.

### Task 1.4: Create Discovery SSE Route

**Size**: Medium | **Priority**: High | **Dependencies**: 1.3

`POST /api/discovery/scan` endpoint returning SSE stream. Zod-validated request body. Boundary validation on root parameter. Mounted in server index.ts.

### Task 1.5: Create Pulse Preset System

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.2, 1.3

Pulse presets at `~/.dork/pulse/presets.json`. Four defaults (health-check, dependency-audit, docs-sync, code-review). `loadPresets()` and `ensureDefaultPresets()` in pulse-store.ts. `GET /api/pulse/presets` endpoint.

### Task 1.6: Improve CLI Startup Banner and First-Run Message

**Size**: Small | **Priority**: Medium | **Dependencies**: 1.1

Clean banner with version, URLs, directory, enabled features. First-run "New to DorkOS?" message. Init wizard post-completion summary.

## Phase 2: Client — Onboarding Flow

### Task 2.1: Scaffold Onboarding FSD Module and Model Hooks

**Size**: Large | **Priority**: High | **Dependencies**: 1.2, 1.4, 1.5

Create `features/onboarding/` FSD module. Implement `useOnboarding` (TanStack Query state management), `useDiscoveryScan` (SSE streaming from POST), `usePulsePresets` (simple query wrapper). Barrel export.

### Task 2.2: Create OnboardingFlow Container with Step Navigation

**Size**: Medium | **Priority**: High | **Dependencies**: 2.1

Full-screen overlay with step indicator, navigation (Back, Skip, Skip all), AnimatePresence transitions. Props: onComplete, initialStep. Renders placeholder step content initially.

### Task 2.3: Create AgentCard and AgentDiscoveryStep Components

**Size**: Large | **Priority**: High | **Dependencies**: 2.2 | **Parallel with**: 2.4

AgentCard: name, path, markers, git branch, checkbox. AgentDiscoveryStep: scan button, progressive results, review/confirm flow, registers selected with Mesh.

### Task 2.4: Create NoAgentsFound Guided Creation Flow

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.2 | **Parallel with**: 2.3

Fallback when no agents found. Directory picker, name/persona inputs, creates real `.dork/agent.json` via `useCreateAgent`.

### Task 2.5: Create PresetCard and PulsePresetsStep Components

**Size**: Large | **Priority**: High | **Dependencies**: 2.2 | **Parallel with**: 2.3, 2.4

PresetCard: toggle, name, cron editor, prompt preview. PulsePresetsStep: preset grid, enable/disable, edit cron, create real schedules on confirm.

### Task 2.6: Create AdapterSetupStep and OnboardingComplete

**Size**: Medium | **Priority**: High | **Dependencies**: 2.2 | **Parallel with**: 2.3, 2.5

AdapterSetupStep: adapter catalog cards, launches existing AdapterSetupWizard. OnboardingComplete: summary screen, "Start a session" button.

### Task 2.7: Integrate Onboarding into App.tsx

**Size**: Medium | **Priority**: High | **Dependencies**: 2.2, 2.3, 2.5, 2.6

First-run detection via `useOnboarding()`. Render OnboardingFlow as full-screen overlay. AnimatePresence transition to main UI on complete/skip.

## Phase 3: Celebration & Empty States

### Task 3.1: Create DiscoveryCelebration Three-Beat Sequence

**Size**: Large | **Priority**: Medium | **Dependencies**: 2.3 | **Parallel with**: 3.2

Beat 1: Staggered card entrance (0-2s). Beat 2: Confetti + "Found N agents!" (2-2.5s). Beat 3: Topology morph (2.5-4s). Reduced motion support.

### Task 3.2: Create ProgressCard and SessionSidebar Integration

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.1, 2.7 | **Parallel with**: 3.1

Compact sidebar card showing step completion status. Clickable steps re-enter onboarding. Dismiss permanently hides. Mounted in SessionSidebar.

### Task 3.3: Create Rich Empty States for All Modules

**Size**: Large | **Priority**: Medium | **Dependencies**: 1.1 | **Parallel with**: 3.1, 3.2

PulseEmptyState (faded schedule preview + Create Schedule CTA), RelayEmptyState (faded activity + Add Adapter CTA), MeshEmptyState (faded topology + Discover Agents CTA), ChatEmptyState (wordmark + New Session CTA), FeatureDisabledState (updated for enabled-by-default).

### Task 3.4: Add MeshPanel 'Discover Agents' Re-entry Button

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.1, 2.3 | **Parallel with**: 3.1, 3.2, 3.3

Permanent discovery button in MeshPanel header. Reuses useDiscoveryScan. Shows registration status. Already-registered agents badged.

## Phase 4: Testing & Polish

### Task 4.1: Write Server-Side Unit Tests

**Size**: Large | **Priority**: High | **Dependencies**: 1.1, 1.3, 1.5 | **Parallel with**: 4.2

Scanner tests (markers, exclusions, depth, permissions, timeout, progress), preset tests (load, create, malformed), feature flag tests (default, disable, independence).

### Task 4.2: Write Onboarding Component and Hook Tests

**Size**: Large | **Priority**: High | **Dependencies**: 2.1, 2.2, 2.3, 3.2 | **Parallel with**: 4.1

useOnboarding hook tests, OnboardingFlow navigation tests, ProgressCard rendering tests, AgentCard interaction tests.

### Task 4.3: Write Discovery Endpoint Integration Tests

**Size**: Medium | **Priority**: High | **Dependencies**: 1.4 | **Parallel with**: 4.1, 4.2

SSE stream format, boundary validation, error handling, concurrent requests, timeout parameter.

### Task 4.4: Mobile Responsive Adaptation and Animation Polish

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.7, 3.1 | **Parallel with**: 4.1, 4.2, 4.3

Mobile Drawer layout, 44px touch targets, celebration adaptation, reduced motion, animation timing polish.

### Task 4.5: Update Documentation

**Size**: Small | **Priority**: Low | **Dependencies**: 2.7, 3.3 | **Parallel with**: 4.1, 4.2, 4.3, 4.4

Update CLAUDE.md (FSD layers, routes, services, feature flags). Update contributing/architecture.md (onboarding module, SSE pattern, celebration).

## Parallel Execution Opportunities

**Phase 1 parallel group**: Tasks 1.1, 1.2, 1.3, 1.5 can all run in parallel (no interdependencies)
**Phase 2 parallel group**: Tasks 2.3, 2.4, 2.5, 2.6 can run in parallel after 2.2
**Phase 3 parallel group**: Tasks 3.1, 3.2, 3.3, 3.4 can run in parallel (mixed dependencies)
**Phase 4 parallel group**: Tasks 4.1, 4.2, 4.3, 4.4, 4.5 can mostly run in parallel

## Critical Path

1.3 → 1.4 → 2.1 → 2.2 → 2.3 → 2.7 → 3.2 → 4.2
