# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add PathInput component, improve ConfigureStep layout, allow existing dirs

### Changed

### Fixed

---

## [0.37.0] - 2026-04-11

> Mesh discovery and agent creation — pre-scan landing states, 7 new AI agent strategies, an instant-advance creation wizard, and a unified /agents page streamline onboarding and daily management.

### Added

- Enhance DiscoveryView with pre-scan state and illustration
- Add discovery strategies for 7 new AI coding agents
- Redesign dialog as instant-advance wizard
- Consolidate mesh panel dialog into /agents page
- Add marketplace-dev skill for package authoring
- Redesign Dork Hub with trust signals, animations, and progressive disclosure

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

## [0.35.0] - 2026-04-09

> Release tooling and configuration robustness — schema validation gates, migration automation, and marketplace stability converge to prevent upgrade breakage.

### Added

- `/system:release` now detects config schema changes without a paired migration and offers to scaffold one inline before the tag is cut. Catches the class of "shipped a schema change, forgot the migration, broke upgrades for existing users" bugs before they reach npm.
- New `adding-config-fields` skill walks contributors through the full Zod → migration → docs → test lifecycle when adding, renaming, removing, or retyping a user-config field. Model-invoked — activates automatically when editing `UserConfigSchema`.
- Agent discovery guide now distinguishes marketplace-installed agents (in `~/.dork/{plugins,agents}`) from agents discovered anywhere on disk via the mesh scanner. The two-registry split is no longer implicit — `GET /api/marketplace/installed` and `GET /api/agents` answer different questions and the docs now say so plainly.
- New `context-isolator` subagent for running data-heavy read-and-summarize operations (release analysis, schema-diff classification, large searches) in an isolated context window. Ported from a sibling project and wired into `/system:release` Phase 3, which was silently missing the agent before.

### Changed

- Persistent user config now sources its migration `projectVersion` from `SERVER_VERSION` automatically — no more hardcoded stub. Migration keys tie to real release boundaries for the first time, so future schema migrations actually fire on upgrade.
- Corrupt-config recovery path now preserves the migration chain. Previously, users who hit corrupt-recovery on any prior build would silently stop running migrations on subsequent upgrades — the fallback Conf instance was missing `projectVersion` and `migrations`. Both the primary and recovery branches now use a single shared options object.
- Schema migration process is now documented first-class in `contributing/configuration.md` with the full `conf` `projectVersion` model, append-only rule, step-by-step procedure, real examples, and anti-patterns. Previously covered in one sentence.
- CI/CD: All JavaScript-based GitHub Actions workflows opt into the Node 24 runtime ahead of GitHub's September 2026 Node 20 deprecation. Preempts the forced-upgrade disruption.

### Fixed

