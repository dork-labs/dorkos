---
description: Review processes for clarity, consistency, and improvements
argument-hint: '[area to review (optional)]'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion, Task, WebSearch
---

# System Review Command

Review Claude Code processes (commands, agents, hooks, configuration) for clarity, consistency, and potential improvements.

## Arguments

- `$ARGUMENTS` - Optional area to focus on. If empty, review everything.
  - Valid areas: `commands`, `agents`, `skills`, `rules`, `hooks`, `config`, `memory` (CLAUDE.md), `skill-extraction`
  - Can also specify a specific file or pattern: `git commands`, `database agents`, `api rules`
  - Special mode: `skill-extraction` - Focus specifically on identifying content that should become Skills

## Review Scope

### Files and Directories to Review

| Area                    | Location                      | What to Check                                           |
| ----------------------- | ----------------------------- | ------------------------------------------------------- |
| **Harness README**      | `/.claude/README.md`          | Inventory accuracy, component tables, structure         |
| **Memory/Instructions** | `/CLAUDE.md`                  | Main instructions, accuracy, completeness               |
| **Commands**            | `/.claude/commands/**/*.md`   | Clarity, consistency, functionality                     |
| **Agents**              | `/.claude/agents/**/*.md`     | Purpose clarity, tool access, instructions              |
| **Skills**              | `/.claude/skills/**/SKILL.md` | Skill definitions, descriptions, progressive disclosure |
| **Rules**               | `/.claude/rules/*.md`         | Path patterns, content relevance, no overlaps           |
| **Hooks**               | `/.claude/settings.json`      | Hook configuration, lifecycle events                    |
| **ADRs**                | `/decisions/*.md`             | Frontmatter, active voice, consequences, manifest sync  |
| **Developer Guides**    | `/contributing/*.md`                | Patterns, best practices                                |
| **UI Documentation**    | `apps/client/src/**/*.tsx`    | Stats accuracy, component lists, content currency       |

## Order of Operations

Execute these steps sequentially. This is an **interactive review** - ask questions and wait for responses.

### Phase 1: Discovery & Inventory

- [ ] **1.1** Determine scope from `$ARGUMENTS`
  - If empty → review everything
  - If specified → focus on that area + its connections

- [ ] **1.2** Build inventory of files to review:

  ```bash
  # Commands
  find ".claude/commands" -name "*.md" -type f

  # Agents
  find ".claude/agents" -name "*.md" -type f

  # Skills
  find ".claude/skills" -name "SKILL.md" -type f 2>/dev/null || echo "No skills directory"

  # Path-specific rules
  find ".claude/rules" -name "*.md" -type f 2>/dev/null || echo "No rules directory"

  # Developer Guides
  find "developer-guides" -name "*.md" -type f 2>/dev/null || echo "No developer-guides directory"

  # Memory files
  ls -la "CLAUDE.md"

  # Hook configuration
  cat ".claude/settings.json" | head -50

  # Count components for README reconciliation
  echo "=== Component Counts ==="
  echo "Commands: $(find .claude/commands -name '*.md' -type f | wc -l)"
  echo "Agents: $(find .claude/agents -name '*.md' -type f | wc -l)"
  echo "Skills: $(find .claude/skills -name 'SKILL.md' -type f 2>/dev/null | wc -l)"
  echo "Rules: $(find .claude/rules -name '*.md' -type f 2>/dev/null | wc -l)"
  ```

- [ ] **1.3** Reconcile with harness README:
  - Read `.claude/README.md` and compare inventory counts
  - Check if component counts match between actual files and README documentation
  - Note any discrepancies for later fixing

- [ ] **1.4** Report inventory to user:
  ```
  Found X commands, Y agents, Z skills, W rules, V developer guides to review.
  Hook configuration: [summary]
  Skills directory: [exists/missing]
  Rules directory: [exists/missing]
  README inventory: [matches/discrepancies noted]
  ```

### Phase 2: Read & Analyze

- [ ] **2.1** Read harness documentation (the sources of truth):
  - Read `.claude/README.md` for harness structure and component inventory
  - Read `CLAUDE.md` for project architecture and conventions
  - Note all documented processes and referenced commands/agents
  - Build a mental model of how things should work

- [ ] **2.2** Read each file in scope, checking for:

**Clarity Issues:**

- Ambiguous instructions
- Missing context
- Unclear when to use
- Missing examples

**Consistency Issues:**

- Conflicting instructions between files
- Different terminology for same concepts
- Inconsistent formatting
- Mismatched YAML frontmatter

