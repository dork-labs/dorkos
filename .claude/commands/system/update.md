---
description: Add, update, or improve processes based on user input
argument-hint: [description of what to add/change]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, TodoWrite, SlashCommand, Task
---

# System Update Command

Add new processes, update existing ones, or improve the Claude Code workflow based on user instructions.

## Arguments

- `$ARGUMENTS` - Description of what to add, update, or improve. Examples:
  - "add a command to quickly scaffold a new entity"
  - "update the spec workflow to include security review"
  - "improve the code review process to check for `any` types"
  - "create a new agent for API testing"

## Process Files Reference

| Type                 | Location                                  | When to Create/Modify                                                      |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| **Commands**         | `/.claude/commands/[namespace]/[name].md` | New quick actions, workflows (user-invoked)                                |
| **Agents**           | `/.claude/agents/[category]/[name].md`    | Complex multi-step workflows needing isolation (tool-invoked)              |
| **Skills**           | `/.claude/skills/[skill-name]/SKILL.md`   | Reusable expertise Claude applies automatically (model-invoked)            |
| **Rules**            | `/.claude/rules/[topic].md`               | Path-specific guidelines that apply to certain file types (path-triggered) |
| **Hooks**            | `/.claude/settings.json`                  | Automated validation/actions (via ClaudeKit, event-triggered)              |
| **ADRs**             | `/decisions/NNNN-slug.md`                 | Architecture decisions with context, rationale, consequences               |
| **Developer Guides** | `/contributing/[name].md`                       | Detailed patterns and conventions (see `writing-developer-guides` skill)   |
| **Memory**           | `/CLAUDE.md`                              | Core instructions, high-level documentation                                |
| **Harness README**   | `/.claude/README.md`                      | Harness structure, component inventory, maintenance guides                 |

## Order of Operations

Execute these steps sequentially. This is an **interactive, research-first** process.

### Phase 1: Understand the Request

- [ ] **1.1** Parse `$ARGUMENTS` to understand:
  - What is the user trying to accomplish?
  - Is this a new process or modification of existing?
  - What type(s) of files will be involved?

- [ ] **1.2** Ask clarifying questions if the request is ambiguous:
  - Use AskUserQuestion with specific options when possible
  - Don't proceed until the goal is clear

### Phase 2: Research Current State

- [ ] **2.1** Read harness documentation to understand:
  - Read `.claude/README.md` for harness structure, component inventory, naming conventions
  - Read `CLAUDE.md` for project architecture and conventions
  - Understand existing patterns and what's already documented

- [ ] **2.2** Search for related existing processes:

  ```bash
  # Find related commands
  grep -r "[relevant keywords]" ".claude/commands" --include="*.md" -l

  # Find related agents
  grep -r "[relevant keywords]" ".claude/agents" --include="*.md" -l

  # Find related path-specific rules
  grep -r "[relevant keywords]" ".claude/rules" --include="*.md" -l

  # Check developer guides
  grep -r "[relevant keywords]" "developer-guides" --include="*.md" -l
  ```

- [ ] **2.3** Read related files to understand:
  - How similar things are currently done
  - What patterns to follow
  - What might need to be updated alongside

- [ ] **2.4** Identify connections:
  - What existing processes will this interact with?
  - What needs to reference the new/updated process?
  - Are there hooks that will validate this?

### Phase 2.5: Research Claude Code Best Practices (When Applicable)

**CRITICAL**: Before proposing changes to Claude Code configuration (commands, agents, skills, hooks), check current best practices:

- [ ] **2.5.1** Determine if research is needed:
  - Is this creating/modifying a command, agent, skill, or hook?
  - Does this involve Claude Code architecture decisions?
  - Has Claude Code released new features that might affect this?

- [ ] **2.5.2** If research is needed, use `claude-code-guide`:

  ```
  Task(
    description="Research Claude Code [component type] best practices",
    prompt="I'm about to [create/modify] a [command/agent/skill/hook] for [purpose].
    Find the current best practices, naming conventions, and any recent changes
    to how Claude Code handles [component type]. Focus on: recommended patterns,
    common pitfalls, and any new features that might be relevant.",
    subagent_type="claude-code-guide"
  )
  ```

- [ ] **2.5.3** Incorporate findings:
  - Update the proposed approach based on current best practices
  - Note any discrepancies between local patterns and official recommendations
  - Highlight new features that could improve the implementation

**Research triggers:**

