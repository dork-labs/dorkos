# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Unify discovery UI — shared CandidateCard, approve/skip model
- Add Slack adapter with Socket Mode, streaming, and format conversion

### Changed

- Fix documentation drift — update CLAUDE.md, API reference, and broken links
- Unify adapter system with BaseRelayAdapter, shared callbacks, and DRY utilities

### Fixed

- Make adapter setup wizard scrollable when form exceeds viewport
---

## [0.12.0] - 2026-03-13

> Marketing storytelling, topology intelligence, and Pulse schedule management

### Added

- Add /story page with dual-mode presentation support for brand storytelling
- Add ScanLine component with three-layer composited animation responding to text streaming
- Enhance Pulse with agent filtering, inline enable/disable toggle, delete with confirmation, and edit-from-sidebar
- Add presentation mode with keyboard navigation, progress indicators, and incremental step reveal
- Add story sections: Hero, Monday Morning Dashboard, How It Was Built, Just Prompts equation, Future Vision, and Close
- Implement agent filtering and caps in ConnectionsView with motion animations
- Filter agent connections to reachable-only so the connections panel only shows agents you can actually reach
- Cap MCP servers list at 4 and agents at 3 with overflow links
- Introduce Pulse presets management and UI components
- Add structured debug logging across chat flow layers
- Add smooth LOD transitions, adapter labels, and ghost node tests to topology
- Redesign AdapterCard with bindings display and CCA treatment
- Implement adapter-binding UX overhaul with ghost adapter placeholders
- Add BaseRelayAdapter, compliance suite, API versioning, and adapter template
- Add useUpdateBinding hook and BindingList component for managing adapter-agent bindings
- Add NavigationLayout sidebar navigation for polished dialog navigation

### Changed

- Remove relay message path from web client, use direct SSE only for more reliable streaming
- Humanize raw IDs and technical jargon across Relay/Mesh UI
- Reconcile contributing guides against relay removal, pulse presets, and ConnectionsView changes
- Document test simulation infrastructure and fix mock proxy routing

### Fixed

- Fix LayoutGroup layout animation to eliminate timeline item jumps
- Fix presentation mode keyboard nav, progress bar, header hiding, and animation replay
- Replace pendingUserContent with optimistic messages in virtualizer
- Disable model/permission selectors before first message, fix post-remap PATCH
- Filter adapter list to agent-bound adapters only
- Prevent form revert and fix AnimatePresence key warnings
- Restore scroll in tabpanel views by adding h-full
- Use text-foreground for node name text consistency
- Filter CCA adapter nodes and always show namespace groups
- Use correct logo SVG paths in OG share card
- Resolve createRequire duplicate declaration in server bundle
- Add missing Fumadocs frontmatter title to spec and plan docs

---

## [0.11.0] - 2026-03-11

> Shortcut discoverability, design system refinements, and UX fixes

### Added

- Add centralized shortcut registry and discoverability panel
- Add design system showcase playground
- Integrate brand orange into client design system
- Replace custom gradient button with Aceternity HoverBorderGradient

### Changed

- Replace custom gradient button with HoverBorderGradient

### Fixed

- Deduplicate remote access toast notifications
- Filter schedules by agent and show adapter display names
- Handle empty roots array in scan endpoint
- Fix toast notifications rendering with transparent backgrounds

---

## [0.10.0] - 2026-03-11

> Tabbed sidebar navigation, agent identity chip, ScheduleBuilder, and always-editable chat input

### Added

- Navigate between Sessions, Schedules, and Connections from tabbed sidebar views
- Build schedules with progressive disclosure — pick frequency, then refine timing
- Pick agents from a direct-selection list when creating schedules
- Switch active agent from the identity chip in the top navigation bar
- See agent emoji in the identity chip at a glance
- Open the command palette directly from the header
- Keep typing while agents stream — messages queue and send when ready
- Auto-hide scrollbars in sidebar and message list until hover
- Detect dev builds and dismiss upgrade prompts with persistent version display

