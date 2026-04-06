---
slug: dorkos-marketplace
number: 219
created: 2026-04-06
status: ideation
linear-issue: null
tags: [marketplace, extensions, agent-templates, tasks, skills, distribution]
---

# DorkOS Marketplace

**Slug:** dorkos-marketplace
**Author:** Claude Code
**Date:** 2026-04-06
**Branch:** preflight/dorkos-marketplace

---

## Source Material

This ideation document was created from a comprehensive pre-existing project brief. **All content from the source has been preserved verbatim** — do not paraphrase away precision. The original brief is the floor for detail, not the ceiling.

- **Source brief:** [`research/20260331_marketplace_project_brief.md`](../../research/20260331_marketplace_project_brief.md)
- **Brief status:** Active (pre-spec exploration, fully developed through multiple iterations)
- **Maturity classification:** partial-spec — has decisions, structure, scope, and 10x vision; lacks API contracts, data models, file structures, and implementation phases
- **Conversation context:** This brief is the result of an extended research-and-design conversation that explored the existing extension system, tasks system redesign, agent templates, Claude Code marketplace, skills.sh, Codex/Cursor plugin formats, and bidirectional compatibility tradeoffs

### Research already incorporated

The brief synthesizes findings from these prior research reports — review them before specification:

- `research/20260329_claude_code_plugin_marketplace_extensibility.md` — Claude Code plugin format deep dive
- `research/20260329_skills_sh_marketplace_format_specification.md` — skills.sh and Agent Skills standard
- `research/20260329_ai_coding_agent_plugin_marketplaces.md` — Codex, Cursor, Copilot, Windsurf, Cline landscape
- `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode, Obsidian, Grafana, Backstage patterns
- `research/20260326_extension_point_registry_patterns.md` — Extension registry implementation
- `research/20260326_extension_system_open_questions.md` — Extension system design decisions
- `research/20260326_agent_built_extensions_phase4.md` — Agent-built extension workflow

### Codebase exploration already performed

During brief development, these subsystems were thoroughly explored:

- **Extension system** — `packages/extension-api/`, `apps/server/src/services/extensions/`, 8 UI slots, esbuild compilation, encrypted secrets, declarative settings
- **Tasks system** — `apps/server/src/services/tasks/`, file-based SKILL.md format (post-redesign), Damon system agent, croner scheduling
- **Agent template system** — `packages/shared/src/template-catalog.ts`, `apps/server/src/services/core/template-downloader.ts`, 7 built-in templates, git+giget download, scaffolding flow
- **Skills package** — `packages/skills/`, `@dorkos/skills`, ADR-0220, SKILL.md unification for tasks/commands/skills
- **Adapter catalog** — `apps/server/src/services/relay/adapter-manager.ts`, `packages/relay/src/adapters/`, plugin-based loading
- **Mesh system** — `packages/mesh/`, agent discovery, agent.json file-first storage (ADR-0043)

### Key architectural decisions already made

These are decisions resolved during brief development — they should NOT be re-litigated during specification:

1. **SKILL.md is the universal file format** (ADR-0220) — tasks, commands, and skills all use it
2. **Bidirectional compatibility with Claude Code** — DorkOS marketplace IS a Claude Code marketplace
3. **Plugins MUST include `.claude-plugin/plugin.json`**; agent templates are exempt (project scaffolds, not plugins)
4. **Extended marketplace.json** approach (test first, fall back to companion file if needed)
5. **Pursue 3 of 5 "10x" visions:** Agent App Store (Vision 1), AI-Native Discovery / MCP Server (Vision 2), Build-to-Install Pipeline (Vision 3)
6. **Project will be decomposed into ~5 sequential specs** at `/ideate-to-spec` time, not implemented as a single monolithic spec

### Recommended decomposition (from brief development)

The brief is intentionally large because it covers an entire product surface. During specification, it should be broken into 5 sequential specs:

1. **`marketplace-foundation`** — Schemas, parser, `@dorkos/marketplace` package (no install yet)
2. **`marketplace-install`** — `dorkos install` CLI, three install flows, atomic transactions, rollback
3. **`marketplace-extension`** — Built-in Marketplace Extension UI, browse/search/filter
4. **`marketplace-web-and-registry`** — `/marketplace` page on dorkos.dev, dorkos-community registry repo, seed packages
5. **`marketplace-agent-installer`** — MCP server, `marketplace_search`/`marketplace_install` tools, agent-driven discovery flow

Each spec is 1-2 weeks of focused work. Critical sequencing: 1 → 2 → (3 ‖ 4) → 5.

---

## 1) Intent & Assumptions (for ideation system)

- **Task brief:** Build a public marketplace for DorkOS that distributes agent templates, plugins (skill packs, extensions, adapters), and bundled "agent apps." Marketplace must be bidirectionally compatible with Claude Code's marketplace format. Pursue Agent App Store framing, expose via MCP server, lay groundwork for Build-to-Install pipeline.
- **Assumptions:**
  - SKILL.md format adoption (ADR-0220) is complete and stable
  - Extension system (4 phases) is production-ready
  - Agent template downloader exists and works
  - Tasks system redesign is complete
  - Claude Code's marketplace.json format is documented and stable
  - Users want both browse-and-click AND agent-driven install flows
  - DorkOS team has bandwidth for ~6 weeks of focused development across 5 specs
- **Out of scope (for v1):**
  - Payments / paid packages
  - User accounts, reviews, ratings
  - Live preview / sandboxed try-before-install
  - Verified publisher checkmarks (Sigstore signing)
  - Recommendation engine
  - Public personal marketplace sharing
  - Full `marketplace_create_package` MCP tool
  - Private/enterprise registry UI (architecture supports it; no UI in v1)

---

## Original Brief Content

The remainder of this document is the unchanged content from `research/20260331_marketplace_project_brief.md`. It will serve as the source material for `/ideate-to-spec`.

---

## Executive Summary

DorkOS needs a public marketplace for distributing installable items: agent templates, extensions, skill packs, and adapter configurations. The AI coding agent ecosystem has converged on two open standards — **MCP** (tool integration) and **Agent Skills / SKILL.md** (skill packaging) — with agent-specific plugin bundles on top. DorkOS has already adopted the SKILL.md standard (ADR-0220, `@dorkos/skills` package) — tasks, commands, and skills all share the same file format. This means marketplace distribution is naturally portable across 30+ tools.

**Core insight:** DorkOS runs on top of Claude Code. Layers 0-2 (MCP, Agent Skills, Claude Code plugins) are already solved. DorkOS only needs to build **Layer 3** — the packaging that adds UI extensions, relay adapters, task scheduling, and agent templates.

**Compatibility principle:** The DorkOS marketplace IS a Claude Code marketplace. Same `marketplace.json` schema, same plugin structure. Every DorkOS package is a valid Claude Code plugin. Claude Code users can add the DorkOS marketplace directly; DorkOS users can install from any Claude Code marketplace. DorkOS-specific features (UI extensions, task scheduling, adapters) live in `.dork/` which non-DorkOS tools silently ignore.

---

## Industry Landscape (March 2026)

### Three Universal Standards

| Layer       | Standard                                   | Adoption                                                                     | What it does                                                             |
| ----------- | ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Tools**   | MCP (Model Context Protocol)               | 97M monthly SDK downloads, ~2K registry entries                              | Universal protocol for connecting agents to external tools               |
| **Skills**  | Agent Skills / `SKILL.md` (agentskills.io) | Claude Code, Codex, Cursor, Copilot, Windsurf, Gemini CLI, Cline, 20+ others | Portable instruction packaging — YAML frontmatter + markdown body        |
| **Context** | `AGENTS.md`                                | 20K+ GitHub repos                                                            | Cross-tool alternative to CLAUDE.md for project-level agent instructions |

### Agent-Specific Plugin Formats

Every major agent has converged on a similar plugin bundle format:

```
Claude Code:  .claude-plugin/plugin.json  → skills + hooks + agents + commands + MCP + LSP
Codex:        .codex-plugin/plugin.json   → skills + MCP + apps
Cursor:       .cursor-plugin/plugin.json  → skills + rules + agents + hooks + MCP + commands
Copilot:      .github/plugin/marketplace.json → skills + MCP
```

All bundle `SKILL.md` files + MCP server configs. The plugin manifest is the wrapper; skills are the portable unit.

### Marketplace Landscape

| Platform        | Format                                                    | Status                                                 |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| **Claude Code** | `claude-plugins-official` git repo, `marketplace.json`    | Live, browsable at claude.com/plugins                  |
| **skills.sh**   | Leaderboard/directory, auto-indexed via install telemetry | Live, 90K+ skills indexed                              |
| **Codex**       | Curated Plugin Directory                                  | Live, self-serve publishing "coming soon"              |
| **Cursor**      | cursor.com/marketplace                                    | Launched Feb 2026, private marketplaces for enterprise |
| **Cline**       | cline.bot/mcp-marketplace                                 | MCP servers only                                       |

### The SKILL.md Format (agentskills.io standard)

Every skill is a directory containing a `SKILL.md` file:

```yaml
---
name: my-skill
description: What it does and when to use it
license: Apache-2.0
compatibility: Requires Node.js 20+
metadata:
  category: code-review
