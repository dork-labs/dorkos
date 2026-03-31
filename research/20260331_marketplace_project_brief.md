---
title: DorkOS Marketplace — Project Brief
date: 2026-03-31
status: active
type: project-brief
linear-issue: null
tags: [marketplace, extensions, agent-templates, tasks, skills, distribution]
---

# DorkOS Marketplace — Project Brief

**Date:** 2026-03-31
**Status:** Pre-spec exploration — ready for ideation when prioritized

---

## Executive Summary

DorkOS needs a public marketplace for distributing installable items: agent templates, extensions, task packs, and adapter configurations. The AI coding agent ecosystem has converged on two open standards — **MCP** (tool integration) and **Agent Skills / SKILL.md** (skill packaging) — with agent-specific plugin bundles on top. DorkOS should align with these standards rather than inventing its own, layering DorkOS-specific capabilities on top of the portable formats.

**Core insight:** DorkOS runs on top of Claude Code. Layers 0-2 (MCP, Agent Skills, Claude Code plugins) are already solved. DorkOS only needs to build **Layer 3** — the packaging that adds UI extensions, relay adapters, task scheduling, and agent templates.

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

## DorkOS Marketplace Item Types

### 1. Agent Templates

Full agent filesystem, downloadable via git. Contains everything needed to set up a working agent.

