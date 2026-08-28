---
title: 'skills.sh Marketplace: Format Specification, Distribution Model, and Claude Code Integration'
date: 2026-03-29
type: external-best-practices
status: active
tags:
  [
    skills,
    claude-code,
    agent-skills,
    skills-sh,
    agentskills-io,
    open-standard,
    marketplace,
    SKILL.md,
  ]
searches_performed: 14
sources_count: 18
---

# Research Summary

skills.sh is a community-driven directory and leaderboard for "agent skills" — reusable instruction packages for AI coding agents. It is NOT a format standard itself; it is a discovery and tracking layer on top of the **Agent Skills open standard** (`agentskills.io`), which was originally developed by Anthropic and released as an open spec. The `SKILL.md` format is the universal artifact: a markdown file with YAML frontmatter that works across 30+ agents (Claude Code, Cursor, GitHub Copilot, Gemini CLI, OpenAI Codex, Roo Code, and many more). Claude Code is the reference implementation and has the richest feature set, adding Claude-specific extensions on top of the base spec.

---

## Key Findings

1. **skills.sh is a directory, not a registry**: It tracks installs via telemetry and surfaces popular skills. There is no submission form or approval process — skills appear automatically once installed through the `npx skills` CLI.

2. **The format is `agentskills.io`**: The canonical open standard lives at `agentskills.io`. The base spec is minimal: a `SKILL.md` file in a directory, with required `name` + `description` frontmatter fields. Claude Code extends this base spec with additional fields.