allowed-tools: Read Edit Grep Glob Bash
---
# My Skill

Instructions for the agent to follow when this skill is activated.
```

**Progressive disclosure:** Level 1 (metadata, ~100 tokens, always loaded) → Level 2 (instructions, <5K tokens, on trigger) → Level 3 (references/, scripts/, assets/, on demand).

**Claude Code extension fields:** `argument-hint`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context` (fork), `agent`, `hooks`, `paths`, `shell`.

### Claude Code Plugin Format

```
my-plugin/
├── .claude-plugin/plugin.json    ← Manifest (name, version, skills, hooks, mcpServers, etc.)
├── skills/
│   └── my-skill/SKILL.md
├── agents/
│   └── my-agent.md
├── hooks/
│   └── hooks.json
├── commands/
│   └── my-command.md
└── .mcp.json                     ← MCP server declarations
```

**Manifest fields:** `name` (required), `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `commands`, `agents`, `skills`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, `userConfig`, `channels`.

**Distribution:** Via `marketplace.json` catalogs hosted in git repos. Sources can be GitHub repos, git URLs, git subdirectories (sparse clone), npm packages, or local paths.

---

## Foundation: SKILL.md as Universal File Format

**ADR-0220** (accepted 2026-04-01) formally adopts the agentskills.io SKILL.md open standard as the base format for all file-based definitions in DorkOS. The `@dorkos/skills` package (`packages/skills/`) provides a single parser, writer, scanner, and validator for the entire system.

### Unified Schema Hierarchy

```
SkillFrontmatterSchema (agentskills.io base — name, description, license, compatibility, metadata, allowed-tools)
├── TaskFrontmatterSchema (extends with: cron, timezone, enabled, max-runtime, permissions, display-name)
└── CommandFrontmatterSchema (extends with: argument-hint, user-invocable, etc.)
```

All three use the **directory format**: `{name}/SKILL.md`. This aligns with the spec's support for bundled `scripts/`, `references/`, and `assets/` subdirectories.

### What This Means for Distribution

- **A DorkOS task IS a valid SKILL.md file.** Install it in Claude Code → it works as a skill (minus scheduling). The `cron`, `permissions`, `max-runtime` fields are just ignored by tools that don't understand them.
- **One parser for everything.** `parseSkillFile<T>` is schema-parameterized — pass `TaskFrontmatterSchema` for tasks, `CommandFrontmatterSchema` for commands, `SkillFrontmatterSchema` for plain skills.
- **"Task Packs" are just "Skill Packs."** A marketplace item containing tasks and skills is simply a collection of SKILL.md directories with varying frontmatter. No separate item type needed.
- **Installation-specific fields are excluded from files.** `agentId` and `cwd` are derived from the file's location on disk, not stored in SKILL.md. This is what makes tasks portable across installations.

---

## DorkOS Marketplace Item Types

### 1. Agent Templates

Full agent filesystem, downloadable via git. Contains everything needed to set up a working agent.

```
code-reviewer-template/
├── .claude-plugin/plugin.json      ← Standard Claude Code plugin (portable)
├── .claude/
│   ├── skills/                      ← Agent Skills standard (SKILL.md dirs)
│   │   └── review-code/SKILL.md
│   ├── commands/                    ← Commands (SKILL.md format, CommandFrontmatter)
│   │   └── review/SKILL.md
│   ├── hooks/...
│   └── rules/...
├── .dork/
│   ├── package.json                 ← DorkOS manifest (type: "agent-template")
│   ├── agent.json.template          ← Agent identity template
│   ├── extensions/                  ← Bundled local extensions
│   ├── tasks/                       ← Bundled task definitions (SKILL.md dirs)
│   │   └── weekly-review/SKILL.md   ← TaskFrontmatter (has `cron` field)
│   └── onboarding.json              ← Template-specific onboarding steps
├── CLAUDE.md.template               ← Template-tracked (marker-based updates)
├── SOUL.md.template
├── NOPE.md.template
├── .template.json                   ← Version tracking (existing system)
└── [project scaffolding files]
```

**Install flow:** Clone repo → template system handles `.template` files → agent auto-imports via `.dork/agent.json` → bundled extensions compile → bundled tasks enter `pending_approval`.

**Update flow:** Existing `.template.json` + `/template:update` system handles version tracking, marker-based CLAUDE.md merges, backup branches, and selective file updates.

### 2. Extensions

UI components, server-side routes, background tasks, settings. Can be standalone (global) or bundled with an agent template (local).

```
linear-status/
├── .claude-plugin/plugin.json      ← Required: makes this a valid Claude Code plugin too
├── skills/                          ← Optional: portable skills (SKILL.md dirs)
├── .dork/
│   ├── package.json                 ← DorkOS manifest (type: "extension")
│   └── extensions/
│       └── linear-status/
│           ├── extension.json       ← Extension manifest (existing format)
│           ├── index.ts             ← Client UI (8 slots available)
│           └── server.ts            ← Server routes, background tasks, proxy
└── README.md
```

**Existing extension capabilities:** 8 UI slots (`sidebar.footer`, `sidebar.tabs`, `dashboard.sections`, `header.actions`, `command-palette.items`, `dialog`, `settings.tabs`, `session.canvas`), server routes, encrypted secrets, plaintext settings, persistent storage, background scheduling, SSE events, data proxy.

### 3. Skill Packs (replaces "Task Packs")

Collections of SKILL.md definitions — skills, tasks, and commands in a single distributable unit. Lightweight.

```
security-audit-pack/
├── .dork/
│   ├── package.json                 ← DorkOS manifest (type: "skill-pack")
│   └── tasks/                       ← SKILL.md dirs with TaskFrontmatter
│       ├── dependency-audit/SKILL.md    ← cron: "0 9 * * 1", permissions: bypassPermissions
│       ├── secret-scan/SKILL.md         ← cron: "0 6 * * *"
│       └── license-check/SKILL.md       ← (no cron — on-demand only)
├── skills/                          ← Optional: plain SKILL.md dirs (portable to any tool)
│   └── audit-report/SKILL.md
└── README.md
```

**Task SKILL.md format** (per `@dorkos/skills` `TaskFrontmatterSchema`): Standard SKILL.md frontmatter (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) extended with `display-name`, `cron` (optional — absent means on-demand), `timezone` (default UTC), `enabled` (default true), `max-runtime` (duration string: "5m", "1h"), `permissions` ("acceptEdits" | "bypassPermissions"). Body = the prompt. ID = directory name slug.

**Portability:** Tasks reference agent capabilities, not specific agent IDs. Installation-specific fields (`agentId`, `cwd`) are derived from directory location, never stored in the file. Project-scoped tasks run against their own project's agent. Global tasks run against Damon (system agent) or a capable agent. Install a task SKILL.md in plain Claude Code → it works as a regular skill.

### 4. Adapters

Relay channel bridges. Separate lifecycle from extensions but distributable through the same marketplace.

```
discord-adapter/
├── .dork/
│   ├── package.json                 ← DorkOS manifest (type: "adapter")
│   └── adapters/
│       └── discord/
│           ├── manifest.json        ← AdapterManifest (config fields, setup guide)
│           └── discord-adapter.ts   ← Factory + runtime
└── README.md
```

### 5. DorkOS Skills (Bundled Concept — Future)

A higher-level "DorkOS Skill" bundles multiple item types into a single user-facing concept. Because skills, tasks, and commands all share the SKILL.md format, a DorkOS Skill is naturally a collection of SKILL.md directories plus optional DorkOS-specific additions:

- SKILL.md directories (skills, tasks, commands — all the same format, differentiated by frontmatter)
- Extensions (UI slots, server routes)
- Adapter requirements (dependency declarations)
- Hooks (`.claude/hooks/`)

**Example:** A "Code Review Skill" bundles `review-code/SKILL.md` (instructions for Claude), `weekly-review/SKILL.md` (TaskFrontmatter with `cron: "0 8 * * 5"`), a dashboard extension showing review status, and a hook that triggers on PR events. All SKILL.md files are portable to other tools; the extension and hook are DorkOS-specific.

**Note:** The SKILL.md unification makes this concept more natural — the boundary between "skill" and "task" is just a `cron` field in the frontmatter. Whether to surface this bundled concept in the marketplace UI or keep separate item types is an open question.

---

## Architecture: The Layer Model

```
Layer 0: MCP                          ← DorkOS already supports (external MCP server at /mcp)
Layer 1: Agent Skills / SKILL.md      ← DorkOS already uses (.claude/skills/)
Layer 2: Claude Code Plugin           ← DorkOS agents inherit these automatically
Layer 3: DorkOS Package               ← THE NEW THING — everything above PLUS:
         ├── UI Extensions (8 slots, server routes, settings)
         ├── Task Definitions (.dork/tasks/*/SKILL.md — same format, extra frontmatter)
         ├── Adapter Configs (relay bridges)
         └── Agent Templates (full agent scaffolding)
```

**What DorkOS gets for free:**

| Capability                       | How                                                 | Cost                       |
| -------------------------------- | --------------------------------------------------- | -------------------------- |
| skills.sh compatibility          | Already using SKILL.md format                       | Zero                       |
| Claude Code plugin compatibility | DorkOS agents are Claude Code agents                | Zero                       |
| MCP tool ecosystem               | Already have MCP server + Claude Code's MCP client  | Zero                       |
| Cross-tool skill portability     | SKILL.md is the standard                            | Zero                       |
| Task portability                 | Tasks ARE SKILL.md files (`@dorkos/skills` package) | Zero — already implemented |

**What DorkOS needs to build:**

| Capability                           | Effort  | Description                                                                      |
| ------------------------------------ | ------- | -------------------------------------------------------------------------------- |
| `.dork/package.json` manifest schema | Medium  | Declares type, extensions, tasks, adapter deps, template metadata                |
| `dorkos install` CLI command         | Medium  | Git clone + file placement + extension compilation + task import                 |
| DorkOS registry (`marketplace.json`) | Small   | Claude Code-compatible format in git repo. PRs to add packages                   |
| `marketplace.json` parser            | Small   | Parse Claude Code's marketplace.json format — enables reading ANY CC marketplace |
| Marketplace Extension (built-in)     | Medium  | Browse/search UI within DorkOS client                                            |
| Web browse experience                | Medium  | `/marketplace` on dorkos.dev                                                     |
| Dependency resolution                | Medium  | `"requires"` in `.dork/package.json` with install-time checks                    |
| Agent-as-installer flow              | Small   | MCP tool that queries registry + calls install                                   |
| `AGENTS.md` detection                | Trivial | Add to unified scanner alongside CLAUDE.md                                       |

---

## Distribution & Compatibility

### Core Principle: The DorkOS Marketplace IS a Claude Code Marketplace

The DorkOS marketplace uses Claude Code's exact `marketplace.json` schema. This makes the two ecosystems bidirectionally compatible:

- **Claude Code users** can add the DorkOS marketplace (`claude marketplace add dorkos-community`) and install any package — they get skills, hooks, commands, MCP servers. DorkOS-specific features (`.dork/`) are silently ignored.
- **DorkOS users** can add any Claude Code marketplace (`dorkos marketplace add claude-plugins-official`) and install any plugin — they get everything Claude Code provides, plus DorkOS reads `.dork/` if present for additional features.

### The Superset Package Structure (Plugins)

Every DorkOS **plugin** (type: `plugin`, `skill-pack`, `adapter`) MUST include `.claude-plugin/plugin.json`. This is what makes bidirectional compatibility work. DorkOS-specific features live in `.dork/` which non-DorkOS tools silently ignore.

**Agent templates are exempt** — they're project scaffolds, not plugins. They may contain `.claude/skills/` and `CLAUDE.md` (which work in any tool), but don't need a plugin manifest.

```
my-package/
├── .claude-plugin/plugin.json     ← REQUIRED: Claude Code sees skills + hooks + MCP
├── skills/                        ← skills.sh / Codex / Cursor see: SKILL.md files
├── hooks/                         ← Claude Code sees: lifecycle hooks
├── .dork/                         ← DorkOS sees: everything above + UI + tasks + adapters
│   ├── package.json               ← DorkOS-specific metadata (type, requires, etc.)
│   ├── extensions/...             ← DorkOS-only: UI extensions
│   ├── tasks/...                  ← DorkOS-only: scheduled tasks (SKILL.md with cron)
│   └── adapters/...               ← DorkOS-only: relay adapter configs
└── README.md
```

**Install in Claude Code** → skills + hooks + MCP work (Layer 2). `.dork/` ignored.
**Install in DorkOS** → everything works including UI extensions, task scheduling, adapters (Layer 3).
**Publish skills to skills.sh** → `skills/` directories auto-indexed (Layer 1).

### Bidirectional Compatibility Matrix

| Scenario                             | Works?  | What the user gets                                                                                                 |
| ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------ |
| **Claude Code marketplace → DorkOS** | Yes     | DorkOS parses standard `marketplace.json`, installs plugin, also reads `.dork/` for extra features if present      |
| **DorkOS marketplace → Claude Code** | Yes     | Claude Code parses same `marketplace.json` (standard format), installs `.claude-plugin/` portion, ignores `.dork/` |
| **DorkOS package → skills.sh**       | Yes     | `skills/` directories are standard SKILL.md, indexed automatically via install telemetry                           |
| **DorkOS package → Cursor/Codex**    | Partial | Skills work (SKILL.md standard). Full plugin compat depends on tool-specific plugin format differences             |
| **Any Claude Code plugin → DorkOS**  | Yes     | Skills, hooks, commands, MCP, agents all work because DorkOS agents ARE Claude Code agents                         |

### Registry Format (Extended marketplace.json)

The DorkOS marketplace extends Claude Code's `marketplace.json` with additional optional fields. The hypothesis is that Claude Code's parser ignores unknown fields — if it doesn't, we fall back to a companion `dorkos-catalog.json` file (see Open Question #7).

**Standard Claude Code fields** (guaranteed compatible):

- `name` — package identifier
- `source` — git URL (github:org/repo, full URL, etc.)
- `description` — short description

**DorkOS extension fields** (ignored by Claude Code if parser is tolerant):

- `type` — `"plugin"` | `"agent-template"` | `"skill-pack"` | `"adapter"` (default: `"plugin"`)
- `category` — browsing category (e.g., `"frontend"`, `"code-quality"`, `"security"`, `"messaging"`)
- `tags` — array of searchable tags
- `icon` — emoji or icon identifier for the browse UI
- `layers` — what the package contains: `["skills", "extension", "tasks", "adapter", "hooks"]`
- `requires` — dependency declarations (e.g., `["adapter:webhook"]`)
- `featured` — whether to highlight in browse UI
- `dorkos-min-version` — minimum DorkOS version

```json
{
  "name": "dorkos-community",
  "plugins": [
    {
      "name": "code-review-suite",
      "source": "github:dorkos-community/code-review-suite",
      "description": "Code review skills, scheduled tasks, and dashboard extension",
      "type": "plugin",
      "category": "code-quality",
      "tags": ["review", "ci", "dashboard"],
      "layers": ["skills", "extension", "tasks"],
      "icon": "🔍"
    },
    {
      "name": "nextjs-agent",
      "source": "github:dorkos-templates/nextjs",
      "description": "Next.js 16 agent template with App Router, Tailwind, and deployment tasks",
      "type": "agent-template",
      "category": "frontend",
      "tags": ["nextjs", "react", "app-router"],
      "icon": "🌐",
      "featured": true
    },
    {
      "name": "security-audit-pack",
      "source": "github:dorkos-community/security-audit-pack",
      "description": "Scheduled security audits — dependency scanning, secret detection, license checks",
      "type": "skill-pack",
      "category": "security",
      "tags": ["audit", "dependencies", "secrets"],
      "layers": ["skills", "tasks"]
    },
    {
      "name": "discord-adapter",
      "source": "github:dorkos-community/discord-adapter",
      "description": "Discord relay adapter — bridge agent messages to Discord channels",
      "type": "adapter",
      "category": "messaging",
      "tags": ["discord", "chat"],
      "layers": ["adapter"],
      "icon": "💬"
    },
    {
      "name": "express-api",
      "source": "github:dorkos-templates/express",
      "description": "Express API agent template with TypeScript, testing, and deployment tasks",
      "type": "agent-template",
      "category": "backend",
      "tags": ["express", "api", "typescript"]
    }
  ]
}
```

**Filtering by type:**

- `TemplatePicker` (agent creation dialog) filters `plugins.filter(p => p.type === "agent-template")`
- `Marketplace Extension` shows all types with tab filters: `[All] [Templates] [Plugins] [Skills] [Adapters]`
- CLI: `dorkos marketplace list --type agent-template`

**Fallback for entries without DorkOS fields:** When reading a Claude Code marketplace that has no DorkOS extension fields, all entries default to `type: "plugin"` with no category/tags. They still install and work — DorkOS just can't filter them.

### Agent Templates: Three Tiers

Templates range from plain repos to fully DorkOS-aware packages:

| Tier              |       Has `.dork/`?        |                       In marketplace?                       | What happens on install                                                     |
| ----------------- | :------------------------: | :---------------------------------------------------------: | --------------------------------------------------------------------------- |
| **Plain repo**    |             No             | Optional (via custom URL or `type: "agent-template"` entry) | Clone → DorkOS scaffolds `.dork/agent.json`, SOUL.md, NOPE.md. Works today. |
| **DorkOS-aware**  |  Yes, with `package.json`  |                             Yes                             | Clone → scaffold → also install bundled tasks, extensions, adapter configs  |
| **Rich template** | Yes, with `.template.json` |                             Yes                             | Clone → scaffold → bundled installs → template versioning/updates enabled   |

A plain GitHub repo with just a CLAUDE.md and source code can be listed as `type: "agent-template"` in the marketplace — the metadata for browsing lives in the registry entry, not in the repo. This means:

- Any existing project repo can become a template with zero modifications
- The marketplace entry provides the display name, description, category, tags
- DorkOS handles all scaffolding (agent.json, SOUL.md, NOPE.md) regardless of tier

### Template vs. Plugin: Different Install Flows

The `type` field in the registry entry determines the install flow:

```bash
# DorkOS reads the registry, sees type: "agent-template"
# → routes to creation flow
dorkos install nextjs-agent
# Equivalent to: dorkos create my-app --template nextjs-agent

# DorkOS reads the registry, sees type: "plugin" (or no type)
# → routes to plugin install flow
dorkos install code-review-suite
# Places files in ~/.dork/extensions/, .claude/skills/, etc.
```

In the UI:

- Templates show a **"Create Agent"** button → opens CreateAgentDialog with template pre-selected
- Plugins show an **"Install"** button → runs the plugin install flow
- The TemplatePicker in CreateAgentDialog shows built-in templates + marketplace templates (filtered by `type: "agent-template"`)

### Install Flows

```bash
# Install from DorkOS marketplace (default)
dorkos install code-review-suite

# Install from any Claude Code marketplace
dorkos install code-review-suite@claude-plugins-official

# Install a skills.sh skill
dorkos install --from skills.sh vercel-labs/agent-skills/nextjs

# Install from any git repo (auto-detects .claude-plugin/ and .dork/)
dorkos install github:user/repo

# Claude Code users can install DorkOS packages too:
# claude plugin install code-review-suite@dorkos-community
```

---

## Design Decisions (Proposed)

| #   | Decision                      | Choice                                                                                                                  | Rationale                                                                                                                                                         |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Plugin format                 | Plugins MUST include `.claude-plugin/plugin.json`. Agent templates are exempt (they're project scaffolds, not plugins). | Plugins need CC compatibility. Templates are cloned as projects — requiring plugin.json would be like requiring a VS Code extension manifest on Create React App. |
| 2   | Skill format                  | Use Agent Skills standard (SKILL.md) as-is — already implemented via `@dorkos/skills`                                   | ADR-0220 accepted. Tasks, commands, and skills share the format. One parser.                                                                                      |
| 3   | Registry format               | Extend Claude Code's `marketplace.json` with optional DorkOS fields (`type`, `category`, `tags`, etc.)                  | Enables browsing/filtering without cloning. If CC rejects unknown fields, fall back to companion file.                                                            |
| 4   | Distribution                  | Git-based (repos for templates, sparse clone for packages)                                                              | Aligns with Claude Code's approach. No custom registry infrastructure needed                                                                                      |
| 5   | DorkOS-specific metadata      | In registry (extended fields) + in package (`.dork/package.json` for richer data)                                       | Registry has enough for browse/filter. Package has full details (dependencies, extension manifests).                                                              |
| 6   | In-app browsing               | Built-in Marketplace Extension using extension API                                                                      | Dogfoods the extension system. Can be updated independently                                                                                                       |
| 7   | Web browsing                  | `/marketplace` on dorkos.dev (marketing site)                                                                           | Discoverable via search engines. SSG from registry JSON                                                                                                           |
| 8   | Primary install channel       | Agent-driven (agent queries registry, installs based on context)                                                        | Differentiator. "Describe what you need" > "browse and click"                                                                                                     |
| 9   | Secondary install channel     | CLI (`dorkos install`) + Marketplace Extension UI                                                                       | Traditional fallback for direct installs                                                                                                                          |
| 10  | Trust model                   | Social trust (verified publishers, signed manifests) — no sandboxing                                                    | Matches Claude Code's full-trust model. Developer audience.                                                                                                       |
| 11  | Template updates              | Existing `.template.json` + marker-based merge system                                                                   | Already built and working. Advisory updates, user controls merges                                                                                                 |
| 12  | Task portability              | Capability-based agent matching, not agent ID references                                                                | Tasks declare needed capabilities; DorkOS finds capable agents                                                                                                    |
| 13  | Dependencies                  | Declarative `"requires"` in `.dork/package.json` with install-time checks                                               | Soft enforcement v1 (warn, don't block). Full resolution later                                                                                                    |
| 14  | Adapter/extension unification | Separate systems, unified marketplace                                                                                   | Different lifecycles and APIs. Single storefront, separate installers                                                                                             |
| 15  | `AGENTS.md` support           | Add as agent detection strategy in unified scanner                                                                      | 20K+ repos. Trivial to implement. Expands discoverability                                                                                                         |

---

## Critical Considerations (Beyond the Happy Path)

These are concerns that must be addressed during specification — they're easy to miss in early design but expensive to retrofit.

### Lifecycle Operations

| Concern             | What it means                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Uninstall**       | Remove a package cleanly: delete files, unregister extensions, remove tasks, optionally preserve secrets/data. Must handle "I uninstalled but my agent's tasks vanished."          |
| **Update**          | When `linear-integration v1.2` ships, how does an installed v1.1 user upgrade? Does it auto-update? Notify? Show a diff? How does it interact with `.template.json` for templates? |
| **Atomic installs** | Installs touch multiple directories. If step 4 of 7 fails, the user's system must roll back to the pre-install state. Extend the template downloader's backup branch pattern.      |
| **Rollback**        | After a successful install, can the user undo? "I installed code-review-suite yesterday and it broke things — revert."                                                             |
| **Reinstall**       | What does `dorkos install code-review-suite` do when it's already installed? Refresh? No-op? Force update?                                                                         |

### Conflict Resolution

| Concern                   | What it means                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slot collisions**       | Two extensions both want `dashboard.sections`. Existing extension system has `priority`, but no UX for conflict resolution. Need explicit ordering and a way for users to disable specific contributions. |
| **Skill name collisions** | Two packages both ship a `code-review` skill. Last-write-wins is a footgun. Need namespace prefixing (`package-name:skill-name`) at install time.                                                         |
| **Dependency conflicts**  | `package-a` requires `adapter:slack@1.x`, `package-b` requires `adapter:slack@2.x`. Detect these BEFORE install and warn (v1) or block (v2).                                                              |
| **Resource conflicts**    | Two packages both register a cron task for `0 9 * * *`. Both fire simultaneously, race conditions. Need scheduler-level coordination.                                                                     |

### Security & Trust

| Concern                     | What it means                                                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permission preview**      | **Most important trust feature.** Before install: "This package will register a dashboard widget, schedule 2 tasks, request access to your Linear API key, run on every PR event, and access these external hosts: api.linear.app". User confirms. |
| **Verified publishers**     | A blue checkmark equivalent. DorkOS team verifies publishers manually for v1. Sigstore/cryptographic signing for v2.                                                                                                                               |
| **Pinned commits**          | `marketplace.json` should pin commit SHAs, not just `github:org/repo`. Otherwise a compromised repo silently distributes malware.                                                                                                                  |
| **External host allowlist** | Packages declare which external hosts they contact. DorkOS enforces this at the network layer (or warns if it can't).                                                                                                                              |
| **Secret handling**         | Packages declare which secrets they need (Linear API key, Slack token). DorkOS prompts the user — secrets never get baked into manifests.                                                                                                          |
| **Sandbox boundaries**      | Even with full-trust, certain operations should require explicit approval (filesystem access outside agent CWD, network calls to non-allowlisted hosts).                                                                                           |

### Discoverability & Telemetry

| Concern               | What it means                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Install telemetry** | **Critical flywheel fuel.** Privacy-preserving, opt-in install counts. skills.sh has 90K skills indexed BECAUSE of telemetry. Without this, the marketplace can't surface what's good. |
| **Search ranking**    | How are results ordered? Need a ranking function from day one. Options: install count, recency, manually featured, search relevance. Probably a weighted mix.                          |
| **Recommendations**   | "People who installed X also installed Y" requires the install graph. Plan the data model for it even if v1 doesn't ship recommendations.                                              |
| **Failure reporting** | When an install fails, anonymously report the error. Authors see what's breaking without surveys.                                                                                      |

### Operational Reality

| Concern                  | What it means                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Caching**              | Don't clone a git repo for every install. Local cache in `~/.dork/cache/marketplace/` with TTL-based refresh.                          |
| **Offline mode**         | DorkOS is local-first. The marketplace should work degraded when offline (browse cached entries, install previously-fetched packages). |
| **Cross-platform paths** | Windows path handling for extension installs. Verify the marketplace install flow works on Windows from day one.                       |
| **Migration**            | `~/.dork/agent-templates.json` already exists. The marketplace must subsume it without breaking existing user workflows.               |
| **Authentication**       | Private repos need auth. v1 uses existing `gh auth token` / `GITHUB_TOKEN` (already wired into template-downloader.ts).                |

### Author Experience

| Concern              | What it means                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Scaffolding CLI**  | `dorkos package init` — creates the directory structure, manifests, README, sample SKILL.md. Lower the barrier to creation. |
| **Local validation** | `dorkos package validate` — lint a package locally before publishing. Catch errors before submission.                       |
| **Publishing flow**  | `dorkos package publish` — submit a PR to dorkos-community automatically (or to any marketplace).                           |
| **Author docs**      | Documentation site explaining how to create a package. Examples, recipes, common patterns.                                  |
| **Live testing**     | `dorkos package test` — run the package in a sandboxed local DorkOS to verify behavior before publishing.                   |

### Naming & Identity

| Concern              | What it means                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Marketplace name** | "DorkOS Marketplace" is descriptive but boring. Brand voice is "confident, minimal, technical." Candidates: **Dork Hub**, **Dork Index**, **Dork Registry**, **DorkPkg**. Decide before building UI. |
| **Package term**     | "Package" is generic. "Plugin" is overloaded. "Skill" conflicts with SKILL.md. Worth considering: **Mod**, **Pack**, **Kit**, **App** (especially if pursuing Agent App Store framing).              |

---

## 10x Vision: From Plugin Marketplace to Agent Infrastructure

The current brief describes a competent traditional plugin marketplace. The 10x version positions DorkOS as **the defining marketplace for the AI agent era**.

Three ideas reframe the entire opportunity. The brief should design APIs, schemas, and architecture to enable these from day one — even if v1 doesn't ship them all.

### 🌟 Vision 1: The Agent App Store

**The reframe:** Stop selling plugins. Sell agents.

The current brief treats agent templates as one of four item types. **Flip it.** The PRIMARY marketplace experience is "install a complete, working agent." Plugins, skill packs, and adapters are _components_ that agent apps use internally — but the user-facing unit is **the agent**.

**Why this matters:**

- Apple's App Store doesn't sell "extensions for iOS." It sells apps.
- Users don't want plugins. They want outcomes. "I want a code reviewer" not "I want a code review extension to install into a generic agent."
- One-click install → working agent in 30 seconds. No configuration. No "now go set up your agent and install this plugin into it."

**What the user sees in the marketplace:**

```
┌─────────────────────────────────────────────────┐
│  Featured Agents                                │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │ 🔍 Code Reviewer                         │  │
│  │ Reviews your PRs every weekday morning,  │  │
│  │ posts findings to Slack, files Linear    │  │
│  │ issues for blockers.                     │  │
│  │                                          │  │
│  │ ★★★★★ 1,247 installs                    │  │
│  │ [Install Agent →]                        │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**What happens on install:**

1. Clone the agent template repo
2. Install bundled extensions, tasks, adapters
3. Prompt for required secrets (Linear API key, Slack token)
4. Configure scheduled tasks
5. Register the agent in mesh
6. Show: "Code Reviewer is running. Next review: Monday 8 AM."

**Implications for the brief:**

- The `type: "agent-template"` field becomes the most important type (relabel as `type: "agent"` for clarity)
- Agent packages bundle EVERYTHING needed (template + plugins + tasks + adapters + secret declarations)
- Browse UI leads with agents, not plugins
- Plugin install is the "advanced" path for users assembling custom agents
- Marketing positions DorkOS as "the App Store for AI agents"

### 🌟 Vision 2: AI-Native Discovery (Marketplace as MCP Server)

**The reframe:** The marketplace isn't for humans. It's for agents.

Don't build a search bar. Build an MCP server. Every AI agent — Claude Code, Cursor, Codex, Cline, ChatGPT, Gemini — can connect to the DorkOS marketplace MCP server and search it.

**Example interaction:**

```
User to Claude Code: "I need to start tracking errors in my Next.js app"

Claude Code → DorkOS Marketplace MCP → marketplace_search({
  query: "error tracking nextjs",
  type: "agent" | "plugin"
})

← Returns: [
  { name: "sentry-monitor", type: "agent", description: "...", install_count: 8421 },
  { name: "posthog-errors", type: "plugin", ... },
  { name: "rollbar-integration", type: "plugin", ... }
]

Claude Code: "I found 3 options. The 'sentry-monitor' agent is the most popular —
it monitors your Sentry project, opens GitHub issues for new errors, and posts
daily summaries to Slack. Want me to install it?"

User: "Yes"

Claude Code → marketplace_install({ name: "sentry-monitor" })
```

**Why this is the highest-leverage 10x move:**

- **Costs almost nothing extra** to build (the marketplace already needs an API)
- **Immediately makes DorkOS relevant to every other agent tool** — Cursor users discover DorkOS through their existing Cursor agent
- **Other tools can install DorkOS packages without using DorkOS** — but the full experience is in DorkOS, creating a natural funnel
- **Positions DorkOS as infrastructure**, not just another agent app
- **Defensible** — once DorkOS is the most-queried agent package registry, the network effect kicks in

**MCP server endpoints:**

```typescript
marketplace_search({ query, type?, category?, tags? })
marketplace_get({ name })
marketplace_install({ name, marketplace? })
marketplace_uninstall({ name })
marketplace_list_installed()
marketplace_list_marketplaces()
marketplace_recommend({ context })  // "what would help with X?"
```

**Strategic positioning:**

- DorkOS = the npm of AI agents
- Marketplace = the package registry every agent tool wants to query
- The brief should explicitly call out "marketplace as MCP server" as a v1 deliverable

### 🌟 Vision 3: Build-to-Install Pipeline

**The reframe:** Lower the barrier to package creation to zero.

User: "I wish there was a package that posts my deploy status to Telegram every morning."

DorkOS: "I'll build it for you."

What happens:

1. An agent scaffolds the package structure (`.dork/package.json`, SKILL.md files, manifest)
2. Generates the task SKILL.md with the cron schedule and prompt
3. If needed, generates a small extension for the dashboard widget
4. Tests it locally in a sandboxed DorkOS environment (Vision 5 from the original list)
5. Publishes to the user's personal marketplace (or commits to a private GitHub repo)
6. Installs it locally
7. Optionally: prompts user to share with the public marketplace

**End-to-end time:** 2-5 minutes from idea to running package.

**Why this is uniquely possible for DorkOS:**

DorkOS already has agent-built extension capabilities (specs/ext-platform-04-agent-extensions). MCP tools for `create_extension`, `test_extension`, `reload_extensions` already exist. The missing piece is wiring this into a "publish to marketplace" flow.

**Implications for the brief:**

- A new MCP tool: `marketplace_create_package({ description, type })`
- A "personal marketplace" concept — every user has their own marketplace they can publish to
- Personal marketplace defaults to a private GitHub repo (`~/.dork/personal-marketplace/`)
- Optional sharing flow: "publish to dorkos-community" with one click
- The build-to-install loop becomes the **fastest path** to extending DorkOS — faster than searching the marketplace, much faster than writing code by hand

**The narrative this enables:**

"Other tools have plugin marketplaces. DorkOS has a plugin marketplace AND an AI that builds plugins on demand AND a way to share them with one click. The marketplace doesn't just grow when humans contribute — it grows every time an agent solves a user's problem."

### Architectural Implications for v1

Even without shipping all three visions in v1, the brief should ensure v1 doesn't preclude them:

| Vision               | What v1 must enable                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent App Store**  | `type: "agent"` (or `agent-template`) is a first-class type in the registry. Bundled secret/dependency declarations work. Browse UI can lead with agents. |
| **MCP Server**       | The marketplace install flow exists as a programmatic API (not just CLI). MCP server is a thin wrapper over the same API.                                 |
| **Build-to-Install** | "Personal marketplace" concept exists from day one (even if it's just a local directory). Manifest scaffolding CLI exists.                                |

### What This Changes in V1 Scope

Add to V1 build list:

- **Marketplace MCP server** — Thin wrapper exposing search, install, list as MCP tools
- **Personal marketplace** — Local directory at `~/.dork/personal-marketplace/` that DorkOS treats as a marketplace source
- **`dorkos package init`** — Scaffolding CLI for new packages (enables Build-to-Install)

Don't add yet (defer to v2):

- Live preview / sandboxed try-before-install
- Verified publisher checkmarks
- Recommendation engine
- Public personal marketplace sharing

---

## V1 Scope (MVP)

**Goal:** Create a flywheel — enough packages to be useful, easy enough to contribute that the catalog grows.

### Build

**Foundation:**

1. **`.dork/package.json` manifest schema** — Zod schema defining package type, contents, dependencies, compatibility
2. **`.claude-plugin/plugin.json` scaffolding** — Tooling to generate a valid Claude Code plugin manifest from DorkOS package contents
3. **`marketplace.json` parser** — Parse Claude Code's marketplace.json format with optional DorkOS extension fields
4. **`@dorkos/marketplace` package** — Shared schemas, parser, install logic (browser-safe + Node.js subpaths)

**Install mechanics:**

5. **`dorkos install` CLI command** — Git clone, file placement, atomic transactions, rollback on failure
6. **Three install flows** — Plugin (skill pack/extension/adapter), Agent (template), Personal package
7. **Permission preview** — Show what a package will do before install (trust/security)
8. **Uninstall + update flows** — Clean removal, version upgrades, advisory notifications
9. **Local cache** — `~/.dork/cache/marketplace/` with TTL refresh, offline degradation

**Discovery:**

10. **Marketplace Extension** (built-in) — `sidebar.tabs` entry with browse/search/install UI, leads with Agents
11. **`/marketplace` web page** — Static page on dorkos.dev reading from registry
12. **Marketplace MCP server** — Thin wrapper over install API exposing `marketplace_search`, `marketplace_install`, etc. (Vision 2)
13. **TemplatePicker integration** — Existing template picker reads marketplace, filters by `type: "agent"` or `"agent-template"`

**Authoring:**

14. **`dorkos package init`** — Scaffolding CLI for new packages (enables Build-to-Install, Vision 3)
15. **`dorkos package validate`** — Local lint/validation
16. **Personal marketplace** — `~/.dork/personal-marketplace/` directory treated as a marketplace source (Vision 3 foundation)

**Registry & Content:**

17. **DorkOS registry** — Claude Code-compatible `marketplace.json` in the `dorkos-community` GitHub org, submissions via PR
18. **5-10 seed packages** — Mix of agents (Vision 1), plugins, skill packs. The **agents** are the headline.
19. **Telemetry (opt-in)** — Anonymous install counts and failure reporting

### Defer

- Live preview / sandboxed try-before-install
- Verified publisher checkmarks (Sigstore signing)
- Recommendation engine ("people who installed X also installed Y")
- Public personal marketplace sharing
- `marketplace_create_package` MCP tool (full Build-to-Install loop — Vision 3 v2)
- Payments / paid packages
- User accounts / reviews / ratings
- Automated security scanning
- Self-serve publishing for `dorkos-community` (v1 is PR-based)
- Visual cron builder for skill packs with tasks
- Full dependency resolution (v1 is warn-only)
- Package versioning beyond semver in manifest
- Private/enterprise registries (architecture supports it via "marketplace of marketplaces" but no UI in v1)

---

## Open Questions

1. **Manifest naming:** `.dork/package.json` vs `.dork/dorkos.json` vs `dork.json` — need to avoid confusion with npm's `package.json`. Note: this is separate from `.claude-plugin/plugin.json` which is always required and uses Claude Code's schema.
2. **Skills as a bundling concept:** Now that tasks, commands, and skills all share the SKILL.md format (differentiated only by frontmatter), should the marketplace surface them as one "Skill Pack" category, or keep "tasks" and "skills" as separate filters? The format unification argues for one category; user mental models may argue for two.
3. **Registry hosting:** Static JSON in git repo (v1) vs API service (future) — when does the static approach stop scaling?
4. ~~**Dual marketplace registration**~~ — **RESOLVED.** The DorkOS marketplace uses Claude Code's exact `marketplace.json` schema. A single registration works in both ecosystems. Claude Code users add the DorkOS marketplace directly; DorkOS users can add any Claude Code marketplace.
5. **Adapter distribution:** Should adapters use the npm plugin loader (existing) or switch to git-based distribution (marketplace pattern)?
6. **`kind` discriminator field:** ADR-0220 deferred adding a `kind` field to SKILL.md frontmatter (the spec notes location-based inference is sufficient for now). For marketplace distribution, a `kind: task` or `kind: skill` field would make it possible to determine intent without knowing the installation path. Should the marketplace require this?
7. **Claude Code marketplace.json extension tolerance:** The extended marketplace.json approach assumes Claude Code's parser ignores unknown fields (`type`, `category`, `tags`, etc.). **This must be tested before v1 ships.** If the parser rejects unknown fields, fall back to a companion `dorkos-catalog.json` file alongside a standard `marketplace.json`. Test by adding a DorkOS-extended entry to a real marketplace and running `claude plugin install` against it.
8. **Marketplace name:** "DorkOS Marketplace" vs **Dork Hub** vs **Dork Index** vs **Dork Registry** vs **DorkPkg**. Decide before building UI.
9. **Package term:** "Package" is generic, "Plugin" is overloaded. Especially if pursuing Agent App Store framing, **"App"** or **"Agent"** may be the right user-facing term — even if the underlying directory is called a "package."
10. **Type field naming for agent templates:** Should the `type` field use `"agent"` (Agent App Store framing) or `"agent-template"` (more accurate technical name)? "Agent" is more user-friendly but may confuse with mesh agents.
11. **Personal marketplace privacy:** Personal marketplace defaults to local-only. Should there be a "publish to GitHub" one-click flow in v1, or defer entirely?
12. **MCP server authentication:** The marketplace MCP server is exposed on the local DorkOS server. For external agents (Claude Code in another project, Cursor) to query it, there needs to be discoverable URL + optional auth. Use the existing `MCP_API_KEY` pattern? Or anonymous read-only?
13. **Telemetry consent:** Opt-in vs opt-out for install telemetry. GDPR/privacy implications. The brand voice is "honest by design" — opt-in is the right choice but slows the flywheel.

---

## Related Research

- `research/20260329_claude_code_plugin_marketplace_extensibility.md` — Claude Code plugin format deep dive
- `research/20260329_skills_sh_marketplace_format_specification.md` — skills.sh and Agent Skills standard
- `research/20260329_ai_coding_agent_plugin_marketplaces.md` — Codex, Cursor, Copilot, Windsurf, Cline landscape
- `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode, Obsidian, Grafana, Backstage patterns
- `research/20260326_extension_point_registry_patterns.md` — Extension registry implementation
- `research/20260326_extension_system_open_questions.md` — Extension system design decisions
- `research/20260326_agent_built_extensions_phase4.md` — Agent-built extension workflow
- `research/20260329_extension_server_side_capabilities.md` — Server-side extension capabilities
- `research/20260329_extension_manifest_settings_schema.md` — Extension settings patterns

## Related Specs

- `specs/plugin-extension-system/` (Spec #173) — Core extension system
- `specs/ext-platform-02-extension-registry/` (Spec #182) — Extension point registry
- `specs/ext-platform-03-extension-system/` (Spec #183) — Extension lifecycle
- `specs/ext-platform-04-agent-extensions/` — Agent-built extensions
- `specs/extension-manifest-settings/` (Spec #209) — Extension settings
- `specs/tasks-system-redesign/` (Spec #211) — File-based task system
- `specs/skills-package/` (Spec #212) — `@dorkos/skills` package (SKILL.md standard adoption) — **implemented**

## Related ADRs

- ADR-0043 — Agent storage (file-first write-through pattern)
- ADR-0199 — Generic register API with SlotContributionMap
- ADR-0200 — App-layer synchronous extension initialization
- ADR-0214 — AES-256-GCM per-extension secret storage
- **ADR-0220** — Adopt SKILL.md open standard for task and command definitions — **key marketplace dependency**
