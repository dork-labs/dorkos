---
title: 'Claude Code Plugin System, Marketplace, and Extensibility Surface'
date: 2026-03-29
type: external-best-practices
status: active
tags: [claude-code, plugins, marketplace, hooks, skills, mcp, extensions, extensibility]
searches_performed: 14
sources_count: 18
---

## Research Summary

Claude Code has a fully-featured plugin and marketplace system as of early 2026. The extensibility surface includes: **Skills** (prompt-based slash commands), **Hooks** (lifecycle event handlers), **MCP servers** (external tool integrations), **LSP servers** (code intelligence), and **Agents** (specialized subagents) — all bundled together in a **Plugin** format. Plugins are distributed via **Marketplaces** (hosted `marketplace.json` catalogs on GitHub, npm, or any git host). The official Anthropic marketplace is `claude-plugins-official`, available at `claude.com/plugins`. There is no `claude.json` manifest — the plugin manifest is `.claude-plugin/plugin.json`.

DorkOS already has a parallel extension system in `packages/extension-api/` (`extension.json` manifest, `ExtensionManifestSchema`) that has some overlap but is architecturally distinct from Claude Code's plugin format.

---

## Key Findings

### 1. No "Claude Code Marketplace" By That Name — It Is Called the "Plugin Marketplace"

The official Anthropic marketplace is named **`claude-plugins-official`** and is automatically pre-registered when Claude Code is installed. Users browse it at `claude.com/plugins` or via `/plugin` → Discover tab inside Claude Code. Install syntax: `/plugin install <name>@claude-plugins-official`.

Anthropic also maintains a **demo plugins repository** at `anthropics/claude-code` (the main Claude Code repo itself), which serves as both source and marketplace example.

### 2. The Plugin Format — `.claude-plugin/plugin.json`

The manifest lives at `.claude-plugin/plugin.json` (NOT `claude.json`). It is **optional** — if absent, Claude Code auto-discovers components from default directory locations. The manifest `name` field drives skill namespacing (`/plugin-name:skill-name`).

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "...",
  "author": { "name": "...", "email": "...", "url": "..." },
  "homepage": "https://...",
  "repository": "https://github.com/...",
  "license": "MIT",
  "keywords": ["keyword1"],
  "commands": "./commands/",
  "agents": "./agents/",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json",
  "lspServers": "./.lsp.json",
  "outputStyles": "./output-styles/",
  "userConfig": {
    "api_token": { "description": "API token", "sensitive": true }
  },
  "channels": [
    { "server": "telegram", "userConfig": { ... } }
  ]
}
```

### 3. Canonical Plugin Directory Structure

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json           # Manifest (optional)
├── commands/                 # Legacy markdown command files
├── skills/                   # Agent Skills (preferred)
│   └── my-skill/
│       └── SKILL.md          # Required entrypoint
├── agents/                   # Custom subagent definitions (.md files)
├── hooks/
│   └── hooks.json            # Hook event handlers
├── output-styles/            # Output style definitions
├── .mcp.json                 # MCP server configurations
├── .lsp.json                 # LSP server configurations
├── settings.json             # Default settings (only 'agent' key supported currently)
└── scripts/                  # Helper scripts referenced by hooks/skills
```

**Critical rule**: Only `plugin.json` goes inside `.claude-plugin/`. All other directories (skills/, agents/, hooks/, commands/) live at the plugin root.

### 4. Skills — The Core Extensibility Primitive