```
code-reviewer-template/
├── .claude-plugin/plugin.json      ← Standard Claude Code plugin (portable)
├── .claude/
│   ├── skills/...                   ← Agent Skills standard
│   ├── commands/...
│   ├── hooks/...
│   └── rules/...
├── .dork/
│   ├── package.json                 ← DorkOS manifest (type: "agent-template")
│   ├── agent.json.template          ← Agent identity template
│   ├── extensions/                  ← Bundled local extensions
│   ├── tasks/                       ← Bundled task definitions (.md files)
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
├── .claude-plugin/plugin.json      ← Optional: also works as Claude Code plugin
├── skills/                          ← Optional: portable skills
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

### 3. Task Packs

Collections of markdown task definitions. Lightweight, just prompts + crons.

```
security-audit-pack/
├── .dork/
│   ├── package.json                 ← DorkOS manifest (type: "task-pack")
│   └── tasks/
│       ├── dependency-audit.md      ← YAML frontmatter + prompt body
│       ├── secret-scan.md
│       └── license-check.md
└── README.md
```

**Task file format** (from tasks-system-redesign spec): Markdown with YAML frontmatter — `name`, `description`, `cron` (optional, empty = on-demand), `timezone`, `agent` (capability-based matching), `enabled`, `maxRuntime`, `permissions`, `tags`, `cwd`. Body = the prompt. ID = filename slug.

**Portability:** Tasks reference agent capabilities, not specific agent IDs. Project-scoped tasks run against their own project's agent. Global tasks run against Damon (system agent) or a capable agent.

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

### 5. Skills (Potential Future Concept)

A higher-level "skill" concept that bundles multiple item types — the user-facing packaging unit. A DorkOS Skill could contain any combination of:

- Instruction files (`.claude/skills/`, `.claude/commands/`, `.claude/rules/`)
- Extensions (UI slots, server routes)
- Task definitions (`.dork/tasks/*.md`)
- Adapter requirements (dependency declarations)
- Hooks (`.claude/hooks/`)

**Example:** A "Code Review Skill" bundles the review instructions (SKILL.md), a task that runs reviews on Fridays, an extension showing review status in the dashboard, and a hook that triggers on PR events.

**Note:** This concept needs more exploration. "Skills" is well-understood by users and aligns with the Agent Skills standard. The question is whether DorkOS Skills are just Agent Skills (SKILL.md only) or an expanded concept that bundles other DorkOS-specific items.

---

## Architecture: The Layer Model

```
Layer 0: MCP                          ← DorkOS already supports (external MCP server at /mcp)
Layer 1: Agent Skills / SKILL.md      ← DorkOS already uses (.claude/skills/)
Layer 2: Claude Code Plugin           ← DorkOS agents inherit these automatically
Layer 3: DorkOS Package               ← THE NEW THING — everything above PLUS:
         ├── UI Extensions (8 slots, server routes, settings)
         ├── Task Definitions (.dork/tasks/*.md)
         ├── Adapter Configs (relay bridges)
         └── Agent Templates (full agent scaffolding)
```

**What DorkOS gets for free:**

| Capability                       | How                                                | Cost |
| -------------------------------- | -------------------------------------------------- | ---- |
| skills.sh compatibility          | Already using SKILL.md format                      | Zero |
| Claude Code plugin compatibility | DorkOS agents are Claude Code agents               | Zero |
| MCP tool ecosystem               | Already have MCP server + Claude Code's MCP client | Zero |
| Cross-tool skill portability     | SKILL.md is the standard                           | Zero |

**What DorkOS needs to build:**

| Capability                           | Effort  | Description                                                       |
| ------------------------------------ | ------- | ----------------------------------------------------------------- |
| `.dork/package.json` manifest schema | Medium  | Declares type, extensions, tasks, adapter deps, template metadata |
| `dorkos install` CLI command         | Medium  | Git clone + file placement + extension compilation + task import  |
| DorkOS registry (`marketplace.json`) | Small   | Static JSON in site repo, PRs to add packages                     |
| Marketplace Extension (built-in)     | Medium  | Browse/search UI within DorkOS client                             |
| Web browse experience                | Medium  | `/marketplace` on dorkos.dev                                      |
| Claude Code plugin import            | Small   | Read `.claude-plugin/plugin.json`, extract skills/hooks           |
| skills.sh import                     | Small   | `npx skills add` wrapper or direct git clone                      |
| Dependency resolution                | Medium  | `"requires": ["adapter:slack"]` with install-time checks          |
| Agent-as-installer flow              | Small   | MCP tool that queries registry + calls install                    |
| `AGENTS.md` detection                | Trivial | Add to unified scanner alongside CLAUDE.md                        |

---

## Distribution & Compatibility

### The Superset Approach

A DorkOS package is a superset — it contains standard-compatible layers that degrade gracefully:

```
my-package/
├── .claude-plugin/plugin.json     ← Claude Code sees: skills + hooks + MCP
├── skills/                        ← skills.sh / Codex / Cursor see: SKILL.md files
├── .dork/                         ← DorkOS sees: everything + UI + tasks + adapters
│   ├── package.json
│   ├── extensions/...
│   ├── tasks/...
│   └── adapters/...
└── README.md
```

**Install in Claude Code** → skills + hooks + MCP work (Layer 2)
**Install in DorkOS** → everything works including UI, tasks, adapters (Layer 3)
**Publish skills to skills.sh** → skills work in Codex, Cursor, Copilot, etc. (Layer 1)

### Install Flows

```bash
# Install a DorkOS package (full experience)
dorkos install code-review-suite

# Install a Claude Code plugin (skills + hooks only, no DorkOS UI)
dorkos install --from claude-plugins-official some-plugin

# Install a skills.sh skill
dorkos install --from skills.sh vercel-labs/agent-skills/nextjs

# Install from any git repo
dorkos install github:user/repo
```

### Registry Format

```json
{
  "name": "dorkos-community",
  "packages": [
    {
      "name": "code-review-suite",
      "version": "1.2.0",
      "source": "github:dorkos-community/code-review-suite",
      "type": "package",
      "layers": ["skills", "extension", "tasks"],
      "claude-code-compatible": true,
      "skills-sh-compatible": true,
      "requires": []
    },
    {
      "name": "linear-integration",
      "source": "github:dorkos-community/linear-integration",
      "type": "package",
      "layers": ["skills", "extension", "adapter"],
      "requires": ["adapter:webhook"]
    }
  ]
}
```

---

## Design Decisions (Proposed)

| #   | Decision                      | Choice                                                                      | Rationale                                                                    |
| --- | ----------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Plugin format                 | Extend Claude Code format, don't create a new one                           | Industry convergence. DorkOS adds `.dork/` alongside `.claude-plugin/`       |
| 2   | Skill format                  | Use Agent Skills standard (SKILL.md) as-is                                  | Already using it. Cross-tool portable. 90K+ indexed on skills.sh             |
| 3   | Registry format               | `marketplace.json` in a git repo (same pattern as Claude Code/Codex/Cursor) | Proven pattern. PRs for submissions. Easy to automate                        |
| 4   | Distribution                  | Git-based (repos for templates, sparse clone for packages)                  | Aligns with Claude Code's approach. No custom registry infrastructure needed |
| 5   | In-app browsing               | Built-in Marketplace Extension using extension API                          | Dogfoods the extension system. Can be updated independently                  |
| 6   | Web browsing                  | `/marketplace` on dorkos.dev (marketing site)                               | Discoverable via search engines. SSG from registry JSON                      |
| 7   | Primary install channel       | Agent-driven (agent queries registry, installs based on context)            | Differentiator. "Describe what you need" > "browse and click"                |
| 8   | Secondary install channel     | CLI (`dorkos install`) + Marketplace Extension UI                           | Traditional fallback for direct installs                                     |
| 9   | Trust model                   | Social trust (verified publishers, signed manifests) — no sandboxing        | Matches Claude Code's full-trust model. Developer audience.                  |
| 10  | Template updates              | Existing `.template.json` + marker-based merge system                       | Already built and working. Advisory updates, user controls merges            |
| 11  | Task portability              | Capability-based agent matching, not agent ID references                    | Tasks declare needed capabilities; DorkOS finds capable agents               |
| 12  | Dependencies                  | Declarative `"requires"` in manifest with install-time checks               | Soft enforcement v1 (warn, don't block). Full resolution later               |
| 13  | Adapter/extension unification | Separate systems, unified marketplace                                       | Different lifecycles and APIs. Single storefront, separate installers        |
| 14  | `AGENTS.md` support           | Add as agent detection strategy in unified scanner                          | 20K+ repos. Trivial to implement. Expands discoverability                    |

---

## V1 Scope (MVP)

**Goal:** Create a flywheel — enough packages to be useful, easy enough to contribute that the catalog grows.

### Build

1. **`.dork/package.json` manifest schema** — Zod schema defining package type, contents, dependencies, compatibility
2. **`dorkos install` CLI command** — Git clone, file placement, extension compilation, task import
3. **DorkOS registry** — `marketplace.json` in the `dorkos-community` GitHub org, submissions via PR
4. **Marketplace Extension** (built-in) — `sidebar.tabs` entry with browse/search/install UI
5. **`/marketplace` web page** — Static page on dorkos.dev reading from registry
6. **5-10 seed packages** — Agent templates, extensions, task packs created by the DorkOS team
7. **Agent install tool** — MCP tool for `tasks_install_package` so agents can query and install

### Defer

- Payments / paid packages
- User accounts / reviews / ratings
- Automated security scanning
- Self-serve publishing (v1 is PR-based)
- Visual cron builder for task packs
- Full dependency resolution (v1 is warn-only)
- Package versioning beyond semver in manifest
- Private/enterprise registries

---

## Open Questions

1. **Manifest naming:** `.dork/package.json` vs `.dork/dorkos.json` vs `dork.json` — need to avoid confusion with npm's `package.json`
2. **Skills as a bundling concept:** Should DorkOS "Skills" be an expanded concept (bundles of skills + extensions + tasks) or stay aligned with the Agent Skills standard (SKILL.md only)?
3. **Registry hosting:** Static JSON in git repo (v1) vs API service (future) — when does the static approach stop scaling?
4. **Dual marketplace registration:** Can a DorkOS package automatically register in the Claude Code marketplace too, or are these always separate registrations?
5. **Adapter distribution:** Should adapters use the npm plugin loader (existing) or switch to git-based distribution (marketplace pattern)?

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
- `specs/tasks-system-redesign/` (Spec #211) — File-based task system (in progress)

## Related ADRs

- ADR-0043 — Agent storage (file-first write-through pattern)
- ADR-0199 — Generic register API with SlotContributionMap
- ADR-0200 — App-layer synchronous extension initialization
- ADR-0214 — AES-256-GCM per-extension secret storage
