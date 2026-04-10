# First Time User Experience (FTUE) — Specification

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-01
**Spec Number:** 79
**Slug:** first-time-user-experience

---

## Overview

Implement a comprehensive, functional onboarding system for DorkOS that spans CLI installation through web client use and module activation. The FTUE creates genuine "magic moments" by leveraging what DorkOS uniquely does: discover agents already on the user's machine, network them, schedule automated work, and connect communication channels.

The approach is a **Hybrid: Functional Onboarding + Progressive Empty States**. A 3-step guided first-run flow produces tangible output at each step. Rich empty states serve as permanent fallback for users who skip. Features (Pulse, Relay, Mesh) are enabled by default.

## Background / Problem Statement

DorkOS currently has no onboarding experience. After `npm install -g dorkos && dorkos`, the CLI prints a minimal banner and the web client shows an empty "New conversation" placeholder. Users must independently discover Pulse, Relay, and Mesh via sidebar tabs — each gated behind feature flags that default to disabled. The init wizard (`init-wizard.ts`) only collects port, theme, tunnel, and working directory settings.

This creates three problems:

1. **No value demonstration.** Users don't experience what makes DorkOS different — agent discovery, scheduling, and messaging — unless they manually enable features and configure each one.
2. **Empty canvas paralysis.** Every module starts empty with no guidance on how to populate it. Users who don't know what a "mesh network" does will never click the tab.
3. **Feature flag barrier.** The disabled-by-default pattern means most users never discover the product's core capabilities (Pulse scheduling, Relay messaging, Mesh coordination).

Research shows that the best developer tool FTUEs look like "the product working" — they produce real output (Linear, Vercel, Stripe), not passive product tours (16-33% completion rate for tours >6 cards). DorkOS can uniquely discover agents already on the user's machine and network them — this is a genuine magic moment that no other tool provides.

## Goals

- Create a 3-step functional onboarding flow that produces real output at each step (registered agents, created schedules, configured adapters)
- Invert feature flags so Pulse, Relay, and Mesh are enabled by default (no env var = enabled)
- Build a server-side filesystem scanner that discovers AI-configured projects via SSE streaming
- Implement rich empty states with visual previews for all modules as permanent FTUE fallback
- Persist onboarding state server-side so progress carries across sessions, browsers, and clients
- Deliver a three-beat celebration when agents are discovered (staggered cards, confetti, topology morph)
- Improve CLI startup output with clean banner and first-run messaging

## Non-Goals

- Deep Obsidian plugin FTUE (separate spec — extension points only)
- Marketing site or docs site onboarding
- User analytics or FTUE metrics tracking
- Product tours, coach marks, or tooltip walkthroughs
- AgentTemplate implementation (future spec — insertion point designed in)
- Mobile-native app support (responsive web only)

## Technical Dependencies

| Dependency              | Version             | Purpose                                                              |
| ----------------------- | ------------------- | -------------------------------------------------------------------- |
| `motion`                | 12.33.0 (installed) | Animation for onboarding transitions, card entrances, topology morph |
| `canvas-confetti`       | 1.9.4 (installed)   | Celebration confetti burst (Beat 2)                                  |
| `@tanstack/react-query` | installed           | Server state for onboarding, presets, discovery                      |
| `zod`                   | installed           | Schema validation for onboarding state, scanner params, presets      |
| `lucide-react`          | installed           | Icons for onboarding UI                                              |
| `chokidar`              | installed           | File watching (already used for binding hot-reload)                  |

No new dependencies required.

## Detailed Design

### 1. Feature Flag Inversion (Prerequisite)

The runtime feature flag factory (`lib/feature-flag.ts`) currently defaults to `false`. The config schema (`packages/shared/src/config-schema.ts`) already defaults relay, scheduler, and mesh to `enabled: true`. The mismatch is in the runtime initialization.

**Changes:**

**`apps/server/src/lib/feature-flag.ts`** — Change the initial state from `false` to `true`:

```typescript
export function createFeatureFlag(): FeatureFlag {
  const state: { enabled: boolean; initError?: string } = { enabled: true };
  // ...rest unchanged
}
```

