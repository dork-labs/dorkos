---
title: 'Slash Command Storage, Format & Discovery — Competitive Analysis'
date: 2026-03-15
type: external-best-practices
status: active
tags:
  [
    slash-commands,
    custom-commands,
    opencode,
    cursor,
    codex,
    windsurf,
    aider,
    continue,
    competitive-analysis,
  ]
searches_performed: 14
sources_count: 28
---

# Slash Command Storage, Format & Discovery — Competitive Analysis

## Research Summary

Six AI coding tools were analyzed for how they store, format, and discover user-defined slash commands. A clear convergence is visible: **markdown files with YAML frontmatter** is the dominant format across Claude Code, OpenCode, Codex CLI, Windsurf, and Continue.dev. Discovery is universally filesystem-based (directory scan). Cursor uses the same markdown-in-directory pattern but without standardized frontmatter. Aider has **no custom command support** at all — only fixed built-ins. The tools with the richest metadata systems are OpenCode and Codex CLI, which both support argument placeholders, agent/model routing, and sub-task invocation.

---

## Tool-by-Tool Breakdown

---

### 1. Claude Code (Anthropic)

> Covered by existing research: `research/20260315_agent_sdk_slash_command_discovery_api.md`

**Storage locations:**

- Project-level: `.claude/commands/<namespace>/<command>.md`
- User-level: `~/.claude/commands/<namespace>/<command>.md`
- Skills (new format): `.claude/skills/<name>/SKILL.md`

**File format:** Markdown with YAML frontmatter.

**Supported frontmatter fields:**

- `description` — shown in command palette
- `argument-hint` — parameter documentation (e.g., `"<file> <ticket>"`)
- `allowed-tools` — comma-separated list of tools the command may invoke (e.g., `Bash, Read`)

**Argument/placeholder syntax:**

- `$ARGUMENTS` — full argument string
- Named placeholders inferred from context

**Discovery mechanism:** Filesystem scan of `.claude/commands/` directories at session init. Also exposed programmatically via the Agent SDK:

- `Query.supportedCommands()` → `SlashCommand[]` (`name`, `description`, `argumentHint`)
- `SDKSystemMessage.subtype === "init"` → `slash_commands: string[]` (names only)
- `Query.initializationResult()` → `SDKControlInitializeResponse.commands: SlashCommand[]`

**Namespace/directory support:** Yes — subdirectory becomes the namespace prefix (e.g., `.claude/commands/frontend/component.md` → `/frontend:component`)

**Invocation syntax:** `/namespace:command` or `/command` if in root

**Programmatic API:** Yes — three SDK methods (see above). The richest in the comparison.

---

### 2. OpenCode (sst/opencode)

**Storage locations:**

- Project-level: `.opencode/commands/*.md`
- Global (XDG): `~/.config/opencode/commands/` (or `~/.local/opencode/` per XDG standard)
- Also configurable via `OPENCODE_CONFIG_DIR` env var

**File format:** Markdown with YAML frontmatter. Filename (minus `.md`) becomes the command name. Commands can alternatively be defined inline in `opencode.jsonc`.

**Supported frontmatter fields:**
| Field | Type | Purpose |
|---|---|---|
| `description` | string | Shown in TUI command picker |
| `agent` | string | Which named agent executes this command |
| `model` | string | Override default model (e.g., `anthropic/claude-3-5-sonnet-20241022`) |
| `subtask` | boolean | Force subagent invocation (keeps primary context clean) |

**Argument/placeholder syntax:**

- `$ARGUMENTS` — full argument string
- `$1`, `$2`, `$3` — positional arguments
- `` `!command` `` — inject bash command output
- `@filename` — inject file contents

**Discovery mechanism:** Filesystem scan of all configured `commands/` directories at startup. Commands are fuzzy-matched in the TUI `/` menu. Custom commands can **override built-ins** (`/init`, `/undo`, `/help`, etc.).

**Alternative: JSON config (`opencode.jsonc`):**

```jsonc
{
  "command": {
    "test": {
      "template": "Run tests with coverage for $ARGUMENTS",
      "description": "Run tests with coverage",
      "agent": "build",
      "model": "anthropic/claude-3-5-sonnet-20241022",
    },
  },
}
```

**Invocation syntax:** `/command-name` or `/command-name arg1 arg2`

**Programmatic API:** None documented. Discovery is filesystem/config only.

**Example file (`.opencode/commands/review.md`):**

