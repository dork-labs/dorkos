---
title: 'Claude Code Skills: Deep Dive — SKILL.md Format, Discovery, Injection, Multi-file Support'
date: 2026-03-28
type: external-best-practices
status: active
tags: [claude-code, skills, SKILL.md, hooks, pretooluse, multi-file, progressive-disclosure, plugin]
searches_performed: 9
sources_count: 8
---

## Research Summary

Claude Code skills are filesystem-based, modular capability extensions defined by a `SKILL.md` file with YAML frontmatter. They support multi-file directory structures with unlimited bundled content via progressive disclosure. Discovery is driven by LLM reasoning over an `<available_skills>` block compiled from skill frontmatter — there is no separate hook or embedding-based routing. A dynamic character budget (defaulting to 8,000 characters, configurable via `SLASH_COMMAND_TOOL_CHAR_BUDGET`) governs how much description text is surfaced to the model. No hard `MAX_SKILLS` cap is publicly documented; limits are soft and tied to the context budget.

---

## Key Findings

1. **SKILL.md is the required entrypoint** but a skill directory can contain unlimited supporting files. Multi-file skill directories are the canonical pattern, not an edge case.

2. **Three-level progressive disclosure** is the architectural foundation: metadata always loaded (~100 tokens), SKILL.md body loaded when triggered (<5K tokens / 500 lines), bundled files loaded on demand via bash reads (effectively unlimited, no pre-load cost).

3. **Discovery is prompt-based**, not hook-based. The Skill tool's system description contains `<available_skills>` XML tags populated with every eligible skill's `name` and `description`. Claude uses pure LLM reasoning to match intent to skills. No PreToolUse injection hook is involved in skill routing.

4. **PreToolUse hooks exist as a skill feature**, not as the mechanism of discovery. Skills can _define_ hooks in their frontmatter that fire during the skill's active lifetime.

5. **The character budget** for skill descriptions defaults to 8,000 characters (with a dynamic scaling of 1% of context window). Individual descriptions are truncated at 250 characters in the listing. The env var `SLASH_COMMAND_TOOL_CHAR_BUDGET` overrides the cap.

6. **`SKILL.md` can reference sub-files and those sub-files can reference further files**, but Anthropic best practices explicitly warn against deeply nested chains — keep all references **one level deep** from `SKILL.md`.

---

## Detailed Analysis

### 1. SKILL.md Format and Frontmatter Schema

Every skill requires exactly one `SKILL.md` file at the root of the skill directory. The file has two parts: YAML frontmatter between `---` delimiters, and a markdown body.

**Frontmatter fields** (from official Claude Code docs):

| Field                      | Required         | Notes                                                                                                                                                                                                         |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                     | No (recommended) | Used as `/slash-command`. Lowercase letters, numbers, hyphens only. Max 64 chars. No XML tags. No reserved words ("anthropic", "claude"). Defaults to directory name if omitted.                              |
| `description`              | Recommended      | How Claude decides when to load the skill. Max 1024 chars (API validation). In listings, truncated at 250 chars. Write in third person. Omitting it causes Claude to use the first paragraph of body content. |
| `argument-hint`            | No               | Shown in `/` autocomplete. E.g. `[issue-number]`                                                                                                                                                              |
| `disable-model-invocation` | No               | `true` prevents Claude from auto-loading the skill. Removes it from Claude's context entirely. Use for `/deploy`-style workflows.                                                                             |
| `user-invocable`           | No               | `false` hides from `/` menu. Use for background knowledge skills.                                                                                                                                             |
| `allowed-tools`            | No               | List of tools pre-approved when skill is active, no per-use prompt. E.g. `Read, Grep, Bash(gh *)`                                                                                                             |
| `model`                    | No               | Override model for this skill's execution.                                                                                                                                                                    |
| `effort`                   | No               | Override effort level (`low`, `medium`, `high`, `max`).                                                                                                                                                       |
| `context`                  | No               | `fork` runs in an isolated subagent context with no conversation history.                                                                                                                                     |
| `agent`                    | No               | Which subagent to use when `context: fork`. Built-in options: `Explore`, `Plan`, `general-purpose`. Can also reference custom `.claude/agents/` entries.                                                      |
| `hooks`                    | No               | Hooks scoped to the skill lifecycle. Same format as settings-based hooks. See hooks section.                                                                                                                  |
| `paths`                    | No               | Glob patterns limiting when the skill auto-activates. Only when working with matching files.                                                                                                                  |
| `shell`                    | No               | Shell for `!` command blocks. `bash` (default) or `powershell`.                                                                                                                                               |

