---
title: 'AI Coding Agent Plugin Marketplaces & Extensibility Standards — Deep Landscape Research'
date: 2026-03-29
type: external-best-practices
status: active
tags:
  [
    openai-codex,
    cursor,
    windsurf,
    cline,
    continue-dev,
    aider,
    github-copilot,
    mcp,
    agent-skills,
    SKILL.md,
    AGENTS.md,
    plugins,
    marketplace,
    extensibility,
    competitive-analysis,
  ]
searches_performed: 18
sources_count: 42
---

# AI Coding Agent Plugin Marketplaces & Extensibility Standards

**Date**: 2026-03-29
**Research Depth**: Deep Research

---

## Research Summary

As of March 2026, a two-layer extensibility standard has crystallized across the AI coding agent ecosystem. The **lower layer** is MCP (Model Context Protocol), now an open standard under the Linux Foundation's Agentic AI Foundation, which defines how agents connect to external tools and data sources. The **upper layer** is the Agent Skills standard (`SKILL.md`), an open specification originally published by Anthropic but now adopted by every major coding agent (Claude Code, Codex, Cursor, Copilot, Windsurf, Gemini CLI, Cline, and more). Above both layers sits a **plugin/bundle abstraction** — introduced in late 2025 and early 2026 by Codex, Cursor, and GitHub Copilot — which packages skills, MCP servers, rules, and hooks into a single installable unit governed by a `plugin.json` manifest and a `marketplace.json` catalog.

OpenAI Codex CLI has the most mature extensibility stack: TOML configuration, a skills system with `.agents/skills/` discovery across multiple scopes, an `agents/openai.yaml` metadata overlay, and a new plugin format (`.codex-plugin/plugin.json`) with an org-managed marketplace (`marketplace.json`). Cursor launched its marketplace in February 2026 with a nearly identical plugin format (`.cursor-plugin/plugin.json`) and five primitives: skills, rules, agents, commands, hooks, and MCP servers. AGENTS.md — donated to the Linux Foundation in December 2025 — is becoming the universal repository context file, analogous to README.md but for AI agents.

---

## Key Findings

### 1. The SKILL.md Standard Is Now Universal

The Agent Skills specification, maintained at agentskills.io and governed by the Agentic AI Foundation (Linux Foundation), defines a skill as a directory containing a `SKILL.md` file with YAML frontmatter (`name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools`) plus optional `scripts/`, `references/`, and `assets/` subdirectories.

Every major agent adopted this standard by early 2026: Claude Code, Codex CLI, Cursor, GitHub Copilot (VS Code and CLI), Windsurf, Gemini CLI, Cline, OpenCode, and Warp. A single SKILL.md is portable across all of them.

Discovery paths that are cross-tool compatible:

- `.agents/skills/` (project-level, Codex/Cursor/Copilot primary)
- `~/.agents/skills/` (user-level, Codex/Cursor/Copilot primary)
- `.claude/skills/` (project-level, Claude Code primary)
- `~/.claude/skills/` (user-level, Claude Code primary)

Windsurf reads from `.windsurf/skills/` (primary) and also reads `.agents/skills/` and `.claude/skills/` for cross-tool compatibility.

### 2. OpenAI Codex Has the Most Mature Plugin Ecosystem

Codex's extensibility stack as of March 2026:

- **Config format**: `~/.codex/config.toml` (global) and `.codex/config.toml` (project). TOML format with profiles, MCP server definitions, feature flags, sandbox modes, and skill enable/disable.
- **Skills**: `~/.agents/skills/` and `.agents/skills/` (multiple scopes; see full table below). SKILL.md format plus optional `agents/openai.yaml` for display metadata and invocation policy.
- **Plugin format**: `.codex-plugin/plugin.json` manifest bundling skills, MCP server configs, and app integrations.
- **Marketplace**: `$REPO_ROOT/.agents/plugins/marketplace.json` or `~/.agents/plugins/marketplace.json`. Each entry carries `name`, `source`, `policy.installation` (INSTALLED_BY_DEFAULT / AVAILABLE / NOT_AVAILABLE), and `policy.authentication`.
- **Official Plugin Directory**: Curated directory live; self-serve publishing coming soon.
- **Built-in scaffolding**: The `$plugin-creator` skill scaffolds plugin manifests. The `$skill-installer` skill installs skills by name, folder reference, or GitHub URL.
- **Custom prompts** (`~/.codex/prompts/*.md`): Soft-deprecated in favor of skills but still operational. Markdown + YAML frontmatter with `description` and `argument-hint` fields.
- **AGENTS.md**: Read from `~/.codex/AGENTS.md` (global) and project levels; project files walk from git root to CWD.