**Functionality Issues:**

- Broken file paths
- Outdated references
- Missing dependencies
- Logic errors

**Completeness Issues:**

- Missing documentation
- Incomplete instructions
- Missing edge case handling

- [ ] **2.3** Check cross-references:
  - Does CLAUDE.md accurately describe available commands/agents?
  - Do commands reference agents that exist?
  - Do hook configurations reference valid events?

### Phase 3: Identify Issues

- [ ] **3.1** Categorize findings:

| Severity       | Meaning                               | Action     |
| -------------- | ------------------------------------- | ---------- |
| **Critical**   | Broken functionality, blocking errors | Must fix   |
| **Warning**    | Inconsistency, confusion risk         | Should fix |
| **Suggestion** | Improvement opportunity               | Optional   |

- [ ] **3.2** For each issue, determine:
  - Can it be fixed automatically?
  - Is there an obvious correct answer?
  - Does it require user input?

### Phase 4: Present Findings

- [ ] **4.1** Present summary to user:

  ```markdown
  ## Process Review Summary

  **Scope**: [what was reviewed]
  **Files Reviewed**: X

  ### Critical Issues (must fix)

  - [ ] [Issue description] in `file.md`

  ### Warnings (should fix)

  - [ ] [Issue description] in `file.md`

  ### Suggestions (optional improvements)

  - [ ] [Improvement idea]
  ```

- [ ] **4.2** For issues requiring decisions, use AskUserQuestion:
  - Present the conflict/ambiguity
  - Offer clear options
  - Include a recommendation when possible

### Phase 5: Apply Fixes

- [ ] **5.1** Group proposed changes by file

- [ ] **5.2** Present batch of changes:

  ```markdown
  ## Proposed Changes

  ### File: `.claude/commands/spec/create.md`

  - Change 1: [description]
  - Change 2: [description]

  ### File: `CLAUDE.md`

  - Change 1: [description]

  **Proceed with these X changes?**
  ```

- [ ] **5.3** Wait for user confirmation before making changes

- [ ] **5.4** Apply approved changes using Edit tool

- [ ] **5.5** Report completion:

  ```markdown
  ## Changes Applied

  - [x] Updated `file1.md`: [what changed]
  - [x] Updated `file2.md`: [what changed]

  ## Remaining Items

  - [ ] [Any deferred items]
  ```

### Phase 6: Recommendations

- [ ] **6.1** Present improvement opportunities:

  ```markdown
  ## Improvement Recommendations

  ### High Value

  1. **[Recommendation]**: [Why and how]

  ### Nice to Have

  1. **[Recommendation]**: [Why and how]
  ```

- [ ] **6.2** Ask user which (if any) to implement now

### Phase 7: Skill Extraction Analysis

**This phase identifies content that should be extracted to Skills.** Run this phase when:

- `$ARGUMENTS` includes `skill-extraction`
- Full review finds patterns that would benefit from Skill extraction
- User asks about improving agent/command organization

- [ ] **7.1** Research current Claude Code Skills best practices:

  ```
  Task(
    description="Lookup Claude Code Skills best practices",
    prompt="Find the latest Claude Code documentation about Skills - what makes a good Skill, naming conventions, directory structure, and when to use Skills vs Agents. Include any recent changes or new features.",
    subagent_type="claude-code-guide"
  )
  ```

  **Note**: Use `claude-code-guide` (not `research-expert`) for Claude Code documentation.
  This agent has direct access to official Claude Code docs and is the authoritative source.

- [ ] **7.2** Scan for Skill extraction candidates in these locations:

**Developer Guides** (`contributing/*.md`):

- Step-by-step procedures that teach expertise
- Best practices sections that guide behavior
- Patterns that apply across multiple features

**Agents** (`.claude/agents/**/*.md`):

- Agents that primarily teach "how to think" rather than "execute tasks"
- Agents that don't need tool isolation
- Agents whose expertise could be useful outside isolated contexts

**CLAUDE.md**:

- Repeated coding standards and patterns
- Architectural guidelines
- Security/quality checklists

**Commands** (`.claude/commands/**/*.md`):

- Commands that primarily provide expertise/guidance
- Commands that could work automatically (model-invoked)