Skills are the primary way to extend Claude Code behavior. They follow the [Agent Skills open standard (agentskills.io)](https://agentskills.io), which is cross-tool compatible.

**SKILL.md format:**

```yaml
---
name: my-skill
description: What this skill does and when to use it (250 char limit)
disable-model-invocation: true # Only user can invoke (not auto-triggered)
user-invocable: false # Hidden from / menu (only Claude can invoke)
allowed-tools: Read, Grep, Glob
model: sonnet
effort: medium # low | medium | high | max
context: fork # Run in isolated subagent
agent: Explore # Which subagent type to use with context:fork
paths: '**/*.ts,src/**' # Glob patterns to scope auto-activation
hooks: # Hooks scoped to this skill's lifecycle
argument-hint: '[issue-number]'
shell: bash # or powershell
---
Skill instructions here.
Use $ARGUMENTS for user input, $ARGUMENTS[0] for positional args.
Use ${CLAUDE_SESSION_ID} for current session.
Use ${CLAUDE_SKILL_DIR} for the skill's directory path.
Use !`command` for shell injection (output replaces placeholder pre-send).
```

**Where skills live:**

- `~/.claude/skills/<name>/SKILL.md` — personal, all projects
- `.claude/skills/<name>/SKILL.md` — project scope
- `<plugin>/skills/<name>/SKILL.md` — plugin scope (namespaced as `plugin:skill`)
- `~/.claude/commands/<name>.md` — legacy format, still works
- `.claude/commands/<name>.md` — legacy project format, still works

Skills from commands/ and skills/ create identical slash commands. Skills take precedence on name collision.

**Bundled skills** (ship with every Claude Code install):

- `/batch <instruction>` — parallel codebase-wide changes using git worktrees
- `/claude-api` — load Claude API reference
- `/debug [description]` — enable debug logging
- `/loop [interval] <prompt>` — scheduled prompt repetition
- `/simplify [focus]` — code quality review with parallel agents

### 5. Hooks — Full Lifecycle Event System

Hooks are configured in `settings.json` (at user, project, or local scope) or in a plugin's `hooks/hooks.json`.

**Configuration format:**

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "regex|pattern",
        "hooks": [
          {
            "type": "command|http|prompt|agent",
            "command": "/path/to/script.sh",
            "async": false,
            "timeout": 600,
            "statusMessage": "Running...",
            "if": "optional filter rule"
          }
        ]
      }
    ]
  }
}
```

**All hook events (26 total):**

| Category | Events                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Session  | `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd`                                |
| Tool     | `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`                                                       |
| Agent    | `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`                                              |
| System   | `Notification`, `ConfigChange`, `CwdChanged`, `FileChanged`, `PreCompact`, `PostCompact`, `WorktreeCreate`, `WorktreeRemove` |
| MCP      | `Elicitation`, `ElicitationResult`                                                                                           |

**Hook types:**

- `command` — shell script, receives JSON on stdin, exit 0=success, exit 2=blocking error
- `http` — POST to URL, receives JSON body, 2xx=success
- `prompt` — single-turn LLM evaluation returning yes/no decision
- `agent` — subagent with tool access for complex verification

**Hook input (all hooks receive):**

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "...",
  "agent_id": "...",
  "agent_type": "..."
}
```

**Hook output schema:**

```json
{
  "continue": true,
  "stopReason": "message",
  "suppressOutput": false,
  "systemMessage": "warning to user",
  "decision": "block|allow|deny",
  "reason": "explanation",
  "additionalContext": "context for Claude",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "...",
    "updatedInput": {},
    "updatedPermissions": [],
    "updatedMCPToolOutput": {}
  }
}
```

**Hook settings files (precedence order, high to low):**

1. Managed policy settings (org-wide, cannot be overridden)
2. `~/.claude/settings.json` (user global)
3. `.claude/settings.json` (project, committed to git)
4. `.claude/settings.local.json` (project local, gitignored)
5. Plugin `hooks/hooks.json` (when plugin enabled)
6. Skill frontmatter `hooks:` field (while skill active)

**Environment variables available in hooks:**

- `$CLAUDE_PROJECT_DIR` — project root
- `${CLAUDE_PLUGIN_ROOT}` — plugin installation directory
- `${CLAUDE_PLUGIN_DATA}` — plugin persistent data directory (`~/.claude/plugins/data/<plugin-id>/`)
- `$CLAUDE_CODE_REMOTE` — `"true"` in web environments
- `$CLAUDE_ENV_FILE` — path to persist env vars (SessionStart, CwdChanged, FileChanged only)

### 6. MCP Servers — External Tool Integration

MCP (Model Context Protocol) servers are configured in:

- `~/.claude/settings.json` — user-level MCP servers
- `.claude/settings.json` — project-level MCP servers
- `.mcp.json` in a plugin — plugin-bundled MCP servers