### 3. Cursor Launched a Full Plugin Marketplace in February 2026

Cursor's plugin format (`.cursor-plugin/plugin.json`) is structurally nearly identical to Codex's. Five extensibility primitives:

1. **Skills** (`skills/<name>/SKILL.md`) — capabilities the agent can auto-invoke
2. **Rules** (`rules/*.mdc`) — persistent behavioral guidance applied by glob or always
3. **Agents** (`agents/*.md`) — specialized sub-agents with custom instructions
4. **Commands** (`commands/*.md`) — explicit slash-invocable workflows
5. **Hooks** (`hooks/hooks.json`) — event-driven scripts (19 hook events)
6. **MCP Servers** (`mcp.json`) — external tool connections

Plugins are installable from cursor.com/marketplace. Organizations on Teams/Enterprise plans can define private marketplaces via a `marketplace.json` at the repository root. Initial partners include Amplitude, AWS, Figma, Linear, Stripe, Cloudflare, Vercel, Databricks, Snowflake, Atlassian, Datadog, and GitLab.

### 4. GitHub Copilot Uses the Same Plugin Pattern with `.github/plugin/marketplace.json`

GitHub Copilot's plugin registry lives at `.github/plugin/marketplace.json`. The schema is structurally similar to Codex and Cursor: a root object with `name`, `metadata.version`, `owner`, and a `plugins` array. Each plugin entry has `name`, `source` (relative path), `description`, `version`, and a `skills` array referencing SKILL.md files. MCP server configs live at `plugins/{name}/.mcp.json` using the standard `mcpServers` key. Hooks and extensibility tools are planned for future implementation.

VS Code's native agent skills contribute additional frontmatter fields not in the base spec: `argument-hint`, `user-invocable`, `disable-model-invocation`.

### 5. AGENTS.md Is the Cross-Tool Context File Standard

AGENTS.md — now stewarded by the Agentic AI Foundation under the Linux Foundation, co-founded by OpenAI, Anthropic, Cursor, Google, and others — serves as the equivalent of AGENTS.md but portable across 25+ tools. It is plain Markdown with no required fields. Agents discover it via directory tree traversal (closest file wins). The file is already present in 20,000+ GitHub repositories.

Tool-specific equivalents that still exist alongside AGENTS.md:

- `AGENTS.md` (Claude Code)
- `~/.codex/AGENTS.override.md` (Codex, project-level override mechanism)
- `.cursorrules` (Cursor, legacy; being migrated to AGENTS.md)

### 6. MCP Is Now the Universal Tool Integration Layer

MCP has 97 million monthly SDK downloads (Python + TypeScript combined) as of early 2026 and is natively supported by every major AI provider. The central MCP Registry at registry.modelcontextprotocol.io has ~2,000 entries (407% growth since September 2025).

Every coding agent's plugin format embeds MCP server configuration as a first-class component:

- Codex: `mcp_servers.<id>` in `config.toml`
- Cursor: `mcp.json` in plugin directory
- Copilot: `.mcp.json` in plugin directory
- Windsurf: MCP integrated via settings

The MCP Registry implements a sub-registry model: organizations can build private registries on top of the central API. Cline has its own MCP Marketplace (cline/mcp-marketplace on GitHub) with one-click installation.

### 7. Windsurf Uses the Standard SKILL.md Format Plus Its Own Skills Discovery

Windsurf added `.windsurf/skills/` directory support in March 2026, reading the standard SKILL.md format. The `name` and `description` frontmatter fields are required (same spec). Windsurf also reads `.agents/skills/` and `.claude/skills/` for cross-agent compatibility.

For workflows (explicit slash-commands): `.windsurf/workflows/*.md` (freeform Markdown, no frontmatter schema). For rules (always-on instructions): `.windsurf/rules/` (glob-matched). For skills (autonomous): `.windsurf/skills/` (SKILL.md standard). Windsurf does NOT have its own plugin marketplace as of March 2026 — it relies on the SKILL.md standard and VS Code extension marketplace (via Open VSX Registry).