**`apps/server/src/index.ts`** — Update feature initialization logic. Currently, initialization checks `env.DORKOS_PULSE_ENABLED` or `config.scheduler.enabled`. With the new default, features initialize unless explicitly disabled. The check becomes:

```typescript
// Before: const pulseEnabled = env.DORKOS_PULSE_ENABLED === 'true' || config.scheduler?.enabled;
// After: features enabled unless explicitly false
const pulseDisabled = env.DORKOS_PULSE_ENABLED === 'false' || config.scheduler?.enabled === false;
if (!pulseDisabled) {
  // Initialize Pulse...
}
```

Apply the same pattern to Relay (`DORKOS_RELAY_ENABLED`) and Mesh (`DORKOS_MESH_ENABLED`).

**`packages/cli/src/cli.ts`** — Update CLI flag defaults. The `--pulse` / `--no-pulse` flags should reflect enabled-by-default behavior. `--no-pulse` explicitly disables; absence means enabled.

**`apps/client/src/layers/shared/ui/FeatureDisabledState.tsx`** — Update messaging. Since features are now enabled by default, the disabled state should indicate the feature was explicitly disabled and show how to re-enable it.

### 2. Onboarding State Schema & API

**`packages/shared/src/config-schema.ts`** — Add `OnboardingStateSchema`:

```typescript
export const OnboardingStateSchema = z.object({
  completedSteps: z.array(z.enum(['discovery', 'pulse', 'adapters'])).default([]),
  skippedSteps: z.array(z.enum(['discovery', 'pulse', 'adapters'])).default([]),
  dismissedAt: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
```

Add to `UserConfigSchema`:

```typescript
onboarding: OnboardingStateSchema.default(() => ({
  completedSteps: [],
  skippedSteps: [],
  dismissedAt: null,
  startedAt: null,
})),
```

**`apps/server/src/routes/config.ts`** — Extend to expose onboarding state:

- `GET /api/config` — Include `onboarding` in the response (already there via config manager)
- `PATCH /api/config` — Accept `onboarding` patches (already works via deep merge)

No new route file needed — the existing config route handles this transparently because the onboarding key is part of UserConfigSchema.

### 3. Server-Side Filesystem Scanner

**New file: `apps/server/src/services/discovery-scanner.ts`**

A filesystem traversal service that scans for AI-configured projects.

```typescript
export interface DiscoveryCandidate {
  path: string;
  name: string;
  markers: string[]; // e.g., ['AGENTS.md', '.claude/']
  gitBranch: string | null;
  gitRemote: string | null;
  hasDorkManifest: boolean; // .dork/agent.json exists
}

export interface ScanOptions {
  root: string; // Starting directory (default: os.homedir())
  maxDepth: number; // Max traversal depth (default: 5)
  excludePatterns: string[];
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'vendor',
  'Library',
  'AppData',
  '.Trash',
  'dist',
  'build',
  '.cache',
  '.npm',
  '.nvm',
  '.local',
  '.cargo',
  '.rustup',
  'go/pkg',
];

export const AGENT_MARKERS = [
  'AGENTS.md',
  '.claude',
  '.cursor',
  '.github/copilot',
  '.dork/agent.json',
];
```

The scanner:

1. Traverses from `root` up to `maxDepth` levels deep
2. At each directory, checks for any `AGENT_MARKERS`
3. When a marker is found, extracts project metadata (name from git remote or directory name, current branch)
4. Skips directories matching `DEFAULT_EXCLUDE_PATTERNS`
5. Uses `fs.readdir` with `withFileTypes: true` for efficiency
6. Returns results as an async generator for progressive streaming

**New file: `apps/server/src/routes/discovery.ts`**

SSE endpoint for progressive scan results:

```
POST /api/discovery/scan
Content-Type: application/json
Body: { root?: string, maxDepth?: number }

Response: SSE stream
  event: candidate
  data: { path, name, markers, gitBranch, gitRemote, hasDorkManifest }

  event: progress
  data: { scannedDirs: number, foundAgents: number }

  event: complete
  data: { totalScanned: number, totalFound: number, durationMs: number }

  event: error
  data: { message: string }
```

The route validates the `root` parameter against the directory boundary (`lib/boundary.ts`) to prevent scanning outside allowed paths. If no `root` is provided, defaults to `os.homedir()`.