**MCP configuration format:**

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["server.js"],
      "env": { "API_KEY": "..." },
      "cwd": "/path"
    },
    "remote-server": {
      "type": "http",
      "url": "https://api.example.com/mcp"
    }
  }
}
```

**CLI installation:**

```bash
claude mcp add --transport http my-server https://api.example.com/mcp
```

**Anthropic MCP Registry:** There is an API at `api.anthropic.com/mcp-registry/v0/servers` (used internally by the Claude Code docs to populate server listings). As of 2026 there is no public enterprise MCP registry management — this is a known feature request (GitHub issue #7992).

**Official MCP integrations available as plugins** (bundled MCP servers):

- Source control: `github`, `gitlab`
- Project management: `atlassian`, `asana`, `linear`, `notion`
- Design: `figma`
- Infrastructure: `vercel`, `firebase`, `supabase`
- Communication: `slack`
- Monitoring: `sentry`

### 7. Agents (Subagents) — Specialized Execution Environments

Plugin agents live in `agents/` directory as markdown files:

```yaml
---
name: security-reviewer
description: Reviews code for security issues. Claude invokes when reviewing untrusted code.
model: sonnet
effort: medium
maxTurns: 20
disallowedTools: Write, Edit
tools: [Read, Grep, Glob, Bash]
skills: ['security-checklist']
memory: false
background: false
isolation: worktree
---
You are a specialized security code reviewer...
```

**Agent frontmatter fields:** `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation` (only valid value: `"worktree"`).

**Security restriction for plugin agents:** `hooks`, `mcpServers`, and `permissionMode` are NOT supported in plugin-shipped agents.

### 8. Marketplace System — Distribution Format

A marketplace is a git repository containing `.claude-plugin/marketplace.json`. The marketplace name drives install syntax: `plugin-name@marketplace-name`.

**`marketplace.json` format:**

```json
{
  "name": "my-marketplace",
  "owner": { "name": "...", "email": "..." },
  "metadata": {
    "description": "...",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "source": "./plugins/my-plugin",
      "description": "...",
      "version": "1.0.0",
      "author": { "name": "..." },
      "category": "productivity",
      "tags": ["tag1"],
      "homepage": "https://...",
      "repository": "https://...",
      "license": "MIT",
      "strict": true
    }
  ]
}
```

**Plugin source types in marketplace.json:**

```json
// Relative path (same repo)
"source": "./plugins/my-plugin"

// GitHub repository
"source": { "source": "github", "repo": "owner/repo", "ref": "v1.0.0", "sha": "abc123..." }

// Any git URL
"source": { "source": "url", "url": "https://gitlab.com/org/repo.git", "ref": "main" }

// Git subdirectory (sparse clone)
"source": { "source": "git-subdir", "url": "https://github.com/org/monorepo", "path": "tools/plugin" }

// npm package
"source": { "source": "npm", "package": "@org/plugin", "version": "^2.0.0", "registry": "https://..." }
```

**Reserved marketplace names (cannot be used by third parties):**
`claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`, `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`, `knowledge-work-plugins`, `life-sciences`

### 9. Installation and Plugin Management

**CLI commands:**

```bash
# Marketplace management
claude plugin marketplace add owner/repo
claude plugin marketplace add ./local-path
claude plugin marketplace update marketplace-name
claude plugin marketplace remove marketplace-name
claude plugin marketplace list

# Plugin management
claude plugin install plugin-name@marketplace-name --scope user|project|local
claude plugin uninstall plugin-name@marketplace-name --keep-data
claude plugin enable plugin-name@marketplace-name --scope project
claude plugin disable plugin-name@marketplace-name
claude plugin update plugin-name@marketplace-name
claude plugin validate .

# Interactive UI
/plugin              # Opens tabbed UI: Discover | Installed | Marketplaces | Errors
/reload-plugins      # Hot-reload without restart
```

**Installation scopes:**
| Scope | Settings file | Shared? |
|---|---|---|
| `user` (default) | `~/.claude/settings.json` | No |
| `project` | `.claude/settings.json` | Yes (via git) |
| `local` | `.claude/settings.local.json` | No |
| `managed` | Managed settings | Yes (org-wide) |

**Plugin cache location:** `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`

**Persistent data directory:** `~/.claude/plugins/data/<plugin-id>/` (survives plugin updates; auto-deleted on uninstall unless `--keep-data`)

**Container/CI pre-population:** Set `CLAUDE_CODE_PLUGIN_SEED_DIR` to a pre-built plugins directory. Mirrors `~/.claude/plugins/` structure.

**Auto-updates:** Controlled per marketplace. Toggled via UI or by setting `DISABLE_AUTOUPDATER` / `FORCE_AUTOUPDATE_PLUGINS` env vars.

### 10. Enterprise / Managed Settings

Organizations deploy managed settings via `managed-settings.json` (platform-specific path or served via MDM). Key plugin-related fields:

```json
{
  "extraKnownMarketplaces": {
    "company-tools": {
      "source": { "source": "github", "repo": "company/claude-plugins" }
    }
  },
  "enabledPlugins": {
    "formatter@company-tools": true
  },
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "company/approved-plugins" },
    { "source": "hostPattern", "hostPattern": "^github\\.example\\.com$" }
  ]
}
```

`strictKnownMarketplaces: []` = complete lockdown (no user-added marketplaces).

### 11. LSP Servers — Code Intelligence Layer

LSP plugins are a distinct category in the official marketplace. They configure language server connections for live diagnostics and navigation. Format in `.lsp.json`:

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": { ".ts": "typescript", ".tsx": "typescript" },
    "transport": "stdio",
    "startupTimeout": 10000
  }
}
```

