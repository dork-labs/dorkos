# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/dork-labs/dorkos/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dork-labs/dorkos/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dork-labs/dorkos/releases/tag/v0.1.0