Mount in `index.ts` at `/api/discovery`. No feature flag — discovery is always available.

### 4. Pulse Preset System

**Preset storage:** `~/.dork/pulse/presets.json`

Created with defaults on first server start (in `index.ts` initialization, after PulseStore is created). If the file doesn't exist, write defaults:

```json
[
  {
    "id": "health-check",
    "name": "Codebase health check",
    "description": "Run lint, typecheck, and tests to catch issues early",
    "prompt": "Run the project's lint, typecheck, and test commands. Report any failures with file locations and suggested fixes. If everything passes, confirm the codebase is healthy.",
    "cron": "0 8 * * 1",
    "cronHuman": "Every Monday at 8:00 AM"
  },
  {
    "id": "dependency-audit",
    "name": "Dependency audit",
    "description": "Check for outdated or vulnerable packages",
    "prompt": "Check all dependencies for known vulnerabilities and outdated versions. List any security advisories. Suggest specific version bumps for critical updates.",
    "cron": "0 9 * * 1",
    "cronHuman": "Every Monday at 9:00 AM"
  },
  {
    "id": "docs-sync",
    "name": "Documentation sync",
    "description": "Verify documentation matches current implementation",
    "prompt": "Review the project's documentation files (README, contributing guides, API docs) against the current codebase. Flag any sections that are outdated, missing, or inaccurate. Suggest specific corrections.",
    "cron": "0 7 * * *",
    "cronHuman": "Every day at 7:00 AM"
  },
  {
    "id": "code-review",
    "name": "Code quality review",
    "description": "Review recent commits for quality issues",
    "prompt": "Review the last 7 days of commits. Look for code quality issues, potential bugs, missing tests, and architectural concerns. Provide actionable feedback organized by severity.",
    "cron": "0 8 * * 5",
    "cronHuman": "Every Friday at 8:00 AM"
  }
]
```

**`apps/server/src/services/pulse/pulse-store.ts`** — Add preset loading:

```typescript
export function loadPresets(): PulsePreset[] {
  const presetsPath = path.join(dorkHome, 'pulse', 'presets.json');
  if (!fs.existsSync(presetsPath)) return [];
  return JSON.parse(fs.readFileSync(presetsPath, 'utf-8'));
}
```

**`apps/server/src/routes/pulse.ts`** — Add preset endpoint:

```
GET /api/pulse/presets
Response: PulsePreset[]
```

### 5. Client — Onboarding Feature Module (FSD)

New FSD feature module at `apps/client/src/layers/features/onboarding/`.

#### Directory Structure

```
layers/features/onboarding/
├── ui/
│   ├── OnboardingFlow.tsx         # Full-screen flow container
│   ├── AgentDiscoveryStep.tsx     # Step 1: Agent discovery
│   ├── PulsePresetsStep.tsx       # Step 2: Pulse preset selection
│   ├── AdapterSetupStep.tsx       # Step 3: Adapter configuration
│   ├── AgentCard.tsx              # Discovered agent card
│   ├── PresetCard.tsx             # Pulse preset card
│   ├── OnboardingComplete.tsx     # Completion summary screen
│   ├── NoAgentsFound.tsx          # Guided agent creation
│   ├── ProgressCard.tsx           # Sidebar progress card
│   └── DiscoveryCelebration.tsx   # Three-beat celebration
├── model/
│   ├── use-onboarding.ts          # Onboarding state hook
│   ├── use-discovery-scan.ts      # SSE scanner hook
│   └── use-pulse-presets.ts       # Preset loading hook
└── index.ts                       # Barrel export
```

#### `OnboardingFlow.tsx` — Full-Screen Container

Takes over the entire viewport during onboarding. Manages step navigation and skip logic.

```typescript
interface OnboardingFlowProps {
  onComplete: () => void;
  onSkipAll: () => void;
  initialStep?: 'discovery' | 'pulse' | 'adapters';
}
```

Layout:

- Full viewport (`fixed inset-0 z-50 bg-background`)
- Step content centered with max-width container (`max-w-2xl`)
- Step indicator at top (3 dots showing progress)
- "Skip all" button always visible in the top-right corner
- Per-step "Skip" button at the bottom of each step
- Smooth crossfade transition between steps (AnimatePresence with 300ms fade)

