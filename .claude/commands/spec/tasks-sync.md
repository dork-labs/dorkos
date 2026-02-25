---
description: Sync tasks from 03-tasks.json (or 03-tasks.md fallback) to the built-in task system
category: validation
allowed-tools: Read, Write, TaskCreate, TaskList, TaskGet, TaskUpdate, Grep
argument-hint: '<path-to-tasks-file>'
---

# Sync Tasks to Task System

Parse task definitions and create any missing tasks in the built-in task system.

**Use this command when:**

- `/spec:decompose` completed but tasks weren't created (e.g., user chose "continue working")
- `03-tasks.json` exists but `TaskList()` shows no matching tasks
- You need to manually sync tasks after editing task files
- Migrating from old markdown-only format to JSON + markdown

## Arguments

- `$ARGUMENTS` - Path to the tasks file. Accepts either:
  - `specs/<slug>/03-tasks.json` (preferred — structured, reliable)
  - `specs/<slug>/03-tasks.md` (fallback — parsed via regex)

## Process

### Step 1: Detect File Type and Extract Slug

```bash
TASKS_FILE="$ARGUMENTS"
SLUG=$(echo "$TASKS_FILE" | cut -d'/' -f2)
```

Determine source type:
- If path ends in `.json` → **JSON mode** (preferred)
- If path ends in `.md` → **Markdown mode** (fallback)
- If neither extension, check for `specs/<slug>/03-tasks.json` first, then `.md`

Display:

```
Syncing tasks for: [slug]
   Source: $ARGUMENTS ([JSON/Markdown] mode)
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
Found [count] existing tasks for [slug]
```

### Step 3: Parse Task Definitions

#### JSON Mode (Preferred)

Read and parse `03-tasks.json`:

```
data = JSON.parse(Read("specs/<slug>/03-tasks.json"))
tasks = data.tasks
```

Each task object has: `id`, `phase`, `subject`, `description`, `activeForm`, `dependencies`, `parallelWith`.

#### Markdown Mode (Fallback)

Read `03-tasks.md` and extract task definitions using regex.

**Task Header Pattern**: `^### Task (\d+)\.(\d+): (.+)$`

For each task section, extract:

- **Phase number**: From group 1
- **Task number**: From group 2
- **Title**: From group 3
- **Description**: Everything between this header and the next `### Task` or `## Phase` header
- **Dependencies**: From the `**Dependencies**:` line

Build task objects matching the JSON schema:

```json
{
  "id": "<phase>.<task>",
  "phase": <phase>,
  "subject": "[<slug>] [P<phase>] <title>",
  "description": "<full content between headers>",
  "activeForm": "<derived from title>",
  "dependencies": ["<parsed from Dependencies line>"]
}
```

**ActiveForm Derivation** (markdown mode only):

- "Create user schema" → "Creating user schema"
- "Implement login form" → "Implementing login form"
- "Add authentication" → "Adding authentication"
- "Set up database" → "Setting up database"

### Step 4: Identify Missing Tasks

For each parsed task:

1. Check if `task.subject` exists in `existing_subjects`
2. If not found, add to `missing_tasks` list

Display:

```
Task Analysis:
   Total in file: [count]
   Already synced: [count]
   Missing: [count]
```

### Step 5: Create Missing Tasks

For each missing task:

```
TaskCreate({
  subject: task.subject,
  description: task.description,
  activeForm: task.activeForm
})
```

Display progress:

```
Creating tasks...
   [P1] Task title 1
   [P1] Task title 2
   [P2] Task title 3
   [P2] Task title 4 (error: <reason>)
```

**Retry logic**: If TaskCreate fails, retry once.

### Step 6: Set Up Dependencies

For each task with dependencies, resolve IDs to task system IDs:

```
TaskUpdate({
  taskId: "<created-task-id>",
  addBlockedBy: ["<dependency-task-id>"]
})
```

**Dependency Resolution**:

- **JSON mode**: Use `task.dependencies` array of task IDs (e.g., `["1.1", "1.2"]`), look up created task IDs by matching
- **Markdown mode**: Parse `**Dependencies**: Task 1.1, Task 1.2` format, convert to task IDs
- Skip dependencies for tasks that don't exist in the system

### Step 7: Generate Missing Companion File

If syncing from JSON and `03-tasks.md` doesn't exist (or vice versa), offer to generate the companion:

- **JSON → MD**: Generate markdown from the structured data
- **MD → JSON**: Generate JSON from the parsed markdown data

Write the companion file to complete the pair.

### Step 8: Report Results

```
SYNC COMPLETE

Results:
   Tasks Created: [count]
   Dependencies Set: [count]
   Errors: [count]
   Companion file: [generated/already exists]

[If errors:]
Some tasks could not be created:
   - [P2] Task title: <error reason>

Tasks are now synced. Run /spec:execute to begin implementation.
```

## Error Handling

### File Not Found

```
Tasks file not found: $ARGUMENTS

Make sure the path is correct:
   /spec:tasks-sync specs/<slug>/03-tasks.json
   /spec:tasks-sync specs/<slug>/03-tasks.md
```

### Invalid JSON

```
Failed to parse 03-tasks.json: [error]

Options:
1. Fix the JSON manually and re-run
2. Fall back to markdown: /spec:tasks-sync specs/<slug>/03-tasks.md
3. Re-run decompose: /spec:decompose specs/<slug>/02-specification.md
```

### No Tasks Found in File

```
No tasks found in $ARGUMENTS

[If JSON]: The "tasks" array is empty or missing
[If markdown]: No task sections detected (expected format: ### Task X.Y: Title)
```

### All Tasks Already Synced

```
All tasks already synced

Found [count] tasks for [slug] in task system.
Nothing to create.
```

## Usage Examples

```bash
# Sync from JSON (preferred)
/spec:tasks-sync specs/user-authentication/03-tasks.json

# Sync from markdown (fallback)
/spec:tasks-sync specs/user-authentication/03-tasks.md

# Auto-detect (checks JSON first, then MD)
/spec:tasks-sync specs/user-authentication/03-tasks.json
```

## Integration

| Related Command   | Relationship                                                         |
| ----------------- | -------------------------------------------------------------------- |
| `/spec:decompose` | Creates 03-tasks.json + 03-tasks.md; main context creates tasks      |
| `/spec:execute`   | Executes tasks created by decompose or this sync command             |
| `TaskList()`      | View all synced tasks                                                |
