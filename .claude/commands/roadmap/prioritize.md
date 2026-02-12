---
description: Analyze priorities and suggest rebalancing
argument-hint: "(no arguments)"
allowed-tools: Read, Bash, Task, AskUserQuestion
category: roadmap
---

# Roadmap Prioritize

Analyze the current roadmap priorities and suggest rebalancing to maintain healthy MoSCoW distribution.

## Usage

```
/roadmap:prioritize
```

## Implementation

### Step 1: Run Health Check

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/check_health.py
```

### Step 2: Analyze Distribution

Check:
- Must-Have percentage (should be <60% of total effort)
- Items that could be deprioritized
- Quick wins being missed (high value, low effort items not in "Now")
- Blocked or at-risk items that need attention

### Step 3: Strategic Analysis

Use the `product-manager` agent for deeper strategic analysis:

```
Task(
  description="Analyze roadmap priorities",
  prompt="Review the roadmap and provide strategic recommendations for priority adjustments. Focus on: 1) Items that could move from Must-Have to Should-Have, 2) Quick wins that should move to Now, 3) Dependencies causing bottlenecks.",
  subagent_type="product-manager"
)
```

### Step 4: Present Recommendations

Display:
- Current MoSCoW distribution
- Specific items recommended for priority changes
- Rationale for each recommendation

### Step 5: Offer to Apply Changes

If user approves recommendations, update the roadmap.json accordingly.

## Output Format

```markdown
## Priority Analysis

### Current Distribution
- Must-Have: X items (Y% of effort) ⚠️ Over 60% threshold
- Should-Have: X items
- Could-Have: X items
- Won't-Have: X items

### Recommendations

1. **Deprioritize**: "Feature X" (Must → Should)
   - Reason: Not blocking any critical path

2. **Promote Quick Win**: "Feature Y" (Later → Now)
   - Reason: High value, low effort, no dependencies

3. **Address Blocker**: "Feature Z" is blocking 3 other items
   - Suggestion: Break into smaller deliverables

Would you like me to apply these changes?
```
