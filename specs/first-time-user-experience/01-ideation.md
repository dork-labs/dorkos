---
slug: first-time-user-experience
number: 79
created: 2026-03-01
status: ideation
---

# First Time User Experience (FTUE)

**Slug:** first-time-user-experience
**Author:** Claude Code
**Date:** 2026-03-01

---

## 1) Intent & Assumptions

- **Task brief:** Design a world-class FTUE for DorkOS that applies across the full journey — from CLI installation through first web client use and module activation. The FTUE should embody progressive disclosure and considerate interfaces, but should also create genuinely magical moments by leveraging what DorkOS uniquely does: discover agents on the user's machine, network them, schedule them, and connect them to communication channels. The onboarding should DO things (discover real agents, create real schedules, configure real adapters) — not just show features. Desktop and mobile web surfaces should be treated as a single responsive experience.

- **Assumptions:**
  - The primary entry point is CLI install (`npm install -g dorkos`) followed by web client use
  - The Obsidian plugin gets lighter FTUE treatment in this spec, with extension points for future work
  - Pulse, Relay, and Mesh will be **enabled by default** (no env var = enabled). This is a change from the current architecture where they default to disabled
  - Target users are expert developers (Kai) and technical architects (Priya) — never the Prompt Dabbler (Jordan)
  - The web client must work well on both desktop and mobile via responsive adaptation
  - Many users will already have agent-configured directories (with `CLAUDE.md`, `.claude/`, etc.) on their machines that Mesh can discover
  - The FTUE should be persistent — if not completed on first visit, remaining steps should be offered on subsequent visits
  - Future: AgentTemplates (like "Wing") will be installable folder structures for new agents. The FTUE should have extension points for this

- **Out of scope:**
  - Deep Obsidian plugin FTUE (separate spec)
  - Marketing site onboarding / docs site restructuring (separate concern)
  - User analytics or FTUE metrics tracking infrastructure
  - Product tours, coach marks, or tooltip walkthroughs (the onboarding flow is fundamentally different — it produces real output, not passive observation)
  - AgentTemplate implementation (future spec, but the FTUE should have the hook for it)

---

## 2) Pre-reading Log

- `packages/cli/src/cli.ts`: CLI entry point — flag parsing, config precedence merge, subcommand dispatch. First-run detection exists but only logs "Created config at {path}"
- `packages/cli/src/init-wizard.ts`: 88-line interactive wizard — prompts for port, theme, tunnel, working directory. No descriptions, no "why", no post-setup summary
- `apps/server/src/services/core/config-manager.ts`: First-run detection via `.isFirstRun` boolean. Config stored at `~/.dork/config.json` with Ajv validation and corrupt config recovery
- `apps/server/src/lib/feature-flag.ts`: Lightweight runtime feature flags with error tracking. Currently defaults features to disabled
- `apps/client/src/App.tsx`: Main app shell — shows "New conversation" placeholder when no session is active. No welcome screen, no onboarding
- `apps/client/src/layers/shared/ui/FeatureDisabledState.tsx`: Generic 27-line component showing disabled state with CLI command. Used by all modules
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`: "No schedules yet" empty state with explanation and "New Schedule" button
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Relay adapter setup with 3-step wizard (configure, test, confirm)
- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`: Agent registry with multiple tabs (agents, topology, discovery, denied). Empty states per tab
- `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx`: Reusable empty state with optional CTA button
- `apps/client/src/layers/features/mesh/ui/TopologyEmptyState.tsx`: Topology-specific empty state
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: Settings tabs for Appearance, Behavior, Server. No field-level help text
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Session list with panel toggles and theme switcher. Auto-selects first session on directory change
- `meta/brand-foundation.md`: DorkOS positioning — "Your AI never sleeps", autonomous agent OS for developers/founders
- `meta/dorkos-litepaper.md`: Full product vision — Pulse (scheduler), Relay (messaging), Mesh (discovery), Engine (runtime), Console (UI)
- `contributing/design-system.md`: Calm tech philosophy — off-white/near-black, single blue accent, 8pt grid, 100-300ms motion
- `contributing/animations.md`: Motion library patterns — fade/slide entrances, AnimatePresence for exits, respects prefers-reduced-motion
- `research/20260301_ftue_best_practices_deep_dive.md`: 700-line deep research covering Fogg B=MAP, Hook Model, JTBD, progressive disclosure, considerate interfaces, and 10+ best-in-class examples

---

