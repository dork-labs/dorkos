# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-agent tool filtering, context injection, and cascade disable
- Per-agent tool filtering, context injection, and cascade disable
- Add preview panel, fuzzy search, sub-menus, and UX polish
- Add tool context injection with config toggles and command palette enhancements
- Migrate standalone sidebar to Shadcn Sidebar component
- Add command palette, agent-centric sidebar, mesh always-on
- Add responsive touch targets to shared UI primitives
- Add responsive sizing and explicit size variants

### Changed

- Add round-trip tests guarding against infinite loop regression
- Update developer guides for domain-grouped services and agent-tools-elevation
- Update README and CLI documentation to reflect DorkOS features and usage

### Fixed

- Auto-stamp last_seen_at and widen health thresholds
- Fix mobile Sheet close bug, sidebar transparency, and remove dead cookie persistence
- Include keywords in custom filter for path/id search
- Fix cmdk prop misuse, @ filtering, and dead code
- Enforce file-first write-through for agent storage (ADR-0043)
- Enhance step completion and skipping logic to handle rapid calls
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

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/dork-labs/dorkos/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/dork-labs/dorkos/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/dork-labs/dorkos/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/dork-labs/dorkos/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/dork-labs/dorkos/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dork-labs/dorkos/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dork-labs/dorkos/releases/tag/v0.1.0