#### `AgentDiscoveryStep.tsx` — Step 1

Manages the discovery scan, progressive result display, and celebration sequence.

States:

1. **Pre-scan** — "Let's find your agents" prompt with "Scan" CTA
2. **Scanning** — Progressive card entrance as agents are found, animated progress
3. **Celebration** — Three-beat sequence (detailed in section 6)
4. **Review** — Agent list with checkboxes for selection, "Confirm & Register" button
5. **No agents** — Guided creation flow (NoAgentsFound component)

Uses `use-discovery-scan.ts` hook for SSE consumption.

#### `PulsePresetsStep.tsx` — Step 2

Displays preset cards loaded from the server. Each card is toggleable with an inline cron editor.

States:

1. **Selection** — Preset cards with on/off toggles
2. **Agent assignment** — For each enabled preset, select which agent(s) to run it against
3. **Confirmation** — Summary of schedules to create, "Create Schedules" button
4. **Created** — Summary showing next run times

Uses `use-pulse-presets.ts` for loading presets and existing schedule mutation hooks for creation.

#### `AdapterSetupStep.tsx` — Step 3

Shows available adapter types as cards. Selecting one launches the existing `AdapterSetupWizard` component (from `features/relay/ui/`).

Cards:

- **Telegram** — "Get notified on Telegram when agents finish work"
- **Webhooks** — "Send events to any URL"
- Future adapters as "Coming soon" disabled cards

Reuses the existing AdapterSetupWizard three-step flow (configure, test, confirm).

#### `AgentCard.tsx` — Discovered Agent Card

Displays a discovered agent with:

- Project name (from git remote or directory name)
- Path (truncated with home shorthand `~/`)
- Git branch badge
- AI config markers (AGENTS.md, .claude/, etc.) as small badges
- Checkbox for inclusion/exclusion
- Staggered entrance animation (motion.div with spring transition)

#### `PresetCard.tsx` — Pulse Preset Card

Displays a preset schedule:

- Name and description
- Cron expression (human-readable)
- Prompt preview (truncated with expand)
- Toggle switch (on/off)
- Inline cron editor (collapses below when toggled on)

#### `OnboardingComplete.tsx` — Completion Screen

Summary of everything configured:

- "{N} agents registered" with small topology preview
- "{M} schedules created" with next run times
- "Telegram connected" (or "No adapters configured — set up later in Relay")
- "Start a session" CTA button that transitions to the main UI

#### `NoAgentsFound.tsx` — Guided Agent Creation

Inline flow (not a dialog):

1. Directory picker (defaults to the cwd where `dorkos` was launched)
2. Agent name input (with auto-suggest from directory name)
3. Optional persona sentence
4. "Create Agent" button

Creates a `.dork/agent.json` manifest via the existing agent creation API (`POST /api/agents/current`).

**Future extension point:** Before the manual creation form, a horizontal row of AgentTemplate cards. Disabled/placeholder for now with a comment: `{/* AgentTemplate cards — see first-time-user-experience spec, Decision #16 */}`.

#### `ProgressCard.tsx` — Sidebar Progress Card

Small collapsible card rendered in `SessionSidebar` when onboarding is incomplete:

```
┌─────────────────────────────┐
│ Continue setup          ✕   │
│                             │
│ ○ Discover agents           │
│ ● Enable scheduling         │
│ ○ Connect adapters          │
│                             │
│ ○ = not started  ● = done   │
└─────────────────────────────┘
```

- Each step is a clickable link that opens OnboardingFlow at that step
- "X" dismiss button permanently hides the card (sets `dismissedAt` in config)
- Completed steps show a checkmark
- Skipped steps are hidden
- On mobile: appears at the top of the session list

#### `DiscoveryCelebration.tsx` — Three-Beat Celebration

Orchestrates the three-beat sequence:

**Beat 1 — Staggered entrance (0-2s):** Agent cards animate in one by one using `motion.div` with staggerChildren. Each card slides up with a spring transition (`damping: 20, stiffness: 300`). The stagger delay is 150ms per card.