### 8. Continue.dev Has the `hub.continue.dev` Block Registry

Continue's hub (hub.continue.dev) is a registry of "blocks" — modular building blocks for custom AI assistants covering models, MCP servers, rules, and prompt files. Continue 1.0 introduced the ability to create multiple named assistants from hub blocks. Publicly shareable agent links are available. This is the most sophisticated model-as-a-block marketplace but is Continue-specific (not cross-tool portable).

### 9. The Landscape of Cross-Tool Standards

Three open standards now govern the space:

| Standard                | Scope                          | Governed By                                                  | Adoption                          |
| ----------------------- | ------------------------------ | ------------------------------------------------------------ | --------------------------------- |
| MCP                     | Tool/data integration protocol | Anthropic → Linux Foundation AAIF                            | 25+ agents, 97M monthly downloads |
| Agent Skills (SKILL.md) | Skill packaging format         | Anthropic → Linux Foundation AAIF                            | 25+ agents, universal             |
| AGENTS.md               | Repository context file        | Anthropic + OpenAI + Google + Cursor → Linux Foundation AAIF | 25+ agents, 20K+ repos            |

All three were donated to the Linux Foundation in December 2025, signaling that the industry converged on open governance as the path to universal adoption.

---

## Detailed Analysis

### OpenAI Codex CLI — Full Extensibility Stack

**Configuration Format: TOML**

The primary config file is `~/.codex/config.toml`. Project-level `.codex/config.toml` files are loaded only for trusted projects.

Key sections:

```toml
# Model selection
model = "gpt-5-codex"
model_reasoning_effort = "high"  # minimal|low|medium|high|xhigh

# Sandbox
sandbox_mode = "workspace-write"  # read-only|workspace-write|danger-full-access
approval_policy = "untrusted"     # untrusted|on-request|never or granular

# Feature flags
[features]
unified_exec = true
multi_agent = true
web_search = true

# MCP servers
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_PERSONAL_ACCESS_TOKEN = "${GITHUB_TOKEN}" }
enabled_tools = ["get_file_contents", "create_or_update_file"]

# Skills configuration
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false

# Plugin toggle
[plugins."gmail@openai-curated"]
enabled = false

# Profiles
[profiles.security]
model = "gpt-5-codex"
sandbox_mode = "read-only"
```

**Skills Discovery Scope Ladder (highest to lowest precedence):**

| Scope         | Path                        | Use case                  |
| ------------- | --------------------------- | ------------------------- |
| REPO (CWD)    | `.agents/skills`            | Folder-specific workflows |
| REPO (parent) | `../.agents/skills`         | Nested repo workflows     |
| REPO (root)   | `$REPO_ROOT/.agents/skills` | Org-wide skills           |
| USER          | `$HOME/.agents/skills`      | Personal cross-project    |
| ADMIN         | `/etc/codex/skills`         | System defaults           |
| SYSTEM        | Bundled with Codex          | Built-in skills           |

Duplicate names across scopes: both appear (no merge/override). Symlinked directories are followed.