- [ ] **7.3** Apply Skill Extraction Decision Tree to each candidate:

  ```
  For each piece of content:

  1. Does it TEACH reusable expertise? (vs. execute a task)
     └─ NO → Not a Skill candidate
     └─ YES → Continue

  2. Would Claude benefit from using it automatically (model-invoked)?
     └─ NO → Keep as Command (user-invoked) or Agent (task-invoked)
     └─ YES → Continue

  3. Does it need isolated context or specific tool permissions?
     └─ YES → Keep as Agent (context isolation needed)
     └─ NO → Continue

  4. Is it reusable across multiple conversations/projects?
     └─ NO → Keep as CLAUDE.md content (project-specific)
     └─ YES → EXTRACT TO SKILL
  ```

- [ ] **7.4** For each Skill candidate, evaluate:
  - **Name**: Can it be a gerund? (verb-ing: `reviewing-code`, `writing-tests`)
  - **Description**: Can you write "does X when Y" clearly?
  - **Size**: Is it under 500 lines for SKILL.md body?
  - **Progressive Disclosure**: Can details go in separate reference files?

- [ ] **7.5** Present Skill extraction recommendations:

  ```markdown
  ## Skill Extraction Analysis

  ### High-Priority Candidates (Strong Skill Fit)

  | Source          | Proposed Skill Name | Why Extract?                                   |
  | --------------- | ------------------- | ---------------------------------------------- |
  | `contributing/xyz.md` | `reviewing-xyz`     | Reusable expertise, auto-activation beneficial |

  ### Medium-Priority Candidates (Consider Converting)

  | Source                         | Proposed Skill Name | Trade-offs                           |
  | ------------------------------ | ------------------- | ------------------------------------ |
  | `.claude/agents/abc-expert.md` | `analyzing-abc`     | Currently Agent, could work as Skill |

  ### Keep as Current Type (Not Skill Candidates)

  | Source                    | Current Type | Why Keep?              |
  | ------------------------- | ------------ | ---------------------- |
  | `.claude/agents/xyz.md`   | Agent        | Needs isolated context |
  | `.claude/commands/foo.md` | Command      | User-invoked preferred |

  ### Recommended Actions

  1. **Create Skill**: `[skill-name]` from `[source]`
  2. **Convert Agent to Skill**: `[agent]` → `[skill-name]`
  3. **Extract from CLAUDE.md**: `[section]` → `[skill-name]`
  ```

- [ ] **7.6** If user approves extraction, use Task tool to execute:
  ```
  Task(
    description="Create Skill from [source]",
    prompt="Create a new Skill in .claude/skills/[skill-name]/SKILL.md extracted from [source file]. Follow Skill best practices: gerund naming, clear description with 'does X when Y', under 500 lines, progressive disclosure.",
    subagent_type="documentation-expert"
  )
  ```

## Review Checklists

### For Harness README

- [ ] Inventory counts match actual file counts
- [ ] All commands are listed in Commands table
- [ ] All agents are listed in Agents table
- [ ] All skills are listed in Skills table
- [ ] All rules are listed in Rules table
- [ ] Directory structure diagram is accurate
- [ ] Core workflows match available commands
- [ ] Naming conventions section is up to date

### For Commands

- [ ] Has valid YAML frontmatter (description, argument-hint, allowed-tools)
- [ ] Clear purpose statement
- [ ] Arguments documented
- [ ] Step-by-step instructions
- [ ] Example outputs
- [ ] Edge cases handled
- [ ] File paths are correct (no hardcoded absolute paths)
- [ ] Referenced agents exist

### For Agents

- [ ] Has valid YAML frontmatter (name, description, tools, model)
- [ ] Description clearly indicates when to use this agent
- [ ] Tools in frontmatter are appropriate for agent's purpose
- [ ] Clear explanation of what the agent does
- [ ] Practical examples or guidelines
- [ ] Output format defined
- [ ] Explains why this needs to be an Agent (context isolation, complexity, etc.)
- [ ] **Skill Check**: Could this Agent work as a Skill instead? (See Agents vs Skills)

### For Skills

- [ ] Has valid YAML frontmatter (name, description, optional allowed-tools)
- [ ] **Name**: Uses gerund form (verb-ing: `processing-pdfs`, `reviewing-code`)
- [ ] **Name**: Lowercase letters, numbers, hyphens only, max 64 chars
- [ ] **Description**: Explains what it does AND when to use it ("does X when Y")
- [ ] **Description**: Written in third person, max 1024 chars
- [ ] **Size**: SKILL.md body under 500 lines (use progressive disclosure)
- [ ] **Progressive Disclosure**: Detailed content in separate reference files
- [ ] **allowed-tools**: Restricted appropriately if Skill needs limited access
- [ ] Located in correct directory: `.claude/skills/[skill-name]/SKILL.md`
- [ ] Supporting files organized: `reference.md`, `examples.md`, `scripts/`, `templates/`