- Creating new commands, agents, skills, or hooks
- Modifying hook lifecycle events or tool permissions
- Implementing features that might have official support
- User mentions wanting "best practices" or "recommended approach"
- Significant architectural changes to `.claude/` configuration

### Phase 3: Create the Plan

- [ ] **3.1** Determine what files need to be:
  - **Created**: New files that don't exist
  - **Modified**: Existing files that need updates
  - **Referenced**: Files that should link to new content

- [ ] **3.2** Create a detailed action plan using TodoWrite:

  ```
  1. [First action] - [file affected]
  2. [Second action] - [file affected]
  3. Update CLAUDE.md documentation (if needed)
  4. Verify cross-references
  ```

- [ ] **3.3** Present the plan to user:

  ```markdown
  ## Implementation Plan: [Brief Title]

  ### Understanding

  You want to: [summary of goal]

  ### Research Findings

  - Related existing process: [what exists]
  - Pattern to follow: [which existing file is a good model]
  - Connections: [what will interact with this]

  ### Proposed Actions

  #### New Files to Create

  1. `[path/to/new/file.md]` - [purpose]

  #### Files to Modify

  1. `[path/to/existing.md]` - [what changes]
  2. `/CLAUDE.md` - Add documentation for new process (if significant)

  #### Validation

  - [ ] Follows existing patterns
  - [ ] Documentation updated
  - [ ] No conflicts with existing processes

  ### Questions Before Proceeding

  - [Any decisions needed]

  **Does this plan look correct?**
  ```

- [ ] **3.4** Wait for user approval or adjustments

### Phase 4: Execute the Plan

- [ ] **4.1** Work through the todo list methodically:
  - Complete one item at a time
  - Mark items complete as you go
  - If you encounter issues, pause and ask

- [ ] **4.2** For each new file, follow the appropriate template:

**Command Template:**

```markdown
---
description: [clear description]
argument-hint: [argument format]
allowed-tools: [appropriate tools]
category: [workflow|validation|documentation|etc]
---

# [Command Name]

[Purpose and context]

## Arguments

- `$ARGUMENTS` - [description]

## Task

### Step 1: [First Step]

[Instructions]

### Step 2: [Next Step]

[Instructions]

## Output Format

[Expected output structure]

## Edge Cases

[How to handle unusual situations]
```

**Agent Template:**

```markdown
---
name: [agent-name]
description: [purpose - what specialized task does this agent handle? Include usage triggers]
tools: [tool list - what tools does this isolated agent need?]
model: [sonnet/haiku/opus - which model is appropriate for this task?]
category: [database|typescript|react|testing|etc]
displayName: [Human readable name]
color: [blue|purple|red|green]
---

# [Agent Name]

[Role and capabilities - remember this agent runs in a separate context window]

## Your Task

[What the agent should accomplish in its isolated execution]
[Note: This agent is invoked via the Task tool, not directly]
[Note: This agent cannot spawn other agents (no infinite nesting)]

## Guidelines

[How to approach the work within this agent's specialized context]

## Output Format

[What should this agent return to the main conversation?]
[Remember: The main conversation doesn't see the agent's internal work, only the final output]
```

**Skill Template:**

```markdown
---
name: [verb-ing-noun]
description: [What it does]. [When to use it - must include "Use when..." phrase]
allowed-tools: [Optional - restrict to specific tools like Read, Grep if needed]
---

# [Skill Title]

## Overview

[Brief 2-3 sentence description of what expertise this Skill provides]

## When to Use

- [Scenario 1 where this Skill applies]
- [Scenario 2 where this Skill applies]
- [Scenario 3 where this Skill applies]

## Key Concepts

### [Concept 1]

[Explanation of the concept]

### [Concept 2]

[Explanation of the concept]

## Step-by-Step Approach

1. **[Step 1 Name]**: [What to do]
2. **[Step 2 Name]**: [What to do]
3. **[Step 3 Name]**: [What to do]

## Best Practices

- [Best practice 1]
- [Best practice 2]
- [Best practice 3]

## Common Pitfalls

- ❌ [What NOT to do]
- ❌ [What NOT to do]

## References

For detailed information, see: `reference.md`
```

**Skill Naming Requirements:**

- Use gerund form (verb + -ing): `processing-pdfs`, `reviewing-code`, `implementing-fsm`
- Lowercase letters, numbers, hyphens only
- Max 64 characters
- No vague names like "helper", "utils", "tools"

**Skill Description Requirements:**

- Must explain WHAT it does AND WHEN to use it
- Include "Use when..." phrase
- Third person, max 1024 characters
- Good: "Extracts text from PDF files. Use when analyzing PDF documents."
- Bad: "Helps with PDFs."