- The Dork Hub marketplace now loads correctly. Previously it showed zero packages because the default community source URL pointed at `github.com/dorkos/marketplace` (an org that doesn't exist — the real repo is at `dork-labs/marketplace`) AND the upstream parser rejected the real Anthropic `claude-plugins-official` catalog entirely because of a strict reserved-name check and a kebab-case regex that couldn't handle the `wordpress.com` plugin. Existing users' `~/.dork/marketplaces.json` files get auto-migrated to the correct URL on first read — no manual editing required. End-to-end verified: 8 plugins from the Dork Labs community marketplace + 126 from the Anthropic catalog now load successfully.

---

## [0.34.1] - 2026-04-09

> Emergency patch — unblocks `npm install -g dorkos` / `npm update -g dorkos` and restores the Docker image publish pipeline after the v0.34.0 release shipped broken.

### Fixed

- Fix `npm install -g dorkos` and `npm update -g dorkos` failing with `E404 '@dorkos/marketplace@0.0.0' is not in this registry`. The v0.34.0 package mistakenly listed a private workspace package as a runtime dependency — v0.34.1 removes it from the published tarball entirely. The marketplace validator and install commands are unaffected because the code was already bundled into the CLI binary at build time, so nothing is actually missing from the runtime. If you hit the 404 on v0.34.0, run `npm install -g dorkos@0.34.1` to recover.
- Restore the Docker image publish pipeline. The v0.34.0 release failed CI because of a cross-environment TypeScript resolution drift in the server build, which blocked `ghcr.io/dork-labs/dorkos:v0.34.0` from being published. v0.34.1 pins `@types/node` deterministically so CI reproduces the local tsc behavior exactly.

---

## [0.34.0] - 2026-04-08

> The marketplace lands — install pipeline, in-app Dork Hub, public web catalog, and strict Claude Code superset format all ship together, plus external MCP agent access and a redesigned agent Settings Tools tab.

### Changed

- **Marketplace**: Converted `marketplace.json` to a **strict superset** of the Claude Code marketplace format. Schema now supports 5 source types (relative-path, github, url, git-subdir, npm), `owner` / `metadata` / `author` object shapes, `.claude-plugin/` file location, and a sidecar `dorkos.json` for DorkOS-specific extensions. The `dorkos-community/marketplace` repo is renamed to `dork-labs/marketplace` and uses the same-repo monorepo layout. Plugin runtime activation now goes through the Claude Agent SDK `options.plugins` API so DorkOS owns install and the SDK owns runtime. Empirically verified against `claude plugin validate` (CC 2.1.92). See spec `marketplace-05-claude-code-format-superset` and ADRs 0236–0239. (`marketplace-05-claude-code-format-superset`)

### Added

- Unify validate CLI + add source reachability check
- Add Settings page and sections to the dev playground
- URL deep links for Settings, Agent, Tasks, Relay, Mesh dialogs
- CLI validators, telemetry, seed fixture, docs (marketplace-05 Batches 5-8)
- Strict CC superset — schema, install, runtime, site (marketplace-05 Batches 1-4)
- Add MCP server surface (marketplace-05-agent-installer) + in-flight WIP
- **Marketplace as MCP server.** The DorkOS marketplace is now exposed as an MCP server at `/mcp`, alongside the existing DorkOS tools. Any AI agent that speaks MCP — Claude Code, Cursor, Codex, Cline, ChatGPT, Gemini — can search the marketplace, get package details, install packages (with user confirmation), and scaffold new packages on the fly. See `contributing/external-agent-marketplace-access.md` for setup instructions. (`marketplace-05-agent-installer`)
- **Personal marketplace.** A per-user local marketplace at `~/.dork/personal-marketplace/` is now created on first server boot. Agents can scaffold new packages here via `marketplace_create_package` without leaving their tool of choice. (`marketplace-05-agent-installer`)
- **8 new MCP tools:** `marketplace_search`, `marketplace_get`, `marketplace_list_marketplaces`, `marketplace_list_installed`, `marketplace_recommend`, `marketplace_install`, `marketplace_uninstall`, `marketplace_create_package`. (`marketplace-05-agent-installer`)
- Add `/marketplace` browse page on dorkos.ai with hourly registry refresh from `dorkos-community/marketplace` (`marketplace-04-web-and-registry`)
- Add per-package detail pages with README rendering, install instructions, related packages, and OG images (`marketplace-04-web-and-registry`)
- Add `/marketplace/privacy` page documenting the install telemetry contract (`marketplace-04-web-and-registry`)
- Add opt-in install telemetry endpoint (`/api/telemetry/install`) backed by Neon Postgres + Drizzle ORM as the single source of truth (`marketplace-04-web-and-registry`)
- Add telemetry consent banner in the in-product Dork Hub (off by default) (`marketplace-04-web-and-registry`)
- Add `dorkos package validate-marketplace` and `dorkos package validate-remote` CLI commands for the dorkos-community submission workflow (`marketplace-04-web-and-registry`)
- Include all marketplace packages in `sitemap.xml` and `llms.txt` (`marketplace-04-web-and-registry`)
- Ship Dork Hub browse UI as built-in extension (marketplace-03-extension)
- Add Dork Hub — in-app marketplace browse experience for discovering and installing agents, plugins, skill packs, and adapters without leaving the app, shipped as the built-in `@dorkos-builtin/marketplace` extension (`marketplace-03-extension`)
- Add featured agents rail and type filters (agents, plugins, skills, adapters) with debounced search across the catalog (`marketplace-03-extension`)
- Add package detail sheet with rendered README and permission preview (`marketplace-03-extension`)
- Add install confirmation dialog with blocking conflict detection before any write (`marketplace-03-extension`)
- Add installed packages view for updating and uninstalling from the Hub (`marketplace-03-extension`)
- Add marketplace sources management for adding and removing git registries from the Hub (`marketplace-03-extension`)
- Add "From Dork Hub" tab to TemplatePicker so agent creation can pull directly from marketplace agents (`marketplace-03-extension`)
- Complete install/uninstall/update pipeline (Batches 4-9 of marketplace-02-install)
- Add `dorkos install <name>` to install plugins, agents, skill packs, and adapters from configured marketplaces — atomic transactions with rollback on failure and permission preview before install (`marketplace-02-install`)
- Add `dorkos uninstall <name>` with `--purge` flag for full data removal (`marketplace-02-install`)
- Add `dorkos update [<name>]` advisory update notifications, with `--apply` to perform upgrades (`marketplace-02-install`)
- Add `dorkos marketplace add/remove/list/refresh` to manage marketplace sources (`marketplace-02-install`)
- Add `dorkos cache list/prune/clear` to manage the local marketplace cache (`marketplace-02-install`)
- Add `/api/marketplace/*` HTTP endpoints for sources, packages, install/uninstall/update, and cache (`marketplace-02-install`)
- Implement foundation package, CLI commands, and kind field addendum
- Show MCP servers in Tools tab
- Add external MCP access controls — toggle, API key, rate limiting, and setup instructions
- Use official brand logos for agent runtimes
- Redesign Tools tab with tool inventories, init errors, and override counts
- Make Settings, Tasks, Relay, Mesh, and Agent dialogs URL-addressable via search params — share links like `?settings=tools` to deep-link teammates to a specific dialog and tab; browser back closes dialogs and reload preserves dialog state. Note: deep links containing `?agentPath=...` include your local project path.
- Add `@dorkos/marketplace` package with schemas, parser, validator, scanner, and scaffolder (spec 1 of 5)
- Add `dorkos package init <name>` CLI command for scaffolding new marketplace packages
- Add `dorkos package validate [path]` CLI command for validating package manifests
- Add optional `kind` field to `SkillFrontmatterSchema` (addendum to ADR-0220)

### Changed (other)

- Extract `TabbedDialog` widget primitive — `SettingsDialog` and `AgentDialog` now consume it as thin declarative wrappers (491 → 54 lines and 177 → 75 lines respectively)
- Split four oversized dialog files under 300 lines
- Reconcile developer guides for marketplace-init branch
- Restructure dialog tabs — replace Capabilities with Tools
- Redesign PersonalityTab with extracted TraitSliders and response mode
- Redesign IdentityTab with hero preview and extract useDebouncedInput
- Move warning to top, multi-line endpoint, Remove on generated key, dork*mcp* prefix
- Redesign ExternalMcpCard with sectioned layout and better visual hierarchy
- Nest scheduler config inside Tasks tool group expansion

### Fixed

- Address code review findings on dialog URL deep links
- Convert RateLimitSection to SwitchSettingRow
- Address code review feedback from 413d74d3
- Close 4 critical install-pipeline gaps from Session 2 review
- Close code-review gaps from 6fdd065c
- Repair .gtrconfig format and assign unique dev ports
- Add error handling for API key lifecycle and restart hint for rate limits

---

## [0.33.0] - 2026-04-05

> Intelligent channel binding and dependency awareness — adapters become channels, runtime requirements surface during onboarding, and system configuration becomes discoverable.

### Added

- Rename relay adapters to channels, add adapter runtime cards and agent-first channel binding
- Enhance ServerTab with subsystem configuration and relocated adapter settings
- Add system requirements check to onboarding with adapter dependency checking
- Add Remote Access shortcut to settings sidebar

### Changed

- Add agent runtime landscape research covering Codex, ACP, Pi Agent, Gemini CLI, and Aider
- Add guidelines for capturing design decisions in visual companion sessions
- Reconcile guides with v0.32.0 changes

---

## [0.32.0] - 2026-04-04

> Chat refinement and architectural cleanup — interrupt running queries with Escape, see agent activity at a glance with colored borders, and benefit from a cleaner, better-organized codebase under the hood.

### Added

- Add server-side query interrupt and Escape-to-stop
- Replace activity dot with colored border indicator

### Changed

- Add pre-commit directory size check for codebase hygiene
- Organize oversized directories and expand dir-size allowlist
- Organize ui/ into domain subdirectories
- Decompose ChatPanel and reduce ChatInputContainer prop surface
- Remove unused Transport import and add onStop prop to ChatInput

### Fixed

- Add horizontal padding to chat scroll area for improved layout

---

## [0.31.0] - 2026-04-03

> Refining agent UX through redesigns and standards adoption — clearer palettes, transparent context usage, and portable skill definitions bring polish and portability to the operator platform.

### Added

- Redesign CommandPalette and FilePalette for clarity and reusability
- Add cache hit rate and usage status bar items, refactor context to per-message
- Redesign tool/thinking blocks for clarity and visual cohesion
- Redesign onboarding copy and project discovery UX
- Adopt SKILL.md file-first architecture for task system
- Add @dorkos/skills package implementing SKILL.md open standard
- Introduce maintaining-dev-playground skill documentation
- Allow disabling tunnel passcode for open or trusted environments

### Fixed

- Include legacy .claude/commands/ in command list after SDK session starts
- Make SDK command and subagent caches per-cwd instead of global
- Resolve all lint warnings across server, client, and CLI
- Serve SPA on tunnel requests so PasscodeGate renders instead of raw JSON

---

## [0.30.0] - 2026-03-31

> Discovery and documentation refinement — unified scan actions, onboarding polish, and a full contributing guide refresh bring consistency to both the agent discovery experience and developer documentation.

### Added

- Unify Skip/Deny actions and add scan options to onboarding

### Changed

- Update contributing guides, external docs, and AGENTS.md
- Fix review issues — FSD compliance, DRY extractions, resetActed
- Unify scan UI — fix DiscoveryView parity, extract shared utilities
- Complete Pulse→Tasks terminology migration and improve docs infrastructure
- Update CLI README and config guide for Tasks rename and new features

### Fixed

- Add resetActed to handleRescan dependency array
- Surface existing agents during onboarding scan
- Update SettingsDialog tests after Remote indicator relocation

---

## [0.29.0] - 2026-03-30

> Agent fleet management and UI refinement — DataTable-powered agent lists, command palette agent settings, breadcrumb navigation, and a streamlined dashboard bring polish and power to the operator experience.

### Added

- Enhance command palette with agent settings dialog
- Convert agents list to DataTable with responsive column hiding
- Auto-focus prompt textarea on session change
- Add Table primitives, DataTable, and Dev Playground showcase
- Add AgentIdentity to shortcut chips row
- Add dedicated Onboarding page to dev playground

### Changed

- Consolidate agent identity to chat input, add breadcrumb nav
- Reorganize Dev Playground sidebar into domain-oriented groups
- Relocate Remote indicator from status bar to sidebar footer
- Streamline dashboard — remove Active Sessions, fix status alignment, unify activity feed
- Polish onboarding flow UI and extract OnboardingNavBar

### Fixed

- Remove unused AgentVisual type import from AppShell
- Remote-access promo opens TunnelDialog directly
- Align sidebar back chevron with content below
- Use dynamic agent name in chat input placeholder
- Improve dev playground overview card layout
- Expand tilde paths in boundary validation and add startup diagnostics
- Cast spawn proc through EventEmitter to fix CI type resolution
- Remove unnecessary ChildProcess cast that fails in CI Node 20

---

## [0.28.0] - 2026-03-30

> Tasks redesign, DorkBot system agent, and the extensibility platform matures — file-based task definitions, manifest-driven settings, extension hooks, session forking, and MCP elicitation bring DorkOS closer to a fully autonomous coordination layer.

### Added

- Redesign Tasks system — rename Pulse→Tasks, add file-based definitions, and make scheduling optional for on-demand tasks
- Replace Damon with DorkBot as the sole system agent
- Add MCP elicitation UI for auth flows and form inputs
- Add session forking via SDK forkSession() and session rename via renameSession()
- Add server-side extension hooks with encrypted secrets and Linear reference extension
- Add manifest-driven settings forms with placeholder hints and grouped sections
- Auto-generate settings UI from extension manifests
- Add plugin hot-reload via reloadPlugins()
- Show available subagents via supportedAgents()
- Evolve linear-issues into Loop-aware dashboard
- Add commands for product management and issue handling
- Add 5-level error handling hierarchy with Dev Playground showcase
- Display context usage meter with category breakdown tooltip for token visibility
- Decouple chat state from React lifecycle into session-keyed Zustand store
- Add openBlank() to task template dialog store
- Fix prompt suggestions, add api_retry events, and effort level controls
- Add spec manifest management system

### Changed

- Extract PageHeader for consistent top-level route headers
- Extract SessionStore, RuntimeCache, and constants from ClaudeCodeRuntime
- Extract extension-manager into focused collaborators
- Extract setting field renderers to separate file
- Document getSubagents() across architecture, API, and data-fetching guides
- Update docs and templates for auto-generated settings tabs

### Fixed

- Eliminate setState-during-render errors on session and tasks pages
- Resolve all 15 client lint warnings
- Update stale test mocks after Tasks rename (Pulse→Tasks)
- Tighten activity filter bar chip sizing and spacing
- Exclude archived issues and fix query complexity in Linear queries
- Unify dashboard section styling for visual consistency
- Add padding to collapsible settings groups and vertical layout for wide controls
- Expose React globally for extension runtime and fix Linear example import
- Clean up lint warnings and fix site build frontmatter
- Fork UX feedback, tests, and tooltip accessibility
- Spread process.env in SDK env option to prevent code 127
- Load local settings so project-level plugin MCP servers are discovered

---

## [0.27.0] - 2026-03-28

> Canvas as a first-class surface — persistent, toggleable, and mobile-ready.

### Added

- Add canvas toggle button in session header with `Cmd+.` keyboard shortcut and command palette action
- Persist canvas state (open/closed, content, panel width) per session in localStorage — survives page refreshes and session switches
- Show dot indicator on canvas toggle when content is available but panel is closed

### Changed

- Remove "New Session" and "Schedule" buttons from dashboard header to reduce clutter

### Fixed

- Match canvas background to sidebar color (`bg-sidebar`) for visual consistency
- Replace chunky 6px resize handle with a subtle 1px line and 8px hit target
- Render canvas as a full-width Sheet on mobile instead of an unusable side panel

---

## [0.26.0] - 2026-03-28

> Network resilience and operator onboarding — faster SSE streams with custom headers and a welcoming first-time experience.

### Added

- Upgrade to fetch-based SSE transport with custom headers, HTTP/2 multiplexing, and retry backoff for more reliable streaming
- Consolidate all SSE connections into a unified /api/events stream for simpler client integration and improved sync reliability
- Add splash screen with onboarding flow and command palette quick-launch entry for faster agent discovery

### Changed

- Update architecture guide to reflect fetch-based SSE transport implementation

---

## [0.25.0] - 2026-03-27

> Extensibility platform and composable filtering — agents can now build and install extensions, and every list surface gets URL-synced, filterable, sortable data views.

### Added

- Build extensions that agents install, configure, and run — the extensibility platform spans agent UI control, extension point registry, extension system core, and agent-built extensions (Phases 1–4)
- Filter and sort agent lists with a composable filter system — text search, enum pills, date ranges, boolean toggles, and URL-synced state
- Redesign Remote Access dialog with progressive disclosure
- Show the default agent in the dashboard sidebar
- Add AgentAvatar and AgentIdentity primitives for consistent agent visual identity
- Add /adr:review command for ADR lifecycle management
- Absorb superpowers plugin into first-party skills and agents
- Add dedicated Feature Promos page to dev playground

### Changed

- Migrate agents list to the composable filter system
- Consolidate agent display to use shared AgentAvatar primitive
- Simplify AgentNode, extract sidebar hooks, update session list
- Unify dev playground with PAGE_CONFIG and shared layout
- Extract resolveAgentVisual for consistent agent visual identity
- Update README screenshot to dark mode with real chat session
- Reconcile contributing and doc guides for extensions and FilterBar

### Fixed

- Wire UI tools to session and align sidebar tab schema
- Harden extension system security and fix flaky tests
- Display human-readable labels for dateRange, boolean, and numericRange filters
- Fix dynamic enum deserialize and color dot rendering in FilterBar
- Resolve workspace packages in electron-vite renderer build
- Alias @dorkos/shared subpaths to source for CI compat
- Add better-sqlite3 as direct dependency for packaging
- Update SchedulesView tests to match rewritten component
- Provide TanStack Router context in DevPlayground

---

## [0.24.0] - 2026-03-25

> Desktop app, tunnel security, and resilience — native macOS distribution, passcode-gated remote access, and SSE auto-reconnect harden the operator experience.

### Added

- Add 6-digit passcode gate for remote access
- Add Electron desktop app for native macOS distribution
- Add status bar inline management with scroll and configure popover
- Generalize subagent system to background task model with stopTask support
- Add rotating placeholder hints in chat input
- Move version display from status bar to sidebar footer
- Add declarative feature promo system with contextual discovery
- Add SSE resilience infrastructure with connection health UI
- Display friendly tool names in ToolApproval
- Add relay outbound awareness for agent-initiated messaging

### Changed

- Remove unnecessary border from SidebarFooterBar component
- Reconcile harness inventory counts with actual files

### Fixed

- Target arm64, externalize manifest, skip codesign discovery
- Remove postinstall electron-rebuild, add dual-mode server spawning
- Exclude desktop from default dev, approve electron builds

---

## [0.23.0] - 2026-03-23

> Task visibility and execution awareness — progress bars, dependencies, and animated background indicators bring your agent fleet to life.

### Added

- View task dependencies and progress at a glance — TaskListPanel now displays real-time progress bars, dependency-aware sorting (blocked tasks dimmed), and click-to-expand detail view with description, owner, elapsed time, and dependency links
- See running background agents with animated indicator showing active subagent execution
- Poll tasks automatically when background refresh is enabled — subagent todo updates appear without manual reload

### Changed

- Extract shared `useTabVisibility` hook for consistent tab-aware polling across features
- Decompose TaskListPanel into focused sub-components (TaskProgressHeader, TaskRow, TaskDetail, TaskActiveForm)

### Fixed

- Fix indicator bar exit animation and always-render pattern
- Fix Rules of Hooks violation in TaskListPanel where useCallback was called after conditional return

---

## [0.22.0] - 2026-03-23

> TodoWrite task system, speculative sessions, and brand icon refresh

### Added

- Add TodoWrite support to task system — recognize the SDK's new batch todo tool with snapshot semantics so tasks appear in the TaskListPanel during streaming and on reload
- Eliminate null sessionId with speculative UUID pattern — sessions get a client-generated ID immediately, avoiding null guards and 404s during the first message
- Replace emoji adapter icons with real brand SVG logos for Slack, Telegram, and other adapters

### Fixed

- Preserve session state across SDK remaps and inline errors — model, permission mode, and cost survive session ID transitions and tool validation failures

---

## [0.21.0] - 2026-03-23

> Agent creation pipeline, fleet management surface, and A2A gateway

### Added

- Create agents from a guided dialog with name validation, directory resolution, personality sliders, and workspace template picker
- Overhaul tool call display with MCP server parsing, streaming state tracking, and classified output rendering
- Redesign agents page as a fleet management surface with health monitoring, filtering, and session launch
- Improve Slack adapter with 8 enhancements including message threading, reaction management, and format fidelity
- Implement A2A external gateway for cross-platform agent interoperability
- Improve ConnectionsTab UX with decomposed components and actionable deep-links to adapter setup
- Adopt TanStack Form for submit-lifecycle forms with validation and error handling
- Add Telegram typing indicator during agent processing for real-time feedback

### Fixed

- Resolve architectural debt from agent creation review — consolidate duplicated route/service logic, fix FSD cross-feature import, add auth token redaction
- Restore result border separator and clean up OutputRenderer imports
- Make dashboard responsive on mobile with proper viewport handling
- Fix Chat SDK HTML rendering, port splitMessage utility, and deprecate legacy adapter
- Update server integration tests for new validation and convention-files patterns

---

## [0.20.0] - 2026-03-22

> Adapter ecosystem expansion — Chat SDK Telegram integration, A2A gateway spec, and agent personality conventions

### Added

- Improve adapter binding validation, routing, and instance-aware codecs
- Add A2A external gateway spec and drop Channels from scope
- Add Chat SDK Telegram adapter and PlatformClient architecture
- Add SOUL.md and NOPE.md convention files for agent personality

### Changed

- Reconcile guides after chat-sdk-relay-adapter-refactor spec

### Fixed

- Add StreamEvent buffering to Chat SDK Telegram adapter
- Normalize Chat SDK thread IDs before relay subject encoding
- Eliminate visible scroll animation on session load
- Improve binding row UX with consistent icons and clearer overflow
- Add missing traits_json and conventions_json migration

---

## [0.19.0] - 2026-03-21

> Fleet management dashboard — dedicated agents page, mission control, and client-side routing

### Added

- Browse and manage agents from a dedicated fleet management page with health monitoring, filtering, and session launch
- Access mission control dashboard with needs-attention alerts, active sessions, system status, and activity feed
- Navigate between dashboard, sessions, and agents with animated sidebar and header transitions
- Add TanStack Router with code-based route definitions and URL search params
- Browse features by product and category on SEO-optimized catalog pages
- Monitor chat status at a glance with a unified status strip combining inference and system indicators
- Toggle multi-window sync and background refresh from the status bar
- Experience smoother chat with per-word text animation and spring-based scroll physics

### Changed

- MCP tools require agent context for session counts and use clearer naming (get_agent)
- Relay tools renamed for clarity: relay_send_and_wait (was relay_query), relay_send_async (was relay_dispatch)
- Relay mailboxes use human-readable subject strings instead of SHA-256 hashes
- Feature catalog split into product and category dimensions for richer filtering
- Clean up routing migration — remove dead code, fix test/code consistency
- Move scan line effect to chat input area with subtle edge fade

### Fixed

- Resolve all ESLint warnings across the monorepo (0 errors, 0 warnings)
- Code review fixes for mesh discovery, MCP tools, and schema validation
- Adapter setup pipeline protected with timeout guards and diagnostic logging
- Relay and Pulse enabled by default on fresh installations
- Fix llms.txt feature categories formatting
- Fix Stop hook hanging and add auto-format on file write
- Fix dashboard navigation router context and auto-select suppression
- Fix DoneEventSchema missing messageIds and export SubagentStatus

---

## [0.18.0] - 2026-03-19

> Chat simulator, interactive tool fixes, and developer guide refresh

### Added

- Add chat simulator to Dev Playground for testing streaming, tool approval, and question flows without a live agent

### Changed

- Reconcile developer guides and external docs with recent architecture changes
- Add test-results directory to .gitignore

### Fixed

- Fix stuck input bar and 404 errors in AskUserQuestion flow
- Fix createPulseRouter missing dorkHome parameter
- Fix tunnel CORS test using hardcoded port instead of dynamic assignment

## [0.17.2] - 2026-03-19

> Dev port convention update and test reliability fixes

### Changed

- Update dev port convention from 4xxx to 6xxx for simultaneous dev/production operation
- Move tunnel port resolution to call time so tests can override VITE_PORT
- Move `createTestDb` to `@dorkos/test-utils/db` subpath to avoid pulling Node.js-only db into jsdom tests

### Fixed

- Fix 153 client test failures caused by NODE_ENV=production leaking into jsdom environment
- Fix error handler and tunnel tests failing when shell has NODE_ENV=production
- Fix getCommands test finding real `.claude/commands/` from repo root

---

## [0.17.1] - 2026-03-19

> Streaming message integrity and reliability fixes

### Added

- Document Claude Agent SDK Message History and Session Listing API for research library

### Fixed

- Prevent session remap flash and merge consecutive assistant JSONL entries
- Eliminate message flash and disappearing errors on stream completion
- Pause background-tab polling for always-on query hooks
- Add hourglass reaction immediately and clean up orphaned reactions

---

## [0.17.0] - 2026-03-18

> CLI polish, Apple-style field grouping, and relay hardening

### Added

- Improve CLI UX with clickable URLs, unknown option handling, and browser open prompt
- Add FieldCard primitives and apply Apple-style field grouping

### Changed

- Move platform formatting rules into adapters
- Eliminate DRY violations, enforce file size limits, and instance-scope mutable state

### Fixed

- Populate sender on index rebuild and fix stale TSDoc
- Fix second hasStarted bug in updateSession and add resume diagnostics
- Fix per-sender rate limiting, add publish rejection logging and inbound result checks
- Prevent new sessions from crashing with invalid SDK resume ID
- Enhance Slack inbound message handling with improved reaction management
- Add inbound typing reaction with FIFO cleanup on stream completion
- Improve ConfigFieldInput layout, error UX, and password toggle
- Persist session map across restarts for Slack DM continuity
- Extract binding permissionMode in CCA agent handler
- Clear pending approval timeouts on SlackAdapter stop

---

## [0.16.0] - 2026-03-18

> Interactive tool approval, standardized form fields, and resilient streaming

### Added

- Standardize form fields with Shadcn Field, SettingRow, and PasswordInput
- Add interactive tool approval for Slack and Telegram adapters
- Add dedicated Forms page and split registry into per-page section files
- Add data path debug toggles for cross-client sync and message polling
- Add unified input zone for interactive cards
- Add 4 sidebar component showcases to dev playground

### Fixed

- Flush stream buffer before posting tool approval cards
- Move empty-stream and retry-depth tests into sendMessage() describe block
- Break infinite SDK retry loop and surface errors to adapters
- Prevent tool_call_end from overwriting pending status on interactive tool calls

---

## [0.15.0] - 2026-03-17

> Multi-client awareness, extended thinking visibility, and dev playground overhaul

### Added

- Add multi-client presence indicator, subagent/hook lifecycle visibility, and tool call enhancements
- Implement tool-approval-timeout-visibility, prompt-suggestion-chips, multi-client-session-indicator
- Add transport error categorization and retry affordance
- Truncate tool results at 5KB with raw JSON fallback for large payloads
- Surface SDK system status messages and compact boundary events in chat UI
- Implement result-error-distinction, extended-thinking-visibility, and tool-progress-streaming
- Add rate-limit countdown UI and prop threading
- Add subagent lifecycle visibility to chat UI
- Redesign QuestionPrompt and unify compact final states
- Add scrollspy TOC, Cmd+K search, and overview landing page to Dev Playground
- Implement navigation overhaul for Dev Playground with improved sidebar and routing
- Add 14 missing component showcases to dev playground
- Add slugify, copyable names, and responsive viewport toggle to dev playground
- Add multi-select and 3-tab question showcases to design system
- Add hook lifecycle showcase and refactor stream-event-handler
- Add ClientsItem presence indicator showcase to design system
- Add ToolApproval countdown timer showcases to design system
- Add truncated tool result showcase to design system
- Add SystemStatusZone to design system showcase
- Add ErrorMessageBlock and ThinkingBlock showcases
- Add rate-limit states to InferenceIndicator showcase
- Add SubagentBlock to design system showcase

### Changed

- Unify ToolApproval and QuestionPrompt container styling
- Extract shared primitives from duplicated chat UI components
- Reconcile contributing guides with recent commits (37 commits since 2026-03-12)
- Improve playground UX with demo wells and DRY cleanup

### Fixed

- Add setSystemStatusWithClear to useMemo deps
- Stabilize ThinkingBlock tests — remove motion mock, add cleanup

---

## [0.14.0] - 2026-03-16

> Binding-level permissions, relay panel redesign, and SDK command discovery

### Added

- Configure permission modes per adapter-agent binding so headless sessions (Slack, Telegram) use the right tool approval level instead of stalling
- Redesign the Relay panel with a 2-tab layout, semantic health indicators, inline permissions, and aggregated dead letter management
- Discover slash commands via the SDK `supportedCommands()` API for more reliable command availability

### Changed

- Derive binding working directory from the agent registry instead of storing a separate path

### Fixed

- Prevent dead letter panel from re-opening after the user explicitly collapses it
- Fix relay panel follow-up issues with health bar rendering, empty states, and label consistency
- Discover root-level commands and fix SDK command cache returning stale results

---

## [0.13.1] - 2026-03-14

### Fixed

- Fix CLI crash on startup caused by duplicate `createRequire` declaration in ESM bundle
- Fix relay build script failing on non-Bash shells by using POSIX-compatible substitution

## [0.13.0] - 2026-03-14

> Slack integration, Docker containerization, and adapter system unification

### Added

- Publish Docker images automatically to GHCR via GitHub Actions for easy containerized deployment
- Add `dorkos cleanup` command to safely remove stored agent data and sessions
- Add Slack adapter with Socket Mode support, message streaming, and format conversion
- Add streaming toggle and typing indicators for real-time Slack message updates
- Add layered adapter documentation system with per-field setup guides and help text
- Unify discovery UI with shared candidate cards and consistent approve/skip workflows

### Changed

- Unify adapter system with BaseRelayAdapter base class, shared callbacks, and DRY utilities
- Add upgrade guidance, rollback instructions, and breaking-change callouts to docs
- Add dedicated Docker guide with install tabs for containerized setup
- Fix documentation drift — update AGENTS.md, API reference, and correct broken links

### Fixed

- Harden onboarding gate validation, error handling, logging, and documentation clarity
- Harden Slack adapter with throttled streaming updates, bounded caches, and better error surfaces
- Fix adapter setup wizard scrollability when forms exceed viewport height

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
- Add endpoint types, dispatch TTL sweeper, and relay_send_and_wait progress accumulation
- Add /chat:self-test slash command
- Add relay_send_async fire-and-poll for long-running tasks

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
- Add relay_send_and_wait blocking MCP tool for inter-agent communication
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
- Register relay_send_and_wait in tool filter and add test coverage

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

- Migrate domain from dorkos.ai to dorkos.ai
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

[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.21.0...HEAD
[0.21.0]: https://github.com/dork-labs/dorkos/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/dork-labs/dorkos/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/dork-labs/dorkos/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/dork-labs/dorkos/compare/v0.17.2...v0.18.0
[0.17.2]: https://github.com/dork-labs/dorkos/compare/v0.17.1...v0.17.2
[0.17.1]: https://github.com/dork-labs/dorkos/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/dork-labs/dorkos/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/dork-labs/dorkos/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/dork-labs/dorkos/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/dork-labs/dorkos/compare/v0.13.1...v0.14.0
[0.13.1]: https://github.com/dork-labs/dorkos/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/dork-labs/dorkos/compare/v0.12.0...v0.13.0
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