### For Rules

- [ ] Has valid YAML frontmatter with `paths:` field
- [ ] **Paths**: Uses valid glob syntax (`src/**/*.ts`, `__tests__/**/*.tsx`)
- [ ] **Paths**: Patterns correctly match intended files (test with `ls` or `find`)
- [ ] **Paths**: No excessive overlap with other rules (check for conflicts)
- [ ] **Content**: Specific to the file types (not generic guidelines)
- [ ] **Content**: Includes code examples using project conventions
- [ ] **Content**: Has "Anti-Patterns" or "Never Do" section
- [ ] **Naming**: Uses kebab-case, topic-based names (`api.md`, not `src-api.md`)
- [ ] **Documentation**: Listed in CLAUDE.md "Path-Specific Rules" section
- [ ] **Relevance**: Content wouldn't fit better in CLAUDE.md, a Skill, or Developer Guide

### For ADRs

- [ ] Has valid YAML frontmatter (number, title, status, created, spec, superseded-by)
- [ ] Status is one of: proposed, accepted, deprecated, superseded
- [ ] Context section is 2-5 sentences, problem-focused (no solution in context)
- [ ] Decision section uses active voice ("We will...")
- [ ] Consequences section has both Positive and Negative subsections
- [ ] Negative consequences are honest trade-offs (not empty)
- [ ] `decisions/manifest.json` matches actual files (numbers, slugs, statuses)
- [ ] `nextNumber` in manifest is higher than all existing ADR numbers
- [ ] Spec links in frontmatter reference valid spec slugs

### For Hooks

- [ ] Configured in `.claude/settings.json`
- [ ] Matches appropriate lifecycle event (PreToolUse, PostToolUse, etc.)
- [ ] Tool matcher is correct
- [ ] ClaudeKit hook command exists

### For CLAUDE.md

- [ ] Project conventions are accurate
- [ ] Directory structure is correct
- [ ] Code patterns are current
- [ ] Developer guide references are valid
- [ ] Examples work correctly

### For UI Documentation Pages (`apps/client/src/`)

- [ ] `harnessStats` array counts match actual file counts in `.claude/`
- [ ] `commandNamespaces` array lists all command namespaces accurately
- [ ] `agents` array matches actual agents in `.claude/agents/`
- [ ] `skills` array matches actual skills in `.claude/skills/`
- [ ] Content matches `.claude/README.md` (single source of truth)
- [ ] No stale or removed components listed
- [ ] File paths in UI are correct

## Cross-Reference Validation

Check these relationships:

```
README.md ←→ Actual Files (do inventory counts match reality?)
README.md ←→ CLAUDE.md (are component tables consistent?)
README.md ←→ Commands (are all commands listed in Commands table?)
README.md ←→ Agents (are all agents listed in Agents table?)
README.md ←→ Skills (are all skills listed in Skills table?)
README.md ←→ Rules (are all rules listed in Rules table?)
CLAUDE.md ←→ Commands (are referenced commands accurate?)
CLAUDE.md ←→ Agents (are referenced agents accurate?)
CLAUDE.md ←→ Skills (are referenced skills accurate?)
CLAUDE.md ←→ Rules (are rules listed in "Path-Specific Rules" section?)
CLAUDE.md ←→ Developer Guides (are references valid?)
Commands ←→ Agents (do Commands reference Agents that exist?)
Commands ←→ Skills (do Commands reference Skills that exist?)
Agents ←→ tools frontmatter (does tool access match agent's purpose?)
Agents ←→ Skills (is there overlap? Should Agent be Skill?)
Skills ←→ Developer Guides (is there duplication?)
Rules ←→ Rules (do path patterns overlap? Is there conflict?)
Rules ←→ CLAUDE.md (does rule content duplicate CLAUDE.md content?)
Rules ←→ Developer Guides (is there duplication of patterns?)
Hooks ←→ Lifecycle events (does hook use appropriate event?)

# ADR Validation
ADR manifest ←→ ADR files (do counts and numbers match?)
ADR spec links ←→ Spec manifest (do referenced specs exist?)
ADR statuses ←→ ADR files (do manifest statuses match frontmatter?)

# UI Documentation Synchronization
UI Pages ←→ README.md (do stats and component lists match?)
UI Pages ←→ Actual Files (do counts match file system?)
UI Pages ←→ CLAUDE.md (is displayed info consistent?)
```

