---
name: marketplace-dev
description: Develop, validate, and publish DorkOS marketplace packages — agents, plugins, skill-packs, and adapters. Use when creating marketplace items, working in the dork-labs/marketplace repo, or helping users build packages for the personal marketplace.
---

# Marketplace Package Development

Build packages that work for both DorkOS and Claude Code. Every package must pass `dorkos package validate` before submission.

## When to Use

| Signal                          | Example                                          | Action                                                           |
| ------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Creating a new marketplace item | "create a code-review agent for the marketplace" | Scaffold with `dorkos package init`, fill manifest, write skills |
| Working in the marketplace repo | Any work in `dork-labs/marketplace`              | Follow same-repo monorepo conventions (ADR-0237)                 |
| Building a personal package     | "I want to make a skill pack for my workflow"    | Scaffold in `~/.dork/personal-marketplace/packages/`             |
| Fixing validation errors        | `dorkos package validate` fails                  | Diagnose using issue codes below                                 |
| Adding to the registry          | "publish this to the marketplace"                | Add entries to `marketplace.json` + `dorkos.json` sidecar        |

## Package Types

There are exactly 4 types. Choose based on what the package delivers:

| Type             | What It Is                                            | Has `.claude-plugin/plugin.json`? | Key Directories                   |
| ---------------- | ----------------------------------------------------- | --------------------------------- | --------------------------------- |
| **`agent`**      | Reusable agent definition with persona, skills, tasks | No                                | `.claude/skills/`, `.dork/tasks/` |
| **`plugin`**     | Claude Code extension with commands, hooks, UI        | Yes                               | `skills/`, `hooks/`, `commands/`  |
| **`skill-pack`** | Bundle of SKILL.md files providing reusable expertise | Yes                               | `skills/`                         |
| **`adapter`**    | Integration bridge (relay transport, mesh discovery)  | Yes                               | `.dork/adapters/`                 |

**Decision rule:** If it defines an agent identity (persona, traits) → `agent`. If it adds UI slots or commands → `plugin`. If it's just skills → `skill-pack`. If it bridges an external service → `adapter`.

## Scaffolding

```bash
dorkos package init <name> [--type agent|plugin|skill-pack|adapter] \
  [--parent-dir <path>] [--description <text>] [--author <text>] [--adapter-type <id>]
```

- `--type` defaults to `plugin`
- `--parent-dir` defaults to cwd
- `--adapter-type` only meaningful for adapters; defaults to package name

### What Gets Created

**All types:**

- `.dork/manifest.json` — DorkOS package manifest (schemaVersion 1, version 0.0.1, MIT)
- `README.md`

**plugin/skill-pack/adapter additionally:**

- `.claude-plugin/plugin.json` — CC-compatible manifest stub

**Type-specific directories:**

| Type         | Directories Created               | Manifest `layers`               |
| ------------ | --------------------------------- | ------------------------------- |
| `plugin`     | `skills/`, `hooks/`, `commands/`  | `['skills', 'extensions']`      |
| `skill-pack` | `skills/`                         | `['skills']`                    |
| `adapter`    | `.dork/adapters/`                 | `['adapters']`                  |
| `agent`      | `.claude/skills/`, `.dork/tasks/` | `['skills', 'tasks', 'agents']` |

## Manifest Reference

### `.dork/manifest.json` (Required for all types)

```jsonc
{
  "schemaVersion": 1, // Always 1
  "name": "my-package", // Kebab-case, matches directory name
  "version": "1.0.0", // Semver
  "type": "plugin", // "agent" | "plugin" | "skill-pack" | "adapter"
  "description": "What it does", // 1-1024 chars, required
  "displayName": "My Package", // Optional, max 128 chars
  "author": "Dork Labs", // Optional, max 256 chars
  "license": "MIT", // Optional, SPDX ID
  "tags": ["review", "ci"], // Optional, max 20 items, each max 32 chars
  "category": "code-quality", // Optional, max 64 chars
  "icon": "🔍", // Optional, emoji or icon ID
  "layers": ["skills"], // Optional, see Layer enum below
  "requires": ["adapter:slack"], // Optional, dependency declarations
  "featured": false, // Optional, set by registry
}
```

