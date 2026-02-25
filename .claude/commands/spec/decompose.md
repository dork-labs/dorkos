---
description: Break down a validated specification into actionable implementation tasks
category: validation
allowed-tools: Read, Task, TaskOutput, Write, Bash(mkdir:*), Bash(cat:*), Bash(grep:*), Bash(echo:*), Bash(basename:*), Bash(date:*), TaskCreate, TaskList, TaskGet, TaskUpdate
argument-hint: '<path-to-spec-file>'
---

# Decompose Specification into Tasks

Decompose the specification at: $ARGUMENTS

## Architecture

Background agents **cannot** use TaskCreate/TaskUpdate/TaskList. This command splits work accordingly:

1. **Background agent** (isolated context): Reads spec, analyzes, writes `03-tasks.json` + `03-tasks.md` to disk
2. **Main context**: Reads `03-tasks.json`, creates all tasks via TaskCreate/TaskUpdate, reports results

This saves ~90% of main context while keeping task creation reliable.

## Phase 1: Setup (Main Context)

### 1.1 Extract Feature Slug

Extract the feature slug from the spec path:

- If path is `specs/<slug>/02-specification.md` → slug is `<slug>`
- If path is `specs/feat-<slug>.md` (legacy) → slug is `feat-<slug>`
- If path is `specs/fix-<issue>-<desc>.md` (legacy) → slug is `fix-<issue>-<desc>`

```bash
SPEC_FILE="$ARGUMENTS"
SLUG=$(echo "$SPEC_FILE" | cut -d'/' -f2)
TASKS_JSON="specs/$SLUG/03-tasks.json"
TASKS_MD="specs/$SLUG/03-tasks.md"
```

### 1.2 Quick Mode Detection

Perform lightweight checks to determine mode:

1. **Check for existing tasks:**
   Use `TaskList()` and filter for tasks with subject containing `[<slug>]`
   - If no matching tasks found → **Full mode**

2. **Check if tasks JSON exists:**
   - If `specs/<slug>/03-tasks.json` doesn't exist → **Full mode**

3. **For incremental detection** (if tasks JSON exists):
   - Read the JSON, check `generatedAt` field
   - Compare against spec changelog dates
   - If no new changelog entries → **Skip mode**

If **Skip mode** detected (no changelog changes):

- Display: "No changes since last decompose (<date>). To force, delete 03-tasks.json"
- **Exit early** - do not spawn background agent

## Phase 2: Spawn Background Agent

Spawn the background agent with the prompt from the BACKGROUND_AGENT_PROMPT section below:

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
Decomposition started in background
   Spec: $ARGUMENTS
   Mode: [Full/Incremental]
   Slug: [slug]

   You can continue working — I'll notify you when done.
```

## Phase 3: Wait for Results

Ask the user:

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

## Phase 4: Create Tasks from JSON (Main Context)

This is the primary task creation path. The background agent wrote `03-tasks.json` to disk — the main context reads it and creates all tasks.

### 4.1 Read Tasks JSON

```
Read("specs/[slug]/03-tasks.json")
```

Parse the JSON. If the file doesn't exist or is malformed, check if `03-tasks.md` exists and offer to run `/spec:tasks-sync` as fallback.

### 4.2 Quality Spot-Check

Before creating tasks, inspect 2-3 task descriptions for quality:

- Check that descriptions contain actual implementation details (code blocks, technical requirements)
- Flag any tasks containing summary phrases: "as specified", "from spec", "see specification"
- If quality issues found, warn the user but proceed (they can re-decompose later)

### 4.3 Create All Tasks

For each task in `tasks[].`:

```
TaskCreate({
  subject: task.subject,
  description: task.description,
  activeForm: task.activeForm
})
```

Track the mapping of `task.id` → `created taskId` for dependency resolution.

Display progress:

```
Creating tasks from 03-tasks.json...
   [P1] Task title 1
   [P1] Task title 2
   [P2] Task title 3
   ...
```

### 4.4 Set Up Dependencies

After all tasks are created, resolve dependencies using the id-to-taskId mapping:

```
For each task where task.dependencies is non-empty:
  blockedByIds = task.dependencies.map(depId => idToTaskIdMap[depId])
  TaskUpdate({
    taskId: createdTaskId,
    addBlockedBy: blockedByIds
  })
```

### 4.5 Handle Failures

If any TaskCreate calls fail:

```
Task Creation Issue

Created: [X] / [total] tasks
Failed: [list of failed task subjects]

Options:
1. **Retry failed** - Attempt to create the failed tasks again
2. **Continue anyway** - Use `/spec:execute` with available tasks
3. **Manual sync** - Run `/spec:tasks-sync specs/[slug]/03-tasks.json`
```

### 4.6 Report Results

Display the final summary:

```
Decomposition Complete

