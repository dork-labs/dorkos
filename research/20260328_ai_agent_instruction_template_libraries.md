---
title: 'AI Coding Agent Instruction & Template Libraries — Cross-Tool Comparison'
date: 2026-03-28
type: external-best-practices
status: active
tags:
  [
    AGENTS.md,
    AGENTS.md,
    cursorrules,
    windsurf,
    aider,
    continue-dev,
    codex,
    instruction-files,
    template-library,
    skills,
    context-injection,
    progressive-loading,
    hierarchical-rules,
  ]
searches_performed: 12
sources_count: 34
---

## Research Summary

Every major AI coding agent (Claude Code, Cursor, Windsurf, Codex, Aider, Continue.dev) has converged on markdown files as the instruction carrier format. The critical divergence is in _loading strategy_: most tools load all instructions eagerly at session start, while Claude Code and Codex CLI have introduced genuine **progressive/lazy loading** through their Skills systems. AGENTS.md has emerged as the closest thing to a universal cross-tool standard (Linux Foundation, 60,000+ projects) but each tool also maintains its own file format with additional capabilities. For template library organization, the most sophisticated pattern is the Claude Code Skills + rules directory system, which cleanly separates always-loaded context, path-scoped rules, and lazily-loaded reusable modules.

---

## Key Findings

1. **Progressive loading exists in exactly two tools (Claude Code and Codex)**: Claude Code's SKILL.md system and Codex's Skills system both implement three-level lazy loading: (a) skill name + description loaded at startup (~30-50 tokens each), (b) full body loaded on invocation, (c) supporting files loaded on demand within a skill. All other tools (Cursor, Windsurf, Aider, Continue.dev) load instructions eagerly at session start.

2. **Hierarchical instruction structures are near-universal**: Claude Code, Cursor, Windsurf, Codex, and Continue.dev all support nested/scoped instruction files. The pattern is: global user-level → project-level → subdirectory-level. Aider is the exception — it has no hierarchical loading, only explicit file includes.

3. **Path-scoped conditional loading is a first-class feature in Claude Code, Cursor, and Continue.dev**: All three support glob-pattern frontmatter that limits when a rule fires. Claude Code's `.claude/rules/` `paths` field, Cursor's `globs` field, and Continue.dev's `globs` field all work identically. This is the primary mechanism for keeping large instruction sets from bloating every session.

4. **AGENTS.md is the interoperability bridge**: Every tool except Aider natively reads AGENTS.md to some degree. The canonical pattern for teams maintaining a single source of truth is: maintain one `AGENTS.md` at the repo root, then have tool-specific files (`AGENTS.md`, `.cursor/rules/*.mdc`, etc.) import or symlink to it for tool-specific additions.

5. **Claude Code's instruction system is the most architecturally sophisticated**: It has five distinct layers (managed policy → user → project → rules directory → skills), with three different loading models (always-eager, path-triggered, and lazy-on-demand). No other tool has this range.