### Changed

- Replace cron presets and visual builder with unified ScheduleBuilder
- Replace AgentCombobox dropdown with AgentPicker direct-selection list
- Restructure StatusLine as a compound component

### Fixed

- Fix agent picker combobox behavior, dialog layout, and default cron expression
- Fix Enter and Cmd+Enter not working in command palette agent sub-menu
- Fix sidebar content overflow caused by Radix ScrollArea table layout
- Fix queued messages not appearing until animation completes
- Fix message loss during streaming and model selector flicker
- Fix scrollbar overlay obscuring sidebar content

---

## [0.9.1] - 2026-03-10

> Chat UX refinements — file attachments rendered inline, message bubbles right-aligned, and relay directory fixes

### Added

- See attached files as inline thumbnails and styled chips in chat message bubbles
- Distinguish your messages at a glance with right-aligned chat bubbles

### Fixed

- Fix relay messages losing working directory context
- Fix agent messages running in wrong directory when sent via relay
- Fix sidebar logo color not adapting to light/dark mode

---

## [0.9.0] - 2026-03-09

> MCP server integration, file uploads, chat UX overhaul, and SSE reliability fixes

### Added

- Embed MCP server with Streamable HTTP transport — external agents (Claude Code, Cursor, Windsurf) can connect via `/mcp`
- File uploads in chat — drag-and-drop, paperclip, and paste to attach files
- Redesign chat message theming — semantic tokens, TV variants, MessageItem decomposition
- Add chat microinteraction polish — spring physics, layoutId, session crossfade
- Unify discovery scanners and fix onboarding scan root
- Add endpoint types, dispatch TTL sweeper, and relay_query progress accumulation
- Add /chat:self-test slash command
- Add relay_dispatch fire-and-poll for long-running tasks

### Changed

- Message-first session creation — eliminate POST /sessions
- Extract ChatInputContainer from ChatPanel
- Split http-transport.ts into transport/ subdirectory (742 → 7 files)
- Extract 4 hooks + 1 component from ChatPanel (617 → 267 lines)
- Clean up URL query params — remove dead code, add pushState, fix setTimeout hack
- Unify page title and favicon system, remove dead code
- Update MessageItem typography to use font-light for improved readability
- Tighten chat typography to text-sm (14px)
- Decompose root eslint.config.js into per-package configs with shared @dorkos/eslint-config
- Extract AgentRuntime interface and RuntimeRegistry abstraction
- Replace text branding with DorkOS logo linking to dorkos.ai
- Rename pulse and agent tools to follow domain_verb_noun convention

### Fixed

- Create MCP server per request to avoid connect() reuse
- Update stale tests and add pre-push test gate via lefthook
- Eliminate ghost messages via per-message correlation IDs
- Improve message history retrieval and error handling in session routes
- Resolve streaming vs history inconsistencies via queueMicrotask and scroll-intent tracking
- Prevent relay-mode polling storm and tool-call spinner regression
- Upgrade streamdown to ^2.4.0 to fix inline code truncation
- Resolve history gaps, SSE session mismatch, and done event loss
- Export health thresholds to eliminate fragile hardcoded test values
- Resolve SSE delivery pipeline causing ~40-50% message freezes
- Apply SSE backpressure handling to session broadcaster relay writes
- Resolve SSE freeze, blank refresh, and relay metadata leaks
- Remove acted candidates from discovery list after approve/deny

---

## [0.8.0] - 2026-03-04

> Agent-centric control, enhanced discovery UX, and critical infrastructure hardening

### Added

- Per-agent tool filtering and cascade disable — configure which tools each agent can access
- Add relay_query blocking MCP tool for inter-agent communication
- Rebuild command palette with preview panel, fuzzy search, and sub-menu navigation for agent discovery
- Migrate sidebar to Shadcn Sidebar component with agent-centric layout
- Add tool context injection with configurable toggles throughout the interface
- Enable Mesh always-on mode for continuous agent discovery and visibility
- Enhance UI primitives with responsive touch targets and sizing variants

