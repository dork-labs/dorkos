---
description: Show documentation health dashboard — guide freshness, TODO stubs, overall score
argument-hint: ''
allowed-tools: Read, Grep, Glob, Bash
category: documentation
---

# Documentation Status Dashboard

Display a health overview of all documentation: contributing guides and external docs.

## Order of Operations

### Step 1: Read INDEX.md

Read `contributing/INDEX.md` and parse both maintenance tracking tables:

- **Contributing Guides Maintenance** table — extract guide name, last reviewed date, notes
- **External Docs Maintenance** table — extract MDX file path, last reviewed date, notes

### Step 2: Check for TODO Stubs

Search `docs/` for any remaining TODO stub markers:

```bash
grep -r "TODO: Write full content" docs/ || echo "No TODO stubs found"
```

Also check for placeholder patterns:

```bash
grep -rn "TODO\|FIXME\|PLACEHOLDER" docs/ --include="*.mdx" || echo "No issues found"
```

### Step 3: Calculate Freshness

For each guide/doc, calculate days since last review:

- **Fresh** (0-14 days): No action needed
- **Aging** (15-30 days): Consider reviewing
- **Stale** (31-60 days): Should review soon
- **Critical** (60+ days): Needs immediate review

### Step 4: Display Dashboard

```
═══════════════════════════════════════════════════
              DOCUMENTATION STATUS
═══════════════════════════════════════════════════

📊 Health Score: [X]/100

───────────────────────────────────────────────────
           CONTRIBUTING GUIDES (14 total)
───────────────────────────────────────────────────

  ✅ Fresh (0-14 days):     X guides
  🟡 Aging (15-30 days):    X guides
  🟠 Stale (31-60 days):    X guides
  🔴 Critical (60+ days):   X guides

  [List stale/critical guides with days since review]

───────────────────────────────────────────────────
           EXTERNAL DOCS (11 MDX files)
───────────────────────────────────────────────────

  ✅ Fresh (0-14 days):     X files
  🟡 Aging (15-30 days):    X files
  🟠 Stale (31-60 days):    X files
  🔴 Critical (60+ days):   X files

  [List stale/critical docs with days since review]

───────────────────────────────────────────────────
           TODO STUBS
───────────────────────────────────────────────────

  [Count of remaining TODO stubs in docs/]
  [List files if any]

═══════════════════════════════════════════════════
```

### Step 5: Health Score Calculation

Score out of 100:

- Start at 100
- Subtract 2 points per aging guide/doc
- Subtract 5 points per stale guide/doc
- Subtract 10 points per critical guide/doc
- Subtract 15 points per TODO stub remaining
- Minimum score: 0

### Step 6: Recommendations

If score < 80, suggest running `/docs:reconcile --all` to identify specific drift.
If TODO stubs exist, list the files that need content.
If INDEX.md is missing, flag as critical and suggest recreating it.