**Layer enum:** `skills`, `tasks`, `commands`, `hooks`, `extensions`, `adapters`, `mcp-servers`, `lsp-servers`, `agents`

**Requires format:** `<type>:<name>[@<version>]` — e.g., `adapter:slack@^1.0.0`, `plugin:linear-integration`

#### Type-Specific Fields

**Agent** — adds `agentDefaults`:

```jsonc
{
  "type": "agent",
  "agentDefaults": {
    "persona": "A security-focused code reviewer", // Max 4000 chars
    "capabilities": ["code-review", "security"],
    "traits": {
      "tone": 3, // 1-5 (formal → casual)
      "autonomy": 4, // 1-5 (guided → self-directed)
      "caution": 5, // 1-5 (conservative → bold)
      "communication": 2, // 1-5 (brief → verbose)
      "creativity": 2, // 1-5 (literal → imaginative)
    },
  },
}
```

**Plugin** — adds `extensions`:

```jsonc
{
  "type": "plugin",
  "extensions": ["my-sidebar-widget"], // Extension IDs registered via ExtensionAPI
}
```

**Adapter** — adds `adapterType` (required):

```jsonc
{
  "type": "adapter",
  "adapterType": "discord", // 1-64 chars, identifies adapter category
}
```

**Skill-pack** — no additional fields.

### `.claude-plugin/plugin.json` (Required for plugin, skill-pack, adapter)

```json
{
  "name": "my-package",
  "version": "1.0.0",
  "description": "What it does"
}
```

Keep this minimal and in sync with `.dork/manifest.json`. Real CC plugins may also declare `commands`, `agents`, `hooks`, `mcpServers`, `lspServers` here.

### SKILL.md Files

Skills live in directory-based format: `<skill-name>/SKILL.md`

```markdown
---
name: example-skill
description: An example skill for this package.
kind: skill
---

# Example Skill

Content here.
```

**Frontmatter fields:**

- `name` — kebab-case, matches directory name
- `description` — one-line human-readable description
- `kind` — `skill` | `task` | `command` (marketplace authors SHOULD include explicitly)
- For tasks: `cron` field for scheduling

**Skill directories scanned by validator (in order):**
`skills/`, `tasks/`, `commands/`, `.claude/skills/`, `.claude/commands/`, `.dork/tasks/`

## Validation

```bash
dorkos package validate [path]   # path defaults to cwd
```

### Pipeline (in order, stops early on errors)

| Step | Check                                                                          | Error Code                | Severity             |
| ---- | ------------------------------------------------------------------------------ | ------------------------- | -------------------- |
| 1    | `.dork/manifest.json` exists (or `.claude-plugin/plugin.json` for CC fallback) | `MANIFEST_MISSING`        | Error (early return) |
| 2    | JSON parses                                                                    | `MANIFEST_INVALID_JSON`   | Error (early return) |
| 3    | Passes Zod schema                                                              | `MANIFEST_SCHEMA_INVALID` | Error (early return) |
| 4    | `.claude-plugin/plugin.json` exists (when type requires it)                    | `CLAUDE_PLUGIN_MISSING`   | Error                |
| 5    | All SKILL.md files valid                                                       | `SKILL_INVALID`           | Error (per skill)    |
| 6    | Directory name matches `manifest.name`                                         | `NAME_DIRECTORY_MISMATCH` | Warning              |

**Exit codes:** `0` = pass (warnings OK), `1` = errors found

### Common Validation Fixes

