# Marketplace Packages

A marketplace package is a directory containing a `.dork/manifest.json` that declares its type, version, and dependencies. DorkOS supports four package types:

| Type         | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `plugin`     | General-purpose: extensions, skills, commands, hooks, MCP servers      |
| `agent`      | A complete agent template — scaffolds a new agent workspace on install |
| `skill-pack` | Lightweight: only SKILL.md files (skills, tasks, commands)             |
| `adapter`    | A relay channel adapter (e.g., Discord, Slack)                         |

## Creating a Package

```bash
dorkos package init my-plugin --type plugin
dorkos package validate ./my-plugin
```

The scaffolder writes:

- `.dork/manifest.json` — DorkOS package manifest (all types)
- `.claude-plugin/plugin.json` — Claude Code plugin manifest (plugin/skill-pack/adapter only)
- `README.md`
- Type-specific starter directories (e.g., `skills/`, `hooks/`, `commands/` for plugins)

## Manifest Schema

See `packages/marketplace/src/manifest-schema.ts` for the canonical Zod schema. Key fields:

- `name` — kebab-case, must match directory name
- `version` — semver
- `type` — `plugin | agent | skill-pack | adapter`
- `description` — 1-1024 chars
- `requires` — dependency declarations like `adapter:slack@^1.0.0`
- `layers` — content categories (`skills`, `tasks`, `hooks`, etc.)

## Related

- `packages/marketplace/README.md` — Package API
- `decisions/0220-adopt-skill-md-open-standard.md` — SKILL.md format (+ addendum on optional `kind` field)
- `decisions/0228-marketplace-manifest-filename.md` — Why `.dork/manifest.json`
- `decisions/0230-marketplace-package-type-agent-naming.md` — Why `agent` not `agent-template`

## Install Workflows

Install machinery ships in `marketplace-02-install`. This guide will be expanded when that spec lands.
