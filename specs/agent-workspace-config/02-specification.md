---
slug: agent-workspace-config
id: 260924-212851
created: 2026-09-24
status: specified
linearIssue: DOR-2314
---

# An agent package can't ship its sessions' harness configuration

## Problem

An agent package installs into `agents/<name>/`, and that folder is the agent's working directory (`resolve-session-cwd.ts`, mode `agent-home`). Every coding agent DorkOS runs reads its own configuration from there:

- **Claude Code** (`settingSources: ['local','project','user']`, `launch-resolver.ts`):
  - `.claude/settings.json` and `.claude/settings.local.json`: hooks, `permissions.allow` rules that approve a tool before DorkOS's `canUseTool` is asked, `env`, eight helper commands, sandbox, plugin and MCP switches.
  - A root `.mcp.json`, whose servers an SDK session connects to without asking.
  - Project subagents (`.claude/agents/*.md`), whose `hooks`, `mcpServers` and `permissionMode` take effect, unlike a plugin subagent's.
  - `.claude/skills/` and `.claude/commands/`, whose frontmatter hooks and `allowed-tools` apply.
- **Codex**: `.codex/config.toml` and `.codex/hooks.json`.
- **OpenCode**: `opencode.json`, `opencode.jsonc` and `.opencode/`. The per-directory instance merges project config, and plugins run in-process.
- **Harness Sync** reads `.claude/settings.json` hooks as a source and projects them, ungated, into the hook files of every harness in `.agents/harness.manifest.json`. That manifest is write-if-absent, so a package could choose the harnesses.

The install preview read none of these, except a root `.mcp.json`, which it described as a plugin's program. `userEditable` accepted `.claude/**`.

## Decision

One rule: **a packaged agent carries what the agent IS (instructions, persona, skills), never the configuration of the harness its sessions run under.**

**Refused at validation** (`@dorkos/marketplace` `agent-workspace-config.ts`, code `AGENT_WORKSPACE_CONFIG_FORBIDDEN`). This covers agent packages only, and only the package tree, not an installed one. Names are compared case-folded. The refused paths:

- `.claude/settings.json` and `.claude/settings.local.json`;
- a root `.mcp.json`;
- `.codex/`;
- `opencode.json`, `opencode.jsonc` and `.opencode/`;
- `.agents/harness.manifest.json`;
- `.gemini/settings.json`, so the rule holds for every harness Harness Sync knows, not only the ones DorkOS runs today;
- a `.claude` folder anywhere below the root (Claude Code loads nested skills and settings);
- a `.claude/agents/**/*.md` subagent that sets `hooks`, `mcpServers` or `permissionMode`, whose header is not YAML (a `---json` header keeps the last of a repeated key silently), that repeats a key, or that sits deeper than the walk checks. All fail closed.

Preview, install and update all run the validator, so each refuses before anything lands.

**Disclosed and bound.** For an agent package, `readRunnableDeclarations` also reads `.claude/skills`, `.claude/commands` and `.agents/skills`. The last is projected into `.claude/skills`. Their frontmatter hooks and allowed tools are on the card and in `disclosedEffectsOf`, so the DOR-2195 approval binds them. Links in those folders are skipped: staging strips a package's links, and in an installed agent they are DorkOS's own projections.

**Allowed**, because a person is shown it or it runs nothing:

- `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/rules/`;
- `.claude/output-styles/`;
- a subagent that sets none of the three fields.

**`userEditable`**: `EFFECT_BEARING_PATHS` gains `.claude`, `.agents`, `.codex`, `.opencode`, `opencode.json` and `opencode.jsonc`, for every package type.

**App**: a refused preview renders "DorkOS won't install this package" with the server's reasons. This happens in the install dialog, where Install is disabled, and in the detail sheet. It never shows "No special permissions required".

### Why refuse rather than disclose

Settings files mix dozens of keys that run programs or widen trust, and each harness adds more. An allowlist of the keys DorkOS understands goes stale the day a harness adds one. An approved allow rule keeps approving tools with no DorkOS gate in front of it. ADR 260803-233420 already refuses `.dork/agent.json` `mcpServers` in a packaged agent for the same reason. Hooks, servers and permissions arrive after install, through DorkOS's gated paths. No published package ships any of these files: all 14 local packages in dork-labs/marketplace still validate.

## Non-goals and residuals

- **The app's agent path** (DOR-2325). It creates the agent by cloning `pkg.source` as a template (`agent-package-seed.ts`, then `template-downloader.ts`), and no validation runs there. This change closes the visible part: the arrival card and naming step disable **Create** and show the refusal whenever the server refuses the package's preview (`use-offer-schedules` `refusal`). The clone itself is not bound to what was previewed, and the route is ungated; DOR-2325 routes marketplace agents through the installer and checks raw templates.
- A skill's `` !`cmd` `` injection and ` ```! ` blocks, which run at render time subject to permission rules: DOR-2327.
- A git directory shipped at an agent package's root: DOR-2326.
- Plugin, skill-pack and adapter packages: their folders are never a working directory, and their copies of these files are inert.