**Beat 2 — Confetti burst (2-2.5s):** After the last card enters, trigger `fireConfetti()` from the existing celebrations infrastructure. Simultaneously show a large centered announcement: "Found {N} agents!" with `motion.h2` scale-in animation (from 0.8 to 1, with spring).

**Beat 3 — Topology morph (2.5-4s):** The agent cards `layoutId`-transition into topology node positions. A simplified topology graph fades in with edges drawing between nodes (SVG path animation with `pathLength`). The graph pulses once (scale 1 -> 1.02 -> 1) to signal "alive."

The celebration respects `prefers-reduced-motion` — if enabled, skip Beat 2 (confetti) and use instant transitions for Beats 1 and 3.

### 6. Client — Model Hooks

#### `use-onboarding.ts`

```typescript
interface UseOnboardingReturn {
  state: OnboardingState;
  isOnboardingComplete: boolean;
  isOnboardingDismissed: boolean;
  shouldShowOnboarding: boolean; // !complete && !dismissed
  completeStep: (step: 'discovery' | 'pulse' | 'adapters') => void;
  skipStep: (step: 'discovery' | 'pulse' | 'adapters') => void;
  dismiss: () => void;
  startOnboarding: () => void;
}
```

Uses TanStack Query for the GET and mutation for PATCH. The query key is `['config']` (reuses the existing config query). The `shouldShowOnboarding` computed property checks:

- No `dismissedAt` set
- Not all three steps are in `completedSteps` or `skippedSteps`

#### `use-discovery-scan.ts`

```typescript
interface UseDiscoveryScanReturn {
  candidates: DiscoveryCandidate[];
  isScanning: boolean;
  progress: { scannedDirs: number; foundAgents: number };
  startScan: (options?: { root?: string }) => void;
  error: string | null;
}
```

Creates an `EventSource` to `POST /api/discovery/scan` (using fetch for the POST, then switching to SSE). Accumulates candidates as they arrive. Updates progress state on each `progress` event.

#### `use-pulse-presets.ts`

```typescript
interface UsePulsePresetsReturn {
  presets: PulsePreset[];
  isLoading: boolean;
  error: string | null;
}
```

Simple TanStack Query wrapper for `GET /api/pulse/presets`.

### 7. Client — Integration Points

#### `App.tsx` — First-Run Detection

Add onboarding detection to the standalone app (not embedded/Obsidian):

```typescript
const { shouldShowOnboarding } = useOnboarding();
const [showOnboarding, setShowOnboarding] = useState(false);

// On mount, check if onboarding should show
useEffect(() => {
  if (shouldShowOnboarding) {
    setShowOnboarding(true);
  }
}, [shouldShowOnboarding]);
```

When `showOnboarding` is true, render `<OnboardingFlow />` as a full-screen overlay (`fixed inset-0 z-50`). When onboarding completes or is skipped, `setShowOnboarding(false)` and the main UI renders.

The transition from onboarding to main UI should be animated: the onboarding flow fades out (200ms) while the sidebar slides in from the left and the main content fades in.

#### `SessionSidebar.tsx` — Progress Card

Mount `<ProgressCard />` below the session list and above the feature panel area when `shouldShowOnboarding` is true and `isOnboardingDismissed` is false:

```typescript
const { shouldShowOnboarding, isOnboardingDismissed } = useOnboarding();

// In the sidebar render:
{shouldShowOnboarding && !isOnboardingDismissed && (
  <ProgressCard onStepClick={(step) => setShowOnboarding(step)} />
)}
```

#### `MeshPanel.tsx` — Re-entry Point

Add a "Discover Agents" button to the mesh panel header or empty state. This button triggers the same discovery scan used in onboarding Step 1, but rendered inline in the mesh panel rather than in the full-screen onboarding flow. The scanner service and SSE endpoint are the same — only the UI container differs.

### 8. Empty State Redesigns

Each module gets a rich empty state with three elements: visual preview, one-line explanation, and one clear CTA.

#### `PulseEmptyState.tsx` (new file)

Visual: A faded/ghosted preview of 2-3 schedule rows showing what a populated schedule list looks like (schedule name, cron, next run time). The preview uses `opacity-40` and `pointer-events-none`.

Text: "Automate recurring tasks — code reviews, dependency audits, health checks."