```markdown
---
description: Security review for changed files
agent: security
model: anthropic/claude-opus-4-5
subtask: true
---

Review the following files for security vulnerabilities: $ARGUMENTS
```

---

### 3. Cursor (Anysphere)

> Feature introduced in Cursor v1.6 (September 12, 2025). Skills migration available in Cursor v2.4+.

**Storage locations:**

- Project-level commands: `.cursor/commands/<name>.md`
- Project-level skills (v2.4+): `.cursor/skills/<skill-name>/SKILL.md`
- Global skills: `~/.cursor/skills/<skill-name>/SKILL.md`
- Legacy compatibility aliases also searched: `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`

**File format:** Markdown files. No standard frontmatter schema is documented — the files are freeform prompt text. Some community practitioners use `## Objective`, `## Requirements`, `## Output` sections as conventions.

**Supported metadata:** No documented frontmatter fields for commands (`.cursor/commands/`). Skills have their own `SKILL.md` format but field schema is not publicly specified.

**Argument/parameter support:** Yes — arguments can be passed after the command name when invoked. The file content is the prompt, and parameters are appended to it at invocation.

**Discovery mechanism:** Filesystem scan of `.cursor/commands/` in the project root. Commands appear in the `/` dropdown in Agent chat input.

**Invocation syntax:** Type `/` in Agent input → dropdown lists all available commands → select and optionally append arguments.

**Programmatic API:** None documented.

**Migration:** A built-in `/migrate-to-skills` command (v2.4+) converts eligible rules and slash commands into the newer skills format automatically.

**Note:** Cursor's commands are intentionally minimal — no frontmatter schema, no metadata — unlike Claude Code and OpenCode. The philosophy is that the file content _is_ the prompt.

---

### 4. OpenAI Codex CLI

**Storage locations:**

- User-global only: `~/.codex/prompts/*.md`
- Only top-level files are scanned — subdirectories and non-`.md` files are ignored.

**File format:** Markdown with YAML frontmatter.

**Supported frontmatter fields:**
| Field | Type | Purpose |
|---|---|---|
| `description` | string | Shown in slash command popup menu |
| `argument-hint` | string | Documents expected parameters (e.g., `KEY=<value>`) |

**Argument/placeholder syntax:**

- **Positional:** `$1`–`$9` expand from space-separated arguments; `$ARGUMENTS` captures all
- **Named:** Uppercase identifiers like `$FILE` or `$TICKET_ID`; supplied as `KEY=value` at invocation (quote values with spaces)
- **Literal `$`:** Use `$$` to emit a single dollar sign

**Discovery mechanism:** Codex scans `~/.codex/prompts/` at startup. The filename (minus `.md`) becomes the command name. Commands appear in the `/` menu as `/prompts:name`.

**Invocation syntax:** `/prompts:name KEY=value` or `/prompts:name arg1 arg2`

**IDE extension:** A separate IDE extension version of Codex also supports slash commands via the same format.

**Programmatic API:** None. File management is the only interface.

**Deprecation note:** Custom prompts are **deprecated** in favor of "skills" — the skills system allows Codex to invoke them both explicitly and implicitly (autonomously).

**Example file (`~/.codex/prompts/draftpr.md`):**

```markdown
---
description: Draft a pull request description
argument-hint: FILES=<paths> PR_TITLE=<title>
---

Draft a pull request for the following files: $FILES

Title: $PR_TITLE

Include a summary, motivation, and testing instructions.
```

---

### 5. Windsurf (Codeium / OpenAI)

> Windsurf uses the term "Workflows" for what other tools call custom slash commands.

**Storage locations:**
| Scope | Path |
|---|---|
| Workspace | `.windsurf/workflows/*.md` |
| Global (per-machine) | `~/.codeium/windsurf/global_workflows/*.md` |
| Enterprise (macOS) | `/Library/Application Support/Windsurf/workflows/*.md` |
| Enterprise (Linux) | `/etc/windsurf/workflows/*.md` |
| Enterprise (Windows) | `C:\ProgramData\Windsurf\workflows\*.md` |

**File format:** Markdown. No documented frontmatter schema — workflows contain a title, description, and numbered steps as plain prose with inline code blocks.

**Supported metadata:** No formally specified frontmatter fields. The workflow's filename becomes its slash command name.

**File size limit:** 12,000 characters per workflow file.

**Discovery mechanism:** Windsurf automatically scans multiple locations:

