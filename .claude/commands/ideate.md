---
description: Structured ideation with documentation
allowed-tools: Read, Grep, Glob, Task, TaskOutput, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(python3:*), Bash(mkdir:*)
argument-hint: '[--roadmap-id <uuid> | --roadmap-item "<title>"] <task-brief>'
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
4. **Main context**: Synthesize findings and write document

**Context savings**: ~80% reduction vs sequential foreground execution

**Performance**: Exploration and research run in parallel instead of sequential

---

## Phase 1: Setup (Main Context - Lightweight)

### Step 1.0: Parse Roadmap Integration (Optional)

If the command includes `--roadmap-id <uuid>` or `--roadmap-item "<title>"`:

**For `--roadmap-id <uuid>`:**

1. Extract the UUID from the command arguments
2. Store as `ROADMAP_ITEM_ID` for later use
3. Remove `--roadmap-id <uuid>` from the task brief

**For `--roadmap-item "<title>"` (title-based lookup):**

1. Run: `python3 roadmap/scripts/find_by_title.py "<title>"`
2. If exit code 0 (single match): Use the returned ID as `ROADMAP_ITEM_ID`
3. If exit code 2 (multiple matches): Parse JSON output and prompt user to select using AskUserQuestion
4. If exit code 1 (no matches): Warn user and proceed without linking
5. Remove `--roadmap-item "<title>"` from the task brief

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

### Step 1.2: Roadmap Integration (If ROADMAP_ITEM_ID is set)

If `ROADMAP_ITEM_ID` was captured in Step 1.0:

1. Update roadmap status to in-progress:

   ```bash
   python3 roadmap/scripts/update_status.py $ROADMAP_ITEM_ID in-progress
   ```

2. Link the spec directory to the roadmap item:
   ```bash
   python3 roadmap/scripts/link_spec.py $ROADMAP_ITEM_ID $SLUG
   ```

### Step 1.3: Echo Intent & Assumptions

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

## Phase 4: Synthesis & Document (Main Context)

### Step 4.1: Root Cause Analysis (Bug Fixes Only)

If the task is a bug fix:

1. Based on exploration findings, identify plausible root-cause hypotheses:
   - Code lines, props/state issues
   - CSS/layout rules
   - Event handlers, race conditions
   - API or data flow issues

2. Select the most likely hypothesis with evidence from exploration

### Step 4.2: Clarification Questions

Based on exploration and research findings, create a list of:

- Unspecified requirements
- Decisions the user needs to make
- Trade-offs that need resolution

### Step 4.3: Write Ideation Document

Create `specs/{slug}/01-ideation.md` with all gathered information.

**Document Structure:**

```markdown
---
roadmapId: { ROADMAP_ITEM_ID } # Only if roadmap integration
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
**Related:** [Roadmap Item](../../roadmap/roadmap.json) ({ROADMAP_ITEM_ID}) # or N/A

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

## 6) Clarification

- **Clarifications:** {numbered list with decisions for user}
```

### Step 4.4: Update Spec Manifest

After writing the ideation document, update `specs/manifest.json`:
1. Add a new entry to the `specs` array with `number`, `slug`, `title`, `created` (today), and `status: "ideation"`
2. Increment `nextNumber`

### Step 4.5: Display Completion Summary

```
═══════════════════════════════════════════════════
              IDEATION COMPLETE
═══════════════════════════════════════════════════

📄 Document: specs/[slug]/01-ideation.md

📊 Discovery Summary:
   - Files explored: [X]
   - Components mapped: [Y]
   - Approaches researched: [Z]

📝 Clarifications needed: [N] items
   (Review section 6 of the ideation document)

🚀 Next Steps:
   1. Review the ideation document
   2. Answer clarification questions if any
   3. Run: /ideate-to-spec specs/[slug]/01-ideation.md

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

### With Roadmap Integration

```bash
# Using roadmap item UUID
/ideate --roadmap-id 550e8400-e29b-41d4-a716-446655440010 Transaction sync and storage

# Using title search
/ideate --roadmap-item "Transaction sync" Implement transaction fetching from Plaid
```

When using `--roadmap-id` or `--roadmap-item`:

- Item status is automatically set to `in-progress`
- Spec directory is linked to the roadmap item
- `roadmapId` is added to ideation file frontmatter

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
