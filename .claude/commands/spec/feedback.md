---
description: Process post-implementation feedback with interactive decisions
category: workflow
allowed-tools: Read, Grep, Glob, Write, Edit, Task, TaskOutput, AskUserQuestion, TaskCreate, TaskList, TaskGet, TaskUpdate
argument-hint: "<path-to-spec-file>"
---

# Process Post-Implementation Feedback

Process ONE specific piece of feedback from testing/usage with structured workflow including code exploration, optional research, interactive decisions, and spec updates.

## Context-Saving Architecture

This command uses **parallel background agents** for discovery:

1. **Main context**: Validation, feedback collection, decisions (~20% of context)
2. **Exploration agent**: Code investigation (background, isolated)
3. **Research agent**: Best practices (background, parallel with exploration)
4. **Main context**: Interactive decisions and file updates

**Context savings**: ~75% reduction vs sequential foreground execution

**Performance**: Exploration and research run in parallel when both requested

---

## Phase 1: Validation & Setup (Main Context - Lightweight)

### Step 1.1: Extract Feature Slug

Extract the slug from the spec path:
- `specs/<slug>/02-specification.md` → slug is `<slug>`
- `specs/feat-<name>.md` (legacy) → slug is `feat-<name>`
- `specs/fix-<issue>-<desc>.md` (legacy) → slug is `fix-<issue>-<desc>`

```bash
SPEC_PATH="$ARGUMENTS"
SLUG=$(echo "$SPEC_PATH" | cut -d'/' -f2)
```

### Step 1.2: Validate Prerequisites

1. **Check implementation exists**: `specs/<slug>/04-implementation.md` must exist
   - If missing → "❌ Error: Run `/spec:execute` first"
   - Exit early

2. **Check for incomplete tasks**:
   ```
   tasks = TaskList()
   in_progress = tasks.filter(t =>
     t.subject.includes("[<slug>]") &&
     t.status === "in_progress"
   )
   ```
   - If any found → Display warning (not a blocker)

Display:
```
═══════════════════════════════════════════════════
Ready to process feedback for: [slug]
═══════════════════════════════════════════════════

✅ Implementation summary found
⚠️ [X] task(s) still in progress (if any)
```

---

## Phase 2: Feedback Collection (Main Context)

### Step 2.1: Prompt for Feedback

Display:
```
╔═══════════════════════════════════════════════════════════════╗
║           Provide Feedback from Testing/Usage                 ║
╚═══════════════════════════════════════════════════════════════╝

Please provide ONE specific piece of feedback from your testing:

Examples of good feedback:
• "Authentication fails when password contains special characters"
• "Dashboard loading is slow with >100 items"
• "Error messages are not user-friendly"

Guidelines:
- Be specific about what's wrong or what could be improved
- Include relevant context (conditions, data, steps to reproduce)
- One issue per feedback session

Your feedback:
```

Wait for user input.

### Step 2.2: Categorize Feedback Type

Analyze feedback text to determine type:

| Type | Keywords | Focus |
|------|----------|-------|
| Bug/Error | fail, error, crash, broken, bug | Error handling, edge cases |
| Performance | slow, lag, timeout, delay | Bottlenecks, optimization |
| UX/UI | confusing, unclear, hard to | User flows, UI components |
| Security | security, auth, permission | Security controls, validation |
| General | (other) | Overall implementation |

Display: "📋 Categorized as: [type]"

---

## Phase 3: Parallel Discovery (Background Agents)

### Step 3.1: Ask About Research

Use AskUserQuestion:
```
"Would you like research-expert to investigate best practices for this issue?"
Options:
- "Yes - Investigate approaches" (Recommended for complex issues)
- "No - Continue with code exploration only"
```

### Step 3.2: Launch Exploration Agent

Always launch the exploration agent in background:

```
Task(
  description: "Explore code for [slug] feedback",
  prompt: <see EXPLORATION_AGENT_PROMPT>,
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true
)
```
Store as `exploration_task_id`.

### Step 3.3: Launch Research Agent (If Requested)

If user selected "Yes - Investigate approaches":

```
Task(
  description: "Research solutions for [slug] feedback",
  prompt: <see RESEARCH_AGENT_PROMPT>,
  subagent_type: "research-expert",
  model: "haiku",
  run_in_background: true
)
```
Store as `research_task_id`.