### Architecture-Specific Validations

**For Commands:**

- Are tools in `allowed-tools` appropriate for the command's purpose?
- Does the command reference any project-specific paths incorrectly?
- Are bash commands using relative paths?

**For Agents:**

- Is there a clear reason why this needs context isolation?
- Are the tools listed actually needed?
- Does the model choice (sonnet/haiku/opus) match the complexity?
- **Skill Check**: Could this be converted to a Skill? (See Phase 7)

**For Skills:**

- Is the name in gerund form (verb-ing)?
- Does the description include both "does what" AND "use when"?
- Is SKILL.md under 500 lines? (use progressive disclosure if not)
- Does it have supporting files if needed (reference.md, examples.md)?
- Is `allowed-tools` appropriately restricted?
- Does similar content exist in an Agent? (potential duplication)

**For Rules:**

- Does the `paths:` pattern actually match the intended files?
  ```bash
  # Test patterns - should return expected files
  find . -path "[pattern]" -type f | head -5
  ```
- Are there overlapping patterns with other rules?
  ```bash
  # Check for potential conflicts
  grep -l "paths:" .claude/rules/*.md
  ```
- Is the content specific enough for those file types?
- Could this content live in CLAUDE.md instead (if it's project-wide)?
- Is there duplication with Developer Guides?
- Are examples using project-specific conventions?

**For Hooks (in settings.json):**

- Is the lifecycle event correct for the hook's purpose?
  - Validation/blocking → PreToolUse
  - Checking/logging → PostToolUse
  - Context loading → SessionStart or UserPromptSubmit
  - Cleanup → Stop
- Does the tool matcher correctly identify target tools?

## Interaction Guidelines

- **Be thorough but efficient** - don't overwhelm with minor issues
- **Prioritize clarity** - always explain why something is an issue
- **Infer when possible** - if the right answer is obvious from CLAUDE.md, just fix it
- **Ask when uncertain** - use AskUserQuestion for genuine ambiguity
- **Batch changes** - group related fixes and confirm before applying
- **Preserve intent** - fix bugs, don't redesign unless asked

## Edge Cases

- **No issues found**: Report clean bill of health, suggest any improvements
- **Many issues**: Prioritize critical first, offer to fix in batches
- **Conflicting sources**: CLAUDE.md is authoritative, but ask if conflict seems intentional
- **Scope unclear**: Ask user to clarify what they want reviewed
- **No skills directory**: Suggest creating `.claude/skills/` if extraction candidates found

## Claude Code Component Architecture Reference

### Component Comparison Matrix

| Aspect         | Slash Command                 | Agent                     | Skill                         | Rule                        | Hook                    |
| -------------- | ----------------------------- | ------------------------- | ----------------------------- | --------------------------- | ----------------------- |
| **Invocation** | User types `/command`         | Tool-invoked via Task     | Model-invoked (automatic)     | Path-triggered              | Event-triggered         |
| **Context**    | Shared with main conversation | Isolated context window   | Shared with main conversation | Shared (injected)           | N/A (scripts)           |
| **Purpose**    | Quick actions/workflows       | Complex isolated tasks    | Reusable expertise            | File-type guidelines        | Deterministic behavior  |
| **Location**   | `.claude/commands/`           | `.claude/agents/`         | `.claude/skills/`             | `.claude/rules/`            | `.claude/settings.json` |
| **When Runs**  | User explicitly invokes       | Spawned for specific task | Claude decides automatically  | When editing matching files | At lifecycle events     |

### Agents vs Skills: Deep Comparison

#### Use an AGENT When:

✅ **Task requires isolated context**

- Agent has its own conversation history
- Prevents context pollution in main conversation
- Useful for exploratory or messy tasks

✅ **Task requires specific tool restrictions**

- Agent can have different tools than main conversation
- Useful for security (read-only agents, etc.)

✅ **Task requires independent execution**

- Running multiple agents in parallel
- Long-running tasks that should be isolated

✅ **Task requires custom model selection**

- Agent can use different model (haiku for speed, opus for complexity)

✅ **Task EXECUTES something** (vs. teaches)

- Runs tests, makes changes, searches code
- Produces concrete outputs

**Agent Signals in Existing Content:**

- Uses phrase "execute", "run", "perform"
- Needs tool isolation (`allowed-tools` very different from main)
- Benefits from parallel execution
- Has "Output Format" section defining concrete deliverables

#### Use a SKILL When:

✅ **Content teaches reusable expertise**

- How to approach a problem
- Best practices and guidelines
- Patterns to follow

✅ **Content should apply automatically**

- Claude should use it when relevant without being asked
- Context-matching is valuable

✅ **Content is used across multiple conversations**

- Not project-specific
- Applicable to many different tasks

✅ **Content doesn't need isolated context**

- Works fine in main conversation
- Doesn't pollute context

✅ **Content PREPARES Claude to solve problems** (vs. solves them)

- Teaching expertise, not executing tasks
- Provides framework for thinking

**Skill Signals in Existing Content:**

- Uses phrase "how to", "best practices", "guidelines"
- Provides step-by-step thinking framework
- Could apply to many different situations
- Doesn't require specific tool access
- Focuses on approach/methodology

### Conversion Patterns

#### Agent → Skill Conversion

**Good Candidate:**

```markdown
# Code Review Expert (Agent)

---

## tools: Read, Grep

Reviews code for architecture, quality, security...

## What to Check

1. Architecture patterns...
2. Code quality...
```

**Converted to Skill:**

```markdown
# reviewing-code-quality (Skill)

---

name: reviewing-code-quality
description: Reviews code for architecture, quality, security, and performance. Use when asked to review code or assess code quality.

---

## Code Review Framework

1. Architecture patterns...
2. Code quality...
```

**Bad Candidate (Keep as Agent):**

```markdown
# Database Expert (Agent)

---

## tools: Bash, Read

Executes database queries and migrations...
```

→ Keep as Agent because it EXECUTES database operations (needs tool isolation)

#### CLAUDE.md → Skill Extraction

**Good Candidate:**

```markdown
## AsyncButton Usage (MANDATORY)

CRITICAL: For buttons that trigger async operations...

**When to Use AsyncButton:**

- Button triggers a React Query mutation
- Button calls a server action
  ...
```

**Could become Skill:**

```markdown
---
name: using-async-buttons
description: Guides correct usage of AsyncButton component for React async operations. Use when implementing buttons that trigger mutations or async operations.
---

# AsyncButton Usage

## When to Use

- Button triggers a React Query mutation...
```

**Bad Candidate (Keep in CLAUDE.md):**

```markdown
## Database Protection Rules

CRITICAL: Migration-First Approach
...
```

→ Keep in CLAUDE.md because it's project-specific policy, not reusable expertise

#### Developer Guide → Skill Extraction

**Good Candidate:**

```markdown
# FSM Developer Guide

## FSM Lifecycle Hooks

1. guard → Check if transition allowed
2. do → Run event-specific effects
   ...
```

**Could become Skill:**

```markdown
---
name: implementing-fsm-workflows
description: Guides implementation of FSM (Finite State Machine) workflow patterns. Use when implementing state machines or workflow transitions.
---

# FSM Implementation

## Lifecycle Hooks

...
```

### Skill Extraction Signals Checklist

When scanning content, look for these signals:

**Strong Skill Signals (Extract):**

- [ ] Contains "how to" methodology
- [ ] Has numbered step-by-step approach
- [ ] Defines "when to use" patterns
- [ ] Provides thinking framework
- [ ] Applicable beyond this specific project
- [ ] Would benefit from automatic activation

**Weak Skill Signals (Keep Current):**

- [ ] Project-specific configuration
- [ ] Executes concrete tasks
- [ ] Requires tool isolation
- [ ] User should control when it runs
- [ ] Very short/simple content

### Naming Conventions Summary

| Component    | Naming Pattern           | Examples                                          |
| ------------ | ------------------------ | ------------------------------------------------- |
| **Commands** | `verb` or `noun`         | `create`, `validate`, `commit`                    |
| **Agents**   | `domain-expert`          | `typescript-expert`, `database-expert`            |
| **Skills**   | `verb-ing-noun` (gerund) | `reviewing-code`, `processing-pdfs`               |
| **Rules**    | `topic` (kebab-case)     | `api`, `dal`, `security`, `testing`, `components` |
| **Hooks**    | `action-target`          | `file-guard`, `lint-changed`                      |

### Quick Reference: Component Selection

```
User explicitly invokes? ────────────────────────► COMMAND
        │
        ▼
Needs isolated context or specific tools? ───────► AGENT
        │
        ▼
Teaches reusable expertise? ─────────────────────► SKILL
        │
        ▼
Applies only to specific file types/paths? ─────► RULE
        │
        ▼
Must happen at lifecycle events? ────────────────► HOOK
        │
        ▼
Project-specific documentation? ─────────────────► CLAUDE.md
```