Spec: [spec-path]
Mode: [Full/Incremental]
Files: specs/[slug]/03-tasks.json, specs/[slug]/03-tasks.md

Task Summary:
   Total: [count] tasks created
   Phase 1 (Foundation): [count]
   Phase 2 (Core Features): [count]
   Phase 3 (Testing): [count]
   Phase 4 (Documentation): [count]

Parallel Execution:
   Tasks [X, Y, Z] can run in parallel
   Critical path: [list]

Next Steps:
   Run /spec:execute specs/[slug]/02-specification.md
```

---

## BACKGROUND_AGENT_PROMPT

The following is the complete prompt sent to the background agent. It contains all the detailed decomposition instructions.

````
You are decomposing a specification into actionable implementation tasks.

## Context
- **Spec File**: [SPEC_PATH]
- **Feature Slug**: [SLUG]
- **Mode**: [Full/Incremental]
- **Tasks JSON Output**: specs/[SLUG]/03-tasks.json
- **Tasks MD Output**: specs/[SLUG]/03-tasks.md
- **Last Decompose Date**: [DATE or "N/A for full mode"]

## Your Deliverables

You MUST write TWO files to disk:

1. **`specs/[SLUG]/03-tasks.json`** — Structured task data (machine-readable, used by main context to create tasks)
2. **`specs/[SLUG]/03-tasks.md`** — Human-readable task breakdown (for browsing, git diffs, documentation)

**You do NOT have access to TaskCreate/TaskUpdate/TaskList.** The main context will read your JSON file and handle all task creation. Your job is to produce high-quality, self-contained task definitions.

## JSON Schema

Write `03-tasks.json` with this exact structure:

```json
{
  "spec": "[SPEC_PATH]",
  "slug": "[SLUG]",
  "generatedAt": "[ISO 8601 timestamp]",
  "mode": "[full/incremental]",
  "lastDecomposeDate": "[DATE or null]",
  "tasks": [
    {
      "id": "1.1",
      "phase": 1,
      "phaseName": "Foundation",
      "subject": "[SLUG] [P1] Imperative task title",
      "description": "FULL implementation details — see Content Requirements below",
      "activeForm": "Present continuous form for spinner",
      "size": "small|medium|large",
      "priority": "high|medium|low",
      "dependencies": [],
      "parallelWith": ["1.2", "1.3"]
    }
  ]
}
```

**Field rules:**
- `id`: Phase.TaskNumber format (e.g., "1.1", "2.3")
- `subject`: Must follow `[SLUG] [P<phase>] <imperative title>` format
- `description`: FULL implementation details (see Content Requirements)
- `activeForm`: Present continuous (e.g., "Creating shared utilities")
- `dependencies`: Array of task IDs this task depends on (e.g., ["1.1", "1.2"])
- `parallelWith`: Array of task IDs that can run simultaneously

## Content Requirements

**CRITICAL**: Task descriptions must be SELF-CONTAINED. The main context copies them verbatim into TaskCreate — there is no second chance to add detail.

Each task description MUST include:
- Complete code examples (full functions, not snippets)
- All technical requirements and specifications
- Detailed implementation steps
- Configuration examples
- Error handling requirements
- Acceptance criteria with specific test scenarios

**Forbidden phrases** (these indicate summarization instead of content):
- "as specified in the spec"
- "from the specification"
- "see specification for details"
- "as described above"
- "implement according to spec"

If you catch yourself writing these phrases, STOP and copy the actual content instead.

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

**Read existing tasks JSON:**
- Read `specs/[SLUG]/03-tasks.json` if it exists
- Identify tasks that correspond to completed work

**Extract New Changelog Entries:**
- Read the spec file's Changelog section
- Find entries with dates >= last decompose date
- Extract: Issue, Decision, Changes, Implementation Impact

**Categorize Tasks:**
1. **Preserve (DONE):** Completed tasks — carry forward unchanged
2. **Update (UPDATED):** Pending tasks affected by changelog — update description
3. **Create (NEW):** New work identified in changelog

### Step 3: Create Task Breakdown

Break down the specification into concrete, actionable tasks.

Key principles:
- Each task should have a single, clear objective
- Copy implementation details, code blocks, and examples verbatim from the spec
- Define clear acceptance criteria with specific test scenarios
- Include tests as part of each task
- Document dependencies between tasks
- Create foundation tasks first, then build features on top

Task structure:
- Foundation tasks: Core infrastructure (database, frameworks, testing setup)
- Feature tasks: Complete vertical slices including all layers
- Testing tasks: Unit, integration, and E2E tests
- Documentation tasks: API docs, user guides, code comments

### Step 4: Write 03-tasks.json

Write the structured JSON file to `specs/[SLUG]/03-tasks.json` following the schema above.

Validate before writing:
- Every task has a unique `id`
- Dependencies reference valid task IDs
- Subjects follow the `[SLUG] [P<phase>] <title>` format
- Descriptions contain actual implementation details (no summary phrases)

### Step 5: Write 03-tasks.md

Write the human-readable markdown breakdown to `specs/[SLUG]/03-tasks.md`:

```markdown
# Task Breakdown: [Specification Name]
Generated: [Date]
Source: [spec-file]
Last Decompose: [Today's Date]

## Overview
[Brief summary of what's being built]

## Phase 1: Foundation

### Task 1.1: [Task Title]
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

For incremental mode, include metadata and markers:
- DONE tasks: marked with checkmark
- UPDATED tasks: marked with update note
- NEW tasks: marked as new

### Step 6: Return Summary

Return a brief completion summary (the main context will read the JSON file for details):

```
## Decomposition Complete

**Spec**: [spec-path]
**Mode**: [Full/Incremental]
**Files Written**:
  - specs/[SLUG]/03-tasks.json
  - specs/[SLUG]/03-tasks.md

**Task Counts**:
  - Total: [count]
  - Phase 1 (Foundation): [count]
  - Phase 2 (Core Features): [count]
  - Phase 3 (Testing): [count]
  - Phase 4 (Documentation): [count]

**Parallel Opportunities**: Tasks [X, Y, Z] can run in parallel
**Critical Path**: [list]
```
````

---

## Success Criteria

The decomposition is complete when:
- Background agent has finished execution
- `specs/[slug]/03-tasks.json` exists with valid JSON matching the schema
- `specs/[slug]/03-tasks.md` exists with human-readable breakdown
- All tasks created in the task system via TaskCreate (Phase 4)
- Tasks preserve ALL implementation details (code blocks, requirements, criteria)
- Dependencies set up via TaskUpdate
- No summary phrases in task descriptions

## Post-Completion Validation

After creating tasks from JSON:

1. **Sample Task Review**:
   - Use `TaskGet({ taskId })` on 2-3 random tasks
   - Verify descriptions contain full implementation details
   - Check for forbidden phrases: "as specified", "from spec", "see specification"

2. **Report to User**:
   - Display task counts and phase breakdown
   - Highlight any quality issues found
   - Provide next steps

## Integration with Other Commands

- **Prerequisites**: Run `/spec:validate` first to ensure spec quality
- **Next step**: Use `/spec:execute` to implement the decomposed tasks
- **Manual sync**: Use `/spec:tasks-sync` to re-create tasks from existing JSON
- **Progress tracking**: Use `TaskList()` to see all tasks with status

## Usage Examples

```bash
# Decompose a feature specification
/spec:decompose specs/feat-user-authentication/02-specification.md

# Decompose a system enhancement spec
/spec:decompose specs/feat-api-rate-limiting/02-specification.md
```

## Incremental Mode

Incremental mode allows re-decomposition after feedback without recreating all tasks:

1. **Preserves completed work** - Tasks marked DONE are carried forward
2. **Updates affected tasks** - Pending tasks get changelog context
3. **Creates new tasks** - Only for work not covered by existing tasks
4. **Maintains numbering** - New tasks continue the sequence

### Force Full Re-decompose

```bash
# Delete both task files
rm specs/<slug>/03-tasks.json specs/<slug>/03-tasks.md

# Run decompose (will use full mode)
/spec:decompose specs/<slug>/02-specification.md
```

## Troubleshooting

### Background Agent Not Completing

If the background agent takes too long:

1. Use `/tasks` to check status
2. Use `TaskOutput(task_id, block: false)` to check progress
3. Large specs may take several minutes — this is normal

### JSON File Missing or Malformed

**Symptom**: Background agent completed but `03-tasks.json` doesn't exist or is invalid JSON

**Solutions**:

1. Check if `03-tasks.md` exists — if so, run `/spec:tasks-sync specs/[slug]/03-tasks.md` (will generate JSON from markdown)
2. Re-run `/spec:decompose` (delete both files first for a clean run)

### Tasks Not Created (JSON exists but TaskList is empty)

**Symptom**: `03-tasks.json` exists but `TaskList()` returns no matching tasks

**Cause**: Phase 4 didn't run (e.g., user chose "continue working" and forgot to come back)

**Solutions**:

1. Run `/spec:tasks-sync specs/[slug]/03-tasks.json` to create tasks from the JSON
2. Re-run `/spec:decompose` — Phase 4 will detect existing JSON and create tasks

### Context Benefits

Running decomposition in background saves ~90% context:

- **Without background**: All spec content and analysis in main context
- **With background**: Only JSON parsing and TaskCreate calls in main context

This allows you to continue working on other tasks or have a longer conversation without hitting context limits.