**String substitutions** available inside skill content:

| Variable               | Description                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `$ARGUMENTS`           | All arguments passed at invocation. If absent from content, appended as `ARGUMENTS: <value>`        |
| `$ARGUMENTS[N]`        | Zero-based positional argument access                                                               |
| `$N`                   | Shorthand for `$ARGUMENTS[N]`                                                                       |
| `${CLAUDE_SESSION_ID}` | Current session ID                                                                                  |
| `${CLAUDE_SKILL_DIR}`  | Absolute path to the skill's directory. Critical for referencing bundled scripts regardless of cwd. |

**Example minimal SKILL.md:**

```yaml
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works, teaching about a codebase, or when the user asks "how does this work?"
---
When explaining code, always include:

1. **Start with an analogy**: Compare the code to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the flow, structure, or relationships
3. **Walk through the code**: Explain step-by-step what happens
4. **Highlight a gotcha**: What's a common mistake or misconception?
```

---

### 2. Multi-file Skill Directory Structure

Skills support arbitrarily complex directory layouts. This is not an advanced feature — it is the **canonical pattern** recommended for anything beyond trivial skills.

**Standard structure:**

```
my-skill/
├── SKILL.md           # Required entrypoint
├── reference.md       # Detailed docs — loaded by Claude when referenced
├── examples.md        # Usage examples — loaded on demand
├── references/        # Subdirectory for domain-specific reference files
│   ├── finance.md
│   ├── sales.md
│   └── marketing.md
├── scripts/
│   └── validate.sh    # Executed via bash, code never enters context
└── assets/
    └── template.md    # Templates Claude fills in
```

**Three types of bundled content:**

1. **Instruction files** (`.md`): Detailed guidance Claude reads on demand via bash. Zero context cost until accessed.
2. **Executable scripts** (`.py`, `.sh`, etc.): Run via bash; only their _output_ enters context, not the source code. This is dramatically more token-efficient than Claude generating equivalent code.
3. **Resource files** (schemas, templates, data): Factual lookup material loaded only when needed.

**Key constraint from best practices:** Keep all file references **one level deep from SKILL.md**. Claude may use `head -100` partial reads when traversing nested chains (SKILL.md → advanced.md → details.md), leading to incomplete information loads. The safe pattern is direct references from SKILL.md to all supporting files.

---

### 3. Discovery Mechanism: How Skills Are Found and Loaded

**Filesystem scanning:** At startup, Claude Code scans configured skill directories:

| Priority    | Location                           | Scope                      |
| ----------- | ---------------------------------- | -------------------------- |
| 1 (highest) | Enterprise managed settings        | All users in organization  |
| 2           | `~/.claude/skills/<name>/SKILL.md` | All projects for this user |
| 3           | `.claude/skills/<name>/SKILL.md`   | This project only          |
| 4           | `<plugin>/skills/<name>/SKILL.md`  | Where plugin is enabled    |

When the same skill name appears at multiple levels, higher priority wins. Plugin skills are namespaced as `plugin-name:skill-name` to avoid conflicts.

**Monorepo/nested discovery:** When editing files in `packages/frontend/`, Claude Code also looks for skills in `packages/frontend/.claude/skills/`. This automatic nested discovery supports monorepo setups.

**Skills from `--add-dir`:** Skills in `.claude/skills/` inside `--add-dir` directories are loaded automatically and support live change detection during a session.