3. **Claude Code is the richest implementation**: It adds `disable-model-invocation`, `user-invocable`, `context`, `agent`, `hooks`, `paths`, `model`, `effort`, `shell`, `argument-hint`, and string substitutions (`$ARGUMENTS`, `$ARGUMENTS[N]`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`) on top of the base spec.

4. **Distribution is git-based**: Skills live in git repos. `npx skills add owner/repo` fetches from GitHub. No npm publishing required, though npm packaging is a common pattern for wider distribution.

5. **Skills are distinct from Claude Code's native custom commands but merged**: `.claude/commands/` files (legacy) and `.claude/skills/` directories (new) both create slash-commands. Skills are the recommended path as they support additional features.

---

## Detailed Analysis

### 1. What Is skills.sh?

skills.sh (https://skills.sh) is "The Agent Skills Directory" — a web-based leaderboard and discovery catalog for installable agent skill packages. It does not host skill files; it indexes them and tracks installation statistics gathered via telemetry from the `npx skills` CLI.

**Key characteristics:**

- Displays install counts ("774.9K installs" for `find-skills`, "676.2K" for all vercel-labs/agent-skills combined)
- Organizes skills by `owner/repo/skillId` hierarchy
- Shows trending / hot / all-time leaderboards
- No manual submission process — skills appear automatically when users install them
- As of March 2026: ~90,508 total skills listed

**Key pages:**

- `skills.sh/` — leaderboard
- `skills.sh/{owner}/{repo}` — all skills in a repo (e.g., `skills.sh/vercel-labs/agent-skills`)
- `skills.sh/{owner}/{repo}/{skill-name}` — individual skill detail page

### 2. What Is the Agent Skills Open Standard (agentskills.io)?

The Agent Skills format was **originally developed by Anthropic** and **released as an open standard**. The canonical spec lives at https://agentskills.io/specification. It defines:

- The `SKILL.md` file format with YAML frontmatter
- The directory structure (`scripts/`, `references/`, `assets/`)
- The progressive disclosure loading model (3 levels)
- File reference conventions

**Adopted by 30+ tools** as of March 2026: Claude Code, Claude.ai, Claude API, Cursor, GitHub Copilot/VS Code, Gemini CLI, OpenAI Codex, Roo Code, OpenCode, OpenHands, JetBrains Junie, Spring AI, Databricks, Snowflake, Laravel Boost, and many others.

### 3. The SKILL.md Format — Base Spec (agentskills.io)

Every skill is a **directory** containing at minimum a `SKILL.md` file:

```
skill-name/
├── SKILL.md           # Required: metadata + instructions
├── scripts/           # Optional: executable code
├── references/        # Optional: documentation
├── assets/            # Optional: templates, resources
└── ...                # Any additional files
```

#### Required Frontmatter Fields

| Field         | Required | Constraints                                                                                                                                       |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | Max 64 chars. Lowercase letters, numbers, hyphens only. Must not start/end with hyphen. No consecutive hyphens. Must match parent directory name. |
| `description` | Yes      | Max 1024 chars. Non-empty. Should describe what it does AND when to use it.                                                                       |

#### Optional Base Spec Fields

| Field           | Constraints                                                                   |
| --------------- | ----------------------------------------------------------------------------- |
| `license`       | License name or reference to bundled file (e.g., `Apache-2.0`, `Proprietary`) |
| `compatibility` | Max 500 chars. Environment requirements (e.g., `Requires Python 3.14+`)       |
| `metadata`      | Arbitrary key-value map for additional properties                             |
| `allowed-tools` | Space-delimited list of pre-approved tools (experimental)                     |

**Minimal valid SKILL.md:**

```yaml
---
name: skill-name
description: A description of what this skill does and when to use it.
---
# Skill Name

Instructions for the agent to follow when activated.
```

**Full base spec example:**

```yaml
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: '1.0'
allowed-tools: Bash(python *) Read
---
```

### 4. Claude Code Extensions to the Base Spec

Claude Code adds a substantial set of additional frontmatter fields beyond the base spec:

#### Complete Claude Code Frontmatter Reference

| Field                      | Required           | Default           | Description                                                                                                            |
| -------------------------- | ------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                     | No (uses dir name) | directory name    | Lowercase letters, numbers, hyphens, max 64 chars.                                                                     |
| `description`              | Recommended        | First paragraph   | What the skill does. Truncated at 250 chars in listing.                                                                |
| `argument-hint`            | No                 | —                 | Autocomplete hint, e.g. `[issue-number]`.                                                                              |
| `disable-model-invocation` | No                 | `false`           | `true` = only user can invoke. Removes from Claude's context.                                                          |
| `user-invocable`           | No                 | `true`            | `false` = hidden from `/` menu. Only Claude invokes.                                                                   |
| `allowed-tools`            | No                 | —                 | Tools Claude can use without asking permission when skill is active.                                                   |
| `model`                    | No                 | session default   | Model to use when this skill is active.                                                                                |
| `effort`                   | No                 | session default   | `low`, `medium`, `high`, `max` (Opus 4.6 only).                                                                        |
| `context`                  | No                 | inline            | Set to `fork` to run in isolated subagent context.                                                                     |
| `agent`                    | No                 | `general-purpose` | Subagent type when `context: fork`. Built-ins: `Explore`, `Plan`, `general-purpose`, or custom from `.claude/agents/`. |
| `hooks`                    | No                 | —                 | Skill-scoped lifecycle hooks.                                                                                          |
| `paths`                    | No                 | —                 | Glob patterns limiting when skill auto-activates.                                                                      |
| `shell`                    | No                 | `bash`            | Shell for `` !`command` `` blocks: `bash` or `powershell`.                                                             |

#### Invocation Control Matrix (Claude Code specific)

| Frontmatter                      | User can invoke | Claude can invoke | Context loading                                                |
| -------------------------------- | --------------- | ----------------- | -------------------------------------------------------------- |
| (default)                        | Yes             | Yes               | Description always in context, full skill loads when invoked   |
| `disable-model-invocation: true` | Yes             | No                | Description NOT in context, full skill loads when user invokes |
| `user-invocable: false`          | No              | Yes               | Description always in context, full skill loads when invoked   |

#### String Substitutions (Claude Code specific)

| Variable               | Description                                |
| ---------------------- | ------------------------------------------ |
| `$ARGUMENTS`           | All arguments passed when invoking         |
| `$ARGUMENTS[N]`        | Specific argument by 0-based index         |
| `$N`                   | Shorthand: `$0` = first arg, `$1` = second |
| `${CLAUDE_SESSION_ID}` | Current session ID                         |
| `${CLAUDE_SKILL_DIR}`  | Directory containing the skill's SKILL.md  |

#### Dynamic Context Injection (Claude Code specific)

The `` !`<command>` `` syntax executes shell commands at render time — before Claude sees the prompt. Output replaces the placeholder:

```yaml
---
name: pr-summary
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---
PR diff: !`gh pr diff`
PR comments: !`gh pr view --comments`
```

This is preprocessing, not something Claude executes — Claude only sees the final rendered output.

### 5. Progressive Disclosure Architecture

The core design principle is three-level loading:

| Level                     | When Loaded             | Token Cost                | Content                                 |
| ------------------------- | ----------------------- | ------------------------- | --------------------------------------- |
| **Level 1: Metadata**     | Always, at startup      | ~100 tokens per skill     | `name` + `description` from frontmatter |
| **Level 2: Instructions** | When skill is triggered | <5,000 tokens recommended | Full SKILL.md body                      |
| **Level 3: Resources**    | As needed               | Effectively unlimited     | scripts/, references/, assets/          |

**Design implication**: Claude scans all skill descriptions at startup. Full instructions only load when the skill is triggered. Supporting files only load when Claude explicitly references them.

**Description budget**: Descriptions are loaded into context so Claude knows what's available. The budget scales at 1% of context window with an 8,000-char fallback. Each entry is capped at 250 chars. To raise the cap, set `SLASH_COMMAND_TOOL_CHAR_BUDGET`.

### 6. Skill Directory Structure (Full)

```
my-skill/
├── SKILL.md                    # Main instructions (required)
├── template.md                 # Template for Claude to fill in
├── references/
│   ├── api-reference.md        # Detailed API docs (loaded on demand)
│   ├── patterns.md             # Common patterns
│   └── advanced.md             # Advanced use cases
├── examples/
│   └── sample.md               # Example output showing expected format
└── scripts/
    └── validate.sh             # Script Claude can execute
```

**Conventions for subdirectories:**

- `scripts/` — executable code (Python, Bash, JS). Scripts run without loading code into context (only output is returned).
- `references/` — documentation loaded on demand into context
- `assets/` — static resources used in output (templates, images, fonts). NOT loaded into context.
- `examples/` — complete working examples to copy/adapt

### 7. Where Skills Live in Claude Code

| Scope      | Path                                     | Applies To              |
| ---------- | ---------------------------------------- | ----------------------- |
| Enterprise | Managed settings                         | All org users           |
| Personal   | `~/.claude/skills/<skill-name>/SKILL.md` | All your projects       |
| Project    | `.claude/skills/<skill-name>/SKILL.md`   | This project only       |
| Plugin     | `<plugin>/skills/<skill-name>/SKILL.md`  | Where plugin is enabled |

**Priority when names conflict**: Enterprise > Personal > Project.

**Plugin namespace**: Plugin skills use a `plugin-name:skill-name` namespace, preventing conflicts.

**Monorepo support**: Claude Code automatically discovers skills from nested `.claude/skills/` directories when working with files in subdirectories (e.g., `packages/frontend/.claude/skills/`).

**`--add-dir` support**: Skills from `.claude/skills/` within `--add-dir` directories are loaded and watched for live changes.

**Legacy `.claude/commands/` still works**: A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy`. Skills are recommended as they support supporting files and additional frontmatter features. If both exist with the same name, the skill wins.

### 8. The skills CLI (`npx skills`)

The `skills` npm package is the package manager for the ecosystem, published by Vercel Labs (https://github.com/vercel-labs/skills).

**Supported source formats:**

```bash
npx skills add vercel-labs/agent-skills         # GitHub shorthand
npx skills add https://github.com/org/repo      # Full URL
npx skills add ./my-local-skills                # Local path
npx skills add org/repo@skill-name              # Specific skill from multi-skill repo
npx skills add -g vercel-labs/agent-skills      # Global install
```

**All commands:**

| Command                             | Function                                      |
| ----------------------------------- | --------------------------------------------- |
| `npx skills add <source>`           | Install skills from repositories              |
| `npx skills add ... --skill <name>` | Install specific skill from multi-skill repo  |
| `npx skills add ... -g`             | Install globally (~/.agent-name/skills/)      |
| `npx skills add ... -y`             | Skip prompts                                  |
| `npx skills add ... --list`         | Preview without installing                    |
| `npx skills list`                   | Display installed skills                      |
| `npx skills find <query>`           | Search for skills interactively               |
| `npx skills remove`                 | Uninstall skills                              |
| `npx skills check`                  | Check for available updates                   |
| `npx skills update`                 | Update all installed skills                   |
| `npx skills init`                   | Create new skill template (SKILL.md scaffold) |

**Install paths by agent:**

- Claude Code: `.claude/skills/` (project) or `~/.claude/skills/` (global)
- Cursor: `.cursor/skills/` or `~/.cursor/skills/`
- Gemini CLI: `.gemini/skills/` or `~/.gemini/skills/`
- (18+ agents supported)

### 9. Distribution and Publishing

**The key insight: there is no registry submission process.**

To publish a skill: put it in a git repo and share the repo URL. That's it.

**How skills appear on skills.sh**: Automatically, via install telemetry. When anyone runs `npx skills add owner/repo`, skills.sh counts the install. No approval process, no submission form.

**Common distribution patterns:**

1. **Direct git repo**: `npx skills add github.com/myorg/my-skills`
2. **Multi-skill repo** (recommended for skill collections): One repo containing a `skills/` directory with multiple skill subdirectories (how `vercel-labs/agent-skills` works)
3. **npm package**: Publish to npm with `agent-skills` and `agentskills` keywords. Tools like TanStack Intent scan npm for these keywords.
4. **Project-local**: Commit `.claude/skills/` to version control
5. **Plugins**: Include `skills/` directory in a Claude Code plugin
6. **Managed settings**: Organization-wide deployment via enterprise settings

**For npm packaging**: Include `"skills"` in `files` field of `package.json`, and add `"agent-skills"` and `"agentskills"` as keywords.

### 10. Skills in Anthropic's Broader Ecosystem

Anthropic distinguishes between three contexts where skills work differently:

#### Claude Code (filesystem-based, Claude Code specific)

- Stored as directories with `SKILL.md` on the local filesystem
- Full Claude Code extension fields available
- Full network access (same as user's computer)
- No upload required — Claude reads files directly via bash

#### Claude API (VM-based, upload required)

- Skills uploaded via `/v1/skills` endpoints as zip files
- Shared workspace-wide (all workspace members)
- No network access (sandboxed VM)
- Requires beta headers: `code-execution-2025-08-25`, `skills-2025-10-02`, `files-api-2025-04-14`
- Pre-built skills: PowerPoint (`pptx`), Excel (`xlsx`), Word (`docx`), PDF (`pdf`)

#### Claude.ai (VM-based, upload required)

- Uploaded as zip files via Settings > Features
- Individual user only (not org-wide)
- Network access depends on user/admin settings

**Skills do NOT sync across surfaces**. A skill uploaded to claude.ai is not available in the Claude API, and Claude Code skills are separate from both.

### 11. Are skills.sh Skills the Same as Claude Code Skills?

**Yes and no:**

| Aspect          | Base Agent Skills Spec (agentskills.io)                 | skills.sh ecosystem | Claude Code extensions                           |
| --------------- | ------------------------------------------------------- | ------------------- | ------------------------------------------------ |
| Core format     | SKILL.md + frontmatter                                  | Same                | Same + extra fields                              |
| Required fields | `name`, `description`                                   | Same                | All fields optional (uses dir name if no `name`) |
| Optional fields | `license`, `compatibility`, `metadata`, `allowed-tools` | Same                | Adds 10+ more fields                             |
| CLI             | `npx skills`                                            | `npx skills`        | Native discovery (no CLI needed)                 |
| Storage         | Any directory                                           | Git repo            | `.claude/skills/`, `~/.claude/skills/`           |
| Discovery       | Agent-specific                                          | skills.sh directory | Claude scans skills dirs at startup              |

**The relationship**: Claude Code's native skill system IS an implementation of the Agent Skills open standard, with Anthropic-specific extensions. A skill authored using only the base spec fields works in Claude Code AND Cursor AND Gemini CLI AND others. Skills using Claude Code-specific fields (`context: fork`, `hooks`, `disable-model-invocation`, etc.) only work in Claude Code.

The `skills` CLI from Vercel Labs is a convenience tool for installing community skills from GitHub repos into the correct agent-specific directories. Claude Code's own discovery mechanism is separate and doesn't require the CLI — it scans `.claude/skills/` automatically.

### 12. Skill Authoring Best Practices

From Anthropic's official guidance:

**Description quality:**

- Front-load the key use case (first 250 chars are most important)
- Use third-person phrasing: "This skill should be used when..."
- Include specific trigger phrases users would naturally say
- Not vague ("Helps with PDFs") — specific ("Extracts text and tables from PDF files, fills PDF forms, merges multiple PDFs. Use when working with PDF documents...")

**Content organization:**

- Keep `SKILL.md` under 500 lines (1,500–2,000 words ideal)
- Move detailed reference material to `references/` subdirectory
- Move executable logic to `scripts/` subdirectory
- Always reference supporting files from `SKILL.md` so Claude knows they exist

**Writing style:**

- Use imperative/verb-first form in the body ("Configure the server" not "You should configure the server")
- Include concrete examples of inputs and outputs
- Document common edge cases

**Permission model:**

- Use `disable-model-invocation: true` for side-effect workflows (deploy, commit, send-message) you want to control manually
- Use `user-invocable: false` for background knowledge Claude should load automatically but users shouldn't invoke as a command
- Use `allowed-tools` to pre-approve tools for the skill scope, avoiding per-call permission prompts

**Security:**

- Skills from untrusted sources are a security risk — they can invoke tools, run bash, and access files
- Only install skills from trusted sources (own skills, well-known orgs: vercel-labs, anthropics, microsoft)
- Review all bundled files before using community skills in production

---

## Sources & Evidence

- Vercel Changelog announcement: [Introducing skills, the open agent skills ecosystem](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)
- Official Claude Code skills documentation: [Extend Claude with skills](https://code.claude.com/docs/en/skills)
- Anthropic platform Agent Skills overview: [Agent Skills Overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- Agent Skills open standard specification: [agentskills.io/specification](https://agentskills.io/specification)
- Agent Skills open standard home: [agentskills.io](https://agentskills.io/home)
- skills.sh directory: [The Agent Skills Directory](https://skills.sh/)
- skills.sh Vercel Labs page: [Skills by vercel-labs](https://skills.sh/vercel-labs/agent-skills)
- vercel-labs/skills GitHub repo: [GitHub - vercel-labs/skills](https://github.com/vercel-labs/skills)
- find-skills SKILL.md example: [skills/find-skills/SKILL.md](https://github.com/vercel-labs/skills/blob/main/skills/find-skills/SKILL.md)
- Anthropic plugin-dev skill-development SKILL.md: [claude-code/plugins/plugin-dev](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/skill-development/SKILL.md?plain=1)
- Vercel Docs: [Agent Skills](https://vercel.com/docs/agent-resources/skills)
- Vercel KB: [Agent Skills - Creating, Installing, and Sharing](https://vercel.com/kb/guide/agent-skills-creating-installing-and-sharing-reusable-agent-context)
- InfoQ coverage: [Vercel Introduces Skills.sh](https://www.infoq.com/news/2026/02/vercel-agent-skills/)
- DeepWiki SKILL.md spec: [SKILL.md Format Specification](https://deepwiki.com/anthropics/skills/2.2-skill.md-format-specification)
- Skill authoring best practices: [Skill authoring best practices - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)

---

## Research Gaps & Limitations

- **Hooks in skills**: The `hooks` frontmatter field is documented as existing but detailed configuration format was not captured in this research. See [Hooks in skills and agents](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents) for details.
- **Plugins integration**: Skills can be bundled inside Claude Code Plugins. Plugin format (`plugin.json`, plugin directory structure) was not deeply researched here.
- **API upload format**: The `/v1/skills` API endpoints for uploading skills to Claude API were not explored in detail.
- **Agent SDK integration**: Skills in the Claude Agent SDK (TypeScript/Python) were mentioned but not detailed.
- **skills.sh discovery mechanism**: Exact telemetry implementation details (how install counts are tracked) not confirmed.

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: `"skills.sh Vercel marketplace"`, `"site:skills.sh"`, `"skills.sh SKILL.md format specification hooks commands frontmatter"`, `"npx skills" Claude Code SKILL.md format specification 2026`
- Primary information sources: vercel.com/docs, code.claude.com/docs, agentskills.io, platform.claude.com/docs, github.com/vercel-labs/skills, skills.sh
- Most authoritative sources: `code.claude.com/docs/en/skills` (complete Claude Code spec), `agentskills.io/specification` (base standard), `platform.claude.com/docs/en/agents-and-tools/agent-skills/overview` (cross-surface overview)