CTA: "Create Schedule" button that opens the CreateScheduleDialog.

#### `RelayEmptyState.tsx` (new file)

Visual: A faded preview showing 2-3 message rows in an activity feed and an adapter status indicator.

Text: "Connect your agents to Telegram, webhooks, and other channels."

CTA: "Add Adapter" button that opens AdapterSetupWizard.

#### `MeshEmptyState.tsx` (update existing)

Visual: A faded mini topology graph with 3 placeholder nodes and connecting edges.

Text: "Discover AI-configured projects on your machine and network them."

CTA: "Discover Agents" button that triggers the discovery scan.

#### `ChatEmptyState.tsx` (new file, replaces inline placeholder in App.tsx)

Replaces the current "New conversation / Select a session" placeholder:

Visual: DorkOS wordmark or minimal logo.

Text: "Start a conversation with Claude Code."

CTA: "New Session" button + directory picker below it.

#### `FeatureDisabledState.tsx` (update existing)

Since features are now enabled by default, this component only appears when a user has explicitly disabled a feature. Update messaging:

Text: "{Feature} is currently disabled."

CTA: Show how to re-enable: "Enable with `dorkos --pulse` or set `scheduler.enabled: true` in `~/.dork/config.json`"

### 9. CLI Output Improvements

#### `packages/cli/src/cli.ts` — Startup Banner

Replace the current minimal output with a clean, informative banner:

```
DorkOS v{version}
Server:   http://localhost:{port}
Network:  http://{ip}:{port}
Directory: {cwd}
Features: Chat | Pulse | Relay | Mesh
```

On first run only, append:

```
New to DorkOS? Open http://localhost:{port} to get started.
```

The first-run message uses `configManager.isFirstRun` to detect.

#### `packages/cli/src/init-wizard.ts` — Post-Wizard Summary

After the wizard completes, print a summary of what was configured:

```
Configuration saved to {configPath}

  Port:    {port}
  Theme:   {theme}
  Tunnel:  {enabled ? 'Enabled' : 'Disabled'}
  Directory: {cwd || 'Default'}

Start DorkOS with: dorkos
```

## User Experience

### First-Time User Flow

1. User runs `npm install -g dorkos && dorkos`
2. CLI prints clean banner with version, URL, features
3. CLI prints "New to DorkOS?" message on first run
4. User opens the web URL
5. Client detects no onboarding state → shows full-screen OnboardingFlow
6. **Step 1 (Discovery):** "Let's find your agents." → Scan runs → agents appear progressively → three-beat celebration → review and confirm
7. **Step 2 (Pulse):** "Want your agents to work while you sleep?" → preset cards → toggle + edit → assign agents → create schedules
8. **Step 3 (Adapters):** "Want your agents to reach you?" → adapter cards → launch existing setup wizard → test → confirm
9. **Complete:** Summary of what was set up → "Start a session" → transition to main UI with populated sidebar

### Skip Paths

- **Skip individual step:** "Skip" at bottom of each step. Step marked as skipped in onboarding state. Flow advances to next step.
- **Skip all:** "Skip all" button always visible. Dismisses the entire flow immediately. User lands on the main UI with empty states.
- **Resume later:** If user closes browser mid-flow, the ProgressCard in the sidebar offers to continue from the last incomplete step.
- **Permanent dismiss:** "X" on ProgressCard hides it forever. User can still manually access discovery from MeshPanel.

### Mobile Adaptation

- OnboardingFlow uses `Drawer` (full-screen bottom sheet) instead of centered content
- AgentCards stack vertically with full-width layout
- PresetCards are full-width with larger touch targets
- Topology graph in celebration Beat 3 is replaced with a count badge ("6 agents networked")
- ProgressCard appears at the top of the session drawer on mobile

## Testing Strategy

### Unit Tests

**Scanner service (`discovery-scanner.test.ts`):**

- Discovers directories with AGENTS.md marker
- Discovers directories with .claude/ directory
- Discovers directories with .dork/agent.json
- Skips excluded patterns (node_modules, .git, vendor)
- Respects maxDepth limit
- Handles permission errors gracefully (skips inaccessible directories)
- Returns correct git branch and remote information
- Handles symlinks without infinite loops