**Official LSP plugins (install via `/plugin install <name>@claude-plugins-official`):**
`pyright-lsp`, `typescript-lsp`, `rust-analyzer-lsp`, `gopls-lsp`, `clangd-lsp`, `csharp-lsp`, `jdtls-lsp`, `kotlin-lsp`, `lua-lsp`, `php-lsp`, `swift-lsp`

### 12. The `.claude/` Directory as a Distribution Format

Standalone (non-plugin) configuration lives in `.claude/` and does NOT use namespacing. It is committed to git and shared with the team. This is the simpler distribution method — no `plugin.json` needed.

```
.claude/
├── AGENTS.md                    # Project instructions (loaded every session)
├── settings.json                # Project settings (hooks, MCP, extraKnownMarketplaces, etc.)
├── settings.local.json          # Local overrides (gitignored)
├── commands/                    # Legacy slash commands as .md files
│   └── review-pr.md             # Creates /review-pr
├── skills/                      # Agent Skills
│   └── my-skill/
│       └── SKILL.md
├── agents/                      # Custom subagents
│   └── my-agent.md
├── rules/                       # Path-specific rules (loaded contextually)
│   └── api-patterns.md
└── plans/                       # Implementation plans (convention, not official)
```

The `~/.claude/` global directory has the same structure and applies to all projects.

### 13. Relationship Between Hooks, Commands/Skills, MCP Servers, and Plugins

```
Plugin (distribution unit)
├── Skills           → slash commands; Claude can auto-invoke based on description
├── Commands         → same as Skills but simpler format (no supporting files)
├── Agents           → subagent definitions with custom system prompts & tool restrictions
├── Hooks            → lifecycle event handlers (PreToolUse, PostToolUse, SessionStart, etc.)
├── MCP Servers      → external tool servers conforming to Model Context Protocol
├── LSP Servers      → language server connections for live code intelligence
└── Output Styles    → define how Claude formats responses

All can also be configured standalone in .claude/ without a plugin wrapper.
```

MCP servers are the "external tool" integration layer — they expose tools to Claude from external systems. Skills/Commands are the "workflow" layer — they package prompt instructions as reusable slash commands. Hooks are the "control" layer — they intercept Claude's actions before/after they happen. Agents define custom execution environments. Plugins are the packaging/distribution format for all of the above.

### 14. Community Registries

Beyond the official Anthropic marketplace:

- **`anthropics/claude-code`** — demo marketplace in the main Claude Code repo (add with `/plugin marketplace add anthropics/claude-code`)
- **`anthropics/skills`** — Public repository for Agent Skills
- **GitHub** — numerous community repositories; no single canonical community registry
- **`claudemarketplaces.com`** — third-party directory/aggregator (95+ curated repositories)
- **`buildwithclaude.com`** — third-party marketplace (494+ extensions)
- **`skillsmp.com`** — Agent Skills Marketplace
- **LiteLLM AI Gateway** — acts as enterprise registry for Claude Code plugins
- **npm** — plugins can be published as npm packages and installed via `source: "npm"`

### 15. Submission to Official Marketplace

Submit at:

- Claude.ai: `claude.ai/settings/plugins/submit`
- Console: `platform.claude.com/plugins/submit`

Name must be kebab-case. Names impersonating official marketplaces are blocked.

---

## Detailed Analysis

### The `plugin.json` Manifest vs DorkOS `extension.json`

DorkOS has its own extension system in `packages/extension-api/` with an `extension.json` manifest (`ExtensionManifestSchema`). The structural differences are significant:

| Aspect            | Claude Code `plugin.json`               | DorkOS `extension.json`                        |
| ----------------- | --------------------------------------- | ---------------------------------------------- |
| Manifest location | `.claude-plugin/plugin.json`            | `extension.json` at root                       |
| Distribution      | Via `marketplace.json` + git/npm        | Not yet defined                                |
| Skills/Commands   | `skills/`, `commands/` dirs             | Not in schema                                  |
| MCP servers       | `.mcp.json` field                       | Not in schema                                  |
| LSP servers       | `.lsp.json` field                       | Not in schema                                  |
| Hooks             | `hooks/hooks.json`                      | Not in schema                                  |
| Server code       | Not applicable                          | `serverCapabilities.serverEntry`               |
| Data proxy        | Not applicable                          | `dataProxy` (zero-code API passthrough)        |
| User config       | `userConfig` field (prompted at enable) | `secrets` + `settings` in `serverCapabilities` |
| Permissions       | Implied by tool access                  | `permissions` array (reserved)                 |
| Versioning        | Semver in `version` field               | Semver in `version` field                      |
| Min host version  | Not in Claude Code                      | `minHostVersion`                               |