Display:
```
🔄 Discovery started:
   → Code exploration: Investigating affected areas
   → Research: Analyzing best practices (if requested)

   Running in background...
```

### Step 3.4: Collect Results

Wait for exploration:
```
TaskOutput(task_id: exploration_task_id, block: true)
```

Wait for research (if launched):
```
TaskOutput(task_id: research_task_id, block: true)
```

Display:
```
✅ Discovery complete
```

---

## Phase 4: Interactive Decisions (Main Context)

### Step 4.1: Display Findings Summary

```
═══════════════════════════════════════════════════════════
                  FINDINGS SUMMARY
═══════════════════════════════════════════════════════════

Feedback: [user's feedback text]
Type: [categorized type]

--- CODE EXPLORATION FINDINGS ---
[summary of exploration findings]

--- RESEARCH FINDINGS ---
[research findings or "Research skipped by user"]

═══════════════════════════════════════════════════════════
```

### Step 4.2: Gather Decisions

**Question 1: Action**
```
"How would you like to address this feedback?"
Options:
- "Implement now" - Update spec and re-run implementation
- "Defer" - Log and create task for later
- "Out of scope" - Log only, no action
```

**Question 2: Scope** (If "Implement now")
```
"What implementation scope?"
Options:
- "Minimal" - Only the specific issue
- "Comprehensive" - Issue plus related improvements
- "Phased" - Quick fix now, comprehensive later
```

**Question 3: Approach** (If "Implement now" and multiple approaches found)
```
"Which implementation approach?"
Options:
- [Approaches from research/exploration]
- "Custom approach"
```

**Question 4: Priority** (If "Implement now" or "Defer")
```
"Priority level?"
Options:
- "Critical" - Blocks core functionality
- "High" - Significant impact
- "Medium" - Noticeable but workarounds exist
- "Low" - Minor inconvenience
```

Display:
```
✓ Decisions captured
  Action: [selected]
  Scope: [selected]
  Priority: [selected]
```

---

## Phase 5: Execute Actions (Main Context)

### If "Implement now"

1. **Add changelog entry** to `specs/<slug>/02-specification.md`:

```markdown
### [current-date] - Post-Implementation Feedback

**Source:** Feedback #[N] (see specs/[slug]/05-feedback.md)

**Issue:** [user's feedback text]

**Decision:** Implement with [scope] scope

**Changes to Specification:**
- Section X: [description]
- Section Y: [description]

**Implementation Impact:**
- Priority: [priority]
- Approach: [approach]
- Affected components: [from exploration]

**Next Steps:**
1. Update affected spec sections
2. Run `/spec:decompose specs/[slug]/02-specification.md`
3. Run `/spec:execute specs/[slug]/02-specification.md`
```

2. Display next steps

### If "Defer"

Create task:
```
TaskCreate({
  subject: "[<slug>] [deferred] [priority]: [truncated feedback]",
  description: "[Full details including exploration/research findings]",
  activeForm: "Creating deferred task"
})
```

### If "Out of scope"

Skip to feedback logging (no other action).

---

## Phase 6: Update Feedback Log (Main Context)

### Step 6.1: Determine Feedback Number

Check `specs/<slug>/05-feedback.md`:
- If exists, find highest `## Feedback #N` and use N+1
- If not exists, start with #1

### Step 6.2: Write Feedback Entry

Create/append to `specs/<slug>/05-feedback.md`:

```markdown
## Feedback #[N]

**Date:** [current-date-time]
**Status:** [status based on action]
**Type:** [feedback type]
**Priority:** [priority]

### Description

[user's feedback text]

### Code Exploration Findings

[summary of exploration findings]

### Research Findings

[research findings or "Research skipped by user"]

### Decisions

- **Action:** [selected action]
- **Scope:** [selected scope]
- **Approach:** [selected approach]
- **Priority:** [selected priority]

### Actions Taken

[action-specific details]

---
```

### Step 6.3: Display Completion Summary

