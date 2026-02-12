# Roadmap Project - Claude Code Instructions

**This is a standalone project.** The code in this directory (HTML, CSS, JS, JSON) is completely separate from the parent Next.js application and should not be mixed with it.

## Project Overview

A visual roadmap management system using MoSCoW prioritization, built with vanilla HTML/CSS/JS. Designed to integrate with Claude Code for seamless planning-to-implementation workflows.

## Technology Stack

| Technology | Purpose |
|------------|---------|
| HTML5 | Single-page application |
| CSS3 | Calm Tech design system (standalone, no Tailwind) |
| Vanilla JS | IIFE pattern, no framework |
| JSON | Data storage (`roadmap.json`) |
| Python 3 | Utility scripts (stdlib only, no pip) |

## Directory Structure

```
roadmap/
├── roadmap.html      # Main visualization page
├── styles.css        # Calm Tech styling (standalone CSS)
├── scripts.js        # View rendering, modals, interactions
├── roadmap.json      # Roadmap data (the source of truth)
├── schema.json       # JSON Schema for validation
├── specs/            # Symlink to ../specs (shared with main app)
├── scripts/          # Python utility scripts
│   ├── utils.py          # Shared utilities
│   ├── update_status.py  # Change item status
│   ├── link_spec.py      # Link spec files to items
│   ├── find_by_title.py  # Search items by title
│   └── slugify.py        # Generate spec slugs
├── README.md         # User documentation
└── CLAUDE.md         # This file (Claude Code instructions)
```

## Key Architectural Decisions

### Standalone CSS (Not Tailwind)

This project uses its own CSS file with the Calm Tech design system. Do NOT:
- Import Tailwind classes
- Reference the parent app's `globals.css`
- Use `@theme` directives

The CSS is self-contained with CSS custom properties for theming.

### Vanilla JavaScript (No React)

The visualization uses vanilla JS with an IIFE pattern. Do NOT:
- Import React components
- Use JSX
- Reference files from `src/`

### Data Storage

- `roadmap.json` is the single source of truth
- Always update `lastUpdated` when modifying the roadmap
- Always update item's `updatedAt` when modifying an item
- Run validation after changes: `python3 .claude/skills/managing-roadmap-moscow/scripts/validate_roadmap.py`

## Common Commands

### Viewing

```bash
# Open in browser (Next.js app - requires dev server running)
/roadmap:open
# Opens http://localhost:3000/roadmap

# CLI text summary (no browser needed)
/roadmap:show
```

**Note:** The roadmap visualization is now integrated into the Next.js app at `/roadmap`. The standalone HTML visualization (`roadmap.html`) is deprecated but kept for reference.

### Management (via Claude Code)

```bash
/roadmap:show           # Display CLI summary (no browser)
/roadmap:open           # Open in browser (Next.js app)
/roadmap:add "title"    # Add new item (interactive)
/roadmap:enrich <id>    # Add ideationContext
/roadmap:prioritize     # Get prioritization suggestions
/roadmap:analyze        # Full health analysis
/roadmap:validate       # Validate JSON structure
```

### Utility Scripts

```bash
# Update item status
python3 roadmap/scripts/update_status.py <item-id> <status>

# Link spec files to an item
python3 roadmap/scripts/link_spec.py <item-id> <spec-slug>

# Link ALL specs to roadmap items (backfill missing linkedArtifacts)
python3 roadmap/scripts/link_all_specs.py [--dry-run]

# Find item by title search
python3 roadmap/scripts/find_by_title.py "<search-query>"

# Generate slug from title
python3 roadmap/scripts/slugify.py "<title>"

# Clear all items and reset project metadata
python3 roadmap/scripts/clear_roadmap.py "<project-name>" "<project-summary>"
```

## Schema Reference

### Item Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | UUID v4 | Yes | Unique identifier |
| `title` | string | Yes | Item title (3-200 chars) |
| `description` | string | No | Detailed description |
| `type` | enum | Yes | feature, bugfix, technical-debt, research, epic |
| `moscow` | enum | Yes | must-have, should-have, could-have, wont-have |
| `status` | enum | Yes | not-started, in-progress, completed, on-hold |
| `health` | enum | Yes | on-track, at-risk, off-track, blocked |
| `timeHorizon` | enum | Yes | now, next, later |
| `effort` | number | No | Story points (1-13 Fibonacci) |
| `dependencies` | array | No | Array of item UUIDs |
| `labels` | array | No | Categorization tags |
| `linkedArtifacts` | object | No | Spec file paths |
| `ideationContext` | object | No | Context for ideation prompts |

### linkedArtifacts

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

```json
{
  "targetUsers": ["who benefits from this"],
  "painPoints": ["problems this solves"],
  "successCriteria": ["how we measure success"],
  "constraints": ["limitations and out-of-scope items"]
}
```

## Visualization Features

### Views

- **Timeline View**: Kanban columns by Now/Next/Later
- **Status View**: Kanban columns by status
- **Priority View**: List grouped by MoSCoW

### Modals

- **Item Detail Modal**: Click any card to see full details
- **Markdown Viewer Modal**: Click spec links to view rendered markdown

### Interactive Elements

- **Start Ideation button**: Copies `/ideate --roadmap-id <uuid>` command
- **Spec links**: Open ideation/spec/tasks in markdown viewer
- **Dependency pills**: Show linked items with status dots
- **Theme toggle**: Light/dark mode

### Health Dashboard

- Must-Have % (warns if >60%)
- Total items count
- In-progress count
- At-risk/blocked count

## Integration Points

### With Claude Code Skills

The `managing-roadmap-moscow` skill (`.claude/skills/managing-roadmap-moscow/`) provides:
- Validation scripts
- Health checking
- Summary generation
- MoSCoW methodology guidance

### With Claude Code Commands

- `/roadmap:show` - Display CLI summary (no browser)
- `/roadmap:open` - Open visualization at localhost:3000/roadmap
- `/roadmap:add` - Add new roadmap item
- `/roadmap:enrich` - Add ideationContext to item
- `/roadmap:prioritize` - Get priority suggestions
- `/roadmap:analyze` - Full health check
- `/roadmap:validate` - Validate JSON
- `/ideate --roadmap-id` - Links ideation to roadmap items

### With Claude Code Agents

- `product-manager` agent for strategic decisions

### With Spec Workflow

1. Click "Start Ideation" on roadmap item
2. Paste command in Claude Code terminal
3. Status updates to "in-progress"
4. Complete `/ideate-to-spec` workflow
5. Status updates to "completed" when done

## Code Conventions

### JavaScript

- IIFE pattern for encapsulation
- `elements` object for DOM references
- Event delegation for dynamic content
- `refreshIcons()` after dynamic content updates (Lucide)

### CSS

- CSS custom properties for theming
- OKLCH colors for consistency
- Mobile-first responsive design
- `.hidden` class for visibility toggle

### Python Scripts

- Python 3 stdlib only (no pip dependencies)
- Import `utils.py` for shared functions
- Use `load_roadmap()` and `save_roadmap()` for JSON operations
- Exit code 0 for success, 1 for failure

## Do NOT

1. Import code from the parent Next.js application
2. Use React, Tailwind, or other parent app dependencies
3. Modify `roadmap.json` without updating timestamps
4. Skip validation after roadmap changes
5. Let Must-Have items exceed 60% of total effort