**Backwards compatibility:** Files in `.claude/commands/` continue working exactly like skills. If a skill and command share the same name, the skill takes precedence. Skills are recommended because they support supporting files, frontmatter control, and the `context: fork` feature.

---

### 4. Injection / Loading Mechanism (Not a PreToolUse Hook)

The "how skills get injected" question is frequently misunderstood. The mechanism is:

**Skills are NOT injected via PreToolUse hooks.** The discovery and loading pipeline is:

1. **At session startup:** Frontmatter from all eligible skill directories is parsed. A `<available_skills>` XML block is built listing each skill's `name` and `description`. This block is embedded in the **Skill tool's own description** inside the system prompt. Cost: approximately ~100 tokens per skill.

2. **Claude reasons over the list:** When Claude encounters a user request, it reads the `<available_skills>` block and uses pure LLM reasoning to decide whether any skill's description matches the intent. No embedding similarity, no algorithmic routing.

3. **When a skill matches:** Claude invokes the `Skill` tool with the skill `name` as parameter. The system responds with:
   - The skill's base directory path (`${CLAUDE_SKILL_DIR}`)
   - The full `SKILL.md` body content

   This content is injected into the conversation as two messages: a user-visible metadata message (with XML tags indicating activation) and a hidden `isMeta: true` message containing the full skill prompt.

4. **Supporting files loaded on demand:** If SKILL.md references `reference/finance.md`, Claude uses a bash Read command to load it. No pre-loading happens; the file enters context only when Claude chooses to read it.

5. **Execution context modification:** When a skill activates, a `contextModifier` applies: pre-approved tools from `allowed-tools` no longer require per-use approval; any `model` override takes effect. This reverts when the skill finishes.

**Invocation control summary:**

| Frontmatter                      | User can invoke | Claude can invoke | Loaded in context                                        |
| -------------------------------- | --------------- | ----------------- | -------------------------------------------------------- |
| (default)                        | Yes (`/name`)   | Yes (auto)        | Description always present; body when invoked            |
| `disable-model-invocation: true` | Yes             | No                | Description NOT in context; body loads when user invokes |
| `user-invocable: false`          | No              | Yes               | Description always present; body when invoked            |

**Subagents with preloaded skills** work differently: full skill content is injected at startup, not on-demand.

---

### 5. PreToolUse Hooks — What They Actually Are in the Skills Context

PreToolUse hooks ARE a real feature, but they are **a feature skills can define**, not the mechanism by which skills are discovered or injected.

**Hooks defined in skill frontmatter:**

```yaml
---
name: secure-operations
description: Perform operations with security checks
hooks:
  PreToolUse:
    - matcher: 'Bash'
      hooks:
        - type: command
          command: './scripts/security-check.sh'
---
```

**Behavior:**

- Hooks defined in a skill are **scoped to the skill's active lifetime**. They fire only while the skill is active, then are cleaned up automatically.
- All hook events are supported: `PreToolUse`, `PostToolUse`, `PreCompact`, etc.
- The `once: true` field is **skills-only** (not available for subagents): it causes the hook to run once per session and then self-remove.
- The same configuration format as settings-level hooks applies.

**PreToolUse at the global settings level** operates separately — it can inspect any tool call via JSON piped to stdin and allow/block it. This is how tools like Parry (prompt injection scanner) work: they install a global PreToolUse hook that checks every tool invocation, including Skill invocations, for malicious content.

---

### 6. Character/Token Budget and Skill Limits

**No hard MAX_SKILLS cap is publicly documented.** The limiting factor is the character budget for the `<available_skills>` block.

**Budget mechanics:**

- **Default:** 8,000 characters for the entire `<available_skills>` section (fallback when context window cannot be determined)
- **Dynamic scaling:** The budget scales to 1% of the total context window when context size is known
- **Per-skill description truncation:** Each skill's description entry is capped at 250 characters in the listing, regardless of total budget
- **Override:** Set `SLASH_COMMAND_TOOL_CHAR_BUDGET` env var to raise the budget
- **All skill names are always included:** Even if descriptions are truncated to fit the budget, skill names remain visible to Claude

