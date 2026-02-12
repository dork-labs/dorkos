---
description: Enrich a roadmap item with ideation context
argument-hint: <item-id-or-title>
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
category: roadmap
---

# Roadmap Enrich

Add or update the ideationContext for a roadmap item to provide richer context for ideation and implementation.

## Usage

```
/roadmap:enrich <item-id>
/roadmap:enrich "<item-title>"
```

## Arguments

- `$ARGUMENTS` - Either a UUID or a title (quoted) to identify the item

## Implementation

### Step 1: Identify the Item

If argument looks like a UUID, use it directly. Otherwise, search by title:

```bash
python3 roadmap/scripts/find_by_title.py "$ARGUMENTS"
```

If multiple matches found, use AskUserQuestion to let user select.

### Step 2: Load Current Item

Read the item from `roadmap/roadmap.json` and display:
- Title
- Description
- Current ideationContext (if any)

### Step 3: Analyze and Suggest Context

Based on the item's title and description, suggest values for:

- **targetUsers**: Who would benefit from this feature
- **painPoints**: What problems does this solve
- **successCriteria**: How do we measure success
- **constraints**: Any limitations or out-of-scope items

### Step 4: Confirm with User

Use AskUserQuestion to present suggestions and allow modifications:

```
Based on "Transaction sync and storage":

Target Users (suggested):
- Users tracking personal spending
- First-time users setting up accounts

Would you like to:
- Accept these suggestions
- Modify them
- Add more
```

### Step 5: Save Updates

Update the item's `ideationContext` field in `roadmap/roadmap.json`.
Also update the `updatedAt` timestamp.

### Step 6: Validate

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

## Example

```
/roadmap:enrich "Transaction sync"

Found: "Transaction sync and storage" (id: abc-123)
Description: "Fetch transactions from Plaid and store them locally..."

Current ideationContext: None

Based on this item, I suggest:

Target Users:
- Users tracking personal spending
- First-time users setting up accounts

Pain Points:
- Manual tracking is tedious
- No visibility into transaction history

Success Criteria:
- Transactions auto-import within 5 seconds
- No duplicate entries
- All transaction metadata preserved

Constraints:
- Read-only (no payment initiation)
- US banks only initially

Would you like to modify any of these before saving?
```

## ideationContext Schema

```typescript
interface IdeationContext {
  targetUsers?: string[]
  painPoints?: string[]
  successCriteria?: string[]
  constraints?: string[]
  technicalNotes?: string
  relatedFeatures?: string[]
}
```
