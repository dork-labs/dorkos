---
description: Break down a validated specification into actionable implementation tasks
category: validation
allowed-tools: Read, Task, TaskOutput, Write, Bash(mkdir:*), Bash(cat:*), Bash(grep:*), Bash(echo:*), Bash(basename:*), Bash(date:*), TaskCreate, TaskList, TaskGet, TaskUpdate
argument-hint: "<path-to-spec-file>"
---

# Decompose Specification into Tasks

Decompose the specification at: $ARGUMENTS

## Context-Saving Architecture

This command uses a **background agent** to perform the heavy decomposition work. This saves ~90% of context in the main conversation by isolating all spec reading, analysis, and task creation.

**Flow:**
1. Main context: Extract slug, detect mode, spawn background agent
2. Background agent: Read spec, analyze, create tasks, write breakdown
3. Main context: Wait for results
4. Main context: Validate task creation, auto-recover if needed, report results

## Phase 1: Setup (Main Context)

### 1.1 Extract Feature Slug

Extract the feature slug from the spec path:
- If path is `specs/<slug>/02-specification.md` → slug is `<slug>`
- If path is `specs/feat-<slug>.md` (legacy) → slug is `feat-<slug>`
- If path is `specs/fix-<issue>-<desc>.md` (legacy) → slug is `fix-<issue>-<desc>`

```bash
SPEC_FILE="$ARGUMENTS"
SLUG=$(echo "$SPEC_FILE" | cut -d'/' -f2)
TASKS_FILE="specs/$SLUG/03-tasks.md"
```

### 1.2 Quick Mode Detection

Perform lightweight checks to determine mode:

1. **Check for existing tasks:**
   Use `TaskList()` and filter for tasks with subject containing `[<slug>]`
   - If no matching tasks found → **Full mode**
   - Display: "🆕 First-time decompose - Full mode"

2. **Check if task file exists:**
   - If `specs/<slug>/03-tasks.md` doesn't exist → **Full mode**
   - Display: "📄 Tasks file missing - Full mode"

3. **For incremental detection** (if tasks file exists):
   - Quick check for "Last Decompose:" line
   - If found, note the date for the background agent
   - Display mode indicator

If **Skip mode** detected (no changelog changes):
- Display: "✅ No changes since last decompose (<date>)"
- Display: "   To force re-decompose, delete <tasks-file>"
- **Exit early** - do not spawn background agent

## Phase 2: Spawn Background Agent

If proceeding with decomposition (Full or Incremental mode), spawn the background agent:

```
Task(
  description: "Decompose [slug] spec into tasks",
  prompt: <see BACKGROUND_AGENT_PROMPT below>,
  subagent_type: "general-purpose",
  run_in_background: true
)
```

Display to user:
```
🚀 Decomposition started in background
   Spec: $ARGUMENTS
   Mode: [Full/Incremental]
   Slug: [slug]

   You can continue working. Use one of these to check progress:
   - Wait for completion: I'll notify you when done
   - Check status: /tasks to see running tasks
   - Continue working: I'll let you know when the agent finishes
```

## Phase 3: Wait for Results

After spawning the background agent, ask the user:

```
The decomposition is running in the background. Would you like me to:
1. **Wait and report** - I'll wait for completion and show you the results
2. **Continue working** - You can do other tasks; I'll notify when done
```

If user chooses to wait, use:
```
TaskOutput(task_id: "<agent-task-id>", block: true)
```

Then proceed to Phase 4.

## Phase 4: Validate Task Creation (Main Context)

After receiving results from the background agent, validate that tasks were actually created.

### 4.1 Check Task Creation Status

Parse the background agent's summary for the "Task Creation Status" section:
- If status is `SUCCESS` and counts match → proceed to reporting
- If status is `TASK_CREATION_INCOMPLETE` → attempt auto-recovery

### 4.2 Verify Tasks Exist

Independently verify using TaskList:

```
all_tasks = TaskList()
feature_tasks = all_tasks.filter(t => t.subject.includes("[<slug>]"))
actual_count = feature_tasks.length
```

Compare against the "Tasks in Breakdown" count from the summary.

### 4.3 Auto-Recovery (If Needed)

If `actual_count < expected_count`:

1. **Read the generated tasks file**: `specs/[slug]/03-tasks.md`
2. **Parse task definitions** from the markdown (look for `### Task X.Y:` headers)
3. **Identify missing tasks** by comparing subjects against existing tasks
4. **Create missing tasks** using TaskCreate with content from the tasks.md file
5. **Set up dependencies** using TaskUpdate

Display during recovery:
```
⚠️ Task creation incomplete. Auto-recovering...
   Expected: [X] tasks
   Found: [Y] tasks
   Creating [X-Y] missing tasks from tasks.md...
```