| Error Code                | Typical Cause                                                | Fix                                                                       |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `MANIFEST_MISSING`        | No `.dork/` directory                                        | Run `dorkos package init` or create manually                              |
| `MANIFEST_SCHEMA_INVALID` | Bad name (uppercase), bad version (not semver), missing type | Fix the specific field — name must be kebab-case, version must be `X.Y.Z` |
| `CLAUDE_PLUGIN_MISSING`   | Plugin/skill-pack/adapter missing CC manifest                | Create `.claude-plugin/plugin.json` with name, version, description       |
| `SKILL_INVALID`           | SKILL.md missing frontmatter or invalid fields               | Add `---` frontmatter block with name, description, kind                  |
| `NAME_DIRECTORY_MISMATCH` | Directory named differently than manifest.name               | Rename directory or update manifest.name (warning only)                   |

## Registry Format (Official Marketplace)

The official marketplace at `dork-labs/marketplace` uses a same-repo monorepo pattern (ADR-0237). Two registry files work together:

### `.claude-plugin/marketplace.json` (CC-standard)

```jsonc
{
  "name": "dorkos",
  "owner": { "name": "Dork Labs", "email": "hello@dorkos.ai" },
  "metadata": {
    "description": "Official marketplace for DorkOS",
    "version": "0.1.0",
    "pluginRoot": "./plugins",
  },
  "plugins": [
    {
      "name": "my-package",
      "source": "./plugins/my-package", // MUST use ./plugins/ prefix
      "description": "What it does",
      "author": { "name": "Author Name" },
      "license": "MIT",
      "category": "code-quality",
      "tags": ["review", "ci"],
      "keywords": ["code-review"],
    },
  ],
}
```

**Critical:** Source paths MUST start with `"./plugins/<name>"` — the `pluginRoot` field is ignored when source starts with `./`.

### `.claude-plugin/dorkos.json` (DorkOS sidecar — ADR-0236)

```jsonc
{
  "$schema": "https://dorkos.ai/schemas/dorkos-marketplace.schema.json",
  "schemaVersion": 1,
  "plugins": {
    "my-package": {
      "type": "agent", // agent | plugin | skill-pack | adapter
      "layers": ["agents", "tasks"],
      "icon": "🔍",
      "featured": true,
      "pricing": { "model": "free" }, // free | paid | freemium | byo-license
    },
  },
}
```

**Why separate files?** CC enforces `additionalProperties: false` on plugin entries. Any inline DorkOS field is rejected. The sidecar is the only safe extension mechanism.

**Drift rules:**

- Plugin in marketplace.json but not dorkos.json → defaults to `type: 'plugin'` (not an error)
- Plugin in dorkos.json but not marketplace.json → orphan, silently dropped (logged as warning)
- dorkos.json missing entirely → all entries get default type (not an error)

### Source Path Forms (for community packages in separate repos)

| Form             | Example                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Relative path    | `"./plugins/code-reviewer"`                                                              |
| GitHub           | `{ "source": "github", "repo": "owner/repo", "ref": "main" }`                            |
| URL              | `{ "source": "url", "url": "https://gitlab.com/foo/bar.git" }`                           |
| Git subdirectory | `{ "source": "git-subdir", "url": "https://...", "path": "packages/plugin-a" }`          |
| npm              | `{ "source": "npm", "package": "@scope/name", "version": "^1.0.0" }` (not yet supported) |

## Submission Flow (Official Marketplace)

1. **Scaffold:** `dorkos package init <name> --type <type> --parent-dir ./plugins`
2. **Author:** Fill `.dork/manifest.json`, write skills/hooks/commands, write README
3. **Validate locally:** `dorkos package validate ./plugins/<name>` — must exit 0
4. **Add registry entry:** Add to `.claude-plugin/marketplace.json` plugins array with `"source": "./plugins/<name>"`
5. **Add sidecar entry:** Add to `.claude-plugin/dorkos.json` plugins object with type, layers, icon, pricing
6. **Validate registry:** `dorkos marketplace validate .claude-plugin/marketplace.json`
7. **Open PR** against `main` of `dork-labs/marketplace`

### Registry Validation Checks

The marketplace validator performs 6 checks:

