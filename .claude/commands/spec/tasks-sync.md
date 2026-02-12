---
description: Sync tasks from 03-tasks.md to the built-in task system
category: validation
allowed-tools: Read, TaskCreate, TaskList, TaskGet, TaskUpdate, Grep
argument-hint: "<path-to-tasks-file>"
---

# Sync Tasks to Task System

Parse `specs/[slug]/03-tasks.md` and create any missing tasks in the built-in task system.

**Use this command when:**
- `/spec:decompose` completed but tasks weren't created
- `03-tasks.md` exists but `TaskList()` shows no matching tasks
- You need to manually sync tasks after editing `03-tasks.md`

## Arguments

- `$ARGUMENTS` - Path to the tasks file (e.g., `specs/feat-auth/03-tasks.md`)

## Process

### Step 1: Extract Feature Slug

```bash
TASKS_FILE="$ARGUMENTS"
SLUG=$(echo "$TASKS_FILE" | cut -d'/' -f2)
```

Display:
```
🔄 Syncing tasks for: [slug]
   Source: $ARGUMENTS
```

### Step 2: Get Existing Tasks

Check what tasks already exist in the task system:

```
all_tasks = TaskList()
existing_tasks = all_tasks.filter(t => t.subject.includes("[<slug>]"))
existing_subjects = existing_tasks.map(t => t.subject)
```

Display:
```
📋 Found [count] existing tasks for [slug]
```

### Step 3: Parse Tasks File

Read the tasks file and extract task definitions.

**Task Header Pattern**: `### Task X.Y: [Title]`

For each task section, extract:
- **Phase number**: From `X` in `Task X.Y`
- **Task number**: From `Y` in `Task X.Y`
- **Title**: Text after the colon
- **Description**: Everything between this header and the next `### Task` or `## Phase` header
- **Dependencies**: From the `**Dependencies**:` line

### Step 4: Identify Missing Tasks

For each parsed task:
1. Build expected subject: `[<slug>] [P<phase>] <title>`
2. Check if subject exists in `existing_subjects`
3. If not found, add to `missing_tasks` list

Display:
```
📊 Task Analysis:
   Total in file: [count]
   Already synced: [count]
   Missing: [count]
```

### Step 5: Create Missing Tasks

For each missing task:

```
TaskCreate({
  subject: "[<slug>] [P<phase>] <title>",
  description: "<full content from tasks.md>",
  activeForm: "<derived from title>"
})
```

Display progress:
```
Creating tasks...
   ✅ [P1] Task title 1
   ✅ [P1] Task title 2
   ✅ [P2] Task title 3
   ❌ [P2] Task title 4 (error: <reason>)
```

**Retry logic**: If TaskCreate fails, retry once after 1 second delay.

### Step 6: Set Up Dependencies

Parse dependency information from each task and set up blockedBy relationships:

```
TaskUpdate({
  taskId: "<new-task-id>",
  addBlockedBy: ["<dependency-task-id>"]
})
```

**Dependency Resolution**:
- Parse `**Dependencies**: Task 1.1, Task 1.2` format
- Look up task IDs by matching subjects
- Skip dependencies for tasks that don't exist

### Step 7: Report Results

```
═══════════════════════════════════════════════════
              SYNC COMPLETE
═══════════════════════════════════════════════════

📊 Results:
   Tasks Created: [count]
   Dependencies Set: [count]
   Errors: [count]

[If errors:]
⚠️ Some tasks could not be created:
   - [P2] Task title: <error reason>

✅ Tasks are now synced. Run `/spec:execute` to begin implementation.
```

## Parsing Rules

### Task Header Detection

```regex
^### Task (\d+)\.(\d+): (.+)$
```
- Group 1: Phase number
- Group 2: Task number within phase
- Group 3: Task title

### Description Extraction

Content between task header and next section marker:
- Next `### Task` header
- Next `## Phase` header
- Next `## ` header (any h2)
- End of file

### Dependency Parsing

```regex
\*\*Dependencies\*\*:\s*(.+)$
```

Parse comma-separated list: `Task 1.1, Task 1.2, Task 2.1`

Convert to subjects for lookup:
- `Task 1.1` → find task with `[P1]` in subject and matching title context

### ActiveForm Derivation

Convert imperative title to present continuous:
- "Create user schema" → "Creating user schema"
- "Implement login form" → "Implementing login form"
- "Add authentication" → "Adding authentication"
- "Update config" → "Updating config"
- "Set up database" → "Setting up database"

## Error Handling

### File Not Found

```
❌ Tasks file not found: $ARGUMENTS

Make sure the path is correct:
   /spec:tasks-sync specs/<slug>/03-tasks.md
```

### No Tasks Found in File

```
⚠️ No tasks found in $ARGUMENTS

The file exists but no task sections were detected.
Expected format: ### Task X.Y: Title
```

### All Tasks Already Synced

```
✅ All tasks already synced

Found [count] tasks for [slug] in task system.
Nothing to create.
```

## Usage Examples

```bash
# Sync tasks for a feature
/spec:tasks-sync specs/user-authentication/03-tasks.md

# After editing tasks.md manually
/spec:tasks-sync specs/dashboard-redesign/03-tasks.md

# Recovery after failed decompose
/spec:tasks-sync specs/api-rate-limiting/03-tasks.md
```

## Integration

| Related Command | Relationship |
|-----------------|--------------|
| `/spec:decompose` | Creates tasks.md and should create tasks (this command is backup) |
| `/spec:execute` | Executes tasks created by decompose or this sync command |
| `TaskList()` | View all synced tasks |
