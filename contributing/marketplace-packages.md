# Marketplace Packages

A marketplace package is a directory containing a `.dork/manifest.json` that declares its type, version, and dependencies. DorkOS supports five package types:

| Type         | Purpose                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| `plugin`     | General-purpose: extensions, skills, commands, hooks, MCP servers                                   |
| `agent`      | A complete agent template — scaffolds a new agent workspace on install                              |
| `skill-pack` | Lightweight: only SKILL.md files (skills, tasks, commands)                                          |
| `adapter`    | A relay channel adapter (e.g., Discord, Slack)                                                      |
| `shape`      | A complete cockpit setup — extensions, layout, a suggested agent, and schedules; install/apply/fork |

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

## Skill Directory Layout

Every skill is a directory containing a `SKILL.md` (the agentskills.io format — see ADR-0220) plus optional standard subdirectories (`SKILL_SUBDIRS` in `packages/skills/src/constants.ts`):

| Subdirectory  | Contents                                                         |
| ------------- | ---------------------------------------------------------------- |
| `scripts/`    | Executable helpers the skill body references                     |
| `references/` | Supplementary reference documents                                |
| `assets/`     | Static files (images, data)                                      |
| `ui/`         | Widget templates (`*.widget.json`) — DorkOS extension, see below |

### Widget templates (`ui/*.widget.json`)

A skill may ship reusable generative-UI widgets: each `ui/*.widget.json` file is `{ name, description, document }` where `document` is a widget document (`@dorkos/shared/ui-widget`) whose string fields may contain `{{placeholder}}` slots. Agents read a template, fill the placeholders, and emit the result as a ` ```dorkos-ui ` fence — the `<gen_ui>` system-prompt block teaches this to every runtime.

Placeholder rules (`WidgetTemplateSchema` in `packages/skills/src/ui-template.ts` enforces them):

- **Free-form string fields** — placeholders allowed (`text.text`, `card.title`, `stat.value`, `image.src` as a whole-string placeholder, …).
- **Number-only fields** — placeholders rejected (`progress.value`, `chart.data[].value`). Route numeric fill-ins through `string | number` fields like `stat.value`.
- **Enum/literal fields** — placeholders rejected (`badge.tone`, `chart.kind`, `stack.direction`, node `type`, …). Pin the concrete value when authoring.

Reference the template from the SKILL.md body (e.g. "render results with `ui/weather-card.widget.json`") so the agent knows it exists. Malformed template files surface as skill validation errors via `validateSkillStructure`. Example fixture: `packages/skills/src/__tests__/fixtures/weather-card.widget.json`.

## Manifest Schema

See `packages/marketplace/src/manifest-schema.ts` for the canonical Zod schema. Key fields:

- `name` — kebab-case, must match directory name
- `version` — semver
- `type` — `plugin | agent | skill-pack | adapter | shape`
- `description` — 1-1024 chars
- `requires` — dependency declarations like `adapter:slack@^1.0.0`
- `layers` — content categories (`skills`, `tasks`, `hooks`, etc.)

## Local Development Loop

Before installing a package, load it straight from your working copy so you can
iterate without a publish/install round-trip. The loop is per-harness — each
agent runtime reads plugin content differently.

| Harness     | Dev loop                                | Notes                                                                                                                                                              |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | `claude --plugin-dir <path-to-package>` | Dev-only flag. Loads the package's commands, skills, and hooks for that session only — it does not write anything, and other agents on the machine are unaffected. |
| Codex       | None needed — reads `.agents/` directly | If the package ships an `.agents/` tree (skills, commands), Codex picks it up natively with no flag and no install step.                                           |

```bash
# Clone the package's repo first; <package-dir> is the package root inside it
# (the directory containing .dork/manifest.json), not the whole repo.
claude --plugin-dir <package-dir>
```

`--plugin-dir` is how the flow plugin itself is dogfooded during development —
see `contributing/flow-engine.md` for that loop in practice. Once the package
is ready, install it for real through the Marketplace (`contributing/marketplace-installs.md`)
so it persists across sessions and projects.

## Related

- `packages/marketplace/README.md` — Package API
- `decisions/0220-adopt-skill-md-open-standard.md` — SKILL.md format (+ addendum on optional `kind` field)
- `decisions/0228-marketplace-manifest-filename.md` — Why `.dork/manifest.json`
- `decisions/0230-marketplace-package-type-agent-naming.md` — Why `agent` not `agent-template`

## Install Workflows

Install machinery ships in `marketplace-02-install`. This guide will be expanded when that spec lands.
