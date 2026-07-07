# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!--
  Unreleased entries live in changelog/unreleased/ — one file per change.
  Do NOT add entries here; add a fragment instead. See changelog/README.md.
  Only /system:release compiles fragments into a version section below.
-->

## [0.44.0] - 2026-06-16

### Added

- Agent context (git status, UI state, queued-message notes) now travels alongside your message instead of inside it — your message reaches the agent exactly as written, and that context never shows up as if you had typed it (#258)
- Agents no longer receive git status twice per turn, trimming redundant prompt context (DOR-132)
- Surface session hook progress ("Running hook X…") in the chat status strip, clearing when the model resumes (DOR-125)
- Tiered command/file palette ranking + alias provenance (DOR-119, DOR-120)
- Render local slash-command output in chat (DOR-126)
- Introduce Core Extensions tier (rename builtin → core)
- Match slash commands by their aliases in the palette, and refresh the command
  list when the agent changes it mid-session (DOR-108)
- Persist a context-compaction row in chat ("Context compacted · N tokens ·
  manual/auto") sourced from the durable transcript, plus a live "Compacting
  context…" strip that resolves and an inline failed-compaction notice (DOR-118)

### Changed

### Fixed

- Chat status strip was starved of live `system_status` events (the projected turn dropped them), so "Compacting context…" and hook progress only appeared after the durable history reload — now retained live (DOR-125, completes DOR-118)
- Open the canvas when an agent pushes content (DOR-97, DOR-104)
- Apply enable/disable live instead of requiring a page reload

---

## [0.43.1] - 2026-06-13

### Changed

- Upgrade Claude Agent SDK to 0.3.177 (restores background-agent and MCP task
  state on session resume)
- Derive Obsidian model/subagent catalog from the SDK
- Codify "one checkout, one writer" worktree strategy

### Fixed

- Give the marketing site a worktree-unique dev port
- Dispatch slash commands as bare prompts so the CLI parses them (DOR-107)
- Read SDK-persisted session titles, drop in-memory overlay (DOR-101)
- Establish flex column root so tall canvas documents scroll (DOR-96)

---

## [0.43.0] - 2026-06-11

### Added

- Docs/ADRs + consolidated dead-code retirement (task #18 — spec complete)
- Stateless EventLog-backed test-mode runtime — runtime-agnosticism proof (task #15)
- Live-turn fidelity events + task/status-strip wiring (#19)
- Restore chat send via trigger-only POST + durable /events (Phase 5)
- Live sidebar + session list via global stream, drop poll (Phase 4)
- Client streaming foundation — StreamManager, hydration, flag removal (Phase 3)
- Runtime-agnostic session streaming — server foundation (Phases 1-2)
- Integrate worktrees into spec execution and Linear loop
- Batch 9 — browser acceptance PASS; implementation complete (DOR-73)
- Batch 7 — resolve recovered cards on result + countdown-zero (DOR-73)
- Batch 6 — Path-B sync routing + server cross-cutting tests (DOR-73)
- Batch 5 — Path A fetch-on-mount, single-resolve verification, docs (DOR-73)
- Batch 4b — Path B re-emit pending interactions on /stream connect (DOR-73)
- Batch 4a — Path A GET /pending-interactions endpoint + transport (DOR-73)
- Batch 3 — getPendingInteractions on the runtime abstraction (DOR-73)
- Batch 2 — pending-interactions selector + idempotent client renderers (DOR-73)
- Batch 1 — pending-interaction snapshots + shared remainingMs/DTO (DOR-73)
- SDK-native breakdown via held-open prompt (A1)
- Runtime auto-mode guard + plain-language confirm copy (#253 follow-ups)
- Adopt auto as a model-gated permission mode (#253 Phase 2)
- Persist per-session settings; allow instant live bypass
- Stream subagent text into the background-task block
- Adopt SDK 0.3.168 native binary, refusal & error surfacing

### Changed

- Triage-type states are never dispatchable
- Evidence-on-close convention — proof, not claims
- Adopt Linear Method conventions + dispatch policy
- Regenerate API docs for GET /pending-interactions (DOR-73)
- Batch 8 — client cross-cutting tests (DOR-73)
- Document Composio CLI as a fallback Linear access path
- Drop orphaned makeUserPrompt
- Guard the generated OpenAPI spec against schema drift
- Correct Claude Code install guidance for the SDK 0.3.168 native binary
- Reconcile developer guides with the past week's changes
- Remove the no-op autoMode toggle and disableAutoMode plumbing (#253 Phase 1)
- Relocate the sdk-event-mapper streaming tests, drop dead mock
- Group claude-code/ into domain subdirs
- Split sdk-event-mapper into focused per-category mappers
- Document granular npm token for 2FA-bypass publish

### Fixed

- Follow-the-rekey continuity (NF-2) + rail row resolution (NF-3) + cross-client pins (task #17)
- F2 identity-seed rekey + test-mode e2e rescue — acceptance re-run fixes (task #16)
- Client quality pass — one /events connection, trigger latch, honest liveness (task #6 batch B)
- Fleet-wide session discovery + server quality pass (task #6 batch A)
- Transport seam — embedded send, real stream methods, baseUrl-aware StreamManager (CLI-C2)
- Sidebar liveness via session_status fanout + hide SDK resume-bootstrap messages
- First-turn id split-brain + interaction-cancel ghosts (acceptance F1/F2/F4/F5)
- Repair command drift, harden checks, probe port collisions
- Harden resume protocol + live approvals (review blockers)
- Report the last request's window, not the turn's cumulative usage
- Report accurate context-window usage in the status bar
- Prune orphan API-reference MDX and repair the docs CI guard
- Don't mutate session mode in the auto-mode guard (self-review)
- Restore streamed thinking on Opus 4.8/4.7
- Harden answer formatting and extract the answer summary
- Stack multi-question answers and remove answered-row flicker
- Deliver structured-question answers to the agent and persist them in the UI
- Address review — reconcile validation docs, echo all settings in PATCH
- Match agent display name in fleet-page search
- Sort agent lists by resolved display name

---

## [0.42.0] - 2026-06-05

### Added

- Surface SDK memory recall events in assistant bubbles
- Render calm status copy from system_status.status
- Enhance SDK event handling with memory recall and terminal reason support
- Surface SDK terminal_reason as informational chip
- Chat: Memory recall indicator — see which memory files shaped each response
- Sunset deferred items from spec 244 prework
- Per-session runtime ownership + capability gating + runtime-neutral relay
- Add /app:runtime-upgrade command for strategic SDK upgrades
- Add new shared skills for Linear workflows

### Changed

- Polish memory recall indicator per code review
- Move shared skills to .agents/skills/ with symlinks
- Add `pnpm dev:dogfood` to run the dev preview and built CLI cockpit side by side

### Fixed

- Downgrade fumadocs-openapi 10.7.1 → 10.6.8 to fix api-doc generation
- Address code review on spec 244 implementation

---

## [0.41.0] - 2026-04-15

> Plugin installation polish and chat input reliability — responsive dialogs, personality picker enhancements, and critical fixes for agent discovery and server stability.

### Added

- Enhance plugin activation and refresh mechanism
- Responsive install dialog and agent picker
- Enhance PersonalityPicker and onboarding flow
- Add PersonalityPicker showcase and integrate into FeaturesPage
- Introduce new chat input components and enhance functionality

### Changed

- Enhance RightPanelContainer styling and transitions
- Streamline imports and enhance ChatInput styling

### Fixed

- Resolve PluginSource objects to giget-compatible strings
- Eliminate spurious 404 and 400 errors on agents page load
- Prevent unhandled errors from crashing Express process
- Prevent AgentPicker dropdown clipping in install dialog
- Show all registered agents in install dialog
- Update project management copy for clarity
- Fix playground registry slug and agent management copy
- Improve agent management action descriptions for clarity

## [0.40.0] - 2026-04-14

> Agent personality and sidebar polish — verbosity-based traits, lifecycle management actions, scoped marketplace installs, and refined animations across the Agent Hub, sidebar, and session components.

### Added

- Add agent lifecycle management actions and split navigation
- Enhance sidebar functionality and UI components
- Add polished avatar picker with micro-interactions and transitions
- Enhance agent trait management and UI components
- Update personality traits from tone-based to verbosity-based system
- Improve PersonalityRadar component for light/dark mode adaptability
- Implement AgentChipContextMenu and enhance ShortcutChips for agent actions
- Update PersonalityRadar component for improved light/dark mode support
- Add nebula theme utilities and PresetPill component
- Polish AgentListItem expand/collapse with spring animations and loading states
- Implement context menu and compact/full session row components
- Enhance AgentHub with loading skeleton and animation transitions
- Add scoped installs and skills-first Toolkit tab
- Add dev tools dropdown menu with unified TanStack devtools panel

### Changed

- Update agent management actions and enhance UI components
- Streamline RightPanelHeader and enhance AgentHubHero UI
- Replace hardcoded default traits with DEFAULT_TRAITS constant
- Remove 'active' status from session indicators and update related tests
- Replace SessionItem with SessionRow components in sidebar and features sections
- Enhance AgentListItem animation and expand/collapse logic
- Fix stale JSDoc referencing removed Sessions drill-down
- Simplify AgentListItem interactions and visual container

### Fixed

- Add success toasts for deny/unblock actions
- Address code review findings in AgentListItem
- Wire route projectPath param and address review findings

---

## [0.39.0] - 2026-04-12

> Agent Hub reimagined — immersive hero design, Cosmic Nebula personality visualization, shell-level right panel infrastructure, and smooth panel animations across the platform.

### Added

- Animate right panel open/close and unify sidebar transition timing
- Redesign Agent Hub with immersive hero, inline pickers, and shared panel header
- Add Cosmic Nebula visualization to personality radar and onboarding
- Redesign Agent Hub with Personality Theater and 3-tab layout
- Add unified Agent Hub right-panel replacing AgentDialog modal
- Add shell-level right panel infrastructure with canvas migration
- Add displayName field to decouple display label from slug

### Changed

- Remove orphaned session.canvas slot and add right-panel to ExtensionPointId
- Update extension slot references to include right-panel
- Merge duplicate imports from @dorkos/marketplace

### Fixed

- Remove dead onClose prop from CanvasHeader and unused TabBar import
- Sync animRef state when animated=false and rename stale testid
- Register agent-hub right-panel contribution and fix 13 broken tests
- Merge DorkOS sidecar in server aggregation and unify shared logic

---

## [0.38.0] - 2026-04-11

> Agent creation polish and chat input reliability — new session navigation after agent creation, improved directory picker, and three fixes that ensure the textarea is always focused and typeable after switching agents.

### Added

- Navigate to new session after creating an agent
- Add PathInput component, improve ConfigureStep layout, allow existing dirs

### Fixed

- Include session param in setDir navigation to fix chat input
- Ensure session param on agent switch so textarea gets focus
- Resolve textarea focus loss after interactive mode exit

---

## [0.37.0] - 2026-04-11

> Mesh discovery and agent creation — pre-scan landing states, 7 new AI agent strategies, an instant-advance creation wizard, and a unified /agents page streamline onboarding and daily management.

### Added

- Enhance DiscoveryView with pre-scan state and illustration
- Add discovery strategies for 7 new AI coding agents
- Redesign dialog as instant-advance wizard
- Consolidate mesh panel dialog into /agents page
- Add marketplace-dev skill for package authoring
- Redesign Marketplace with trust signals, animations, and progressive disclosure

### Changed

- Reconcile 8 guides with recent mesh, tool-approval, state, and API changes
- Use ResponsiveDialog, extract sub-components, optimize for mobile

### Fixed

- Use actual emoji character instead of escaped surrogate pair
- Accept template name in handleTemplateSelect, remove unused prop
- Preserve search params when switching view tabs
- Fix sidebar add-agent buttons not opening creation dialog

---

## [0.36.0] - 2026-04-11

> Agent sidebar redesign — stable alphabetical ordering, pinning, context menus, and activity badges replace the old LRU-shuffling 8-agent cap, alongside a tool approval overhaul and SDK-driven model discovery.

### Added

- Redesign agent list with stable ordering, pinning, and context menu
- Unify dashboard and session sidebars with expandable agents
- Comprehensive tool approval system overhaul
- SDK-driven model discovery with disk cache, warm-up, and universal schema
- Add opensrc skill for fetching dependency source code
- Channels tab functionality — pause, test, activity metadata
- Channels tab visual polish — brand icons, progressive disclosure, humanized copy

### Changed

- Use bg-secondary for selected model card
- Use ResponsivePopover for model config, fix card width

### Fixed

- Synthesize DorkOS manifest from CC plugin.json for CC-only packages
- Prevent popover drift during status bar content changes
- Preserve model selection during effort/mode changes
- Prevent model popover overflow and blank state on config change
- Migrate stagePackage to fetchPackage dispatcher for relative-path sources
- Prevent stale ToolApproval card after input-zone approval
- Align ModelConfigPopover with Design B mockup
- Filter internal adapters from channels tab and inline setup wizard

---

Older releases (v0.1.0 – v0.35.0) are archived in [changelog/archive/CHANGELOG-v0.1.0-to-v0.35.0.md](changelog/archive/CHANGELOG-v0.1.0-to-v0.35.0.md).
