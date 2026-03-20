---
description: Structured ideation with documentation
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Write, AskUserQuestion, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(python3:*), Bash(mkdir:*)
argument-hint: '<task-brief>'
category: workflow
---

# Preflight ▸ Discovery ▸ Plan

**Task Brief:** $ARGUMENTS

---

## Context-Saving Architecture

This command uses **parallel background agents** for maximum efficiency:

1. **Main context**: Lightweight orchestration (~15% of context)
2. **Codebase exploration agent**: Maps relevant code (background, isolated)
3. **Research agent**: Investigates best practices (background, parallel)
4. **Main context**: Resolve key decisions interactively with the user
5. **Main context**: Synthesize findings and write document

**Context savings**: ~80% reduction vs sequential foreground execution

**Performance**: Exploration and research run in parallel instead of sequential

---

## Phase 1: Setup (Main Context - Lightweight)

### Step 1.1: Create Task Slug & Setup

1. Create a URL-safe slug from the task brief (e.g., "fix-chat-scroll-bug")
2. Create feature directory: `mkdir -p specs/{slug}`
3. Read `specs/manifest.json` → get `nextNumber` → assign as this spec's number
4. Store the number and today's date for frontmatter

Display:

```
📋 Ideation: $TASK_BRIEF
   Slug: [slug]
   Number: [number]
   Directory: specs/[slug]/
```

### Step 1.2: Echo Intent & Assumptions

Write a quick "Intent & Assumptions" block:

- Restate the task brief in 1-3 sentences
- List explicit assumptions
- List what's explicitly out-of-scope

Store this for the ideation document.

---

## Phase 2: Parallel Discovery (Background Agents)

Launch BOTH agents simultaneously in background, then continue with initial drafting while they work.

### Step 2.1: Launch Codebase Exploration Agent

```
Task(
  description: "Explore codebase for [slug]",
  prompt: <see EXPLORATION_AGENT_PROMPT>,
  subagent_type: "Explore",
  run_in_background: true
)
```

Store the task_id as `exploration_task_id`.

### Step 2.2: Launch Research Agent (Parallel)

```
Task(
  description: "Research solutions for [slug]",
  prompt: <see RESEARCH_AGENT_PROMPT>,
  subagent_type: "research-expert",
  run_in_background: true
)
```

Store the task_id as `research_task_id`.

Display:

```
🔄 Discovery phase started (parallel agents):
   → Codebase exploration agent: Mapping relevant code
   → Research agent: Investigating best practices

   Both agents running in parallel...
```

### Step 2.3: Determine if Bug Fix

While agents run, check if this is a bug fix:

- Look for keywords: "fix", "bug", "broken", "error", "crash", "doesn't work"
- If bug fix detected, note that root cause analysis will be needed

---

## Phase 3: Collect Results

### Step 3.1: Wait for Exploration Results

```
TaskOutput(task_id: exploration_task_id, block: true)
```

Extract from exploration findings:

- Primary components/modules (with file paths)
- Shared dependencies (theme/hooks/utils/stores)
- Data flow (source → transform → render)
- Feature flags/config
- Potential blast radius

### Step 3.2: Wait for Research Results

```
TaskOutput(task_id: research_task_id, block: true)
```

Extract from research findings:

- Potential solutions with pros/cons
- Industry best practices
- Trade-offs and considerations
- Ultimate recommendation

Display:

```
✅ Discovery complete:
   → Codebase exploration: [X] files mapped, [Y] components identified
   → Research: [Z] approaches analyzed
```

---

## Phase 3.5: Interactive Clarification

Now that you have exploration and research findings, resolve key decisions with the user BEFORE writing the document.

### Step 3.5.1: Identify Key Decisions

Analyze the exploration and research findings to identify 2-4 unresolved decisions that would meaningfully affect the ideation outcome. Look for:

- **Scope boundaries** — What's included vs excluded when the task brief is ambiguous
- **Technical approach** — When research found multiple viable solutions with different trade-offs
- **Architecture choices** — When exploration revealed multiple valid integration points or patterns
- **Behavioral decisions** — Error handling, edge cases, UX flows that aren't specified

**Skip this phase if** the task brief is sufficiently clear and exploration/research findings converge on an obvious approach. Not every ideation needs interactive clarification — use judgment.

### Step 3.5.2: Ask Clarifying Questions

Use AskUserQuestion with up to 4 questions in a single call. For EACH question:

