---
description: Intelligently select the next roadmap item to work on
argument-hint: "(no arguments)"
allowed-tools: Bash, Read
category: roadmap
---

# Roadmap Next

Analyze the roadmap and recommend the next item to work on based on priority algorithm.

## Selection Algorithm

1. **Filter eligible items:**
   - Status is `not-started` OR `on-hold` (if dependencies now met)
   - Exclude items with unmet dependencies (check `dependencies` array against completed items)

2. **Sort by priority:**
   - MoSCoW: must-have > should-have > could-have > wont-have
   - Time horizon: now > next > later
   - Health: at-risk/blocked items get priority within same MoSCoW (need attention)
   - Dependency impact: items that unblock others first (count how many items depend on each)

3. **Return top candidate with rationale**

## Implementation

1. Load and parse the roadmap:

```bash
cat roadmap/roadmap.json
```

2. Apply the selection algorithm to find the best next item:

   a. Get all items with status `not-started` or `on-hold`
   b. Get list of completed item IDs
   c. Filter out items whose dependencies are not all in the completed list
   d. Sort remaining items by:
      - MoSCoW priority (must-have=1, should-have=2, could-have=3, wont-have=4)
      - Time horizon (now=1, next=2, later=3)
      - Health (at-risk/blocked get 0 bonus, on-track/off-track get 1)
      - Dependency impact (count how many other items list this one in dependencies)

3. Output the recommendation in this format:

```markdown
## Next Roadmap Item

**Selected:** {title}
**ID:** {uuid}
**Type:** {type} | **MoSCoW:** {moscow} | **Horizon:** {timeHorizon}
**Health:** {health} | **Effort:** {effort} points

### Rationale
{Explain why this item was selected over others}

### Dependencies
{List any dependencies and their status, or "None"}

### To start work:
\`\`\`
/roadmap:work {uuid}
\`\`\`
```

## Edge Cases

- **No eligible items:** Report "All items are completed, blocked, or have unmet dependencies"
- **All must-haves completed:** Celebrate and move to should-haves
- **Circular dependencies:** Report the cycle and suggest resolution
- **On-hold items:** Check if their blockers are resolved before including

## Priority Scoring Reference

| Factor | Values | Score |
|--------|--------|-------|
| MoSCoW | must-have | 1 |
| | should-have | 2 |
| | could-have | 3 |
| | wont-have | 4 |
| Time Horizon | now | 1 |
| | next | 2 |
| | later | 3 |
| Health | at-risk, blocked | 0 (prioritize) |
| | on-track, off-track | 1 |
| Unblocks Others | Each dependent | -0.1 per dependent |

**Lower total score = higher priority**

## Example Output

```markdown
## Next Roadmap Item

**Selected:** Fix Mobile Navigation
**ID:** 550e8400-e29b-41d4-a716-446655440004
**Type:** bugfix | **MoSCoW:** must-have | **Horizon:** now
**Health:** at-risk | **Effort:** 2 points

### Rationale
This is the highest priority item because:
1. It's a must-have bugfix in the "now" horizon
2. Its health is at-risk, indicating it needs immediate attention
3. No unmet dependencies

### Dependencies
None

### To start work:
\`\`\`
/roadmap:work 550e8400-e29b-41d4-a716-446655440004
\`\`\`
```
