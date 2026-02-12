---
description: Add a new item to the roadmap
argument-hint: <title>
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
category: roadmap
---

# Roadmap Add

Add a new item to the roadmap with MoSCoW prioritization.

## Usage

```
/roadmap:add "Implement user authentication"
```

## Arguments

- `$ARGUMENTS` - The title of the new roadmap item

## Implementation

### Step 1: Parse Title

Extract the title from arguments. If no title provided, ask the user for one.

### Step 2: Gather Item Details

Use AskUserQuestion to collect:

1. **Type** (feature, bugfix, improvement, maintenance, research)
2. **MoSCoW Priority** (must-have, should-have, could-have, wont-have)
3. **Time Horizon** (now, next, later)
4. **Description** (brief description of the item)
5. **Effort** (small, medium, large, x-large) - optional
6. **Labels** (comma-separated tags) - optional

### Step 3: Generate UUID

```bash
python3 -c "import uuid; print(str(uuid.uuid4()))"
```

### Step 4: Add to Roadmap

Read `roadmap/roadmap.json`, add the new item with:
- Generated UUID as `id`
- Current ISO timestamp for `createdAt` and `updatedAt`
- Status: `not-started`
- Health: `on-track`

### Step 5: Validate

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

### Step 6: Report Result

Display the newly created item and confirm success.

## Example

```
/roadmap:add "Transaction categorization"

Creating new roadmap item: "Transaction categorization"

What type of item is this?
- feature
- bugfix
- improvement
- maintenance
- research

What is the MoSCoW priority?
- must-have (project fails without it)
- should-have (important but not critical)
- could-have (nice to have if time permits)
- wont-have (explicitly deferred)

...

Created roadmap item:
- ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890
- Title: Transaction categorization
- Priority: should-have
- Horizon: next
```
