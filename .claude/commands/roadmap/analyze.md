---
description: Perform a full health check with detailed analysis
argument-hint: "(no arguments)"
allowed-tools: Bash, Read
category: roadmap
---

# Roadmap Analyze

Perform a comprehensive health check of the roadmap with detailed analysis.

## Usage

```
/roadmap:analyze
```

## Implementation

### Step 1: Run Health Check

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/check_health.py
```

### Step 2: Run Validation

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

### Step 3: Generate Report

Compile a detailed report including:

#### MoSCoW Distribution
- Must-Have % (warn if >60%)
- Count and effort by priority level

#### Status Breakdown
- Not Started
- In Progress
- Completed
- On Hold

#### Health Indicators
- Items at risk
- Blocked items
- Items missing effort estimates

#### Dependency Analysis
- Items with unresolved dependencies
- Dependency chains
- Potential bottlenecks

#### Timeline Analysis
- Items in each horizon (Now, Next, Later)
- Overdue items (in "Now" but not started)
- Items without time horizon

## Output Format

```markdown
## Roadmap Health Report

### Overall Health: [Good/Warning/Critical]

### MoSCoW Distribution
| Priority | Count | Effort | % of Total |
|----------|-------|--------|------------|
| Must-Have | X | Y days | Z% |
| Should-Have | X | Y days | Z% |
| Could-Have | X | Y days | Z% |
| Won't-Have | X | - | - |

⚠️ Warning: Must-Have exceeds 60% threshold

### Status Breakdown
- Not Started: X items
- In Progress: X items
- Completed: X items
- On Hold: X items

### Items Needing Attention

#### At Risk (2)
- "Feature A" - No progress in 2 weeks
- "Feature B" - Dependency blocked

#### Blocked (1)
- "Feature C" - Waiting on external API

#### Missing Estimates (3)
- "Feature D", "Feature E", "Feature F"

### Recommendations
1. [Specific actionable recommendation]
2. [Specific actionable recommendation]
```