### Changed

- Improve developer guides documenting domain-grouped services and agent tool elevation patterns
- Update README and CLI documentation to reflect complete DorkOS feature set

### Fixed

- Fix critical agent-to-agent routing bug causing CWD mismatches and harden CCA pipeline
- Improve Mesh agent health detection with auto-stamping and widened thresholds
- Fix mobile sidebar sheet close behavior, transparency issues, and remove stale cookie code
- Improve command palette search with keyword inclusion for better path/ID matching
- Clean up command palette cmdk prop usage and @ filtering logic
- Enforce file-first write-through storage pattern for agent identity (ADR-0043)
- Improve onboarding step completion logic to handle rapid user interactions
- Register relay_query in tool filter and add test coverage

---

## [0.7.0] - 2026-03-02

> Brand refresh, CI hardening, and marketing site overhaul

### Added

- Add full-app Docker integration testing and runnable container
- Enforce dorkHome parameter usage in server code via ESLint rule
- Add Docker and GitHub Actions smoke testing for CLI installs
- Add GitHub Actions CLI smoke test workflow for npm package install validation
- Add Dockerfile and .dockerignore for isolated CLI smoke testing
- Add `smoke:docker` convenience script for local Docker smoke tests
- Add DorkLogo to onboarding welcome screen
- Add FAQ accordion section before install CTA on marketing site
- Align site copy with pro-human positioning
- Rewrite IdentityClose copy to celebrate human ambition
- Rewrite PivotSection with "intelligence doesn't scale" metaphor
- Upgrade timeline beam with Aceternity-inspired SVG tracing
- Replace dorkian logos with new dork logos and update references
- Enhance WelcomeStep with dynamic gradient effects
- Add agent discovery scroll fix image and enhance CLI build configuration

### Changed

- Migrate domain from dorkos.dev to dorkos.ai
- Add DORKOS_HOST, Docker workflow, and discovery endpoint to guides

### Fixed

- Use cd for CLI version bump and gitignore tarballs
- Resolve Docker runtime and npm publishing issues
- Support dark mode in favicon SVG
- Gate shouldShowOnboarding on config loading state
- Send partial patches to prevent skip dismiss race condition
- Fix missing `better-sqlite3` dependency in CLI package that crashed on `npm install -g dorkos`
- Adjust beam visibility range in TimelineSection

---

## [0.6.0] - 2026-03-02

> First-time user experience, remote access overhaul, and research library curation

### Added

- Walk through first-time setup with guided agent discovery, Pulse presets, and animated onboarding flow
- Overhaul remote access with multi-tab sync, UX redesign, and CLI QR code
- Add curl install script, tabbed UI, Homebrew tap, and CLI check
- Reset all data and restart server from the Advanced settings tab
- Add research library curation with file reduction phases
- Replace static llms.txt with dynamic route handler
- Add header, breadcrumb, prev/next nav, tags, RSS link, and SEO improvements to blog
- Wire research library into agent and main context

### Changed

- Remove standalone roadmap app and all references
- Rename apps/web to apps/site for clarity
- Codify plans/ as canonical location and migrate from docs/plans/
- Update all contributing guides based on 30 recent specs

### Fixed

- Target registered agents in Pulse presets step instead of server default directory
- Unify onboarding nav bar, select all agents by default, reduce spacing
- Fix scroll containment and improve agent discovery UX
- Reset stale tunnel status fields on stop and broadcast changes to other tabs
- Restore code block padding after opting out of fumadocs dark theme
- Update debug commands for .dork directory and fix ADR/README inventory

---

## [0.5.0] - 2026-03-01

> Human-readable Relay messaging, marketing site overhaul, and 125+ code quality fixes