DorkOS extensions are more server-side focused (server.ts entry point, data proxy) while Claude Code plugins are more prompt/behavior focused (skills, agents, hooks). They serve different needs and the overlap is modest.

### The `settings.json` Configuration Schema (Relevant Fields)

The Claude Code project settings file (`.claude/settings.json`) has these plugin-relevant top-level keys:

```json
{
  "hooks": { ... },
  "mcpServers": { ... },
  "extraKnownMarketplaces": { ... },
  "enabledPlugins": { "plugin@marketplace": true },
  "disableAllHooks": false,
  "permissions": { ... }
}
```

### Hook Precedence and Plugin Scope

Plugin hooks are the lowest priority (below user, project, and local settings hooks) but cannot conflict with managed policy hooks. Plugin hooks use `${CLAUDE_PLUGIN_ROOT}` to reference scripts bundled with the plugin. This means plugin hook scripts travel with the plugin when installed.

### The `agentskills.io` Open Standard

Skills conform to an open standard at `agentskills.io`. Claude Code extends it with `context: fork`, `disable-model-invocation`, `user-invocable`, `paths`, `hooks`, `shell`, and the `${CLAUDE_SKILL_DIR}` variable. The core `name`, `description`, `allowed-tools`, `model` fields are part of the open standard and work across multiple AI tools.

---

## Research Gaps and Limitations

- The exact `settings.json` full schema was in a large document that was truncated — complete schema not fully extracted
- The `agentskills.io` open standard specification was not fetched directly
- The `output-styles/` directory format was referenced but not fully documented
- No pricing information found for plugin distribution
- The internal Anthropic MCP registry API (`api.anthropic.com/mcp-registry/v0/servers`) documentation was referenced in source code but not publicly documented
- "Channels" feature in plugin.json (Telegram/Slack message injection) was only briefly documented

---

## Contradictions and Disputes

- The `api.anthropic.com/mcp-registry` endpoint is used in Claude Code docs frontend code but there is no official public documentation for this API. A GitHub issue (#7992) treats enterprise MCP registry support as a feature request — possibly this is a newer internal API not yet surfaced publicly.
- The demo marketplace documentation references `claude-code-plugins` as the name of the demo marketplace from `anthropics/claude-code` but install syntax uses `anthropics-claude-code` (hyphenated form of the GitHub path) as the marketplace name.

---

## Search Methodology

- Number of searches performed: 14
- Most productive search terms: "Claude Code marketplace registry plugins 2026", "Claude Code hooks format specification", "Claude Code skills format specification", "Claude Code extension format .claude directory"
- Primary information sources: `code.claude.com/docs` (official Claude Code documentation), GitHub repositories, community blog posts
- Fetched pages: `/en/overview`, `/en/hooks`, `/en/skills`, `/en/plugins`, `/en/plugin-marketplaces`, `/en/plugins-reference`, `/en/discover-plugins`

## Sources and Evidence

- [Claude Code Overview](https://code.claude.com/docs/en/overview)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Create Plugins](https://code.claude.com/docs/en/plugins)
- [Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [Discover and Install Plugins](https://code.claude.com/docs/en/discover-plugins)
- [Official Anthropic Plugins GitHub](https://github.com/anthropics/claude-plugins-official)
- [Agent Skills GitHub (anthropics/skills)](https://github.com/anthropics/skills)
- [Claude Code MCP Page](https://code.claude.com/docs/en/mcp)
- [Claude Code Settings](https://code.claude.com/docs/en/settings)
- [Community Marketplace Directory (claudemarketplaces.com)](https://claudemarketplaces.com/)
- [DeepWiki - Claude Code Plugin System](https://deepwiki.com/anthropics/claude-code/4.8-other-marketplace-plugins)
- [Hooks Guide (claudelog.com)](https://claudelog.com/mechanics/hooks/)
- [Skills Deep Dive](https://mikhail.io/2025/10/claude-code-skills/)
- [MCP Registry Issue #7992](https://github.com/anthropics/claude-code/issues/7992)
- [.claude Directory Anatomy](https://blog.dailydoseofds.com/p/anatomy-of-the-claude-folder)
- [Complete .claude Directory Guide](https://computingforgeeks.com/claude-code-dot-claude-directory-guide/)