**Skill Directory Structure:**

```
.claude/skills/[skill-name]/
├── SKILL.md          # Required: Main instructions (under 500 lines)
├── reference.md      # Optional: Detailed documentation
├── examples.md       # Optional: Usage examples
├── scripts/          # Optional: Helper scripts
└── templates/        # Optional: Template files
```

**Rule Template (Path-Specific):**

````markdown
---
paths: [glob patterns for files this rule applies to]
---

# [Topic] Rules

These rules apply to [description of what files/patterns].

## Required Patterns

### [Pattern Category]

[Description and code examples]

```typescript
// Example code showing the pattern
```
````

## Anti-Patterns (Never Do)

```typescript
// NEVER do this
[bad pattern]  // Wrong

// Do this instead
[good pattern]  // Correct
```

## Checklist

- [ ] [Verification item 1]
- [ ] [Verification item 2]

````

**Rule Naming Conventions:**
- Use kebab-case: `api.md`, `dal.md`, `security.md`, `testing.md`
- Name by topic, not by path: `components.md` not `src-components.md`
- Keep names concise and descriptive

**Rule Path Patterns:**
- Use glob syntax: `apps/server/src/**/*.ts`, `**/__tests__/**/*.tsx`
- Multiple patterns: `apps/server/src/routes/**/*.ts, packages/shared/src/**/*.ts`
- Wildcards: `**/auth/**`, `**/login/**` (for security-related anywhere)

**When to Create a Rule vs Other Types:**
- Guidelines apply ONLY to specific file types → **Rule**
- Guidelines apply to ALL code → **CLAUDE.md**
- User needs explicit control → **Command**
- Task needs isolation/execution → **Agent**
- Reusable expertise, auto-activated → **Skill**

**Developer Guide Template:**

For developer guides in `/contributing/`, apply the `writing-developer-guides` skill which provides:
- Optimal structure for AI agent consumption
- Required sections (Overview, Key Files, Decision Matrix, Core Patterns, Anti-Patterns, Troubleshooting)
- Complete template in `.claude/skills/writing-developer-guides/reference.md`

After creating/updating a guide, update `contributing/INDEX.md` with:
- Entry in Guide Coverage Map table
- Pattern matching rules (file patterns + keywords)
- Maintenance tracking date

- [ ] **4.3** After creating/modifying process files, update `.claude/README.md`:
  - Add new commands to the Commands table
  - Add new agents to the Agents table
  - Add new skills to the Skills table
  - Add new rules to the Rules table
  - Update the inventory counts at the top
  - Update directory structure if needed

- [ ] **4.4** Update CLAUDE.md if:
  - The change introduces a significant new pattern
  - The change affects core project conventions
  - The change should be visible to all AI assistants

- [ ] **4.5** Update UI documentation pages if the change affects harness components:

  **When to update**: Changes to commands, agents, skills, or rules require updating the Claude Code harness UI page

  **What to update**:
  - `harnessStats` array - Update counts (Commands, Agents, Skills, Rules, Hooks, MCP Servers)
  - `commandNamespaces` array - Add/remove/modify command entries
  - `agents` array - Add/remove/modify agent entries
  - `skills` array - Add/remove/modify skill entries

  **How to update**:
  1. Read the current Claude Code harness UI page
  2. Count actual components:
     ```bash
     echo "Commands: $(find .claude/commands -name '*.md' -type f | wc -l)"
     echo "Agents: $(find .claude/agents -name '*.md' -type f | wc -l)"
     echo "Skills: $(find .claude/skills -name 'SKILL.md' -type f | wc -l)"
     echo "Rules: $(find .claude/rules -name '*.md' -type f | wc -l)"
     ```
  3. Update the relevant arrays to match
  4. Ensure consistency with `.claude/README.md` inventory

### Phase 5: Batch Confirmation

- [ ] **5.1** Before writing any files, present the batch:
  ```markdown
  ## Ready to Apply Changes

  ### Files to Create
  1. `[path]` - [X lines]

  ### Files to Modify
  1. `[path]` - [summary of changes]

  ### Preview of Key Changes

  **[filename]:**
````

[Key content snippet]

```