- Current workspace and subdirectories
- Git repository structure (walks up to git root)
- Multiple open folders (with deduplication using shortest relative path)

**Invocation syntax:** `/workflow-name` in Cascade chat.

**Programmatic API:** None. UI-only management (Workflows panel in Cascade sidebar).

**Workflows vs. Rules vs. Skills distinction:**
| Type | Storage | Invocation | Auto-invoke |
|---|---|---|---|
| Workflows | `.windsurf/workflows/` | Manual `/name` | Never |
| Rules | `.windsurf/rules/` | Context-injected | Automatic (per glob) |
| Skills | `.windsurf/skills/` | Can be auto-invoked | Yes (Cascade decides) |

**Note:** Windsurf's workflow format is the least structured of all tools reviewed — no frontmatter at all, just prose steps. This makes it easy to author but difficult to introspect programmatically.

---

### 6. Aider

**Custom slash command support: None.**

Aider provides approximately 45 fixed built-in commands (`/add`, `/drop`, `/code`, `/architect`, `/git`, `/commit`, `/run`, `/test`, etc.) but has **no mechanism for user-defined slash commands**.

Two GitHub issues document this gap:

- [Issue #894](https://github.com/Aider-AI/aider/issues/894) (July 2024): Feature request to add custom commands via `aider_commands.yml`
- [Issue #4235](https://github.com/Aider-AI/aider/issues/4235) (June 2025): Question on custom commands, still open with no implementation

The June 2025 issue explicitly cited Claude Code's custom slash command system as the reference implementation. As of March 2026, the feature remains unimplemented.

**Configuration:** Aider uses `.aider.conf.yml` for runtime settings but this is an options file, not a command definition file. No YAML-based custom command system exists.

---

### 7. Continue.dev

**Storage locations:**

- Project-level: `.continue/prompts/*.md`
- User-level (implied): `~/.continue/prompts/` (follows same pattern)

**File format:** Markdown with YAML frontmatter.

**Supported frontmatter fields:**
| Field | Type | Purpose |
|---|---|---|
| `name` | string | Display name and slash command identifier |
| `description` | string | Shown in command picker |
| `invokable` | boolean | When `true`, makes this a `/` slash command in IDE + CLI |

**Discovery mechanism:** Continue scans `.continue/prompts/` and registers any file with `invokable: true` as a slash command. Commands appear in the `/` dropdown in Chat, Plan, and Agent mode.

**Invocation syntax:** Type `/name` in the Continue chat panel, or via CLI: `cn --prompt <name> "additional instructions"`

**Deprecated approach:** The old `config.ts`/`config.json` `slashCommands` array with programmatic `run` functions is deprecated. New approach is prompt files exclusively.

**Programmatic API:** None via filesystem. The old `config.ts` approach allowed programmatic slash commands (async `run` function with full access to the Continue SDK), but this is deprecated. The CLI flag `cn --prompt <name>` is the closest analog.

**Example file (`.continue/prompts/explain-code.md`):**

```markdown
---
name: explain-code
description: Explain what the selected code does
invokable: true
---

Please explain the following code in plain English, covering:

1. What it does
2. How it works
3. Any potential issues or edge cases

{{selection}}
```

---

## Structured Comparison Table

| Dimension                         | Claude Code                 | OpenCode                       | Cursor                           | Codex CLI                   | Windsurf                                | Aider  | Continue.dev                       |
| --------------------------------- | --------------------------- | ------------------------------ | -------------------------------- | --------------------------- | --------------------------------------- | ------ | ---------------------------------- |
| **Custom commands supported**     | Yes                         | Yes                            | Yes                              | Yes                         | Yes (Workflows)                         | **No** | Yes                                |
| **Project-level path**            | `.claude/commands/`         | `.opencode/commands/`          | `.cursor/commands/`              | N/A                         | `.windsurf/workflows/`                  | N/A    | `.continue/prompts/`               |
| **User-level path**               | `~/.claude/commands/`       | `~/.config/opencode/commands/` | `~/.cursor/skills/`              | `~/.codex/prompts/`         | `~/.codeium/windsurf/global_workflows/` | N/A    | `~/.continue/prompts/`             |
| **File format**                   | Markdown + YAML frontmatter | Markdown + YAML frontmatter    | Markdown (no frontmatter schema) | Markdown + YAML frontmatter | Markdown (no frontmatter)               | N/A    | Markdown + YAML frontmatter        |
| **`description` field**           | Yes                         | Yes                            | No spec                          | Yes                         | No spec                                 | N/A    | Yes                                |
| **`argument-hint` field**         | Yes                         | No                             | No                               | Yes                         | No                                      | N/A    | No                                 |
| **`allowed-tools` field**         | Yes                         | No                             | No                               | No                          | No                                      | N/A    | No                                 |
| **Agent/model routing**           | No                          | Yes (`agent`, `model`)         | No                               | No                          | No                                      | N/A    | No                                 |
| **Subtask/subagent flag**         | No                          | Yes (`subtask`)                | No                               | No                          | No                                      | N/A    | No                                 |
| **`invokable` flag needed**       | No (auto)                   | No (auto)                      | No (auto)                        | No (auto)                   | No (auto)                               | N/A    | **Yes** (required)                 |
| **Namespace via subdirs**         | Yes                         | No                             | No                               | No                          | No                                      | N/A    | No                                 |
| **Positional args (`$1`, `$2`)**  | Partial                     | Yes                            | No spec                          | Yes                         | No                                      | N/A    | No                                 |
| **Named args (`$KEY=value`)**     | No                          | No                             | No                               | Yes                         | No                                      | N/A    | No                                 |
| **Bash injection (`` `!cmd` ``)** | No                          | Yes                            | No                               | No                          | No                                      | N/A    | No                                 |
| **File injection (`@file`)**      | Yes                         | Yes                            | No spec                          | No                          | No                                      | N/A    | Yes (`{{selection}}`)              |
| **Discovery**                     | Filesystem scan             | Filesystem scan                | Filesystem scan                  | Filesystem scan             | Filesystem scan                         | N/A    | Filesystem scan                    |
| **Programmatic list API**         | Yes (SDK)                   | No                             | No                               | No                          | No                                      | N/A    | No                                 |
| **Override built-ins**            | No                          | Yes                            | No                               | No                          | No                                      | N/A    | No                                 |
| **JSON/TOML alternative**         | No                          | Yes (`opencode.jsonc`)         | No                               | No                          | No                                      | N/A    | No (`config.yaml` for hub prompts) |

---

## Key Findings

### 1. Markdown + YAML Frontmatter Is the Clear Standard

Five of the six tools that support custom commands (Claude Code, OpenCode, Codex CLI, Continue.dev, and implicitly Cursor) use markdown files where YAML frontmatter carries metadata and the body is the prompt template. This is a de-facto standard for the ecosystem. Windsurf is the only exception with its freeform prose workflow files.

### 2. Filesystem Scan Is Universal

Every tool uses a directory scan for discovery — no tool requires explicit registration in a manifest, config file entry, or API call. The filename (minus `.md`) always becomes the command name. This convention is universal.

### 3. Claude Code Has the Only Programmatic Discovery API

The Agent SDK's `Query.supportedCommands()`, `initializationResult()`, and `slash_commands` on the init message are unique. No other tool exposes a programmatic interface for enumerating commands — management is always done by direct filesystem manipulation.

### 4. OpenCode Has the Richest Routing Metadata

OpenCode's frontmatter supports `agent`, `model`, and `subtask` routing — letting a command dispatch to a specific named agent with a specific model without user interaction. No other tool in this comparison supports this level of per-command routing.

### 5. Codex CLI Has the Richest Argument System

Codex supports both positional (`$1`–`$9`, `$ARGUMENTS`) and named (`KEY=value`) argument passing. The named argument system with `argument-hint:` frontmatter is particularly ergonomic. OpenCode has positional args and bash injection but not the named `KEY=value` invocation pattern.

### 6. Continue.dev Requires Explicit Opt-In

Continue.dev is the only tool that requires `invokable: true` in frontmatter for a prompt to become a slash command. All others auto-register every `.md` file in the commands directory.

### 7. Aider Has No Custom Command System (Open Gap)

As of March 2026, Aider has not implemented custom slash commands despite multiple feature requests dating back to mid-2024. Community members explicitly cite Claude Code as the reference implementation they want Aider to emulate.

### 8. Namespace Isolation Is Unique to Claude Code

Claude Code's subdirectory-as-namespace pattern (`.claude/commands/frontend/component.md` → `/frontend:component`) is the only tool to provide command namespacing. This prevents collisions and provides organizational clarity for large command libraries. All other tools use a flat namespace.

---

## Detailed Analysis

### The Emerging `.{toolname}/commands/` Convention

All tools follow the pattern `.<toolname>/commands/` for project-level commands:

- Claude Code: `.claude/commands/`
- OpenCode: `.opencode/commands/`
- Cursor: `.cursor/commands/`
- Windsurf: `.windsurf/workflows/`
- Continue.dev: `.continue/prompts/`

The user-level equivalent follows XDG conventions:

- Linux/macOS: `~/.config/<tool>/commands/` or `~/.<tool>/commands/`
- Codex is the outlier with `~/.codex/prompts/` (flat user home, no XDG)

### Frontmatter Field Convergence

Comparing fields that appear across multiple tools:

| Field           | Claude Code | OpenCode | Codex CLI | Continue.dev | Status                 |
| --------------- | ----------- | -------- | --------- | ------------ | ---------------------- |
| `description`   | Yes         | Yes      | Yes       | Yes          | Universal              |
| `argument-hint` | Yes         | No       | Yes       | No           | Shared by 2            |
| `allowed-tools` | Yes         | No       | No        | No           | Unique to Claude Code  |
| `agent`         | No          | Yes      | No        | No           | Unique to OpenCode     |
| `model`         | No          | Yes      | No        | No           | Unique to OpenCode     |
| `subtask`       | No          | Yes      | No        | No           | Unique to OpenCode     |
| `invokable`     | No          | No       | No        | Yes          | Unique to Continue.dev |
| `name`          | No          | No       | No        | Yes          | Unique to Continue.dev |

### Discovery Mechanisms in Detail

**Scan-on-startup (OpenCode, Cursor, Codex, Claude Code, Continue.dev):** Commands are discovered once at startup or session init, then cached. File changes typically require a restart.

**Multi-scope merge (Windsurf, Claude Code, OpenCode):** Multiple directory scopes (global, project, enterprise) are merged with project taking precedence. Claude Code adds namespace isolation via subdirectories to avoid conflicts.

**Lazy session-bound discovery (Claude Code SDK):** The SDK defers full command discovery until session initialization completes, then caches per session. This is the most robust approach since the SDK has full knowledge of built-in commands plus all custom sources.

### Skills vs. Commands

Multiple tools are converging on a **two-tier model**:

- **Commands** (explicit, slash-invoked): User types `/name` explicitly. Pure prompt templates.
- **Skills** (autonomous, context-invoked): The AI decides when to use them. More structured, with capability declarations.

| Tool        | Command Type                         | Skill Type                       |
| ----------- | ------------------------------------ | -------------------------------- |
| Claude Code | `.claude/commands/*.md`              | `.claude/skills/<name>/SKILL.md` |
| OpenCode    | `.opencode/commands/*.md`            | `.opencode/skills/*.md`          |
| Cursor      | `.cursor/commands/*.md`              | `.cursor/skills/<name>/SKILL.md` |
| Codex CLI   | `~/.codex/prompts/*.md` (deprecated) | `~/.codex/skills/`               |
| Windsurf    | `.windsurf/workflows/*.md`           | `.windsurf/skills/`              |

This two-tier pattern is significant: **the industry is moving from "commands the user invokes" toward "capabilities the agent can invoke autonomously."** The `commands/` directories are being superseded by `skills/` directories as the primary extensibility mechanism.

---

## Implications for DorkOS

DorkOS's `CommandRegistryService` (in `apps/server/src/services/runtimes/claude-code/command-registry.ts`) is well-aligned with the industry pattern:

1. **Format alignment:** Uses the same markdown + YAML frontmatter format as Claude Code, which is the ecosystem standard.
2. **Discovery alignment:** Filesystem scan is universal — no tool uses anything else.
3. **Richer metadata than SDK:** DorkOS extracts `allowedTools`, `filePath`, and `namespace` — metadata not returned by the Claude Agent SDK's `supportedCommands()`.
4. **Gap: no skills support:** The `.claude/skills/` format (the new Claude Code format) is not scanned. This is documented as a known gap.
5. **Gap: no built-in commands:** DorkOS only scans custom commands; Claude Code built-ins (`/compact`, `/help`, `/clear`) require SDK query to surface.
6. **Unique advantage:** DorkOS is the only system that both scans custom commands _and_ has access to the SDK's programmatic discovery API — combining these would give it the most complete command list of any tool.

If DorkOS were to add routing metadata similar to OpenCode's (`agent`, `model`, `subtask`), it could use custom commands to dispatch work to different agents by name — which would be a meaningful differentiator.

---

## Sources & Evidence

- [Commands — OpenCode Docs](https://opencode.ai/docs/commands/) — Primary: full spec for OpenCode custom commands
- [Custom slash commands feature request — sst/opencode #299](https://github.com/sst/opencode/issues/299) — Implementation history, XDG path decision
- [Cursor 1.6 Changelog — Slash Commands](https://cursor.com/changelog/1-6) — Announcement of Cursor custom slash commands feature
- [cursor-commands GitHub repo](https://github.com/hamzafer/cursor-commands) — Community examples of Cursor command format
- [This New Cursor Feature Changes Everything — ReactSquad](https://www.reactsquad.io/blog/this-new-cursor-feature-changes-everything-slash-commands) — Cursor parameter passing and SudoLang usage
- [Custom Prompts — OpenAI Codex Docs](https://developers.openai.com/codex/custom-prompts/) — Primary: full Codex custom prompt spec (storage, frontmatter, placeholder syntax)
- [Slash Commands — OpenAI Codex Docs](https://developers.openai.com/codex/cli/slash-commands/) — Codex built-in commands reference
- [Workflows — Windsurf Docs](https://docs.windsurf.com/windsurf/cascade/workflows) — Primary: full Windsurf workflow spec (storage, scopes, discovery)
- [In-chat commands — Aider](https://aider.chat/docs/usage/commands.html) — Aider built-in commands reference
- [Custom commands feature request — Aider-AI/aider #894](https://github.com/Aider-AI/aider/issues/894) — July 2024 custom commands FR, unimplemented
- [Custom commands question — Aider-AI/aider #4235](https://github.com/Aider-AI/aider/issues/4235) — June 2025 confirmation custom commands still not implemented
- [Slash Commands — Continue Docs](https://docs.continue.dev/customize/slash-commands) — Continue slash command overview
- [Prompts Deep Dive — Continue Docs](https://docs.continue.dev/customize/deep-dives/prompts) — Continue prompt file frontmatter fields
- [Continue Dev Prompts Deep Dive — PRPM](https://prpm.dev/blog/continue-deep-dive) — Third-party confirming `.continue/prompts/` path
- [Using Slash Commands in Continue](https://docs.continue.dev/actions/how-to-use-it) — Continue invocation patterns
- Existing DorkOS research: `research/20260315_agent_sdk_slash_command_discovery_api.md` — Claude Code SDK command discovery API detail

---

## Research Gaps & Limitations

- **Cursor frontmatter spec:** Cursor's official docs do not publish a formal frontmatter schema for `.cursor/commands/` files. Community examples vary widely (freeform markdown, SudoLang, prose sections). The lack of a spec is likely intentional.
- **Windsurf frontmatter:** Windsurf does not publish a workflow frontmatter schema. Enterprise system-scope workflows were documented but the format was not confirmed independently.
- **Continue.dev user-level path:** The `~/.continue/prompts/` path was inferred from the project-level `.continue/prompts/` convention and third-party sources. Not confirmed from official docs directly.
- **OpenCode XDG path ambiguity:** Issue #299 mentions `~/.local/opencode/` (XDG data) while the official docs show `~/.config/opencode/commands/` (XDG config). The exact path may depend on OS defaults.
- **Skills format:** This research focused on commands/slash commands. The emerging `skills/` directories across all tools were noted but not fully researched — this is a separate research area.

---

## Contradictions & Disputes

- **Codex custom prompts deprecation:** OpenAI's Codex docs note that custom prompts (`~/.codex/prompts/`) are "deprecated in favor of skills." However, the feature still works and is documented — it is soft-deprecated, not removed.
- **Continue.dev `invokable` behavior:** Some Continue community issues report that prompt files don't reliably appear as slash commands, suggesting the discovery mechanism has had bugs (`Do \`Prompt files\` actually work? #2342`). The feature is marked experimental in some contexts.

---

## Search Methodology

- Searches performed: 14 (8 WebSearch + 6 WebFetch calls)
- Most productive searches: direct fetches of opencode.ai/docs/commands, developers.openai.com/codex/custom-prompts, docs.windsurf.com/windsurf/cascade/workflows
- Primary information sources: official documentation sites, GitHub issue trackers, community blogs
- Prior cached research (`20260315_agent_sdk_slash_command_discovery_api.md`) provided the complete Claude Code section without additional searches