**Practical implication:** Front-load the key use case in the first 250 characters of `description`. Write descriptions that work even when truncated.

**Historical context (may be outdated):** Some reverse-engineering articles from late 2025 mentioned a 15,000-character budget figure. The official docs now state 8,000 characters as the fallback with dynamic 1% scaling. The official number should be trusted.

**SKILL.md body size:** Soft limit of 500 lines recommended. No hard byte cap is documented. If content exceeds 500 lines, use progressive disclosure into supporting files.

---

### 7. Progressive Discovery: Referencing Sub-files

Yes, SKILL.md can reference and effectively "include" other files. This is the canonical pattern for complex skills.

**How it works technically:**

- `SKILL.md` links to supporting files with standard markdown links: `[reference.md](reference.md)` or `[reference/finance.md](reference/finance.md)`
- When Claude reads `SKILL.md` and encounters a reference, it can choose to invoke a bash Read command on the referenced file
- The referenced file's content then enters the context window
- Claude decides which files to read based on task relevance — it does NOT automatically load all referenced files

**Correct pattern (one level deep):**

```markdown
## Additional resources

- For complete API details, see [reference.md](reference.md)
- For form-filling specifics, see [forms.md](forms.md)
- For usage examples, see [examples.md](examples.md)
```

**Anti-pattern (too deep):**

```markdown
# SKILL.md → links to advanced.md → links to details.md
```

Claude may do partial reads on nested chains. Keep all references in a flat structure from SKILL.md.

**For long reference files (100+ lines):** Include a table of contents at the top so Claude can orient itself even from a partial read.

---

### 8. Skill Hooks — `once` Field and Lifecycle

A unique feature of skill-scoped hooks is `once: true`:

```yaml
hooks:
  PreToolUse:
    - matcher: 'Write'
      hooks:
        - type: command
          command: "echo 'first write intercepted'"
          once: true
```

With `once: true`, the hook fires once per session then removes itself. This is skills-only — subagents do not have this field. Useful for one-time setup validation or initialization checks that should not repeat on every tool use.

---

### 9. `context: fork` and Subagent Execution

Setting `context: fork` fundamentally changes how the skill runs:

- A **new isolated context** is created with no access to conversation history
- The `SKILL.md` body becomes the subagent's prompt
- The `agent` field picks the execution environment (`Explore`, `Plan`, `general-purpose`, or custom `.claude/agents/` entry)
- Results are summarized and returned to the main conversation

Important warning from official docs: `context: fork` only makes sense for skills with explicit task instructions. If your skill is "use these API conventions" without a task, the forked subagent receives the guidelines but has nothing actionable to do.

---

### 10. Dynamic Context Injection with `!` Commands

Skills can inject live data before Claude sees the prompt using shell command syntax:

```yaml
---
name: pr-summary
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---
## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
```

The `!` commands execute **before** the skill content is sent to Claude. The output replaces the placeholder. Claude sees actual PR data, not the shell command. This is preprocessing, not something Claude executes.

---

## Complete Frontmatter Schema (Synthesized)

```yaml
---
# REQUIRED (but defaults to directory name if omitted)
name: skill-name # max 64 chars, lowercase + hyphens only

# RECOMMENDED
description: > # max 1024 chars; truncated to 250 in listings
  What the skill does and when to use it. Write in third person.
  Front-load the key use case. Include trigger phrases.

# INVOCATION CONTROL
disable-model-invocation: false # true = only user can invoke via /name
user-invocable: true # false = hidden from / menu; Claude-only

# EXECUTION CONTROL
context: fork # run in isolated subagent
agent: Explore # subagent type (with context: fork)
model: claude-opus-4-6 # model override
effort: high # low | medium | high | max

# TOOL PERMISSIONS
allowed-tools: Read, Grep, Bash(gh *)

# ARGUMENT HINTS
argument-hint: '[issue-number]'

# PATH SCOPING
paths:
  - 'packages/frontend/**'
  - '*.tsx'

# SHELL
shell: bash # bash | powershell

# SKILL-SCOPED HOOKS
hooks:
  PreToolUse:
    - matcher: 'Bash'
      hooks:
        - type: command
          command: './scripts/security-check.sh'
          once: true # skills-only: fires once per session then removed
---
```