1. **Think deeply** before formulating — consider what the codebase exploration revealed about existing patterns, what the research found about best practices, and what the user's intent likely is
2. **The FIRST option MUST be your recommendation**, with `(Recommended)` appended to the label
3. **The recommended option's description MUST explain WHY** — reference specific findings (e.g., "Follows the existing pattern in `features/chat/`" or "Research shows this is the industry standard for...")
4. Provide 2-3 alternative options that represent genuinely different approaches, not minor variations

Example:

```
AskUserQuestion:
  questions:
    - question: "How should error states be displayed in the new panel?"
      header: "Error UX"
      options:
        - label: "Inline toast notification (Recommended)"
          description: "Consistent with the existing pattern in ChatPanel — exploration found 4 other features using toasts via sonner. Least disruptive to user flow."
        - label: "Inline error banner"
          description: "More visible but takes up panel space. Would be a new pattern in the codebase."
        - label: "Status bar indicator"
          description: "Minimal UI impact but easy to miss. Used by StatusLine for non-critical info."
```

### Step 3.5.3: Incorporate Answers

Store the user's answers (including any custom "Other" responses) for incorporation into the ideation document. These become resolved decisions in Section 6, not open questions.

Display:

```
✅ Clarification complete:
   → [N] decisions resolved
   → Proceeding to synthesis...
```

---

## Phase 4: Synthesis & Document (Main Context)

### Step 4.1: Root Cause Analysis (Bug Fixes Only)

If the task is a bug fix:

1. Based on exploration findings, identify plausible root-cause hypotheses:
   - Code lines, props/state issues
   - CSS/layout rules
   - Event handlers, race conditions
   - API or data flow issues

2. Select the most likely hypothesis with evidence from exploration

### Step 4.2: Write Ideation Document

Create `specs/{slug}/01-ideation.md` with all gathered information.

**Document Structure:**

```markdown
---
slug: { slug }
number: { number }
created: { current-date }
status: ideation
---

# {Task Title}

**Slug:** {slug}
**Author:** Claude Code
**Date:** {current-date}
**Branch:** preflight/{slug}

---

## 1) Intent & Assumptions

- **Task brief:** {task description}
- **Assumptions:** {bulleted list}
- **Out of scope:** {bulleted list}

## 2) Pre-reading Log

{From exploration agent - files/docs read with takeaways}

- `path/to/file`: takeaway...

## 3) Codebase Map

{From exploration agent}

- **Primary components/modules:** {paths + roles}
- **Shared dependencies:** {theme/hooks/utils/stores}
- **Data flow:** {source → transform → render}
- **Feature flags/config:** {flags, env, owners}
- **Potential blast radius:** {areas impacted}

## 4) Root Cause Analysis

{Only for bug fixes - from main context analysis}

- **Repro steps:** {numbered list}
- **Observed vs Expected:** {concise description}
- **Evidence:** {code refs, logs, CSS/DOM snapshots}
- **Root-cause hypotheses:** {bulleted with confidence}
- **Decision:** {selected hypothesis + rationale}

## 5) Research

{From research agent}

- **Potential solutions:** {numbered list with pros and cons}
- **Recommendation:** {concise description}

## 6) Decisions

{From interactive clarification phase — resolved, not open}

| #   | Decision           | Choice          | Rationale                                           |
| --- | ------------------ | --------------- | --------------------------------------------------- |
| 1   | {What was decided} | {User's choice} | {Why — from exploration/research or user reasoning} |
| 2   | {What was decided} | {User's choice} | {Why}                                               |

{If no clarification was needed, state: "No ambiguities identified — task brief and findings were sufficiently clear."}
```

### Step 4.3: Update Spec Manifest

After writing the ideation document, update `specs/manifest.json`:

1. Add a new entry to the `specs` array with `number`, `slug`, `title`, `created` (today), and `status: "ideation"`
2. Increment `nextNumber`

### Step 4.4: Display Completion Summary

```
═══════════════════════════════════════════════════
              IDEATION COMPLETE
═══════════════════════════════════════════════════

📄 Document: specs/[slug]/01-ideation.md

📊 Discovery Summary:
   - Files explored: [X]
   - Components mapped: [Y]
   - Approaches researched: [Z]

📝 Decisions resolved: [N] items
   (See section 6 of the ideation document)

🚀 Next Steps:
   1. Review the ideation document
   2. Run: /ideate-to-spec specs/[slug]/01-ideation.md

═══════════════════════════════════════════════════
```

---

## EXPLORATION_AGENT_PROMPT