### Added

- Rebuild marketing homepage with narrative-driven design, approachable language, and new imagery
- Improve social share cards, SEO metadata, and AI readability for the marketing site
- Browse, install, and configure external adapters from a built-in catalog
- Route external messages to specific agents with visual binding management in topology
- Group related messages into threaded conversations in the Relay activity feed
- Display human-readable names for endpoints, adapters, and message subjects throughout Relay
- Monitor Relay health at a glance with status bar, message filters, and smooth animations
- Test Telegram adapter connections before going live
- Choose from all available Claude models dynamically instead of a hardcoded list
- See available updates at a glance with a version indicator and details popover
- Access agent settings and start chats directly from topology graph nodes

### Changed

- Standardize logging across all packages with structured, parseable output
- Rename "Tunnel" to "Remote" throughout the UI for clarity

### Fixed

- Fix critical Relay publish pipeline bug where adapter delivery was silently skipped, blocking all Relay-routed chat messages and Pulse dispatches
- Return detailed delivery results from adapters instead of discarding status information
- Add 30-second timeout protection for adapter delivery
- Include adapter-delivered messages in the SQLite audit trail
- Return real trace IDs for Relay messages instead of placeholder values
- Fix Telegram feedback loop that caused duplicate messages
- Send properly formatted messages through Telegram instead of raw JSON chunks
- Resolve CWD resolution and MCP transport reuse issues
- Show correct sender names on delivered conversation messages
- Track message delivery end-to-end through the Relay publish pipeline
- Fix header overlap on marketing homepage hero section
- Fix Vercel deployment failures for the marketing site
- Handle console endpoint registration errors gracefully
- Resolve 125+ code quality issues across server, relay, mesh, client, and shared packages

---

## [0.4.0] - 2026-02-26

> Multi-agent infrastructure — Relay message bus, Mesh discovery, Agent Identity, and unified database

### Added

- Elevate topology chart with ELK.js layout, zoom LOD, and enriched nodes
- Add agent identity as first-class entity
- Add fullscreen toggle, min-height, and overflow fixes to ResponsiveDialog
- Add registry integrity with reconciliation, idempotent upserts, and orphan cleanup
- Improve sidebar UX with shortcut, persistence, tooltips, and mobile fixes
- Consolidate three SQLite databases into single Drizzle-managed dork.db
- Wire edges and namespace grouping into topology graph
- Disciplined env var handling with per-app Zod validation
- Enable Relay, Mesh, and Pulse by default
- Env-aware data dir, mesh panel UX overhaul, web lint fixes
- Enhance browser testing methodology and documentation
- Add AI-driven browser testing system with Playwright
- Add Mesh agent discovery with registry, topology graph, health monitoring, and MCP tools
- Add Relay inter-agent message bus with delivery tracing, dead-letter handling, and MCP tools
- Add Relay external adapter system for Telegram and webhook channels
- Add unified adapter system with plugin loading and Claude Code runtime adapter
- Add Access tab to Mesh panel for managing agent permissions
- Add standalone roadmap management app with table, kanban, MoSCoW, and Gantt views
- Add visual cron builder, directory picker integration, and calm tech notifications to Pulse
- Add interactive clarification to ideation and recommendation discipline

### Changed

- Replace raw HTML elements with shadcn Button/Input primitives
- Add agent identity documentation across internal and external guides
- Migrate from npm to pnpm for faster installs and stricter dependency resolution
- Route Pulse jobs and console output through Relay transport for unified message delivery and tracing
- Comprehensive Relay & Mesh release preparation
- Redesign Pulse scheduler UI with filtering, accessibility, and navigation improvements
- Rebrand homepage modules and create DorkOS litepaper
- Rename Vault module to Wing with updated brand positioning
- Replace triangles logo with DORK monogram

### Fixed