---

## Sources & Evidence

- Official Claude Code Skills documentation: [Extend Claude with skills](https://code.claude.com/docs/en/skills) — comprehensive guide covering all frontmatter fields, multi-file structure, invocation control, subagents, and dynamic injection
- Official Agent Skills overview (platform docs): [Agent Skills - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — architecture explanation, progressive disclosure three-level model, VM environment, token cost table
- Official best practices guide: [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — 500-line soft limit, one-level-deep reference pattern, description writing rules, progressive disclosure patterns
- Plugin skill development guidance: [claude-code plugin-dev SKILL.md](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/skill-development/SKILL.md) — confirms multi-file pattern, 1,500-2,000 word lean SKILL.md recommendation
- Official anthropics/skills repo example: [skill-creator/SKILL.md](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md) — real-world multi-file skill with references/, scripts/, agents/ subdirectories
- Reverse-engineering deep dive: [Inside Claude Code Skills](https://mikhail.io/2025/10/claude-code-skills/) — implementation details on the Skill tool, `<available_skills>` block, `contextModifier` pattern, injection as conversation messages
- Architecture analysis: [Claude Agent Skills: A First Principles Deep Dive](https://leehanchung.github.io/blogs/2025/10/26/claude-skills-deep-dive/) — 15,000-char budget figure (may be outdated), LLM-reasoning-based routing (no embeddings), isMeta injection pattern
- SLASH_COMMAND_TOOL_CHAR_BUDGET: documented in [skills docs](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short): "budget scales dynamically at 1% of the context window, with a fallback of 8,000 characters"

---

## Research Gaps & Limitations

- **No public MAX_SKILLS number documented.** The system scales based on context budget, not a hard count. Real-world behavior at 50+ skills is empirically untested here.
- **The 18KB byte budget** mentioned in the original research brief does not appear in any official documentation consulted. It may refer to a legacy or hypothetical limit, or to a specific context window at 1%. Treat as unverified.
- **`pretooluse-skill-inject` hook name** does not appear in official docs. The actual mechanism is the `<available_skills>` block in the Skill tool description. The term may be informal/community shorthand.
- **Subagent preloading mechanics** (when full skill content is injected at startup) are mentioned but not fully detailed in public docs.
- **API vs Claude Code surface differences:** On the Claude API, skills require VM container setup and beta headers. Claude Code uses pure filesystem-based skills — simpler but different backend.

---

## Contradictions & Disputes

- **Character budget figure:** The leehanchung reverse-engineering article (2025) reports 15,000 characters. The official docs say 8,000 characters fallback with 1% dynamic scaling. The official docs should be taken as authoritative for current behavior.
- **`name` field required status:** The platform docs say `name` and `description` are "Required." The Claude Code docs say `name` is "No (defaults to directory name)." The discrepancy exists because the platform API requires `name` for upload validation, while Claude Code infers it from the directory name.

---

## Search Methodology

- Searches performed: 9 total
- Most productive search terms: `"Claude Code SKILL.md format frontmatter documentation 2026"`, `"Claude Code skills PreToolUse hook injection SLASH_COMMAND_TOOL_CHAR_BUDGET MAX_SKILLS 2026"`
- Primary sources: `code.claude.com/docs/en/skills`, `platform.claude.com/docs/en/agents-and-tools/agent-skills/overview`, `platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices`, `github.com/anthropics/skills`, `github.com/anthropics/claude-code`
- Secondary sources: leehanchung.github.io, mikhail.io (reverse-engineering articles from late 2025)