**Proceed with these changes?**
```

- [ ] **5.2** Wait for explicit confirmation

- [ ] **5.3** Apply all changes

### Phase 6: Verification

- [ ] **6.1** Verify the implementation:
  - Read back created/modified files
  - Check CLAUDE.md is accurate (if modified)
  - Verify no broken references

- [ ] **6.2** Report completion:

  ```markdown
  ## Implementation Complete

  ### Created

  - `[path]` - [description]

  ### Modified

  - `[path]` - [what changed]

  ### How to Use

  [Quick instructions for the new/updated process]

  ### Testing Suggestion

  Try: `[example usage]`
  ```

- [ ] **6.3** Offer follow-up:
  - "Would you like me to test this?"
  - "Any adjustments needed?"

### Phase 7: Automatic Review

- [ ] **7.1** After implementation is complete, automatically run `/system:review` to validate:
  - The new/updated processes are consistent with existing ones
  - Documentation is accurate
  - No conflicts were introduced
  - Cross-references are valid

- [ ] **7.2** Report the review findings and address any issues discovered

**Note**: This automatic review ensures quality and catches any inconsistencies introduced by the update.

## Claude Code Architecture Primer

Understanding HOW each component is invoked is critical for choosing the right file type.

### Invocation Models

| Component         | Invocation                                              | When to Use                                                | Example                                |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- |
| **Slash Command** | **User-invoked** - User types `/command`                | User wants explicit control over when this runs            | `/spec:create`, `/git:commit`          |
| **Agent**         | **Tool-invoked** - Invoked via Task tool                | Complex multi-step workflows needing separate context      | `typescript-expert`, `database-expert` |
| **Hook**          | **Event-triggered** - Runs at specific lifecycle events | Deterministic behavior that MUST happen at specific points | `file-guard`, `lint-changed`           |

### Key Architecture Concepts

**Slash Commands:**

- User explicitly types `/command` to trigger them
- They are expanded prompts - Markdown files containing instructions
- User controls when they execute
- Live in `.claude/commands/[namespace]/[name].md`

**Agents:**

- Invoked via the **Task tool** for complex isolated workflows
- Have **separate context windows** (prevents context pollution)
- Cannot spawn other agents (prevents infinite nesting)
- Use when task needs isolation or specialized expertise
- Custom system prompts and tool permissions
- Live in `.claude/agents/[category]/[name].md`

**Hooks:**

- Automatically run at specific **lifecycle events** via ClaudeKit
- Provide deterministic control (always happen at certain points)
- Don't rely on LLM decisions - they execute based on events
- Configured in `.claude/settings.json`
- Available events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`

### Key Questions for Choosing Type

**Ask yourself:**

1. **Who decides when this runs?**
   - User explicitly triggers → **Command**
   - Spawned for complex isolated task → **Agent**
   - System automatically at lifecycle event → **Hook**

2. **Does it need tool restrictions?**
   - Yes, isolate for security → Use **Agent** with custom tool list

3. **Does it need separate context?**
   - Yes, prevent context pollution → **Agent** (separate context window)
   - No, share context → **Command**

### Lifecycle Events (for Hooks)

| Event              | When It Fires              | Common Uses                        |
| ------------------ | -------------------------- | ---------------------------------- |
| `SessionStart`     | New/resumed session starts | Load context, set env vars         |
| `UserPromptSubmit` | User submits a prompt      | Add contextual information         |
| `PreToolUse`       | Before tool executes       | Permission gating, validation      |
| `PostToolUse`      | After tool completes       | Validation, formatting checks      |
| `Stop`             | Session ends               | Cleanup, auto-commit, final checks |
| `SubagentStop`     | Agent completes            | Checkpoint creation                |

## Decision Framework

### Choosing File Type

| If the need is...                               | Create a...     | Why                                        |
| ----------------------------------------------- | --------------- | ------------------------------------------ |
| User wants explicit control over execution      | Command         | User-invoked via `/command`                |
| Complex task needs isolation/separate context   | Agent           | Tool-invoked via Task tool                 |
| Reusable expertise Claude applies automatically | Skill           | Model-invoked when relevant                |
| Guidelines for specific file types/paths        | Rule            | Path-triggered when editing matching files |
| Deterministic behavior at lifecycle events      | Hook            | Event-triggered automatically              |
| Detailed patterns for developers                | Developer Guide | Reference documentation                    |

### Agents vs Skills Decision

**Create an AGENT when:**

- Task requires isolated context window
- Task needs specific tool restrictions different from main conversation
- Task benefits from parallel execution
- Task EXECUTES something (runs code, makes changes)

**Create a SKILL when:**

- Content teaches reusable expertise
- Claude should apply it automatically when relevant
- Content doesn't need context isolation
- Content PREPARES Claude to solve problems (methodology, approach)

