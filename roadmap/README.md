# Product Roadmap

A standalone visual roadmap management system using MoSCoW prioritization.

> **Note:** This is a standalone project. The code here (HTML, CSS, JS, JSON) is separate from the parent Next.js application and should not be mixed with it.

## Quick Start

### View the Roadmap

**Via Claude Code:**
```bash
/roadmap:open     # Start server and open in browser
/roadmap:status   # Check if server is running
/roadmap:close    # Stop the server
```

**Manually:**
```bash
cd roadmap
python3 -m http.server 8765
# Then open http://localhost:8765/roadmap.html
```

### Manage via Claude Code

```bash
/roadmap:show           # Display roadmap summary
/roadmap:open           # Open visualization in browser
/roadmap:close          # Stop the server
/roadmap:status         # Check server status
/roadmap:add "title"    # Add a new item
/roadmap:enrich <id>    # Add ideationContext to item
/roadmap:prioritize     # Get prioritization suggestions
/roadmap:analyze        # Full health analysis
/roadmap:validate       # Validate JSON structure
```

## Files

| File | Purpose |
|------|---------|
| `roadmap.json` | Main roadmap data (source of truth) |
| `schema.json` | JSON Schema for validation |
| `roadmap.html` | Visualization page |
| `styles.css` | Calm Tech design system |
| `scripts.js` | View rendering and interactions |
| `scripts/` | Python utility scripts |
| `specs/` | Symlink to project specs |

## Visualization Features

### Three Views

| View | Organization | Best For |
|------|-------------|----------|
| **Timeline** | Now / Next / Later columns | Sprint planning |
| **Status** | Not Started / In Progress / Completed / On Hold | Progress tracking |
| **Priority** | Must / Should / Could / Won't lists | Scope management |

### Interactive Elements

- **Cards**: Click to open detail modal
- **Start Ideation**: Copies `/ideate --roadmap-id <uuid>` command
- **Spec Links**: Opens markdown files in viewer modal
- **Theme Toggle**: Light/dark mode support
- **Auto-refresh**: Data refreshes every 2 minutes

### Health Dashboard

- **Must-Have %**: Warns if >60% (scope creep indicator)
- **Total Items**: Count of all roadmap items
- **In Progress**: Currently active items
- **At Risk/Blocked**: Items needing attention

## MoSCoW Prioritization

| Priority | Meaning | Guideline |
|----------|---------|-----------|
| **Must Have** | Critical for success | Keep <60% of effort |
| **Should Have** | Important but not critical | Can delay if needed |
| **Could Have** | Nice to have | If time permits |
| **Won't Have** | Out of scope | Prevents scope creep |

## Effort Estimation

Story points on the Fibonacci scale:

| Points | Scope | Time Estimate |
|--------|-------|---------------|
| 1-2 | Quick tasks | Hours |
| 3-5 | Standard tasks | 1-2 days |
| 8 | Larger tasks | 3-5 days |
| 13 | Epic-sized | Should be broken down |

## Time Horizons

| Horizon | Timeframe | Focus |
|---------|-----------|-------|
| **Now** | Current sprint (2 weeks) | Active work |
| **Next** | 2-4 weeks | Planned work |
| **Later** | 1-3 months | Future work |

## Roadmap Item Schema

### Required Fields