## 3) Codebase Map

### Primary Components/Modules

**CLI & Server Entry:**

- `packages/cli/src/cli.ts` (150 lines) — Entry point, flag parsing, config precedence, first-run detection
- `packages/cli/src/init-wizard.ts` (88 lines) — Interactive setup prompts (port, theme, tunnel, cwd)
- `apps/server/src/index.ts` — Server startup, feature initialization, service composition
- `apps/server/src/services/core/config-manager.ts` (152 lines) — First-run detection, config validation
- `apps/server/src/lib/feature-flag.ts` (31 lines) — Runtime feature flag factory

**Client App Shell & Navigation:**

- `apps/client/src/App.tsx` — Main container, sidebar/chat layout, keyboard shortcuts
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Session list, panel toggles, theme switcher
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Settings tabs

**Empty State Components (all need redesign):**

- `apps/client/src/layers/shared/ui/FeatureDisabledState.tsx` — Will be less needed with features-on-by-default, but kept for explicit opt-out cases
- `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx` — Reusable empty state
- `apps/client/src/layers/features/mesh/ui/TopologyEmptyState.tsx` — Topology-specific empty state
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx` — Pulse empty state (inline)
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` — Relay empty state (inline)

**Feature Module Panels:**

- `apps/client/src/layers/features/pulse/ui/` — Schedule list, create dialog, run history
- `apps/client/src/layers/features/relay/ui/` — Activity feed, message trace, adapter management
- `apps/client/src/layers/features/mesh/ui/` — Agent registry, topology graph, discovery

**Obsidian Plugin (lighter scope):**

- `apps/obsidian-plugin/src/` — Plugin lifecycle, CopilotView, React mounting

### Shared Dependencies

