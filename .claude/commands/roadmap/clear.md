---
description: Clear all roadmap items and reset project metadata
argument-hint: [--force]
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
category: roadmap
---

# Roadmap Clear

Clear all items from the roadmap and optionally set new project metadata. This is a destructive operation that cannot be undone.

## Usage

```
/roadmap:clear
/roadmap:clear --force
```

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--force` - Skip confirmation prompt (use with caution)

## Implementation

### Step 1: Load Current Roadmap

Read `roadmap/roadmap.json` and display current state:

```
Current roadmap state:
- Project: {projectName}
- Items: {items.length} total
  - Must-have: {count}
  - Should-have: {count}
  - Could-have: {count}
  - Won't-have: {count}
```

### Step 2: Confirm Destructive Action

Unless `--force` flag is provided, use AskUserQuestion to confirm:

```
⚠️ WARNING: This will permanently delete all {items.length} roadmap items.

Are you sure you want to clear the roadmap?
```

Options:
- "Yes, clear all items" - Proceed with clearing
- "No, cancel" - Abort the operation

If user selects "No, cancel", display "Operation cancelled" and exit.

### Step 3: Gather New Project Metadata

Use AskUserQuestion to collect:

1. **Project Name** - Ask for the new project name
   - Provide current name as default option
   - Allow custom input

2. **Project Summary** - Ask for the new project summary/description
   - Provide current summary as default option
   - Allow custom input

### Step 4: Execute Clear

Run the Python script:

```bash
python3 roadmap/scripts/clear_roadmap.py "<project-name>" "<project-summary>"
```

### Step 5: Validate

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

### Step 6: Report Result

Display success message:

```
✅ Roadmap cleared successfully

New roadmap state:
- Project: {projectName}
- Summary: {projectSummary}
- Items: 0

Next steps:
- Run /roadmap:add to add your first item
- Run /roadmap:open to view the empty roadmap
```

## Example

```
/roadmap:clear

Current roadmap state:
- Project: Next.js Boilerplate
- Items: 8 total
  - Must-have: 3
  - Should-have: 3
  - Could-have: 2
  - Won't-have: 0

⚠️ WARNING: This will permanently delete all 8 roadmap items.

Are you sure you want to clear the roadmap?
> Yes, clear all items

What should the project be called?
> My New Project

Brief description of the project:
> A modern web application with real-time features

✅ Roadmap cleared successfully

New roadmap state:
- Project: My New Project
- Summary: A modern web application with real-time features
- Items: 0

Next steps:
- Run /roadmap:add to add your first item
- Run /roadmap:open to view the empty roadmap
```

## Force Mode Example

```
/roadmap:clear --force

# Skips confirmation, still asks for project metadata

What should the project be called?
> Quick Test Project

Brief description of the project:
> Testing the roadmap system

✅ Roadmap cleared successfully
...
```