```
═══════════════════════════════════════════════════════════
              FEEDBACK PROCESSING COMPLETE
═══════════════════════════════════════════════════════════

Feedback #[N] processed successfully

Decision: [action]
Priority: [priority]

Files Updated:
  - specs/[slug]/05-feedback.md
  [if implement: - specs/[slug]/02-specification.md]

[if implement:
Next Steps:
  1. Review changelog entry in spec
  2. Update affected spec sections
  3. Run: /spec:decompose specs/[slug]/02-specification.md
  4. Run: /spec:execute specs/[slug]/02-specification.md
]

[if defer:
Task Created: #[task-id]
View: TaskGet({ taskId: "[task-id]" })
]

═══════════════════════════════════════════════════════════
```

---

## EXPLORATION_AGENT_PROMPT

```
You are exploring code to investigate feedback for a feature.

## Context
- **Feature:** [SLUG]
- **Feedback:** [user's feedback text]
- **Type:** [categorized type]
- **Spec File:** specs/[SLUG]/02-specification.md

## Your Tasks

### 1. Read the Specification

Read the spec file to understand:
- Component names and descriptions
- File paths and directory structure
- Current implementation approach

### 2. Investigate Affected Code

Based on the feedback type, focus on:

**Bug/Error:** Error handling, edge cases, validation logic
**Performance:** Bottlenecks, resource usage, optimization
**UX/UI:** User interaction flows, UI components
**Security:** Security controls, authentication, authorization
**General:** Overall implementation, integration points

### 3. Assess Blast Radius

Identify:
- Files requiring changes
- Files that depend on those
- Test files needing updates

### 4. Return Findings

```
## EXPLORATION FINDINGS

### Affected Components
- [file path]: [how it relates to feedback]
- [file path]: [how it relates to feedback]

### Blast Radius
- **Direct changes:** [N] files
- **Indirect impact:** [N] files
- **Tests affected:** [N] files

### Immediate Concerns
- [Any risks or critical issues]

### Recommended Changes
- [Specific file]: [what needs to change]
- [Specific file]: [what needs to change]
```
```

---

## RESEARCH_AGENT_PROMPT

```
You are researching solutions for feedback on a feature.

## Context
- **Feature:** [SLUG]
- **Feedback:** [user's feedback text]
- **Type:** [categorized type]

## Your Tasks

### 1. Identify Research Topics

Based on the feedback, identify:
- Core technical challenges
- Potential solution approaches

### 2. Research Best Practices

For this type of issue:
- Industry best practices
- Common patterns
- Security/performance considerations

### 3. Compare Approaches

For each approach:
- Pros and cons
- Complexity
- Maintenance implications

### 4. Return Findings

```
## RESEARCH FINDINGS

### Recommended Approach
[Name and description]

### Alternative Approaches
1. [Approach]: [pros/cons]
2. [Approach]: [pros/cons]

### Considerations
- Security: [points]
- Performance: [points]

### Pitfalls to Avoid
- [Common mistake 1]
- [Common mistake 2]
```
```

---

## Usage Examples

```bash
# Process feedback for a feature
/spec:feedback specs/my-feature/02-specification.md

# After providing feedback like:
# "Authentication fails when password contains special characters"

# The command will:
# 1. Validate prerequisites
# 2. Categorize as Bug/Error type
# 3. Launch exploration (background)
# 4. Optionally launch research (background, parallel)
# 5. Present findings and gather decisions
# 6. Update spec/log as appropriate
```

---

## Performance Characteristics

| Metric | Sequential | Parallel (This Command) |
|--------|-----------|------------------------|
| Exploration + Research | ~6-8 min | ~3-4 min (2x faster) |
| Context usage | 100% in main | ~25% in main |
| User wait time | Blocked during agents | Only during collection |

---

## Integration with Other Commands

| Command | Relationship |
|---------|--------------|
| `/spec:execute` | **Prerequisite** - Must complete before feedback |
| `/spec:decompose` | **Run after** (if "Implement now") - Updates task breakdown |
| `/spec:execute` | **Run after decompose** - Implements changes |

---

## Troubleshooting

### "No implementation found"
Run `/spec:execute` first to complete initial implementation.

### "X tasks still in progress"
Warning only - can proceed. Feedback changes may affect them.

### Research taking too long
Research runs in background. Can skip research for simpler issues.