- **Design system**: Calm tech tokens (off-white/near-black, blue accent #3B82F6, 8pt grid)
- **UI primitives**: 17 shadcn components (Dialog, Drawer, Tabs, Tooltip, Badge, etc.)
- **Animation**: motion/react library, AnimatePresence, MotionConfig with reduced-motion
- **State**: Zustand (UI), TanStack Query (server), nuqs (URL params)
- **Responsive**: `useIsMobile()` hook, `ResponsiveDialog` (Dialog on desktop, Drawer on mobile)

### Data Flow

```
npm install -g dorkos
  → dorkos (CLI parses flags, merges config precedence)
  → ConfigManager detects first-run, creates ~/.dork/config.json
  → Init wizard runs (optional, skippable)
  → Server starts (Express binds, ALL features initialize by default)
  → Browser opens (or URL printed to terminal)
  → React app mounts → App.tsx renders
  → Empty session sidebar → user creates first session
  → ChatPanel loads → Claude Code responds
  → User discovers Pulse/Relay/Mesh tabs (already enabled, empty states guide first use)
```

### Feature Flags / Config

**Critical change: Features enabled by default.** When no env var or config entry exists, Pulse, Relay, and Mesh will be **enabled**. Users can explicitly disable with `DORKOS_PULSE_ENABLED=false`, `DORKOS_RELAY_ENABLED=false`, `DORKOS_MESH_ENABLED=false`.

This inverts the current pattern:

- Current: `undefined` → disabled, `true` → enabled
- New: `undefined` → enabled, `false` → disabled

### Potential Blast Radius

**High Priority (FTUE core):**

- New `features/onboarding/` FSD module — the functional onboarding flow (agent discovery, pulse presets, adapter setup), persistent progress tracking, first-run detection
- Feature flag default inversion (server + shared config schema + CLI flags)
- Server-side filesystem scanner API — endpoint for discovering agent directories (CLAUDE.md, .claude/, .dork/agent.json)
- Pulse preset registry — config file or module that defines preset schedules with prompts and cron expressions
- CLI startup output improvements (clean banner, first-run messaging)
- App.tsx — first-run detection, onboarding flow mount point
- All empty state components across Chat, Pulse, Relay, Mesh (rich visual previews)

**Medium Priority (integration):**

- SessionSidebar — persistent progress card for incomplete onboarding
- Mesh panel — integration with onboarding's agent discovery (shared registration flow)
- Pulse panel — integration with onboarding's preset creation (shared schedule creation)
- Relay panel — integration with onboarding's adapter setup (reuse AdapterSetupWizard)
- Config schema — onboarding completion state tracking (`onboarding: { completedSteps, dismissedAt }`)
- Celebrations infra — confetti/delight animation for agent discovery moment

**Low Priority (polish + future):**

- Settings dialog field-level help text
- Status bar informational improvements
- CLI post-setup summary
- Obsidian plugin FTUE
- Docs site getting-started guide
- AgentTemplate insertion point (placeholder UI for future spec)

---

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

---

## 5) Research

### FTUE Best Practices Deep Dive (Full report: `research/20260301_ftue_best_practices_deep_dive.md`)

The research covered 5 structured rounds with 22+ web searches, analyzing academic frameworks, developer tool examples, multi-module discovery patterns, and anti-patterns for expert users.

### Key Frameworks

**1. BJ Fogg's Behavior Model (B = MAP):** Behavior requires Motivation + Ability + Prompt to converge. For DorkOS, Kai already has maximum motivation — he installed the tool. The FTUE's job is to maximize Ability (reduce friction) and provide the right Prompt (affordances at the right moment). Increasing Ability is almost always more effective than increasing Motivation.

**2. Nir Eyal's Hook Model:** The Investment phase is the FTUE's hidden goal. Getting Kai to name his agent, create his first schedule, or configure his cwd builds investment that drives return visits. The first meaningful personalization is more valuable than any amount of feature explanation.

**3. JTBD for Onboarding Architecture:** The FTUE should route to jobs, not introduce features. Kai's job: "agents work autonomously while I sleep." Priya's job: "think and execute in the same environment." Every FTUE element should move the user toward their job.

### Best-in-Class Examples

| Tool        | Brilliant Insight                                                                                                                           | Transferable to DorkOS                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Linear**  | Theme selection first — low-stakes personalization before any demands. Teaches keyboard shortcuts early — signals "this is for power users" | Start with personalization (theme, cwd), teach command palette early                   |
| **Vercel**  | Zero-config deployments — value before understanding                                                                                        | `dorkos` must "just work" with zero config on first run                                |
| **Stripe**  | Docs ARE the FTUE. Time-to-first-API-call is the north star                                                                                 | README is the first UI. Time from install to first session under 3 minutes             |
| **Arc**     | 90-second feature introduction, hands-on, with immediate escape hatch                                                                       | Each module should have a ~90-second interactive "why this exists" available on demand |
| **Notion**  | Template-based workspace preloading solves blank canvas paralysis                                                                           | Empty states should show visual previews of what populated state looks like            |
| **Raycast** | Lead with universal features, let extensions be discovered through use                                                                      | Chat is the entry surface; command palette surfaces everything else                    |

### Why Product Tours Are Wrong for DorkOS

- 16-33% completion rate for tours with more than 6 cards
- Expert users (Kai) cite forced tours as anti-adoption signals
- Passive observation doesn't create learning retention — active engagement does
- Tours appear before users have context to absorb the information
- One exception: user-triggered, opt-in tours for specific modules outperform by 2-3x

### Progressive Disclosure as Permanent Architecture

Progressive disclosure is not a temporary onboarding state — it's the product's permanent information architecture. The hierarchy:

1. **Primary surface**: Chat (always visible, always the default)
2. **Secondary surface**: Pulse, Relay, Mesh tabs (visible but lower visual weight)
3. **Tertiary surface**: Configuration, advanced settings, agent identity
4. **Discoverable**: Command palette (Cmd+K) surfaces everything by intent-search

Research finding: designs with more than 2 levels of disclosure nesting have low usability. DorkOS's 4 modules must feel like a flat, scannable list — not a hierarchy of nested features.

### Empty States as Primary FTUE Vehicle

Nielsen Norman Group research: well-designed empty states are more memorable and effective than forced tutorials because they're encountered naturally. The three functions:

1. **Communicate system status**: Empty because nothing exists yet, not because of an error
2. **Provide learning cues**: Show what you'd find here if populated
3. **Enable direct task pathways**: One clear action button

Design formula: two parts instruction, one part delight. Instruction must be completely clear before personality is added.

### The "Considerate Interface" Framework (Alan Cooper)

Key principles for DorkOS FTUE:

- **Takes an Interest**: Remember last cwd, last theme, last session
- **Is Forthcoming**: When creating a schedule, show next 3 run times. When opening a session, show git status
- **Keeps Informed Without Interruption**: Status bar, quiet badges — not modals or alerts
- **Is Perceptive**: Remember preferences automatically. Don't ask twice
- **Doesn't Ask Many Questions**: Directory picker with sensible defaults, not a prompt asking "which directory?"
- **Doesn't Burden With Its Problems**: Don't surface system errors unless the user needs to act

### The Anti-Persona Filter

If a design decision makes DorkOS easier for Jordan (non-technical, wants templates and no-code), it probably makes it worse for Kai. Specific signals to preserve:

- Technical terminology: sessions, schedules, cwd — never softened
- Configuration visibility: env vars and config files are features, not obstacles
- Architectural transparency: the README leads with what the tool IS, not what it promises

### Potential Solutions

**1. Passive Progressive Disclosure + Empty States Only**

- Description: No welcome modal, no tour, no guided flow. Chat is the default. Each module has rich empty states with visual previews. Users discover features by clicking tabs
- Pros: Respects expert users, natural discovery, permanent not temporary, research-backed
- Cons: Risk of underdiscovery of Pulse/Relay/Mesh if users never click the tabs. Misses the opportunity to create magic moments. Doesn't leverage DorkOS's unique ability to discover existing agents on the user's machine
- Complexity: Medium
- Maintenance: Low

**2. Goal-Driven First-Run**

- Description: On first web client open, show a 2-3 option selector: "What brings you here?" → routes to the relevant module
- Pros: Immediately relevant experience, maps to JTBD framework
- Cons: Adds one step before value, can feel like a survey, risks Jordan-ification
- Complexity: Low
- Maintenance: Low

**3. Functional Onboarding (Recommended)**

- Description: A guided first-run experience that DOES real things — discovers real agents on the machine, creates real schedules from presets, configures real adapters. Each step produces tangible output. Not a tour that shows features, but a wizard that activates the product. Persistent across sessions — if the user exits mid-flow, remaining steps are offered on the next visit via a subtle, non-intrusive mechanism
- Pros: Creates genuine "magic moments" (discovering 5 agents you already have is delightful). Each step produces real value — the user walks away with a working system. Leverages DorkOS's unique capabilities that no other product has. Persistent progress respects the user's time. Expert users still feel respected because the onboarding is doing real work, not explaining concepts
- Cons: Higher implementation complexity. Must gracefully handle edge cases (no agents found, adapter auth failures, schedule creation errors). Must remain non-blocking — the user must be able to skip at any point and use Chat immediately
- Complexity: High
- Maintenance: Medium (presets config, adapter catalog, and AgentTemplate hooks need upkeep)

**4. Hybrid: Functional Onboarding + Progressive Empty States**

- Description: Combine Approach 3's functional onboarding flow for first-run with Approach 1's rich empty states as the permanent fallback. If the user skips or exits onboarding, each module's empty state still guides them. If they complete onboarding, the empty states are already populated
- Pros: Best of both worlds. Magic moments for engaged users, graceful fallback for skip-happy experts. The empty states serve double duty — they work during onboarding AND independently
- Cons: Requires designing both systems, though they share components
- Complexity: High
- Maintenance: Medium

### Recommendation

**Approach 4 (Hybrid: Functional Onboarding + Progressive Empty States)** is the recommended path. Here's why:

1. **DorkOS does things other products don't.** Discovering agents already on the user's machine and networking them is genuinely novel. A passive empty state can't create that moment — but a guided discovery flow can. The research says the best FTUEs look like "the product working." Agent discovery IS the product working.

2. **Each onboarding step produces real output.** This is the critical distinction from a product tour. A tour shows; this onboarding builds. After completing the flow, the user has: registered agents in Mesh, scheduled runs in Pulse, and connected adapters in Relay. The product is operational.

3. **The persistent progress model respects time.** If Kai installs DorkOS at 11pm and only has 2 minutes, he can discover agents and skip the rest. Tomorrow, when he opens the client, a subtle indicator offers to continue where he left off. This is considerate software — it remembers his context without demanding his attention.

4. **Empty states are the safety net.** If the user skips the entire onboarding, every module still has a rich empty state that guides them independently. The onboarding is additive, not required.

5. **It creates opportunities for genuine delight.** The celebration when Mesh discovers 5 agents across the user's projects is a moment no other tool provides. This is the kind of magic that turns users into advocates.

### The Functional Onboarding Flow

**Context:** This flow appears on first web client open. It's skippable at every step. Each step produces real output. Progress persists across sessions.

#### Step 1: Agent Discovery (Mesh)

The first and most magical step. DorkOS scans the user's filesystem for directories that contain agent markers.

**What we scan for (broadest net — any AI-configured project):**

- Directories with `CLAUDE.md` files (Claude Code projects)
- Directories with `.claude/` directories (Claude Code configuration)
- Directories with `.dork/agent.json` manifests (already-configured DorkOS agents)
- Directories with `.cursor/` configuration (Cursor IDE projects)
- Directories with `.github/copilot` or similar AI-related configuration
- Git repositories with any of the above markers

When the user confirms a project, DorkOS creates a `.dork/agent.json` manifest in that directory — upgrading it from "AI-configured project" to "DorkOS agent" with networking and scheduling capabilities.

**Scan scope:** Full home directory scan with exclusions (node_modules, .git internals, vendor, Library/, AppData/, etc.). Use fast filesystem traversal with depth limit. Show results progressively as they're found — the staggered entrance animation makes even a 5-10 second scan feel dynamic rather than sluggish.

**If agents are found — the three-beat magic moment:**

**Beat 1 — Staggered discovery:** Agent cards appear one by one as the scan finds them. Each card shows: project name (from git or directory name), path, git branch, and what AI config was detected (CLAUDE.md, .claude/, etc.). The stagger animation builds anticipation — "oh, it found that one too!"

**Beat 2 — Confetti celebration:** When the scan completes, confetti burst (using existing celebrations infra) with a large, elegant "Found {N} agents!" announcement. The typography and animation here should be cinematic — this is the emotional peak.

**Beat 3 — Topology reveal:** The agent cards animate/morph into a mini topology graph, showing the agents as connected nodes with lines drawing between them. The graph pulses briefly, signaling "alive" and "networked." This demonstrates the VALUE of discovery — not just "we found things" but "they're now connected."

After the sequence: the user can review the discovered agents, deselect any they don't want registered, then confirm. All confirmed agents get `.dork/agent.json` manifests created and are registered in Mesh.

**If multiple agents found:**

- Emphasize the networking aspect: "These {N} agents can now talk to each other. A scheduling agent can ask a finance agent to approve a budget. A docs agent can verify code examples against the real codebase."
- Show the topology graph with connections between agents

**If no agents found — guided agent creation:**

- Don't treat this as failure — treat it as opportunity
- "No agents found yet — let's create your first one."
- **Guided inline flow:** Pick a project directory (defaults to cwd where dorkos was launched) → name the agent → optional persona sentence → Create. Creates `.dork/agent.json`. The naming step is the personalization/investment moment
- The new agent appears as a single node in a mini topology graph — small but ready to grow
- **Future (AgentTemplate):** Before the manual creation flow, show template cards: "Start from a template" → Wing (general-purpose), CodeReviewer, DocsKeeper, SecurityAuditor. Each describes what it installs. User picks one, selects a directory, template installs and registers. This is the primary insertion point for AgentTemplates

#### Step 2: Continuous Improvement (Pulse)

After agent discovery, transition naturally: "Now that your agents are set up, want them to work while you sleep?"

**Preset schedules** (loaded from `~/.dork/pulse/presets.json`, created with defaults on first run):

- "Codebase health check" — Weekly lint + typecheck + test run with a report
- "Dependency audit" — Weekly check for outdated/vulnerable packages
- "Documentation sync" — Daily verify that docs match implementation
- "Code quality review" — Weekly code review of recent commits
- "Custom" — Write your own prompt and schedule

**The UI:**

- Each preset shown as a card with: name, description, cron expression (human-readable), and the prompt that will be used
- User toggles on/off the ones they want. Can edit the cron expression or prompt before confirming
- For each selected preset, the user picks which agent(s) it applies to (from the agents discovered in Step 1)
- On confirm: real schedules are created in Pulse. Next run times are shown
- Delight moment: "Your first schedule runs at {time}. You'll have results waiting for you."

**If the user has no interest in scheduling:**

- "Skip for now" is always available and prominent
- The Pulse empty state will guide them later

#### Step 3: Adapters (Relay)

After scheduling (or skipping it): "Want your agents to reach you when they're done?"

**Available adapters:**

- **Telegram** — "Get notified on Telegram when agents finish work, runs complete, or errors occur"
- **Webhooks** — "Send events to any URL — Slack incoming webhook, Discord, custom endpoints"
- Future adapters shown as "coming soon" cards

**The flow:**

- Each adapter card shows what it does and what's needed to set it up (e.g., Telegram bot token)
- Selecting an adapter launches the existing `AdapterSetupWizard` (configure → test → confirm)
- On successful test: celebration + "Connected! Your agents can now reach you on Telegram."
- If the user doesn't have credentials ready: "Set this up later" with a clear path back (Relay tab → Adapters)

#### Persistent Progress

**The key principle:** The onboarding is valuable enough to offer again, but never aggressive enough to annoy.

**Implementation:**

- Track onboarding completion state in `~/.dork/config.json` (e.g., `onboarding: { completedSteps: ['mesh'], dismissedAt: null }`)
- If the user exits mid-flow, the next visit shows a subtle, contextual reminder — NOT a modal or banner that blocks the UI
- **Display mechanism:** A small card or collapsible section in the session sidebar (below the session list) that says something like: "Continue setup — Pulse and Relay are ready to configure" with direct links to each remaining step
- The card is dismissable ("Don't show again"). If dismissed, it's gone forever
- Once all 3 steps are completed (or individually dismissed), the onboarding system is fully retired
- On mobile: the same mechanism adapts — perhaps a subtle bottom sheet or a badge on a "Setup" tab

#### Skip and Skip-All

- Every step has a prominent "Skip" option
- There's also a "Skip all — I'll explore on my own" that dismisses the entire onboarding flow immediately
- Skipping is respected. The rich empty states in each module serve as the fallback FTUE
- The persistent progress card (sidebar) only shows steps the user hasn't explicitly skipped

#### AgentTemplates (Future Extension Point)

When AgentTemplates are implemented:

- They appear in Step 1 when no agents are discovered: "No agents found. Start with a template?"
- They also appear when creating a new agent from any context (Mesh panel, agent settings)
- A template is a folder structure (CLAUDE.md, .claude/commands/, .dork/agent.json, etc.) that gets installed into a directory
- Templates are loaded from a registry (local config or remote catalog)
- This is out of scope for this spec but the onboarding flow should have a clear insertion point for it

---

## 6) Decisions

| #   | Decision                            | Choice                                               | Rationale                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FTUE scope and priority             | Full journey, web-first                              | Design the complete path from npm install through module activation. Invest most depth in web client (desktop + mobile). CLI and Obsidian plugin get lighter treatment with extension points                                                                                                                                                       |
| 2   | Empty state richness                | Contextual + visual preview                          | Each module's empty state explains purpose in 2 sentences, shows a small visual preview of what populated state looks like (e.g., mini topology graph, sample schedule card), and provides one clear action. Research shows visual previews outperform pure text                                                                                   |
| 3   | Feature activation model            | **Features enabled by default**                      | Pulse, Relay, and Mesh are enabled when no env var exists. Inverts the current disabled-by-default pattern. Eliminates the entire "discover features behind flags" problem. Users can explicitly disable with `=false`                                                                                                                             |
| 4   | Mobile FTUE approach                | Responsive adaptation                                | One FTUE design that adapts to screen size via existing responsive patterns (useIsMobile, ResponsiveDialog). Full-screen onboarding flow uses full-width sheets on mobile. Cards stack vertically. Touch-optimized tap targets                                                                                                                     |
| 5   | Onboarding approach                 | **Functional onboarding + empty state fallback**     | A 3-step guided flow (Discover Agents → Enable Pulse Presets → Connect Adapters) that does real work at each step — not a product tour. Every step produces tangible output. Rich empty states serve as permanent fallback for users who skip                                                                                                      |
| 6   | Onboarding UI container             | **Full-screen flow**                                 | The onboarding takes over the entire viewport — no sidebar, no tabs, just the flow. Each step gets the full canvas. When the flow completes, it transitions into the full product (sidebar slides in, populated). A prominent "Skip all" is always visible. The onboarding IS the first product experience                                         |
| 7   | Agent definition (what to scan for) | **Any AI-configured project (broadest)**             | Scan for CLAUDE.md, .claude/, .cursor/, .github/copilot, .dork/agent.json, or any AI-related config in git repositories. Maximizes discoveries. When confirmed, projects get `.dork/agent.json` manifests, upgrading them to DorkOS agents with networking and scheduling                                                                          |
| 8   | Scan scope                          | **Full home directory with exclusions**              | Scan everything under ~/ excluding node_modules, .git internals, vendor, Library/, etc. Show results progressively as found. The staggered entrance animation makes even longer scans feel dynamic                                                                                                                                                 |
| 9   | Pulse presets source                | **Server-side JSON at `~/.dork/pulse/presets.json`** | Created with defaults on first run (health check, dependency audit, docs sync, code review). Fully user-editable. If corrupted/deleted, re-created with defaults on next server start                                                                                                                                                              |
| 10  | Onboarding state persistence        | **Server-side config**                               | `onboarding` key in `~/.dork/config.json`: `{ completedSteps, skippedSteps, dismissedAt }`. Server exposes via config API. Persists across browsers, devices, and client types (web + Obsidian). Single source of truth                                                                                                                            |
| 11  | Persistent progress display         | **Sidebar card with step links**                     | Small collapsible card below session list in sidebar. Shows remaining steps as clickable links. Permanently dismissable. On mobile, appears at top of session drawer. Clicking a step re-enters the full-screen onboarding at that step                                                                                                            |
| 12  | Discovery celebration               | **Three-beat sequence**                              | Beat 1: Staggered card entrance as agents are found. Beat 2: Confetti burst + "Found {N} agents!" announcement. Beat 3: Cards morph into topology graph showing connections forming. Total: ~3-4 seconds of choreographed delight                                                                                                                  |
| 13  | No agents found experience          | **Guided agent creation**                            | "No agents found yet — let's create your first one." Inline flow: pick directory → name agent → optional persona → Create. The naming step is the investment moment. Future: AgentTemplate cards appear before manual creation                                                                                                                     |
| 14  | Discovery re-entry                  | **Re-scannable from Mesh panel**                     | After onboarding, the Mesh panel gets a "Discover agents" button that re-runs the same scan. Discovery is a permanent product capability, not a one-time onboarding feature                                                                                                                                                                        |
| 15  | Visual design quality               | **Elevated within design system**                    | Same calm tech palette (off-white/near-black, blue accent) but turned up: larger headline typography (24-32px), more generous whitespace (16-24pt), smoother spring animations (300-500ms), richer micro-interactions (hover states, focus rings, press feedback). Minimal, elegant, extremely polished. The most cinematic surface in the product |
| 16  | AgentTemplates                      | **Future extension point**                           | The onboarding flow has a clear insertion point for AgentTemplates (installable folder structures). Shows when no agents are discovered. Out of scope for implementation but designed into the flow                                                                                                                                                |

---

## Appendix: Persona Journey Maps

### Kai's Ideal First 10 Minutes (The Autonomous Builder)

**Minute 0:** Reads README. Sees architecture description first (not marketing). Sees `npm install -g dorkos`. Copies. Runs.

**Minute 1:** `dorkos` starts. Clean terminal output:

```
DorkOS v1.x.x
Server: http://localhost:4242
Directory: /Users/kai/projects (detected from cwd)
Features: Chat | Pulse | Relay | Mesh

New to DorkOS? Start a session at http://localhost:4242
```

No ASCII art. No "Welcome!" Greppable, informative, clean. The "New to DorkOS?" line appears on first run only.

**Minute 2:** Opens web UI. First-time detection triggers the functional onboarding.

**Step 1 — Agent Discovery:** "Let's find your agents." DorkOS scans Kai's filesystem. A spinner shows briefly, then — agents appear one by one, staggered animation. Found 7 agents across 5 projects. Confetti. "Found 7 agents across your projects."

Kai sees his projects listed as cards — the monorepo, the CLI tool, the side project, the client work. Each with its directory, git branch, and whether it has CLAUDE.md. He recognizes his world reflected back to him. This tool understands what he has.

"These agents are now part of your mesh network. They can discover each other, communicate, and coordinate work." A mini topology graph shows the 7 agents as connected nodes. Kai's eyes widen slightly — this is what he came for.

He deselects the client work project (not his, doesn't want it in the mesh). Confirms 6 agents. They're registered.

**Minute 4 — Step 2 — Continuous Improvement:** "Want your agents to work while you sleep?"

Preset cards appear: Codebase health check (weekly), Dependency audit (weekly), Code review of recent commits (daily). Each shows the prompt that will be used and the cron expression in human-readable form.

Kai toggles on "Codebase health check" and "Code review of recent commits." He picks his monorepo agent for both. Edits the code review cron from daily to "weekday mornings at 7am." Confirms. Two schedules created. Next run times shown.

"Your first code review runs tomorrow at 7:00am. Results will be waiting for you."

Kai thinks: "This is what I've been wanting."

**Minute 6 — Step 3 — Adapters:** "Want your agents to reach you when they're done?"

Telegram card appears. Kai already has a Telegram bot from another project. He pastes the token. Test message sent. His phone buzzes. "Connected! Your agents will notify you on Telegram when runs complete."

Kai skips the webhook adapter. Done.

**Minute 7:** Onboarding complete. The UI transitions to the chat interface. Kai sees his session sidebar, the populated Mesh topology, and the Pulse tab showing 2 scheduled runs. He opens a session in his monorepo. Types a message. Claude Code responds.

**The investment is made.** Kai has 6 registered agents, 2 active schedules, and a Telegram connection. This took 7 minutes and produced a fully operational system. He will come back.

### Kai's "Skip Everything" Path (2 minutes)

**Minute 0-1:** Same CLI install and first open.

**Minute 2:** Sees the onboarding. Clicks "Skip all — I'll explore on my own." The onboarding disappears instantly. Clean chat interface. Empty session sidebar with directory picker and "New Session" button.

Kai creates a session. Works normally. The Pulse, Relay, and Mesh tabs are there in the sidebar — already enabled, with rich empty states ready when he's curious.

A small, collapsible card in the sidebar says: "Continue setup — discover agents, enable scheduling, connect adapters." He ignores it. It stays quiet.

Two days later, he notices the card again. Clicks "Discover agents." The magic moment happens on day 2 instead of day 1. The onboarding adapts to his pace.

### Priya's Ideal First 10 Minutes (The Knowledge Architect)

**Minute 0:** Discovers DorkOS through Obsidian community. Reads docs about the plugin. Installs CLI + Obsidian plugin.

**Minute 1:** Plugin activates. Detects running DorkOS server (or prompts to start one). Panel opens in Obsidian.

**Minute 2:** The plugin's empty state speaks Obsidian language: "Ask Claude Code about your notes, run code, or execute tasks. Your vault is the context." Priya types a question referencing a note.

**Minute 3:** Claude Code responds with vault context. The integration is real — this isn't a chat widget. Trust established.

**Minute 4:** Priya opens the web client (she wants to see the full interface). First-time detection triggers the functional onboarding.

**Agent Discovery:** DorkOS finds 3 projects on her machine — the main service, the API gateway, and her personal knowledge base. She registers all 3. Sees them connected in the topology graph. Appreciates the clean architecture.

**Minute 6 — Pulse:** She selects "Documentation sync" (daily verify docs match implementation) for the main service agent. She edits the prompt to reference her specific ADR format. Creates one schedule.

**Minute 8 — Adapters:** She skips adapters for now — she prefers to check results in the web UI, not get push notifications. "Skip for now."

**Minute 9:** Opens agent identity settings for her main service agent. Names it "Atlas." Gives it a persona focused on architecture and system design. The agent becomes an extension of her thinking.

**Minute 10:** Returns to Obsidian. The agent panel is there when she needs it. Atlas will check her docs every morning. Calm technology.

### "No Agents Found" Journey (New User)

**Minute 2:** First open. Agent Discovery scans. Spinner. "No existing agents found on your machine."

Not a failure — an opportunity. "Let's set up your first agent."

**Current (pre-AgentTemplate):** Directory picker defaults to the cwd where `dorkos` was run. "Configure this directory as an agent?" User names the agent, optionally sets a persona. A `.dork/agent.json` is created. The agent appears in the topology graph — a single node, ready to grow.

**Future (with AgentTemplates):** "Choose a template to get started." Cards show available templates: Wing (general-purpose), CodeReviewer, DocsKeeper, SecurityAuditor. Each describes what it installs (CLAUDE.md, .claude/commands/, etc.). User picks one, selects a directory, template installs. The agent is configured and registered.

The flow then continues to Pulse and Relay as normal.

### Mobile Journey (Responsive Adaptation)

**First open on mobile:** Same onboarding flow, responsive layout. Agent discovery works identically (the scan is server-side). Cards stack vertically. The topology graph is replaced with a simpler list view on small screens. Preset schedule selection uses full-width cards.

**Key mobile adaptations:**

- Onboarding steps use full-screen sheets (Drawer) instead of inline sections
- Agent cards are stacked, touch-optimized with large tap targets
- The topology graph preview is simplified or replaced with a count badge ("6 agents networked")
- Adapter setup uses the same ResponsiveDialog pattern (Dialog → Drawer on mobile)
- The persistent progress card appears as a small banner at the top of the session drawer

**Ongoing mobile use:** Primarily monitoring — checking session status, reviewing Pulse run history, reading agent responses. The full onboarding flow works on mobile but most users will complete it on desktop first.