**Plugin Format (`.codex-plugin/plugin.json`):**

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "Brief overview",
  "author": { "name": "Author Name", "email": "author@example.com" },
  "homepage": "https://example.com",
  "repository": "https://github.com/example/repo",
  "license": "MIT",
  "keywords": ["productivity"],
  "skills": "skills/",
  "mcpServers": ".mcp.json",
  "apps": ".app.json",
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "A brief tagline",
    "longDescription": "Detailed description...",
    "developerName": "Example Corp",
    "category": "Productivity",
    "capabilities": ["file-access", "web-search"],
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": ["Example prompt 1", "Example prompt 2"],
    "brandColor": "#FF6B35",
    "logo": "assets/logo.png"
  }
}
```

**Marketplace Format (`~/.agents/plugins/marketplace.json` or `$REPO_ROOT/.agents/plugins/marketplace.json`):**

```json
{
  "name": "my-marketplace",
  "interface": { "displayName": "My Plugin Collection" },
  "plugins": [
    {
      "name": "my-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/my-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Policy values: `INSTALLED_BY_DEFAULT`, `AVAILABLE`, `NOT_AVAILABLE`.

Installed plugins cache to: `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`

**`agents/openai.yaml` — Codex-specific skill metadata overlay:**

```yaml
interface:
  display_name: 'User-Facing Name'
  short_description: 'UI description'
  icon_small: 'assets/icon-small.png'
  icon_large: 'assets/icon-large.png'
  brand_color: '#FF6B35'
  default_prompt: 'Surrounding prompt context'

policy:
  allow_implicit_invocation: true

dependencies:
  tools:
    - type: 'mcp'
      value: 'serverName'
```

---

### Cursor Plugin Format — Full Specification

**Plugin Directory Structure:**

```
my-plugin/
├── .cursor-plugin/plugin.json   # Required manifest
├── skills/
│   └── skill-name/
│       └── SKILL.md
├── rules/
│   └── my-rule.mdc
├── agents/
│   └── my-agent.md
├── commands/
│   └── my-command.md
├── hooks/
│   └── hooks.json
├── mcp.json
├── assets/
├── scripts/
└── README.md
```

**`plugin.json` Schema:**

```json
{
  "name": "my-plugin",
  "description": "Plugin purpose",
  "version": "1.0.0",
  "author": { "name": "Author Name", "email": "author@example.com" },
  "homepage": "https://example.com",
  "repository": "https://github.com/example/plugin",
  "license": "MIT",
  "keywords": ["tag1", "tag2"],
  "logo": "assets/logo.png",
  "rules": "rules/",
  "agents": "agents/",
  "skills": "skills/",
  "commands": "commands/",
  "hooks": "hooks/hooks.json",
  "mcpServers": "mcp.json"
}
```

**Rules format (`.mdc` frontmatter):**

```yaml
---
description: Brief rule explanation
alwaysApply: true
globs: '**/*.ts'
---
```

**Hooks format (`hooks/hooks.json`):**

```json
{
  "hooks": {
    "sessionStart": [{ "command": "./scripts/setup.sh" }],
    "beforeShellExecution": [{ "command": "./scripts/validate.sh", "matcher": "rm|curl" }],
    "afterFileEdit": [{ "command": "./scripts/format.sh" }]
  }
}
```

Available hook events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`, `beforeTabFileRead`, `afterTabFileEdit`.

**`marketplace.json` Schema (multi-plugin repos):**

```json
{
  "name": "marketplace-id",
  "owner": { "name": "Organization", "email": "contact@org.com" },
  "metadata": { "description": "Collection description" },
  "plugins": [
    {
      "name": "plugin-id",
      "source": "plugin-directory",
      "description": "Plugin description",
      "version": "1.0.0",
      "author": { "name": "Author" },
      "license": "MIT",
      "keywords": ["tag"],
      "logo": "plugins/plugin-id/assets/logo.png",
      "category": "Developer Tools",
      "tags": ["productivity", "git"]
    }
  ]
}
```

Maximum 500 plugins per marketplace entry.

---

### GitHub Copilot Plugin Format

**`.github/plugin/marketplace.json`:**

```json
{
  "name": "copilot-plugins",
  "metadata": {
    "description": "GitHub Copilot plugins",
    "version": "1.0.0"
  },
  "owner": {
    "name": "GitHub",
    "email": "copilot@github.com"
  },
  "plugins": [
    {
      "name": "plugin-name",
      "source": "plugins/plugin-name",
      "description": "Human-readable purpose",
      "version": "1.0.0",
      "skills": ["./skills/skill-name"]
    }
  ]
}
```

MCP server config lives at `plugins/{name}/.mcp.json` using the standard `mcpServers` key. VS Code contributes skills via extension `package.json`:

```json
{
  "contributes": {
    "chatSkills": [{ "path": "./skills/my-skill/SKILL.md" }]
  }
}
```

VS Code adds three frontmatter fields not in the base agentskills.io spec:

- `argument-hint`: Chat input hint text
- `user-invocable`: Whether to show as slash command (default true)
- `disable-model-invocation`: Prevent auto-loading (default false)

---

### Agent Skills Specification (agentskills.io) — Complete Reference

**Directory structure:**

```
skill-name/           # Must match 'name' frontmatter field
├── SKILL.md          # Required
├── scripts/          # Executable code (Python, Bash, JS)
├── references/       # Reference docs loaded on-demand
│   ├── REFERENCE.md
│   └── FORMS.md
└── assets/           # Templates, images, data files
```

**SKILL.md frontmatter fields:**

| Field           | Required | Constraints                                                                                                       |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | 1–64 chars, lowercase letters/numbers/hyphens, no leading/trailing/consecutive hyphens, must match directory name |
| `description`   | Yes      | 1–1024 chars, describes what + when to use, include specific task keywords                                        |
| `license`       | No       | License name or bundled license file reference                                                                    |
| `compatibility` | No       | 1–500 chars, environment requirements                                                                             |
| `metadata`      | No       | Arbitrary `string → string` map for tool-specific extensions                                                      |
| `allowed-tools` | No       | Space-delimited pre-approved tools (experimental)                                                                 |

**Progressive disclosure model:**

1. Startup: `name` + `description` (~100 tokens per skill) loaded for all skills
2. Activation: Full SKILL.md body loaded when agent selects the skill
3. On-demand: Files in `scripts/`, `references/`, `assets/` loaded only when referenced

**Recommended SKILL.md body size:** Under 500 lines / under 5000 tokens. Move detailed references to `references/` directory.

**Validation:** `skills-ref validate ./my-skill` (github.com/agentskills/agentskills)

---

### AGENTS.md Standard — Cross-Tool Context File

**Discovery protocol (directory tree traversal):**

- Agents walk from the file being edited up to the repo root
- Closest AGENTS.md takes precedence (leaf wins)
- Files concatenate root-to-leaf for agents that merge (e.g., Codex)
- Empty files are skipped

**Codex-specific AGENTS.md behavior:**

1. `~/.codex/AGENTS.override.md` (global, highest priority)
2. `~/.codex/AGENTS.md` (global)
3. Walk from git root to CWD, loading `AGENTS.override.md` then `AGENTS.md` at each level
4. Max bytes: `project_doc_max_bytes` (32 KiB default)
5. Fallback filenames configurable via `project_doc_fallback_filenames`

**Format:** Plain Markdown. No required schema. Common sections:

- Project overview and build commands
- Code style guidelines
- Testing workflow
- Security considerations
- PR/commit guidelines

**Governance:** Donated to Linux Foundation AAIF (December 2025) by OpenAI and Anthropic. Now supported by 25+ tools: Codex, Claude Code, Cursor, Copilot, Jules (Google), Factory, Aider, goose, OpenCode, Zed, Warp, Devin, Gemini CLI, Windsurf, and more.

---

### Cline MCP Marketplace

Cline's MCP Marketplace (cline.bot/mcp-marketplace) is a curated registry of MCP servers with one-click installation inside the Cline VS Code extension. The official submission repository is at github.com/cline/mcp-marketplace.

**Submission format:** GitHub issue template (not a schema file). Submitters provide:

- GitHub repository URL
- 400×400 PNG logo
- Reason for addition

**Review criteria:**

- Community adoption (GitHub engagement)
- Developer credibility
- Project maturity (code quality, docs, maintenance)
- Security (enhanced scrutiny for financial/crypto)

**Installation metadata:** Servers can include an `llms-install.md` file for automated setup guidance beyond the README.

Cline's marketplace is MCP-specific — it catalogs MCP servers, not agent skills bundles.

---

### Continue.dev Hub

hub.continue.dev (redirects to continue.dev) is a registry of modular "blocks" for building custom AI assistants. Categories: models, MCP servers, rules, slash commands (prompt files).

Continue 1.0 features:

- Multiple named assistant configurations from hub blocks
- Publicly shareable assistant links
- Hub-sourced fast apply models

This is the most sophisticated model-as-config marketplace but is Continue-specific and not cross-tool.

---

### Windsurf Extensibility (as of March 2026)

Windsurf uses three configuration layers in `.windsurf/`:

| Type      | Path                               | Invocation         | Auto-invoke           |
| --------- | ---------------------------------- | ------------------ | --------------------- |
| Workflows | `.windsurf/workflows/*.md`         | Manual `/name`     | Never                 |
| Rules     | `.windsurf/rules/`                 | Glob-matched       | Automatic             |
| Skills    | `.windsurf/skills/<name>/SKILL.md` | `@mention` or auto | Yes (Cascade decides) |

Cross-tool compatibility: Windsurf also reads `.agents/skills/`, `~/.agents/skills/`, `.claude/skills/`, `~/.claude/skills/`.

Global skills: `~/.codeium/windsurf/skills/<name>/`

Enterprise skills:

- macOS: `/Library/Application Support/Windsurf/skills/`
- Linux: `/etc/windsurf/skills/`
- Windows: `C:\ProgramData\Windsurf\skills\`

**No Windsurf-specific plugin marketplace** as of March 2026. IDE extensions distributed via Open VSX Registry (VS Code fork).

---

### MCP as the Universal Tool Layer — Current Status

| Metric                                            | Value                                        |
| ------------------------------------------------- | -------------------------------------------- |
| Monthly SDK downloads (Python + TypeScript)       | 97 million                                   |
| MCP Registry entries                              | ~2,000                                       |
| Smithery (public registry) entries                | 2,500+                                       |
| Monthly total skills/MCP servers (all registries) | 351,000+                                     |
| Native adoption                                   | Anthropic, OpenAI, Google, Microsoft, Amazon |
| Linux Foundation governance                       | December 2025                                |

**2026 MCP Roadmap priorities:**

1. Transport scalability (horizontal scaling, `.well-known` discovery metadata)
2. Agent communication (Tasks/SEP-1686, retry semantics, expiry policies)
3. Governance maturation (contributor ladder, Working Group autonomy)
4. Enterprise readiness (audit trails, SSO, gateway behavior, config portability)

---

## Cross-Tool Format Comparison Table

| Dimension                | Codex CLI                            | Cursor                                | GitHub Copilot                        | Windsurf                                | Claude Code               | Continue.dev                        |
| ------------------------ | ------------------------------------ | ------------------------------------- | ------------------------------------- | --------------------------------------- | ------------------------- | ----------------------------------- |
| **Config file**          | `~/.codex/config.toml`               | `.cursor/settings.json`               | N/A                                   | Settings UI                             | `AGENTS.md`               | `~/.continue/config.yaml`           |
| **Config format**        | TOML                                 | JSON                                  | N/A                                   | GUI                                     | Markdown                  | YAML                                |
| **Plugin manifest**      | `.codex-plugin/plugin.json`          | `.cursor-plugin/plugin.json`          | `.github/plugin/marketplace.json`     | None                                    | None                      | None                                |
| **Marketplace format**   | `~/.agents/plugins/marketplace.json` | `.cursor-plugin/marketplace.json`     | `.github/plugin/marketplace.json`     | None                                    | None                      | hub.continue.dev                    |
| **Skills format**        | SKILL.md (agentskills.io)            | SKILL.md (agentskills.io)             | SKILL.md (agentskills.io)             | SKILL.md (agentskills.io)               | SKILL.md (agentskills.io) | Prompt files (`.continue/prompts/`) |
| **Skills discovery**     | `.agents/skills/`                    | `.cursor/skills/` + `.agents/skills/` | `.github/skills/` + `.agents/skills/` | `.windsurf/skills/` + `.agents/skills/` | `.claude/skills/`         | `.continue/prompts/`                |
| **Rules/context**        | AGENTS.md                            | `.cursor/rules/*.mdc`                 | AGENTS.md                             | `.windsurf/rules/`                      | AGENTS.md                 | Rules blocks                        |
| **MCP integration**      | `config.toml` + `mcp.json` in plugin | `mcp.json` in plugin                  | `.mcp.json` in plugin                 | Settings                                | Via MCP settings          | Hub MCP blocks                      |
| **Hooks system**         | No                                   | Yes (19 events)                       | No (planned)                          | No                                      | No                        | No                                  |
| **Official marketplace** | Yes (curated + coming self-serve)    | Yes (cursor.com/marketplace)          | Yes (github.com/marketplace)          | No                                      | No                        | hub.continue.dev                    |
| **Private marketplaces** | Yes (org JSON file)                  | Yes (Teams/Enterprise)                | No                                    | No                                      | No                        | No                                  |

---

## Plugin Format Structural Comparison

| Field                 | Codex `.codex-plugin/plugin.json`                                          | Cursor `.cursor-plugin/plugin.json` | Copilot `.github/plugin/marketplace.json` |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| `name`                | Required, kebab-case                                                       | Required, kebab-case                | Required                                  |
| `version`             | Required, semver                                                           | Optional, semver                    | Required, semver                          |
| `description`         | Required                                                                   | Optional                            | Required                                  |
| `author`              | Optional object (name, email, url)                                         | Optional object (name, email)       | N/A                                       |
| `skills`              | Optional path                                                              | Optional path/array                 | Required paths array                      |
| `mcpServers`          | Optional (`mcp.json`)                                                      | Optional (`mcp.json`)               | Optional (`.mcp.json`)                    |
| `hooks`               | No                                                                         | Yes (`hooks/hooks.json`)            | Planned                                   |
| `rules`               | No                                                                         | Yes (`rules/`)                      | No                                        |
| `agents`              | No                                                                         | Yes (`agents/`)                     | No                                        |
| `commands`            | No                                                                         | Yes (`commands/`)                   | No                                        |
| `apps`                | Yes (`.app.json`)                                                          | No                                  | No                                        |
| `interface` object    | Rich (displayName, category, logo, screenshots, brandColor, defaultPrompt) | Minimal                             | Minimal                                   |
| `policy`              | Yes (installation, authentication)                                         | No                                  | No                                        |
| Install policy values | INSTALLED_BY_DEFAULT, AVAILABLE, NOT_AVAILABLE                             | N/A                                 | N/A                                       |

---

## What DorkOS Is Missing and Opportunities

### Current DorkOS position

DorkOS already has:

- The correct SKILL.md format for skills (`.claude/skills/`)
- A `CommandRegistryService` scanning custom commands
- MCP integration as a first-class consumer

### Missing / Opportunity Areas

1. **Plugin format**: DorkOS has no `.dork-plugin/plugin.json` manifest format. As Cursor and Codex have shown, this is the distribution unit above SKILL.md — it bundles skills + MCP servers + rules into a single installable package.

2. **Marketplace JSON**: No `marketplace.json` catalog format for plugin distribution. Codex uses `~/.agents/plugins/marketplace.json`; Cursor uses `.cursor-plugin/marketplace.json`. DorkOS could define `~/.dork/plugins/marketplace.json` or `.dorkos/plugins/marketplace.json`.

3. **Installation policy**: The `INSTALLED_BY_DEFAULT / AVAILABLE / NOT_AVAILABLE` policy model from Codex is elegant for enterprise/team use cases — it gives org admins a governance lever.

4. **Hooks system**: Cursor is the only tool with a rich hooks system (19 event types). `sessionStart`, `beforeShellExecution`, `afterFileEdit` hooks are particularly powerful for DorkOS's relay/activity tracking use case.

5. **`.agents/` compatibility**: By adding `.agents/skills/` as an additional discovery path alongside `.claude/skills/`, DorkOS agents can use the cross-tool standard directory without any format changes.

6. **AGENTS.md reading**: DorkOS should read AGENTS.md from project directories in addition to AGENTS.md. Since AGENTS.md is now the industry-standard cross-tool context file (donated to Linux Foundation), supporting it makes DorkOS agents work in repos that use the universal standard.

7. **`agents/openai.yaml`-equivalent**: Codex's per-skill metadata overlay (`agents/openai.yaml`) allows skills to declare tool dependencies, display metadata, and invocation policy without modifying the base SKILL.md. A DorkOS-specific overlay (e.g., `agents/dorkos.yaml`) could declare relay subjects, mesh namespaces, and schedule templates.

8. **Self-serve plugin publishing**: Neither Codex nor Cursor has shipped self-serve publishing yet (coming soon for both). DorkOS has a first-mover opportunity to ship a community registry first.

---

## Sources & Evidence

- [OpenAI Adds Plugin System to Codex — InfoWorld](https://www.infoworld.com/article/4151214/openai-adds-plugin-system-to-codex-to-help-enterprises-govern-ai-coding-agents.html)
- [OpenAI's Codex Gets Plugins — The New Stack](https://thenewstack.io/openais-codex-gets-plugins/)
- [Codex Plugins Documentation — OpenAI Developers](https://developers.openai.com/codex/plugins)
- [Build Plugins — Codex Docs](https://developers.openai.com/codex/plugins/build)
- [Agent Skills — Codex Docs](https://developers.openai.com/codex/skills)
- [Configuration Reference — Codex Docs](https://developers.openai.com/codex/config-reference)
- [Advanced Configuration — Codex Docs](https://developers.openai.com/codex/config-advanced)
- [MCP Integration — Codex Docs](https://developers.openai.com/codex/mcp)
- [Custom Instructions with AGENTS.md — Codex Docs](https://developers.openai.com/codex/guides/agents-md)
- [Sample Configuration — Codex Docs](https://developers.openai.com/codex/config-sample)
- [OpenAI/skills GitHub Repository — Skills Catalog](https://github.com/openai/skills)
- [Agent Skills Specification — agentskills.io](https://agentskills.io/specification)
- [AGENTS.md — Open Standard Site](https://agents.md/)
- [AGENTS.md on InfoQ](https://www.infoq.com/news/2025/08/agents-md/)
- [Cursor Marketplace Launch Blog Post](https://cursor.com/blog/marketplace)
- [Cursor New Plugins Blog Post](https://cursor.com/blog/new-plugins)
- [Cursor Plugins Reference Docs](https://cursor.com/docs/reference/plugins)
- [cursor/plugins GitHub Repository](https://github.com/cursor/plugins)
- [cursor/plugin-template GitHub Repository](https://github.com/cursor/plugin-template)
- [Windsurf Cascade Skills Documentation](https://docs.windsurf.com/windsurf/cascade/skills)
- [Cline MCP Marketplace Documentation](https://docs.cline.bot/mcp/mcp-marketplace)
- [cline/mcp-marketplace GitHub Repository](https://github.com/cline/mcp-marketplace)
- [Continue.dev Hub](https://continue.dev/)
- [MCP Registry Announcement — MCP Blog](https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/)
- [2026 MCP Roadmap — MCP Blog](http://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [GitHub Copilot Plugins Marketplace System — DeepWiki](https://deepwiki.com/github/copilot-plugins/2.1-marketplace-system)
- [VS Code Agent Skills Documentation](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [Porting Skills to OpenAI Codex — fsck.com](https://blog.fsck.com/2025/10/27/skills-for-openai-codex/)
- [Slash Command Storage Formats — DorkOS Research (20260315)](research/20260315_slash_command_storage_formats_competitive.md)
- [Phase 4 Agent-Built Extensions — DorkOS Research (20260326)](research/20260326_agent_built_extensions_phase4.md)

---

## Research Gaps & Limitations

- **Windsurf plugin format**: Windsurf has no announced plugin marketplace or `plugin.json` format as of March 2026. It relies on the SKILL.md standard and the Open VSX extension marketplace for VS Code-level extensions. This may change following the Cognition AI acquisition (December 2025).
- **Codex self-serve publishing**: OpenAI's official plugin directory exists but self-serve publishing was "coming soon" as of March 2026. The exact submission format and approval process are not yet public.
- **Continue.dev hub block schema**: The exact YAML/JSON schema for hub blocks was not obtained. The hub's block format is Continue-specific and does not appear to be documented as an open spec.
- **Aider**: Aider's core tool still has no plugin or custom command system as of March 2026. AiderDesk (a third-party GUI wrapper) has an extension system with hooks and React UI components, but this is not the canonical Aider tool.
- **Codex `agents/openai.yaml` full schema**: The exact YAML schema for all fields in this file was not exhaustively confirmed — the fields shown are from documentation examples, not a formal schema definition.
- **Cline skills support**: Cline's MCP Marketplace is well-documented, but whether Cline reads SKILL.md files from `.agents/skills/` was not confirmed.

---

## Contradictions & Disputes

- **AGENTS.md vs AGENTS.md precedence**: Some sources indicate that when both `AGENTS.md` and `AGENTS.md` are present in a Claude Code project, `AGENTS.md` takes precedence. Other sources suggest they are merged. The canonical behavior may depend on Claude Code version.
- **Codex prompts deprecation**: OpenAI documentation marks `~/.codex/prompts/*.md` (custom prompts) as "deprecated in favor of skills" but the feature remains fully operational and documented. This is a soft deprecation with no removal timeline.
- **Windsurf acquisition impact**: Windsurf was acquired by Cognition AI in December 2025. The impact on the plugin/extension roadmap is not yet clear from available documentation.

---

## Search Methodology

- Searches performed: 18 WebSearch + 12 WebFetch calls
- Most productive searches: "OpenAI Codex plugin marketplace JSON", "Cursor plugin format plugin.json specification 2026", "agentskills.io specification", "AGENTS.md specification standard"
- Prior research consulted: `20260315_slash_command_storage_formats_competitive.md` (covered slash command formats thoroughly; avoided re-searching covered ground), `20260326_agent_built_extensions_phase4.md` (covered DorkOS extension architecture)
- Primary sources: OpenAI Codex developer docs, cursor.com/docs, agentskills.io, agents.md, VS Code docs, DeepWiki analysis