```json
{
  "id": "uuid-v4",
  "title": "Feature title",
  "type": "feature|bugfix|technical-debt|research|epic",
  "moscow": "must-have|should-have|could-have|wont-have",
  "status": "not-started|in-progress|completed|on-hold",
  "health": "on-track|at-risk|off-track|blocked",
  "timeHorizon": "now|next|later",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

### Optional Fields

```json
{
  "description": "Detailed description",
  "effort": 5,
  "dependencies": ["other-item-uuid"],
  "labels": ["tag1", "tag2"],
  "linkedArtifacts": { ... },
  "ideationContext": { ... }
}
```

### linkedArtifacts

Tracks associated spec files:

```json
{
  "specSlug": "feature-name",
  "ideationPath": "specs/feature-name/01-ideation.md",
  "specPath": "specs/feature-name/02-specification.md",
  "tasksPath": "specs/feature-name/03-tasks.md",
  "implementationPath": "specs/feature-name/04-implementation.md"
}
```

### ideationContext

Rich context for generating better ideation prompts:

```json
{
  "targetUsers": ["who benefits from this feature"],
  "painPoints": ["problems this solves"],
  "successCriteria": ["how we measure success"],
  "constraints": ["limitations or out-of-scope items"]
}
```

## Claude Code Integration

### Workflow: Roadmap Item to Implementation

```
1. /roadmap:open              # Start server and open visualization
2. Click "Start Ideation"     # Copy command to clipboard
3. Paste in terminal          # Status -> in-progress
4. /ideate-to-spec <path>     # Transform ideation to spec
5. /spec:execute <path>       # Implement; status -> completed
6. /roadmap:close             # Stop the server when done
```

### Related Commands

| Command | Purpose |
|---------|---------|
| `/roadmap:show` | Display summary |
| `/roadmap:open` | Start server and open visualization |
| `/roadmap:close` | Stop the server |
| `/roadmap:status` | Check if server is running |
| `/roadmap:add <title>` | Add a new item |
| `/roadmap:enrich <item>` | Add ideationContext |
| `/roadmap:prioritize` | Get priority suggestions |
| `/roadmap:analyze` | Full health analysis |
| `/roadmap:validate` | Validate JSON structure |
| `/ideate --roadmap-id <uuid>` | Start ideation linked to item |
| `/ideate --roadmap-item "title"` | Start ideation by title |

### Related Skills

- `managing-roadmap-moscow` - MoSCoW methodology and utilities

### Related Agents

- `product-manager` - Strategic product decisions

## Utility Scripts

All scripts use Python 3 stdlib (no pip dependencies).

### Update Status

```bash
python3 roadmap/scripts/update_status.py <item-id> <status>
# Example: python3 roadmap/scripts/update_status.py 550e8400-... in-progress
```

Valid statuses: `not-started`, `in-progress`, `completed`, `on-hold`

### Link Spec

```bash
python3 roadmap/scripts/link_spec.py <item-id> <spec-slug>
# Example: python3 roadmap/scripts/link_spec.py 550e8400-... transaction-sync
```

### Link All Specs (Backfill)

```bash
# Preview what would be linked (no changes)
python3 roadmap/scripts/link_all_specs.py --dry-run

# Actually link all specs to matching roadmap items
python3 roadmap/scripts/link_all_specs.py
```

This script finds all spec directories and links them to roadmap items by matching:
1. `roadmapId` in spec frontmatter
2. Existing `linkedArtifacts.specSlug`
3. Title similarity (fuzzy matching)

### Find by Title

```bash
python3 roadmap/scripts/find_by_title.py "<search-query>"
# Example: python3 roadmap/scripts/find_by_title.py "transaction"
```

### Generate Slug

```bash
python3 roadmap/scripts/slugify.py "<title>"
# Example: python3 roadmap/scripts/slugify.py "Monthly income vs spending"
# Output: monthly-income-vs-spending
```

### Validate Roadmap

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py
```

### Check Health

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/check_health.py
```

### Generate Summary

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/generate_summary.py
```

## Architecture Notes

### Standalone Design

This project is intentionally separate from the parent Next.js application:

- **CSS**: Standalone Calm Tech styles (not Tailwind)
- **JS**: Vanilla JavaScript with IIFE pattern (not React)
- **Data**: JSON file storage (not database)

### Why Standalone?

1. **Simplicity**: No build step, just open in browser
2. **Portability**: Can be used with any project
3. **Speed**: Instant load, no framework overhead
4. **Independence**: Doesn't break if main app changes

### Shared Resources

- `specs/` symlink connects to project specs for viewing

## Maintenance

### After Editing roadmap.json

1. Update `lastUpdated` timestamp
2. Update item's `updatedAt` if modified
3. Run validation: `python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py`

### Health Checks

- Keep Must-Have <60% of total effort
- Review At Risk/Blocked items regularly
- Break down items with effort >8