```
You are exploring a codebase to map relevant areas for a new task.

## Context
- **Task Brief**: [TASK_BRIEF]
- **Feature Slug**: [SLUG]
- **Is Bug Fix**: [true/false]

## Your Tasks

### 1. Scan Repository Structure

Search for:
- Developer guides in `contributing/`
- Architecture docs in the root directory
- README files
- Related spec files in `specs/`
- Related Architecture Decision Records in `decisions/`

### 2. Search for Relevant Code

Using keywords from the task brief, search for:
- Components, hooks, utilities
- Styles and layout files
- Data access patterns
- Feature flags or config
- Test files for affected areas

### 3. Build Dependency/Context Map

For each relevant file found, note:
- File path
- Role/purpose (1-2 sentences)
- Dependencies it imports
- What imports it (reverse dependencies)

### 4. Assess Blast Radius

Identify:
- Direct files that need changes
- Files that depend on those (may need updates)
- Test files that will need updates
- Config/feature flags affected

### 5. Return Structured Findings

Return in this format:

```

## CODEBASE EXPLORATION RESULTS

### Pre-reading Log

- `contributing/data-fetching.md`: Explains TanStack Query patterns used in this project
- `src/layers/entities/user/api/queries.ts`: Current user data fetching implementation
  [Continue for all relevant files...]

### Codebase Map

**Primary Components/Modules:**

- `src/layers/features/auth/ui/LoginForm.tsx` - Main login form component
- `src/layers/entities/user/model/types.ts` - User type definitions
  [Continue...]

**Shared Dependencies:**

- `src/layers/shared/lib/query-client.ts` - TanStack Query client
- `src/layers/shared/ui/Button.tsx` - UI components
  [Continue...]

**Data Flow:**
User input → LoginForm → authClient.signIn → BetterAuth → Session → redirect

**Feature Flags/Config:**

- None identified (or list any found)

**Potential Blast Radius:**

- Direct: 3 files (LoginForm, queries, types)
- Indirect: 5 files (components importing user data)
- Tests: 2 test files need updates

```

```

---

## RESEARCH_AGENT_PROMPT

```
You are researching solutions and best practices for a development task.

## Context
- **Task Brief**: [TASK_BRIEF]
- **Feature Slug**: [SLUG]
- **Is Bug Fix**: [true/false]

## Your Tasks

### 1. Identify Research Topics

Based on the task brief, identify:
- Core technical challenges
- Potential implementation approaches
- Relevant libraries or patterns

### 2. Research Best Practices

For each topic, investigate:
- Industry best practices
- Common implementation patterns
- Security considerations
- Performance implications

### 3. Compare Approaches

For each viable approach:
- Describe the approach
- List pros
- List cons
- Note complexity level
- Note maintenance implications

### 4. Make Recommendation

Based on findings:
- Recommend the best approach
- Explain why it's recommended
- Note any caveats or conditions

### 5. Return Structured Findings

Return in this format:

```

## RESEARCH FINDINGS

### Potential Solutions

**1. [Approach Name]**

- Description: [1-2 sentences]
- Pros:
  - [Pro 1]
  - [Pro 2]
- Cons:
  - [Con 1]
  - [Con 2]
- Complexity: [Low/Medium/High]
- Maintenance: [Low/Medium/High]

**2. [Approach Name]**
[Same structure...]

**3. [Approach Name]**
[Same structure...]

### Security Considerations

- [Security point 1]
- [Security point 2]

### Performance Considerations

- [Performance point 1]
- [Performance point 2]

### Recommendation

**Recommended Approach:** [Approach Name]

**Rationale:**
[2-3 sentences explaining why this is the best choice for this specific task]

**Caveats:**

- [Any conditions or warnings]

```

```

---

## Usage Examples

### Basic Usage

```bash
/ideate Fix chat UI auto-scroll bug when messages exceed viewport height
```

Creates `specs/fix-chat-ui-auto-scroll-bug/01-ideation.md` with full discovery.

---

## Performance Characteristics

| Metric                 | Sequential   | Parallel (This Command) |
| ---------------------- | ------------ | ----------------------- |
| Exploration + Research | ~8-10 min    | ~4-5 min (2x faster)    |
| Context usage          | 100% in main | ~20% in main            |
| Agent isolation        | N/A          | Full isolation          |

---

## Integration with Other Commands

| Command           | Relationship                                        |
| ----------------- | --------------------------------------------------- |
| `/ideate-to-spec` | **Run next** - Transforms ideation to specification |
| `/spec:decompose` | Creates tasks from specification                    |
| `/spec:execute`   | Implements the tasks                                |