6. **OpenClaw's SKILL.md standard is cross-tool**: Claude Code's skills follow the [Agent Skills open standard](https://agentskills.io), which works across multiple AI tools. Both Claude Code and Codex implement compatible variants of the progressive skill disclosure model.

---

## Detailed Analysis Per Tool

### 1. Claude Code

#### File Format and Locations

Claude Code has five instruction layers, loaded in priority order from lowest to highest:

| Layer          | Location                                                    | Scope                                 | Who writes it                 |
| -------------- | ----------------------------------------------------------- | ------------------------------------- | ----------------------------- |
| Managed policy | `/Library/Application Support/ClaudeCode/AGENTS.md` (macOS) | All users on a machine                | IT/DevOps, cannot be excluded |
| User-global    | `~/.claude/AGENTS.md`                                       | All projects on your machine          | Individual developer          |
| User rules     | `~/.claude/rules/*.md`                                      | All projects, glob-scoped             | Individual developer          |
| Project        | `./AGENTS.md` or `./.claude/AGENTS.md`                      | This project                          | Team (version-controlled)     |
| Project rules  | `.claude/rules/**/*.md`                                     | This project, glob-scoped             | Team (version-controlled)     |
| Skills         | `.claude/skills/<name>/SKILL.md`                            | This project (or `~/.claude/skills/`) | Individual or team            |
| Auto memory    | `~/.claude/projects/<project>/memory/MEMORY.md`             | Per project                           | Claude writes itself          |

`AGENTS.md` content is delivered as a **user message after the system prompt** (not as system prompt). Skills inject into the system prompt layer. This is architecturally significant — it means AGENTS.md instructions can be "overridden" by conversational flow in a way that system prompt injections cannot.

#### Hierarchical Loading

Claude Code walks the directory tree upward from the working directory, loading every `AGENTS.md` it finds. Running from `packages/web/` loads both `packages/web/AGENTS.md` and root `AGENTS.md`. Subdirectory `AGENTS.md` files load _on demand_ when Claude reads files in those subdirectories — they are not eagerly loaded at session start.

```
monorepo/
├── AGENTS.md              # loaded at launch (walk-up)
├── packages/
│   ├── web/
│   │   ├── AGENTS.md      # loaded at launch (we're running from here)
│   │   └── .claude/
│   │       └── rules/
│   │           └── react.md   # loaded if paths match
│   └── server/
│       └── AGENTS.md      # loaded ON DEMAND when Claude reads server/ files
```

`@path/to/import` syntax allows AGENTS.md files to import other files, with up to 5 hops of recursion. This enables a DorkOS-style approach where the root `AGENTS.md` contains `@AGENTS.md` to remain compatible with other tools:

```markdown
@AGENTS.md

## Claude Code Specific

Use plan mode for changes under src/billing/.
```

#### Path-Scoped Rules

The `.claude/rules/` directory supports YAML frontmatter `paths` fields with glob patterns. Rules without `paths` are always loaded. Rules with `paths` only load when Claude is working with matching files:

```markdown
---
paths:
  - 'src/api/**/*.ts'
---

# API Development Rules

All endpoints must include Zod validation.
```

Rules are discovered recursively from `.claude/rules/`, so subdirectories (`frontend/`, `backend/`) work natively. Symlinks in the rules directory are resolved — this is the mechanism for sharing rules across projects without duplication.

The `claudeMdExcludes` setting allows skipping specific AGENTS.md files in monorepos where other teams' instruction files are irrelevant.

#### Skills — The Progressive Loading System

Skills are the most distinctive feature of Claude Code's instruction system. They implement a three-level progressive disclosure model:

**Level 1 — Metadata** (always in context, ~30-50 tokens per skill):

```yaml
name: explain-code
description: Explains code with visual diagrams. Use when explaining how code works.
```

**Level 2 — Full SKILL.md body** (loaded on invocation):
The complete instructions, only fetched when Claude determines the skill is relevant or you invoke it with `/skill-name`.

**Level 3 — Supporting files** (loaded on demand within skill):

```
.claude/skills/my-skill/
├── SKILL.md           # overview + navigation
├── reference.md       # loaded when needed (referenced from SKILL.md)
├── examples.md        # loaded when needed
└── scripts/
    └── helper.py      # executed, not loaded into context
```

Skills support additional frontmatter capabilities absent from AGENTS.md/rules:

- `disable-model-invocation: true` — human-only invocation (for deploy, commit, etc.)
- `user-invocable: false` — Claude-only, hidden from `/` menu
- `context: fork` — runs in an isolated subagent context
- `allowed-tools` — restrict which tools are active for this skill
- `paths` — glob-scoped auto-activation (same as rules)
- `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` — argument substitution
- `` !`command` `` — shell preprocessing before skill content is sent to Claude

Skills follow the [Agent Skills open standard](https://agentskills.io) and work across multiple AI tools that implement the standard.

#### Auto Memory

Claude writes its own memory to `~/.claude/projects/<project>/memory/MEMORY.md`. The first 200 lines (or 25KB) are loaded at session start. Topic files (`debugging.md`, `patterns.md`) are not loaded at startup but read on demand. This is a form of agent-maintained lazy loading distinct from developer-authored instructions.

**Key distinction: AGENTS.md vs Rules vs Skills**

|                     | AGENTS.md                 | .claude/rules/           | Skills                        |
| ------------------- | ------------------------- | ------------------------ | ----------------------------- |
| Loading             | Always, at startup        | Always or path-triggered | Metadata only; body on demand |
| Granularity         | Project-wide              | Per-file-type            | Per-workflow                  |
| Use case            | Architecture, conventions | Type-specific rules      | Repeatable procedures         |
| Arguments           | No                        | No                       | Yes ($ARGUMENTS)              |
| Shell preprocessing | No                        | No                       | Yes (!`command`)              |
| Subagent execution  | No                        | No                       | Yes (context: fork)           |

---

### 2. Cursor

#### File Format and Locations

Cursor has two instruction file formats:

1. **Legacy** (still supported): `.cursorrules` at project root — a single flat markdown file
2. **Current** (recommended): `.cursor/rules/*.mdc` — directory of MDC files with YAML frontmatter

The `.mdc` (Modular Markdown Configuration) format:

```markdown
---
description: 'React component guidelines'
globs: ['src/components/**/*.tsx']
alwaysApply: false
---

# React Component Rules

- Use named exports
- Props interface above component
```

Global user-level rules live in Cursor's settings panel (not a filesystem file) or can be set in `~/.cursor/rules/` for personal cross-project rules.

#### Hierarchical Loading

Cursor supports a three-tier hierarchy:

- **Team rules** → committed `.cursor/rules/` in the repo
- **Project rules** → local `.cursor/rules/` (gitignored)
- **User rules** → Cursor settings or `~/.cursor/rules/`

All applicable rules merge; earlier sources are overridden by more specific ones. Nested `AGENTS.md` files in subdirectories are automatically applied to their scope.

#### Rule Activation Types

Four modes:

1. **Always Apply** (`alwaysApply: true`) — every chat session, every request
2. **Auto-attached** (`globs` specified, `alwaysApply: false`) — triggered when file matches pattern
3. **Agent-requested** (`description` specified, no `globs`) — Claude decides when relevant
4. **Manual** — user `@mentions` the rule file explicitly

There is no lazy loading of rule content — full file content loads on activation. The glob-pattern approach reduces noise but doesn't defer content loading the way Claude Code's skills do.

#### Organization Recommendations

Community best practices from Cursor forums:

- Prefix files with numbers for load order control: `01-core.mdc`, `02-react.mdc`
- Keep each rule file under 500 lines; split by domain
- `alwaysApply: true` should be reserved for absolute must-haves (~5-10 rules max)
- Use `globs` aggressively — a React rule should not load when editing a Python file

The `sanjeed5/awesome-cursor-rules-mdc` GitHub repository catalogs community-created rule libraries (a de facto template library for Cursor).

---

### 3. Windsurf / Codeium

#### File Format and Locations

Two rule tiers:

1. **Global** rules: `global_rules.md` — applies to all workspaces
2. **Workspace** rules: `.windsurf/rules/*.md` — workspace-specific, committed to the project

Legacy format: `.windsurfrules` at project root (still supported).

**Hard limits**: individual rule files capped at 6,000 characters; total combined global + local must not exceed 12,000 characters. Content beyond these limits is silently truncated.

#### Context Injection Pipeline

Windsurf assembles context in this order before each LLM call:

1. Global `global_rules.md`
2. Workspace `.windsurf/rules/*.md` files
3. Memories (workspace-level notes Cascade accumulates)
4. Open files (editor context)
5. Codebase retrieval results
6. Recent actions

There is no hierarchical subdirectory loading and no path-scoped conditional loading. All workspace rules load for all files.

#### Memories

Windsurf's Cascade has a separate "Memories" system — structured notes the AI accumulates per workspace. This is analogous to Claude Code's auto memory but managed at the workspace level rather than per-project.

#### Key Limitation

No progressive loading. No file-import syntax. No skills concept. The 12,000-character total limit is binding — teams with large instruction sets must be very selective. This is the most constrained instruction system of the tools surveyed.

---

### 4. OpenAI Codex CLI

#### File Format and Locations

Codex reads `AGENTS.md` files using a hierarchical walk-down approach:

1. **Global**: `~/.codex/AGENTS.md` (or `AGENTS.override.md` if present)
2. **Project**: starting from git root, walking down to cwd, picking up one file per directory

The system searches for files in this precedence at each level:

1. `AGENTS.override.md` (explicit override — takes precedence over base)
2. `AGENTS.md`
3. Fallback filenames from `project_doc_fallback_filenames` in `~/.codex/config.toml`

Empty files are skipped. Loading stops when combined size reaches `project_doc_max_bytes` (32 KiB default, configurable).

#### Hierarchical Loading

Files are concatenated with blank lines between them. Later files (closer to cwd) override earlier guidance due to position in the final combined prompt. This is the "nearest wins" pattern:

```
repo/
├── AGENTS.md              # global project rules
├── packages/
│   ├── web/
│   │   └── AGENTS.md      # web-specific overrides (loaded last for web/)
│   └── api/
│       └── AGENTS.md      # api-specific overrides (loaded last for api/)
```

#### Skills — Progressive Loading

Codex has a Skills system analogous to Claude Code's:

```
.agents/skills/
└── my-skill/
    ├── SKILL.md           # frontmatter + instructions
    ├── scripts/           # executable utilities
    ├── references/        # supporting docs
    ├── assets/            # templates
    └── agents/openai.yaml # UI and dependency configuration
```

SKILL.md frontmatter:

```yaml
---
name: skill-name
description: When this skill should/shouldn't trigger
---
```

Progressive disclosure: at session start, Codex loads only `name`, `description`, and file path for each skill. Full `SKILL.md` instructions load only when the skill is invoked (implicit from task match or explicit via `$skill` mention).

Skill discovery hierarchy (in order):

- `.agents/skills/` in cwd (repo-scoped)
- `.agents/skills/` in parent directories (shared organizational level)
- `$HOME/.agents/skills` (user-level)
- `/etc/codex/skills` (system/admin-level)
- Built-in system skills

The `agents/openai.yaml` metadata file controls UI presentation (`display_name`, `icon`, `brand_color`, `default_prompt`) and policy (`allow_implicit_invocation: true/false` — whether Codex can auto-invoke the skill or requires explicit `$skillname`).

Skills package into **Plugins** for distribution: a plugin bundles multiple skills, app mappings, MCP server configuration, and presentation assets into installable packages.

---

### 5. Aider

#### File Format and Location

Aider uses a conventional "conventions file" — any markdown or text file, by default named `CONVENTIONS.md`. This is the simplest instruction system of all tools surveyed.

Loading methods:

```bash
# Per-session CLI
aider --read CONVENTIONS.md

# Config file (.aider.conf.yml)
read: CONVENTIONS.md
# or multiple:
read: [CONVENTIONS.md, docs/api-conventions.md, security.md]
```

The `--read` / `/read` flag marks files as read-only, enabling **prompt caching** if the provider supports it. This is a meaningful performance optimization — a read-only conventions file is cached after the first request and reused, reducing latency and cost on subsequent turns.

#### No Hierarchy, No Progressive Loading

Aider has no hierarchical loading, no path-scoped activation, and no lazy loading. All `read:` files are loaded as-is at session start. There is no concept of rules directories, glob patterns, or skills.

Multiple files can be included, but organization is entirely manual. Community patterns:

- Split by concern: `read: [CONVENTIONS.md, TESTING.md, ARCHITECTURE.md]`
- Commit conventions files to the repo; add `--read CONVENTIONS.md` to `.aider.conf.yml`

#### AGENTS.md Note

Aider does not natively read `AGENTS.md`. If using both Aider and other tools on the same repo, the pattern is to name the shared file `AGENTS.md` and reference it in Aider's `read:` config explicitly.

There is a community repository (`aider-conventions`) of shared conventions files for different languages and frameworks — a grassroots template library.

#### Proposed Future Enhancement

An `--system-prompt-extras <file>` feature was proposed in a GitHub issue (#4817) to allow direct system prompt injection from a file, but had not shipped as of this research date. Current workarounds use `--read` with read-only flag.

---

### 6. Continue.dev

#### File Format and Locations

Continue uses markdown files in `.continue/rules/` directories:

```
project/
└── .continue/
    └── rules/
        ├── 01-coding-standards.md
        ├── 02-testing.md
        └── api/
            └── endpoints.md
~/.continue/
└── rules/
    └── personal-preferences.md
```

Files support YAML frontmatter:

```yaml
---
name: API Guidelines
globs: ['src/api/**/*.ts']
alwaysApply: false
description: 'REST API design conventions'
---
```

Additionally, Continue has a **Hub** system: rules can be stored in Continue's Mission Control cloud platform and referenced in `config.yaml` via `uses: username/rule-name` — no local file is created. This is the closest thing to a centralized template library in the tools surveyed.

#### Hierarchical Loading Order

1. Hub assistant rules (if using cloud-based assistant)
2. Referenced Hub rules via `uses:` declarations
3. Local workspace rules from `.continue/rules/`
4. Global rules from `~/.continue/rules/`

Files load in **lexicographical order**. Prefix with numbers (`01-`, `02-`) to control sequence.

#### Rule Activation Modes

- `alwaysApply: true` — included in every session
- `alwaysApply: false` with `globs` — included when file matches pattern
- `alwaysApply: false` with `description` only — Agent selects when relevant
- Default (no frontmatter) — included if no globs specified OR globs match

`regex` field: match file _content_ patterns to trigger rules (not just file paths). This enables rules like "apply security guidelines when file contains 'database connection'."

#### Scope Restriction

Rules are excluded from autocomplete and apply model roles — they only affect Agent, Chat, and Edit modes. This is a deliberate design choice to keep the autocomplete model lightweight.

---

## Comparative Matrix

|                                 | Claude Code                  | Cursor                   | Windsurf                     | Codex CLI         | Aider           | Continue.dev          |
| ------------------------------- | ---------------------------- | ------------------------ | ---------------------------- | ----------------- | --------------- | --------------------- |
| **Primary file**                | AGENTS.md                    | .cursor/rules/\*.mdc     | .windsurf/rules/\*.md        | AGENTS.md         | CONVENTIONS.md  | .continue/rules/\*.md |
| **AGENTS.md support**           | Via @import                  | Native (subdirectory)    | Via .windsurfrules or import | Native (primary)  | Manual --read   | Partial               |
| **Hierarchical loading**        | Yes (5 levels)               | Yes (3 levels)           | Partial (2 levels)           | Yes (walk-down)   | No              | Yes (3 levels)        |
| **Path-scoped rules**           | Yes (paths: glob)            | Yes (globs:)             | No                           | No                | No              | Yes (globs: + regex:) |
| **Progressive/lazy loading**    | Yes (skills)                 | No                       | No                           | Yes (skills)      | No              | No                    |
| **Template library concept**    | Skills + ClaudeHub           | awesome-cursor-rules-mdc | None official                | Skills + plugins  | Community repo  | Continue Hub          |
| **Character/token limits**      | None explicit                | None explicit            | 12,000 chars total           | 32 KiB combined   | None explicit   | None explicit         |
| **@import / cross-file refs**   | Yes (@path)                  | No                       | No                           | No                | Multiple --read | No                    |
| **Shell preprocessing**         | Yes (skills: !`cmd`)         | No                       | No                           | No                | No              | No                    |
| **Auto memory (agent-written)** | Yes (MEMORY.md)              | No                       | Yes (Memories)               | No                | No              | No                    |
| **Org-wide managed policy**     | Yes (/Library/.../AGENTS.md) | No                       | No                           | /etc/codex/skills | No              | No                    |

---

## Loading Strategy Deep Dive

### Eager Loading (All Files at Session Start)

**Cursor**, **Windsurf**, **Aider**, and **Continue.dev** load all matching instructions at the beginning of each session. The filtering mechanism is:

- Cursor: `alwaysApply` + `globs` determine which files load
- Windsurf: all workspace rules load, no per-file filtering
- Aider: all `read:` files load
- Continue.dev: `globs` + `alwaysApply` determine which files load

For large instruction sets, this means the entire relevant instruction corpus occupies context tokens before any user message is processed. This is the dominant approach but creates context window pressure.

### Progressive Loading (Metadata First, Body on Demand)

**Claude Code** and **Codex CLI** both implement the same three-level progressive disclosure:

```
Session Start:
  └── Load: [skill-name + description, 30-50 tokens each]
      All skill descriptions are in context, full bodies are not

Task arrives:
  └── Claude/Codex evaluates: "Is skill X relevant?"
  └── If yes: load full SKILL.md body into context
      └── If SKILL.md references other files: load those on demand

Result: 95%+ of instruction content never enters context for irrelevant skills
```

This architectural difference is significant for teams maintaining large instruction libraries. With eager loading, 50 rules = 50 rule files' worth of tokens consumed per session. With skill-based progressive loading, 50 skills = 50 short descriptions + the 1-3 skills that fire per session.

**The practical threshold**: For projects with fewer than 10-15 instruction files covering distinct domains, eager loading and progressive loading have similar token budgets. Progressive loading becomes meaningfully advantageous above that threshold.

---

## AGENTS.md as Universal Standard

`AGENTS.md` (maintained by the Agentic AI Foundation under the Linux Foundation) is the closest thing to a universal instruction file standard as of 2026:

- Used natively by: Codex CLI, GitHub Copilot, Cursor (subdirectory AGENTS.md), Amp, Devin, OpenHands, Continue.dev
- 60,000+ open-source projects
- Hierarchical: project root + any subdirectory, nearest file takes precedence

**The canonical cross-tool pattern for teams:**

```
repo/
├── AGENTS.md              # Universal: works with Codex, Copilot, Amp, Devin
├── AGENTS.md              # @AGENTS.md + Claude-specific additions
├── .cursor/rules/
│   ├── core.mdc           # alwaysApply: true
│   └── frontend.mdc       # globs: ["src/**/*.tsx"]
└── .continue/rules/
    └── conventions.md     # mirrors AGENTS.md content
```

For organizations where multiple developers use different tools on the same codebase, the symlink/import pattern avoids duplication:

```bash
# .cursor/rules/shared.mdc imports from AGENTS.md content
# AGENTS.md imports: @AGENTS.md
# .windsurfrules imports: (manual copy, Windsurf has no import syntax)
```

**ETH Zurich research finding (2026)**: AGENTS.md files with LLM-generated boilerplate _reduce_ AI coding performance. Best practice: omit anything inferable, focus on non-obvious tooling, custom build commands, and project-specific constraints. The more generic the instruction, the less value it adds.

---

## Template Library Organization Patterns

### Pattern 1: Rules-Directory Taxonomy (Claude Code / Cursor / Continue.dev)

Organize by concern, use numeric prefixes for load order, glob-scope by file type:

```
.claude/rules/
├── 00-always/
│   ├── architecture.md          # alwaysApply (no paths field)
│   └── security.md              # alwaysApply
├── 01-frontend/
│   ├── react.md                 # paths: ["src/**/*.tsx"]
│   ├── styling.md               # paths: ["src/**/*.css", "src/**/*.ts"]
│   └── testing.md               # paths: ["**/*.test.tsx"]
├── 02-backend/
│   ├── api.md                   # paths: ["src/api/**/*.ts"]
│   └── database.md              # paths: ["src/db/**/*.ts"]
└── 03-shared/
    └── types.md                 # paths: ["**/*.types.ts"]
```

Symlink shared organizational standards:

```bash
ln -s ~/company-standards/security.md .claude/rules/00-always/company-security.md
```

### Pattern 2: Skills as Reusable Procedures (Claude Code / Codex)

Reserve AGENTS.md/rules for context and conventions. Use skills for reusable procedures:

```
.claude/
├── AGENTS.md                    # Project architecture, team conventions
├── rules/
│   ├── api-design.md            # paths: ["src/api/**"]
│   └── testing.md               # paths: ["**/*.test.ts"]
└── skills/
    ├── commit/
    │   └── SKILL.md             # /commit workflow (disable-model-invocation: true)
    ├── pr-review/
    │   └── SKILL.md             # /pr-review procedure
    ├── debug-api/
    │   ├── SKILL.md             # /debug-api with dynamic context injection
    │   └── patterns.md          # reference: known bug patterns (loaded on demand)
    └── deploy/
        ├── SKILL.md             # disable-model-invocation: true
        ├── checklist.md
        └── scripts/
            └── pre-deploy.sh
```

This pattern keeps the always-in-context footprint minimal while making the full procedure library available on demand.

### Pattern 3: Multi-Agent Instruction Isolation

For DorkOS-style multi-agent setups where different agents have different roles:

```
project/
├── AGENTS.md                    # Universal conventions (all agents)
├── agents/
│   ├── researcher/
│   │   └── AGENTS.md           # @../AGENTS.md + research-specific rules
│   ├── coder/
│   │   └── AGENTS.md           # @../AGENTS.md + coding-specific rules
│   └── reviewer/
│       └── AGENTS.md           # @../AGENTS.md + review-specific rules
```

Each agent runs from its own directory, picking up both the shared `AGENTS.md` (via @import) and its role-specific instructions. This is the "fallback then override" model: org-level template + per-agent role additions.

### Pattern 4: Monorepo Package Isolation

```
monorepo/
├── AGENTS.md                    # Root: project-wide conventions
├── AGENTS.md                    # Root: @AGENTS.md + Claude-specific
├── packages/
│   ├── web/
│   │   ├── AGENTS.md           # Lazy-loaded when Claude reads web/ files
│   │   └── AGENTS.md           # Override for web-specific conventions
│   ├── server/
│   │   ├── AGENTS.md           # Lazy-loaded when Claude reads server/ files
│   │   └── AGENTS.md           # Override for server-specific conventions
│   └── shared/
│       └── AGENTS.md           # Shared types/utils conventions
```

Claude Code's subdirectory AGENTS.md lazy loading and Codex's walk-down AGENTS.md loading both support this pattern natively.

---

## Best Practices for Template Library Organization

### What to put in each layer

**Always-loaded (AGENTS.md / .claude/rules/ without paths)**:

- Project architecture overview (folder structure, service boundaries)
- Critical conventions that apply everywhere (naming, error handling, testing requirements)
- Must-know commands (`pnpm dev`, `pnpm test`, build pipeline)
- Non-obvious decisions with the _why_ (the reasoning, not just the rule)
- Target: under 200 lines total across all always-loaded content

**Path-scoped rules**:

- Language or framework conventions (React rules, SQL guidelines)
- Test file conventions (separate from source file conventions)
- Config file handling
- Security patterns for specific modules
- Target: 1 rule per domain, load only when in that domain

**Skills (if available)**:

- Repeatable multi-step procedures (commit workflow, PR review, deploy checklist)
- Complex workflows with branching logic
- Anything that needs dynamic shell preprocessing (`!`command``)
- Background reference material that's large but sometimes needed
- Target: each skill under 500 lines, move detail to supporting files

**Avoid putting in instruction files**:

- Information the LLM already knows (standard library docs, common patterns)
- LLM-generated boilerplate (ETH Zurich research: this reduces performance)
- Anything that would be obvious to a competent developer
- Duplicate content from README.md (use @import instead)

### Version control and governance

- Commit `.claude/rules/`, `.cursor/rules/`, `.continue/rules/` to version control
- Use CODEOWNERS to require review from a small group for instruction file changes
- Treat instruction PRs like code PRs: describe the behavior change, not just the text change
- Add changelog entries when behavior changes (instructions are observable contracts)

### For organizations / template distribution

- **Claude Code**: Managed policy AGENTS.md at `/Library/Application Support/ClaudeCode/AGENTS.md`, enforced and un-excludable
- **Claude Code**: Org-wide skills via managed settings
- **Codex**: System-level skills at `/etc/codex/skills`
- **Continue.dev**: Hub rules via `uses: org-name/rule-name` in config.yaml
- **All tools**: Maintain a template repo with starter instruction sets per project type; new projects clone the template set

---

## Research Gaps & Limitations

- **Windsurf's newer features**: Windsurf is evolving rapidly; the 12,000-character limit and lack of path-scoped rules may have changed since this research.
- **GitHub Copilot not covered**: Copilot's `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md` system (with glob-pattern frontmatter, since July 2025) was not investigated in depth.
- **AgentSkills open standard coverage**: The `agentskills.io` standard that Claude Code implements was mentioned but not fully documented here; other tools implementing it beyond Claude Code and Codex were not enumerated.
- **Continue Hub**: The Continue Mission Control cloud platform for team-managed rules was mentioned but the pricing and feature set were not verified.
- **Aider `--system-prompt-extras`**: Whether this proposed feature shipped after the research date on the prior report is unknown.

---

## Contradictions & Disputes

- **ETH Zurich vs conventional wisdom**: The 2026 ETH Zurich study found that AGENTS.md files often reduce AI performance due to LLM-generated boilerplate. This contradicts the "more context is better" intuition many developers follow. The resolution: specificity matters more than volume. Human-written, non-inferable instructions help; generic LLM-generated instructions hurt.
- **Progressive vs eager loading**: Cursor's community forum suggests that having all rules always-available (eager) reduces the risk of Claude "missing" a relevant rule. Claude Code's progressive model is more token-efficient but requires good skill descriptions for automatic invocation to work. Both approaches are valid; the choice depends on how many distinct rule domains the project has.

---

## Sources & Evidence

- [How Claude remembers your project — Claude Code Docs](https://code.claude.com/docs/en/memory) — Definitive source for AGENTS.md hierarchy, loading order, @import, paths frontmatter, auto memory
- [Extend Claude with skills — Claude Code Docs](https://code.claude.com/docs/en/skills) — Definitive source for SKILL.md format, progressive loading, frontmatter fields, supporting files, invocation control
- [Rules — Cursor Docs](https://cursor.com/docs/context/rules) — MDC format, activation types, frontmatter fields
- [Custom instructions with AGENTS.md — Codex OpenAI Developers](https://developers.openai.com/codex/guides/agents-md) — AGENTS.md hierarchy, walk-down loading, size limits, override files
- [Agent Skills — Codex OpenAI Developers](https://developers.openai.com/codex/skills) — SKILL.md format, progressive disclosure, openai.yaml, skill discovery hierarchy, plugins
- [Specifying coding conventions — Aider](https://aider.chat/docs/usage/conventions.html) — --read flag, .aider.conf.yml, prompt caching
- [How to Create and Manage Rules in Continue — Continue Docs](https://docs.continue.dev/customize/deep-dives/rules) — rule format, locations, hierarchical loading, globs + regex, Hub system
- [Cascade Memories — Windsurf Docs](https://docs.windsurf.com/windsurf/cascade/memories) — Memories system, workspace rules
- [Windsurf Rules & Workflows — Paul Duvall](https://www.paulmduvall.com/using-windsurf-rules-workflows-and-memories/) — .windsurf/rules structure, global vs workspace
- [AGENTS.md — agents.md](https://agents.md/) — Cross-tool standard, Linux Foundation stewardship
- [AGENTS.md — agentsmd/agents.md GitHub](https://github.com/agentsmd/agents.md) — Open format specification
- [AGENTS.md, AGENTS.md, and Every AI Config File Explained — DeployHQ](https://www.deployhq.com/blog/ai-coding-config-files-guide) — Cross-tool comparison, symlink patterns
- [New Research Reassesses the Value of AGENTS.md Files — InfoQ (ETH Zurich)](https://www.infoq.com/news/2026/03/agents-context-file-value-review/) — Academic finding on LLM-generated boilerplate reducing performance
- [AGENTS.md: A New Standard for Unified Coding Agent Instructions — Addo Zhang](https://addozhang.medium.com/agents-md-a-new-standard-for-unified-coding-agent-instructions-0635fc5cb759) — Symlink patterns, team organization
- [awesome-cursor-rules-mdc — GitHub](https://github.com/sanjeed5/awesome-cursor-rules-mdc) — Community template library for Cursor rules
- [Mastering Claude Skills: Progressive Context Loading — Remio AI](https://www.remio.ai/post/mastering-claude-skills-progressive-context-loading-for-efficient-ai-workflows) — Three-level progressive loading explained
- [Claude Skills and Subagents — Towards Data Science](https://towardsdatascience.com/claude-skills-and-subagents-escaping-the-prompt-engineering-hamster-wheel/) — Skills vs AGENTS.md distinction
- Prior research: `research/20260321_openclaw_ai_convention_markdown_files.md` — OpenClaw workspace file system, NOPE.md, AGENTS.md history
- Prior research: `research/20260321_agent_personality_convention_files_impl.md` — Multi-runtime injection mechanisms, OpenCode, Codex, Aider, Continue system prompt injection

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "Claude Code AGENTS.md hierarchical loading subdirectory rules 2026", "Claude Code skills SKILL.md progressive loading lazy context window 2026", "Cursor .cursor/rules mdc files hierarchical context injection 2026", "OpenAI Codex CLI AGENTS.md hierarchical loading progressive 2026", "Continue.dev rules context injection per-project 2026"
- Primary sources: code.claude.com/docs, cursor.com/docs, developers.openai.com/codex, aider.chat/docs, docs.continue.dev, docs.windsurf.com
- Prior research leveraged: 2 highly relevant reports covering OpenClaw workspace conventions and multi-runtime injection mechanisms