**Preset loading (`pulse-presets.test.ts`):**

- Loads presets from JSON file
- Returns empty array when file doesn't exist
- Handles malformed JSON gracefully
- Creates default presets on first server start

**Onboarding state (`use-onboarding.test.ts`):**

- `shouldShowOnboarding` is true when no steps completed and not dismissed
- `shouldShowOnboarding` is false when all steps completed
- `shouldShowOnboarding` is false when dismissed
- `completeStep` adds to completedSteps
- `skipStep` adds to skippedSteps
- `dismiss` sets dismissedAt timestamp

**Feature flag inversion (`feature-flag.test.ts`):**

- `createFeatureFlag()` defaults to enabled (true)
- `setEnabled(false)` disables the flag
- Error state tracking works independently of enabled state

### Integration Tests

**Discovery scan endpoint (`discovery.integration.test.ts`):**

- SSE stream emits candidate events for discovered agents
- SSE stream emits progress events during scan
- SSE stream emits complete event when scan finishes
- Returns 400 for invalid root path
- Returns 403 for root path outside boundary
- Handles concurrent scan requests

**Config onboarding state (`config.integration.test.ts`):**

- PATCH /api/config with onboarding state updates correctly
- GET /api/config returns onboarding state
- Onboarding state persists across server restarts

### Component Tests

**OnboardingFlow (`OnboardingFlow.test.tsx`):**

- Renders Step 1 initially
- Advances to Step 2 after completing Step 1
- "Skip" button advances to next step
- "Skip all" calls onSkipAll
- Starts at the correct step when `initialStep` is provided

**ProgressCard (`ProgressCard.test.tsx`):**

- Shows remaining incomplete steps
- Hides completed and skipped steps
- "X" button calls dismiss
- Step links call onStepClick with correct step

**AgentCard (`AgentCard.test.tsx`):**

- Renders project name and path
- Shows marker badges
- Checkbox toggles selection state

## Performance Considerations

**Filesystem scanning:**

- The scanner traverses the home directory which can be large. Depth limit (default 5) and exclusion patterns prevent excessive traversal.
- Results stream via SSE so the client shows progress immediately rather than waiting for the full scan.
- The scanner uses `fs.readdir` with `withFileTypes: true` to avoid extra `stat` calls.
- Scanning runs in the server process. For very large home directories, consider moving to a worker thread in a future iteration.

**Onboarding overlay:**

- The OnboardingFlow is rendered as a fixed overlay. When it unmounts, the main UI (sidebar, chat) renders for the first time — no double-render of the full app.
- Celebration animations use `motion` library which is already loaded for other animations. No additional bundle cost.

**Empty state previews:**

- The ghosted preview elements are static (no data fetching). They use `opacity-40` and `pointer-events-none` to prevent interaction.

## Security Considerations

**Filesystem scanning:**

- The scanner root is validated against the directory boundary (`lib/boundary.ts`). Scan requests outside the boundary return 403.
- The scanner only reads directory listings and checks for file/directory existence. It does not read file contents.
- Exclusion patterns prevent scanning sensitive directories (Library, AppData).
- The scanner does not follow symlinks outside the boundary.

**Onboarding state:**

- Stored in `~/.dork/config.json` which is user-local. No sensitive data in onboarding state.

**Preset prompts:**

- Default presets contain generic prompts (lint, test, review). Users can edit them. Prompts are not executed during onboarding — they're stored as schedule configurations.

## Documentation

- Update `contributing/architecture.md` with onboarding feature module documentation
- Update `AGENTS.md` with the new `features/onboarding/` FSD module and discovery route
- Add inline code comments for the three-beat celebration choreography (timing values and rationale)
- Blog post or changelog entry describing the FTUE feature

## Implementation Phases

### Phase 1: Foundation

1. Feature flag inversion (`feature-flag.ts`, `index.ts`, `cli.ts`)
2. Onboarding state schema (`config-schema.ts`)
3. Discovery scanner service (`discovery-scanner.ts`)
4. Discovery SSE route (`routes/discovery.ts`)
5. Pulse preset system (`pulse-store.ts`, `routes/pulse.ts`, default presets JSON)
6. CLI startup banner improvements

### Phase 2: Client — Onboarding Flow