After recovery:
```
✅ Recovery complete
   Tasks now registered: [new count]
```

### 4.4 Handle Recovery Failure

If auto-recovery fails (can't parse tasks.md or TaskCreate keeps failing):

```
⚠️ Task Creation Issue

The task breakdown was saved to specs/[slug]/03-tasks.md
but some tasks could not be registered in the task system.

Expected: [X] tasks | Created: [Y] tasks

Options:
1. **Retry** - Run `/spec:decompose` again
2. **Manual sync** - Run `/spec:tasks-sync specs/[slug]/03-tasks.md`
3. **Continue anyway** - Use `/spec:execute` (will work with available tasks)
```

### 4.5 Report Results

Display the final summary to the user:
- Task creation status (success/recovered/incomplete)
- Task counts by phase
- Parallel execution opportunities
- Next steps

---

## BACKGROUND_AGENT_PROMPT

The following is the complete prompt sent to the background agent. It contains all the detailed decomposition instructions.

```
You are decomposing a specification into actionable implementation tasks.

## Context
- **Spec File**: [SPEC_PATH]
- **Feature Slug**: [SLUG]
- **Mode**: [Full/Incremental]
- **Tasks File**: specs/[SLUG]/03-tasks.md
- **Last Decompose Date**: [DATE or "N/A for full mode"]

## Process Overview

Break down the specification into:
1. Clear, actionable tasks with dependencies
2. Implementation phases and milestones
3. Testing and validation requirements
4. Documentation needs

## ⚠️ CRITICAL: TaskCreate is MANDATORY

**Task creation via TaskCreate is NOT optional.** The decomposition is considered FAILED if tasks are not created in the task system.

You MUST:
1. **Create ALL tasks using TaskCreate** — Every task in your breakdown must be registered
2. **Set up ALL dependencies using TaskUpdate** — Required for `/spec:execute` to work
3. **Verify creation succeeded** — Call `TaskList()` at the end to confirm tasks exist
4. **Report creation status** — Include task count verification in your summary

**If TaskCreate fails:**
- Retry the call once
- If still failing, continue with remaining tasks
- Report failures in your summary with `TASK_CREATION_INCOMPLETE` status

## ⚠️ CRITICAL: Content Preservation Requirements

**THIS IS THE MOST IMPORTANT PART**: When creating tasks, you MUST copy ALL content from the task breakdown into the task descriptions. Do NOT summarize or reference the spec - include the ACTUAL CODE and details.

## Pre-Flight Checklist

Before creating any tasks, confirm your understanding:
- [ ] I will NOT write summaries like "Create X as specified in spec"
- [ ] I will COPY all code blocks from the task breakdown into task descriptions
- [ ] I will INCLUDE complete implementations, not references
- [ ] Each task will be self-contained with ALL details from the breakdown
- [ ] I will call TaskCreate for EVERY task in my breakdown
- [ ] I will verify tasks were created using TaskList() before finishing

**If you find yourself typing phrases like "as specified", "from spec", or "see specification" - STOP and copy the actual content instead!**

## Instructions

### Step 1: Read and Validate Specification

- Read the spec file at [SPEC_PATH]
- Verify it's a valid specification (has expected sections)
- Extract implementation phases and technical details

### Step 2: Analyze Specification Components

- Identify major features and components
- Extract technical requirements
- Note dependencies between components
- Identify testing requirements
- Document success criteria

### Step 2.5: Incremental Mode Processing (if MODE=incremental)

When running in incremental mode:

**Get Completed Tasks for Preservation:**
- Use `TaskList()` and filter for tasks where subject contains `[SLUG]` and status is `completed`
- These tasks will be marked with ✅ DONE and preserved as-is

**Extract New Changelog Entries:**
- Read the spec file's "## 18. Changelog" section
- Find entries with dates >= last decompose date
- Extract: Issue, Decision, Changes to Specification, Implementation Impact

**Categorize Existing Tasks:**
1. **Preserve Tasks (✅ DONE):** All completed tasks - no changes
2. **Update Tasks (🔄 UPDATED):** In-progress/pending tasks affected by changelog
3. **Create Tasks (⏳ NEW):** New work identified in changelog

### Step 3: Create Task Breakdown

Break down the specification into concrete, actionable tasks.

Key principles:
- Each task should have a single, clear objective
- **PRESERVE ALL CONTENT**: Copy implementation details, code blocks, and examples verbatim
- Define clear acceptance criteria with specific test scenarios
- Include tests as part of each task
- Document dependencies between tasks
- Create foundation tasks first, then build features on top
- Each task should be self-contained with all necessary details

**CRITICAL REQUIREMENT**: Preserve:
- Complete code examples (full functions, not snippets)
- All technical requirements and specifications
- Detailed implementation steps
- Configuration examples
- Error handling requirements
- All acceptance criteria and test scenarios

Task structure:
- Foundation tasks: Core infrastructure (database, frameworks, testing setup)
- Feature tasks: Complete vertical slices including all layers
- Testing tasks: Unit, integration, and E2E tests
- Documentation tasks: API docs, user guides, code comments

### Step 3.5: Incremental Task Breakdown Adjustments (if MODE=incremental)

- **Mark Preserved Tasks**: Add ✅ DONE marker to completed tasks
- **Mark Updated Tasks**: Add 🔄 UPDATED marker with update note
- **Mark New Tasks**: Add ⏳ NEW marker and continue task numbering
- **Include Re-decompose Metadata**: Add metadata section showing history

### Step 4: Generate Task Document

Create a comprehensive task breakdown document with this structure:

```markdown
# Task Breakdown: [Specification Name]
Generated: [Date]
Source: [spec-file]
Last Decompose: [Today's Date]

## Re-decompose Metadata (if incremental mode)

### Decompose History
| Session | Date | Mode | Changelog Entries | New Tasks | Notes |
|---------|------|------|-------------------|-----------|-------|

### Current Session Details
- **Mode**: [Full/Incremental]
- **Previous Decompose**: [date]
- **Current Decompose**: [today]

## Overview
[Brief summary of what's being built]

## Phase 1: Foundation

### Task 1.1: [Task Title]
**Description**: One-line summary
**Size**: Small/Medium/Large
**Priority**: High/Medium/Low
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:
- [All technical details from spec]

**Implementation Steps**:
1. [Detailed step from spec]

**Acceptance Criteria**:
- [ ] [Specific criteria from spec]
- [ ] Tests written and passing

## Phase 2: Core Features
[Continue pattern...]
```

### Step 5: Create Task Management Entries

Use Claude Code's built-in task tools to create tasks.

**For each task in your breakdown:**
```
TaskCreate({
  subject: "[SLUG] [P<phase>] <imperative title>",
  description: "<FULL implementation details - COPY from breakdown, don't summarize>",
  activeForm: "<present continuous form for spinner>"
})
```

🚨 **WRONG** (Don't do this):
```
TaskCreate({
  subject: "[auth-flow] [P1] Implement utilities",
  description: "Create shared utilities module for all hooks",
  activeForm: "Creating utilities"
})
```

✅ **CORRECT** (Do this):
```
TaskCreate({
  subject: "[auth-flow] [P1] Implement utilities",
  description: `Create cli/hooks/utils.ts with the following implementations:

## Code Implementation

\`\`\`typescript
import { exec } from 'child_process';
// ... FULL CODE from task breakdown ...
\`\`\`

## Technical Requirements
- Standard input reader with timeout
- Project root discovery using git
// ... ALL requirements ...

## Acceptance Criteria
- [ ] readStdin with 1-second timeout
// ... ALL criteria ...`,
  activeForm: "Implementing hook utilities"
})
```

**Setting up dependencies:**
```
TaskUpdate({
  taskId: "<new-task-id>",
  addBlockedBy: ["<dependency-task-id-1>", "<dependency-task-id-2>"]
})
```

### Step 6: Save Task Breakdown

- Save the detailed task breakdown document to `specs/[SLUG]/03-tasks.md`
- Ensure "Last Decompose: [Today's Date]" is included for future incremental detection

### Step 7: Verify Task Creation

**Before returning, verify tasks were created:**

```
# Get all tasks and filter for this feature
all_tasks = TaskList()
feature_tasks = all_tasks.filter(t => t.subject.includes("[SLUG]"))
created_count = feature_tasks.length
```

Compare `created_count` against the number of tasks in your breakdown.

### Step 8: Return Summary

**IMPORTANT**: Return a structured summary for the main conversation:

```
## Decomposition Complete

**Spec**: [spec-path]
**Mode**: [Full/Incremental]
**Tasks File**: specs/[SLUG]/03-tasks.md

### Task Creation Status
- **Status**: [SUCCESS / TASK_CREATION_INCOMPLETE]
- **Tasks in Breakdown**: [count]
- **Tasks Created**: [count from TaskList verification]
- **Dependencies Set**: [count]
- **Creation Failures**: [list task numbers that failed, or "None"]

### Task Summary
- **Total Tasks**: [count]
- **Phase 1 (Foundation)**: [count] tasks
- **Phase 2 (Core Features)**: [count] tasks
- **Phase 3 (Testing)**: [count] tasks
- **Phase 4 (Documentation)**: [count] tasks

### Parallel Execution Opportunities
- Tasks [X, Y, Z] can run in parallel
- Critical path: [list]

### Incremental Changes (if applicable)
- **Preserved**: [count] tasks (completed, no changes)
- **Updated**: [count] tasks (affected by changelog)
- **Created**: [count] tasks (new from changelog)

### Next Steps
Run `/spec:execute specs/[SLUG]/02-specification.md` to begin implementation.
```
```

---

## Success Criteria

The decomposition is complete when:
- ✅ Background agent has finished execution
- ✅ Task breakdown document saved to specs directory
- ✅ All tasks created using built-in task tools (TaskCreate)
- ✅ **Tasks preserve ALL implementation details including:**
  - Complete code blocks and examples (not summarized)
  - Full technical requirements and specifications
  - Detailed step-by-step implementation instructions
  - All configuration examples
  - Complete acceptance criteria with test scenarios
- ✅ Foundation tasks identified and prioritized
- ✅ Dependencies between tasks documented (TaskUpdate with addBlockedBy)
- ✅ All tasks include testing requirements
- ✅ Parallel execution opportunities identified
- ✅ **Tasks use proper structure:**
  - `subject`: `[<slug>] [P<phase>] Brief imperative title`
  - `description`: Complete technical implementation (ACTUAL CODE, not references)
  - `activeForm`: Present continuous form for spinner
- ✅ **Quality check passed**: TaskGet displays full code implementations
- ✅ **No summary phrases**: Tasks don't contain "as specified", "from spec", etc.

## Post-Completion Validation

After receiving results from the background agent:

1. **Sample Task Review**:
   - Use `TaskGet({ taskId })` on a random task
   - Verify description contains full implementation details
   - Check for forbidden phrases: "as specified", "from spec", "see specification"

2. **Report to User**:
   - Display the summary from the background agent
   - Highlight any issues found in validation
   - Provide next steps

## Integration with Other Commands

- **Prerequisites**: Run `/spec:validate` first to ensure spec quality
- **Next step**: Use `/spec:execute` to implement the decomposed tasks
- **Progress tracking**:
  - Use `TaskList()` to see all tasks with status
  - Filter by subject prefix: tasks containing `[slug]` belong to this feature

## Usage Examples

```bash
# Decompose a feature specification
/spec:decompose specs/feat-user-authentication/02-specification.md

# Decompose a system enhancement spec
/spec:decompose specs/feat-api-rate-limiting/02-specification.md
```

## Incremental Mode

### Overview

Incremental mode allows re-decomposition after feedback without recreating all tasks:

1. **Preserves completed work** - Tasks marked DONE are not regenerated
2. **Updates affected tasks** - In-progress tasks get changelog context
3. **Creates new tasks** - Only for work not covered by existing tasks
4. **Maintains numbering** - New tasks continue the sequence
5. **Tracks history** - Metadata section shows all decompose sessions

### Force Full Re-decompose

```bash
# Delete the tasks file
rm specs/<slug>/03-tasks.md

# Run decompose (will use full mode)
/spec:decompose specs/<slug>/02-specification.md
```

## Troubleshooting

### Background Agent Not Completing

If the background agent takes too long:
1. Use `/tasks` to check status
2. Use `TaskOutput(task_id, block: false)` to check progress
3. Large specs may take several minutes - this is normal

### Tasks Not Created (tasks.md exists but TaskList is empty)

**Symptom**: `03-tasks.md` file was created but `TaskList()` returns no matching tasks

**Cause**: Background agent wrote the document but TaskCreate calls failed or weren't executed

**Solutions**:
1. **Auto-recovery** should trigger automatically in Phase 4
2. **Manual sync**: Run `/spec:tasks-sync specs/[slug]/03-tasks.md`
3. **Re-run decompose**: Delete `03-tasks.md` and run `/spec:decompose` again

### Partial Task Creation

**Symptom**: Some tasks created, but fewer than expected

**Cause**: Background agent may have hit context limits or TaskCreate failed for some tasks

**Solutions**:
1. Phase 4 auto-recovery will attempt to create missing tasks
2. Check `03-tasks.md` for the complete breakdown
3. Use `/spec:tasks-sync` to sync remaining tasks

### TaskCreate Returning Errors

**Symptom**: Background agent reports TaskCreate failures

**Possible causes**:
- Task description too long (try splitting into smaller tasks)
- Invalid characters in subject
- System resource limits

**Solution**: Use `/spec:tasks-sync` which includes retry logic and error handling

### Context Benefits

Running decomposition in background saves ~90% context:
- **Without background**: All spec content, analysis, task creation in main context
- **With background**: Only slug extraction and summary in main context

This allows you to continue working on other tasks or have a longer conversation without hitting context limits.
