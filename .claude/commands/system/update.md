---
description: Add, update, or improve processes based on user input
argument-hint: [description of what to add/change]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, TodoWrite, SlashCommand, Agent
---

# System Update

Add a new process, update an existing one, or improve the Claude Code harness per `$ARGUMENTS`. This is a **research-first, batch-confirm** workflow: understand the current state before proposing anything, and get one confirmation before writing anything.

## Component reference

The component types, their locations, when to use each (command vs agent vs skill vs rule vs hook), naming conventions, and per-component templates all live in `.claude/README.md` under **"Maintaining the Harness"**. That is the source of truth — follow its templates rather than inventing structure. Quick orientation:

| Type            | Location                                 | Invocation                                       |
| --------------- | ---------------------------------------- | ------------------------------------------------ |
| Command         | `.claude/commands/[namespace]/[name].md` | User types `/namespace:name`                     |
| Agent           | `.claude/agents/[name].md`               | Dispatched via the Agent tool (isolated context) |
| Skill           | `.claude/skills/[name]/SKILL.md`         | Model-invoked when context matches               |
| Rule            | `.claude/rules/[topic].md`               | Path-triggered via `paths:` frontmatter          |
| Hook            | `.claude/settings.json`                  | Lifecycle-event-triggered                        |
| Developer guide | `contributing/[name].md`                 | Reference docs (use `writing-developer-guides`)  |

Skills that must work in both Claude Code and Codex live canonically in `.agents/skills/` — see the `syncing-agent-skills` skill before creating or renaming one.

## Workflow

### 1. Research

- Read `.claude/README.md` (inventory, conventions) and the components related to the request — grep `.claude/commands`, `.claude/agents`, `.claude/skills`, `.claude/rules` for overlapping functionality.
- Identify what the change interacts with: existing processes that reference it, hooks that validate it, README tables that list it.
- If the request involves Claude Code architecture decisions (new hook events, skill mechanics, recent features), dispatch the `claude-code-guide` agent to check current official guidance first.
- If the request is ambiguous, ask before planning. If the user actually wants to _discover_ an approach through experimentation, redirect to `/system:learn` — it runs the experimentation loop and calls back into this command to codify.

### 2. Plan and batch-confirm

Present one plan covering everything: files to create (with purpose), files to modify (with what changes), and a preview of the key content. Wait for explicit confirmation **before writing any files**. If there are genuine design choices (e.g. skill vs command), present them with a recommendation.

### 3. Execute

Apply all approved changes, following the README's component templates and existing neighboring files as style models.

Then update the documentation surfaces:

- **`.claude/README.md`** — always: add/update the component's table entry and the inventory counts.
- **`AGENTS.md`** — only for significant changes (new pattern, changed core convention, something every agent must know). AGENTS.md stays under its line budget: express additions as principles or pointers, never lists; compress existing content if needed to make room; don't document what agents can discover by reading source.

### 4. Verify and report

Read back what was written, confirm no broken cross-references, and report what was created/modified with a usage example. If the change touched 3+ components, suggest running `/system:review` to validate consistency.

## Quality bar

Before presenting the plan, check: follows existing naming conventions; right component type for the invocation model (who decides when it runs — user → command, model → skill, event → hook, isolated execution → agent, file-path context → rule); complete frontmatter; no conflict or duplication with existing processes.