7. FSD feature module scaffolding (`features/onboarding/`)
8. Model hooks (`use-onboarding.ts`, `use-discovery-scan.ts`, `use-pulse-presets.ts`)
9. `OnboardingFlow.tsx` container with step navigation
10. `AgentDiscoveryStep.tsx` with scan, progressive results, review
11. `AgentCard.tsx` component
12. `NoAgentsFound.tsx` guided creation
13. `PulsePresetsStep.tsx` with preset cards and schedule creation
14. `PresetCard.tsx` component
15. `AdapterSetupStep.tsx` reusing AdapterSetupWizard
16. `OnboardingComplete.tsx` summary screen
17. `App.tsx` integration (first-run detection, overlay mount)

### Phase 3: Celebration & Empty States

18. `DiscoveryCelebration.tsx` three-beat sequence
19. `ProgressCard.tsx` sidebar integration
20. `SessionSidebar.tsx` progress card mount
21. `PulseEmptyState.tsx` rich empty state
22. `RelayEmptyState.tsx` rich empty state
23. `MeshEmptyState.tsx` redesign
24. `ChatEmptyState.tsx` new empty state
25. `FeatureDisabledState.tsx` update for enabled-by-default
26. `MeshPanel.tsx` "Discover Agents" re-entry button

### Phase 4: Testing & Polish

27. Scanner unit tests
28. Preset loading tests
29. Onboarding state hook tests
30. Feature flag inversion tests
31. Discovery endpoint integration tests
32. OnboardingFlow component tests
33. ProgressCard component tests
34. Mobile responsive testing and adjustments
35. Animation polish (timing, easing, reduced-motion)

## Open Questions

1. ~~**Scanner performance on large filesystems**~~ (RESOLVED)
   **Answer:** 30-second timeout with partial results. The scanner stops after 30 seconds and emits a `complete` event with `timedOut: true`. Since results stream via SSE, the user always sees agents as they're found. The timeout prevents runaway scans on enormous home directories.

   Original context preserved:
   - Should the scanner have a configurable timeout? If a scan takes >30 seconds, should it automatically stop and show partial results?
   - The current design streams results progressively so the user sees progress, but an extremely large home directory could take minutes.

2. ~~**Preset schedule timezone**~~ (RESOLVED)
   **Answer:** Detect the user's timezone from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and adjust default preset cron expressions to local time. The timezone is sent to the server when creating schedules so "8 AM Monday" means 8 AM in the user's local time, not UTC.

   Original context preserved:
   - The default presets use UTC times. Should the onboarding detect the user's timezone and adjust the cron expressions?
   - The PulseStore already supports timezone configuration.

3. ~~**Discovery re-scan deduplication**~~ (RESOLVED)
   **Answer:** Show already-registered agents with a "registered" badge. Registered agents appear with a muted style and a badge, and cannot be re-registered. This gives users the full picture of what's on their machine while making it clear which agents are new.

   Original context preserved:
   - When re-running discovery from MeshPanel, should already-registered agents be excluded from scan results or shown with a "registered" badge?
   - The latter is more informative but adds complexity.

## Related ADRs

- ADR #2: Feature-Sliced Design (accepted) — guides the FSD module structure for the onboarding feature
- ADR #5: Zustand + TanStack Query (accepted) — informs the state management approach
- ADR #17: Standardize Subsystem Integration Pattern (proposed) — relevant for how onboarding integrates with Pulse, Relay, Mesh
- ADR #38: Progressive Disclosure Mode A/B for Feature Panels (proposed) — closely related to empty state redesigns

## References

- Ideation document: `specs/first-time-user-experience/01-ideation.md`
- FTUE research: `research/20260301_ftue_best_practices_deep_dive.md`
- Personas: `meta/personas/the-autonomous-builder.md`, `meta/personas/the-knowledge-architect.md`
- Design system: `contributing/design-system.md`
- Animation patterns: `contributing/animations.md`
- BJ Fogg Behavior Model: B = MAP (Motivation, Ability, Prompt)
- Nir Eyal Hook Model: Trigger → Action → Variable Reward → Investment
- Alan Cooper "About Face" — Considerate Interface principles
- Nielsen Norman Group: Empty state design research