1. Fetch/read marketplace.json and dorkos.json
2. DorkOS schema validation (passthrough — any CC-valid marketplace accepted)
3. Sidecar schema validation (strict when present)
4. CC compatibility check (ported CC validator)
5. Plugin sources reachable (probes each plugin's `.claude-plugin/plugin.json`)
6. Reserved-name check (marketplace name not in reserved list)

**Exit codes:** `0` = pass, `1` = schema/validation error, `2` = CC validator fails or sources unreachable

## Personal Marketplace (Local Development)

For iterating before official submission:

- **Location:** `~/.dork/personal-marketplace/`
- **Auto-bootstrapped** on server boot with `marketplace.json`, `README.md`, `packages/` subdirectory
- **Registered** as `file://` source named `personal`
- **Create via MCP:** `marketplace_create_package` tool scaffolds directly into personal marketplace

Workflow: Scaffold in personal marketplace → iterate → validate → move to official repo for submission.

## Extension API (Plugin Type Only)

Plugins can register UI extensions. Available slots:

| Slot                    | Purpose                     |
| ----------------------- | --------------------------- |
| `sidebar.footer`        | Footer area of left sidebar |
| `sidebar.tabs`          | Tab list in left sidebar    |
| `dashboard.sections`    | Dashboard widget grid       |
| `header.actions`        | Top-right action buttons    |
| `command-palette.items` | Command palette entries     |
| `dialog`                | Modal dialog slots          |
| `settings.tabs`         | Settings dialog tabs        |
| `session.canvas`        | Canvas area in sessions     |

Extensions receive an `ExtensionAPI` object with methods for:

- `registerComponent(slot, id, component, options?)` — place React component in a slot
- `registerCommand(id, label, callback, options?)` — add command palette item
- `registerDialog(id, component)` — register modal dialog
- `registerSettingsTab(id, label, component)` — add settings tab
- `getState()` / `subscribe(selector, callback)` — read and watch host state (cwd, activeSession, agent)
- `loadData<T>()` / `saveData<T>(data)` — scoped persistent storage
- `notify(message, options?)` — show toast notifications
- `navigate(path)` — client-side navigation
- `executeCommand(command)` — execute UI commands
- `openCanvas(content)` — open canvas with content

Declare extension IDs in the manifest: `"extensions": ["my-extension-id"]`

## Anti-Patterns

| Don't                                                    | Do Instead                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| Put DorkOS fields in marketplace.json plugin entries     | Use dorkos.json sidecar                                     |
| Use `"source": "code-reviewer"` (relative to pluginRoot) | Use `"source": "./plugins/code-reviewer"` (explicit path)   |
| Skip `.claude-plugin/plugin.json` for non-agent types    | Always create it — validation will fail without it          |
| Use uppercase or underscores in package names            | Use kebab-case: `my-cool-plugin`                            |
| Leave SKILL.md without frontmatter                       | Always include `name`, `description`, `kind` in `---` block |
| Set `version` to non-semver strings                      | Use `X.Y.Z` format (e.g., `0.1.0`, `1.0.0`)                 |
| Forget to add both registry entries                      | Always update both marketplace.json AND dorkos.json         |

## Canonical Examples

### Minimal Agent Package

```
my-agent/
├── .dork/
│   └── manifest.json    → type: "agent", agentDefaults: { persona: "..." }
├── .claude/
│   └── skills/
│       └── my-skill/
│           └── SKILL.md
├── .dork/
│   └── tasks/
└── README.md
```

### Minimal Plugin Package

```
my-plugin/
├── .dork/
│   └── manifest.json    → type: "plugin", extensions: ["my-widget"]
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── helper-skill/
│       └── SKILL.md
├── hooks/
├── commands/
└── README.md
```

### Minimal Skill-Pack

```
my-skills/
├── .dork/
│   └── manifest.json    → type: "skill-pack"
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── skill-one/
│   │   └── SKILL.md
│   └── skill-two/
│       └── SKILL.md
└── README.md
```

### Minimal Adapter

```
my-adapter/
├── .dork/
│   └── manifest.json    → type: "adapter", adapterType: "discord"
├── .claude-plugin/
│   └── plugin.json
├── .dork/
│   └── adapters/
└── README.md
```