- Prevent agent node overlap in topology expanded view
- Pass consolidated db to RelayCore and add init error diagnostics
- Restore migration journal timestamp for 0004_ambitious_spectrum
- Resolve unused variable warnings across server package
- Resolve @dorkos/shared subpath imports in esbuild bundle
- Correct Relay documentation to match implementation
- Correct Mesh documentation to match implementation
- Correct Pulse documentation to match implementation
- Replace julianday() with strftime() in TraceStore latency metric
- Correct access rule directionality, endpoint, and add priority scheme
- Resolve React Flow zero-height error in topology tab
- Surface API errors in MeshPanel and harden MeshCore init
- Aggregate manifest reporter counts per spec file, not per test case
- Wire live health data into Mesh topology graph and fix aggregate SQL boundary
- Support array subjectPrefix in Relay and wire adapter context builder
- Fix 7 critical wiring bugs in Relay convergence implementation
- Resolve four completion gaps in Pulse scheduler — runs now correctly persist state, handle timeouts, and clean up on cancellation
- Declare runtime env vars in turbo.json globalPassThroughEnv
- Fix docs search, add blog footer and TOC sidebar

---

## [0.3.0] - 2026-02-18

### Added

- Add Pulse scheduler for autonomous cron-based agent jobs with web UI, REST API, MCP tools, and SQLite persistence
- Add runtime tunnel toggle with QR code sharing from the sidebar
- Add blog infrastructure with Fumadocs
- Add ADR draft/archived lifecycle with daily auto-curation and auto-extraction from specs
- Add context builder for SDK system prompt injection
- Add activity feed hero and marketing page sections

### Changed

- Refactor agent-manager to use modular context-builder pattern
- Redesign landing page with new hero variants and content sections
- Complete documentation overhaul — fill all stubs, add concepts section, rewrite stale guides

## [0.2.0] - 2026-02-17

### Added

- Add marketing website and documentation site with Fumadocs integration
- Add logging infrastructure with request middleware and CLI integration
- Add directory boundary enforcement for API endpoint security
- Add versioning, release, and update system
- Add git worktree runner (gtr) for parallel development workflows
- Add persistent config file system at `~/.dork/config.json`
- Add ngrok tunnel integration for remote access
- Add ESLint 9 and Prettier with FSD layer enforcement
- Add Architecture Decision Records (ADR) system
- Add TSDoc documentation standards for public API

### Changed

- Migrate client to Feature-Sliced Design architecture
- Rename guides/ to contributing/ for self-documenting audience
- Extract hardcoded values into centralized constants
- Split oversized files into focused modules
- Change default server port from 6942 to 4242
- Centralize .env loading via dotenv-cli at monorepo root

### Fixed

- Fix shell eval error in release command backticks
- Fix OpenAPI JSON generation for Vercel builds
- Fix API docs generation when openapi.json is missing
- Resolve React Compiler and ESLint warnings
- Fix barrel and import paths after FSD migration

## [0.1.0] - 2025-02-08

### Added

- Web-based chat UI for Claude Code sessions
- REST/SSE API powered by the Claude Agent SDK
- Tool approval and deny flows
- AskUserQuestion interactive prompts
- Slash command discovery from `.claude/commands/`
- Cross-client session synchronization via file watching
- Obsidian plugin with sidebar integration
- ngrok tunnel support for remote access
- OpenAPI documentation at `/api/docs` (Scalar UI)
- CLI package (`dorkos`) for standalone usage
- Keyboard shortcuts for navigation
- Directory picker for working directory selection

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/dork-labs/dorkos/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/dork-labs/dorkos/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/dork-labs/dorkos/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/dork-labs/dorkos/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/dork-labs/dorkos/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/dork-labs/dorkos/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/dork-labs/dorkos/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dork-labs/dorkos/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dork-labs/dorkos/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dork-labs/dorkos/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dork-labs/dorkos/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dork-labs/dorkos/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dork-labs/dorkos/releases/tag/v0.1.0