**Key Test:** Does it TEACH or EXECUTE?

- TEACH (how to approach) → **Skill**
- EXECUTE (run tasks) → **Agent**

### Rules vs CLAUDE.md vs Skills

**Create a RULE when:**

- Guidelines apply ONLY to specific file patterns (e.g., `apps/server/src/routes/**/*.ts`)
- Content would clutter CLAUDE.md but is important for those file types
- Different files need different guidelines (e.g., API routes vs components)
- You want automatic context injection when editing matching files

**Keep in CLAUDE.md when:**

- Guidelines apply to ALL files in the project
- It's core project architecture or conventions
- It's high-level documentation needed in every context

**Create a SKILL when:**

- Expertise is reusable across many projects
- Claude should apply it automatically based on task type (not file type)
- Content teaches methodology, not file-specific patterns

**Key Test:** Does it apply to specific FILE TYPES or specific TASK TYPES?

- Specific files/paths → **Rule**
- Specific task categories → **Skill**
- Everything → **CLAUDE.md**

### Choosing Location

| Command type           | Namespace                        |
| ---------------------- | -------------------------------- |
| Specification workflow | `spec/`                          |
| Git operations         | `git/`                           |
| Developer guides       | `contributing/`                        |
| Checkpoints            | `checkpoint/`                    |
| System/meta            | `system/`                        |
| Code analysis          | `dev/`                           |
| Configuration          | `config/`                        |
| Architecture decisions | `adr/`                           |
| AGENTS.md management   | `agents-md/`                     |
| Other                  | Create new namespace or use root |

### Agent Categories

| Agent type          | Category         |
| ------------------- | ---------------- |
| Database operations | `database/`      |
| TypeScript/types    | `typescript/`    |
| React/frontend      | `react/`         |
| Testing             | `testing/`       |
| Build tools         | `build-tools/`   |
| Code quality        | `code-quality/`  |
| Documentation       | `documentation/` |
| Framework-specific  | `framework/`     |
| Git operations      | `git/`           |
| E2E testing         | `e2e/`           |
| Refactoring         | `refactoring/`   |

### Naming Conventions

- **Commands**: `verb` or `noun` (e.g., `create`, `validate`, `commit`)
- **Agents**: `domain-expert` (e.g., `typescript-expert`, `database-expert`)
- **Skills**: `verb-ing-noun` gerund form (e.g., `reviewing-code`, `processing-pdfs`, `implementing-fsm`)
- **Hooks**: `action-target` (e.g., `file-guard`, `lint-changed`)

## Interaction Guidelines

- **Research first** - Never modify without understanding current state
- **Confirm assumptions** - If unsure about user intent, ask
- **Follow patterns** - Match existing file structure and style
- **Update documentation** - CLAUDE.md must reflect significant changes
- **Batch changes** - Group related modifications
- **Explain reasoning** - Help user understand implementation choices
- **Offer alternatives** - If there are multiple good approaches, present options

## Quality Checklist

Before presenting changes for approval:

- [ ] Follows existing naming conventions
- [ ] Uses appropriate file type for the need (Command vs Agent vs Skill vs Rule)
- [ ] Has complete YAML frontmatter
- [ ] Includes clear instructions/documentation
- [ ] Handles edge cases
- [ ] Will be documented appropriately
- [ ] Doesn't conflict with existing processes
- [ ] File paths are correct and consistent

**Additional checks for Skills:**

- [ ] Name uses gerund form (verb-ing)
- [ ] Description includes "Use when..." phrase
- [ ] SKILL.md under 500 lines (progressive disclosure)
- [ ] Supporting files organized in skill directory

**Additional checks for Rules:**

- [ ] `paths:` frontmatter uses valid glob patterns
- [ ] Patterns don't overlap excessively with other rules
- [ ] Rule content is specific to the file types (not generic)
- [ ] Anti-patterns section included
- [ ] Examples use project conventions
- [ ] Rule documented in CLAUDE.md "Path-Specific Rules" section

## Edge Cases

- **Request is vague**: Ask clarifying questions before planning
- **Request conflicts with existing**: Present the conflict, ask how to resolve
- **Request requires multiple file types**: Plan all together, implement sequentially
- **Request affects hooks**: Extra caution - hooks can block operations
- **Request is very large**: Break into phases, confirm each phase
- **Request requires experimentation first**: If the user wants to "learn how to" do something before codifying, suggest `/system:learn` instead. The learn command handles the experimentation loop and then calls `/system:update` to codify what worked.
