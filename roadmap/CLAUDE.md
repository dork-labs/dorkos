# Roadmap Project - Claude Code Instructions

**This is a standalone project.** The roadmap data (`roadmap.json`) and Python scripts live in this directory. The web application (Express API + React SPA) lives at `apps/roadmap/`.

## Project Overview

A visual roadmap management system using MoSCoW prioritization. The app at `apps/roadmap/` provides a full-stack web interface (Express + React 19), while Python utility scripts here offer CLI-based workflows. Both read/write the same `roadmap.json` file.

## Technology Stack

| Technology | Purpose |
| --- | --- |
| Express | REST API server (port 4243) at `apps/roadmap/` |
| React 19 + Vite 6 | SPA client with FSD architecture at `apps/roadmap/` |
| lowdb | JSON file persistence for `roadmap.json` |
| TanStack Table | Table view with sorting/filtering |
| @hello-pangea/dnd | Drag-and-drop Kanban view |
| Tailwind CSS 4 | Styling (client) |
| Python 3 | Utility scripts (stdlib only, no pip) |
| JSON | Data storage (`roadmap.json`) |

## Directory Structure

```
roadmap/                  # Data + scripts (this directory)
├── roadmap.json          # Roadmap data (the source of truth)
├── schema.json           # JSON Schema for validation
├── specs/                # Symlink to ../specs (shared with main app)
├── scripts/              # Python utility scripts
│   ├── utils.py          # Shared utilities
│   ├── update_status.py  # Change item status
│   ├── link_spec.py      # Link spec files to items
│   ├── find_by_title.py  # Search items by title
│   └── slugify.py        # Generate spec slugs
├── README.md             # User documentation
└── CLAUDE.md             # This file

apps/roadmap/             # Web application
├── src/
│   ├── server/           # Express API
│   │   ├── index.ts      # Server entry (port 4243)
│   │   ├── app.ts        # Express app factory
│   │   ├── routes/       # items, meta, files route handlers
│   │   ├── services/     # RoadmapStore (lowdb)
│   │   └── lib/          # Logger
│   └── client/           # React 19 SPA (FSD layers)
│       ├── main.tsx      # Entry point
│       ├── App.tsx       # Root component
│       └── layers/       # FSD: shared, entities, features
├── package.json
├── vite.config.ts
└── tsconfig*.json
```

## API Endpoints

All endpoints are under `/api/roadmap/`:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/roadmap/items` | List all items |
| POST | `/api/roadmap/items` | Create new item |
| GET | `/api/roadmap/items/:id` | Get single item |
| PATCH | `/api/roadmap/items/:id` | Update item |
| DELETE | `/api/roadmap/items/:id` | Delete item |
| POST | `/api/roadmap/items/reorder` | Reorder items |
| GET | `/api/roadmap/meta` | Project metadata + health stats |
| GET | `/api/roadmap/files/*` | Serve spec files (specs/ only) |

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `ROADMAP_PORT` | `4243` | Express server port |
| `ROADMAP_PROJECT_ROOT` | `process.cwd()` | Project root for locating `roadmap.json` and `specs/` |

## Client Views

- **Table View**: TanStack Table with sorting, filtering, column visibility
- **Kanban View**: Drag-and-drop columns by time horizon (@hello-pangea/dnd)
- **MoSCoW Grid**: Cards grouped by MoSCoW priority
- **Gantt View**: Custom timeline visualization

## Key Architectural Decisions

### Standalone App (Not Transport-Based)

The roadmap app is independent from the main DorkOS Transport interface. It has its own Express server, React client, and data persistence layer. It does NOT import from `apps/server/` or `apps/client/`.

### Data Storage

- `roadmap.json` is the single source of truth
- The Express API persists via lowdb (JSON file adapter)
- Python scripts read/write the same file directly
- Always update `lastUpdated` when modifying the roadmap
- Always update item's `updatedAt` when modifying an item

### No Auth

Single-user tool with no authentication. Designed for local development use.

## Common Commands

### Development

```bash
dotenv -- turbo dev --filter=@dorkos/roadmap   # Start Express + Vite dev servers
npx vitest run apps/roadmap/                    # Run tests
```

### Management (via Claude Code)

```bash
/roadmap:show           # Display CLI summary (no browser)
/roadmap:open           # Open in browser
/roadmap:add "title"    # Add new item (interactive)
/roadmap:enrich <id>    # Add ideationContext
/roadmap:prioritize     # Get prioritization suggestions
/roadmap:analyze        # Full health analysis
/roadmap:validate       # Validate JSON structure
```

### Utility Scripts

```bash
python3 roadmap/scripts/update_status.py <item-id> <status>
python3 roadmap/scripts/link_spec.py <item-id> <spec-slug>
python3 roadmap/scripts/link_all_specs.py [--dry-run]
python3 roadmap/scripts/find_by_title.py "<search-query>"
python3 roadmap/scripts/slugify.py "<title>"
python3 roadmap/scripts/clear_roadmap.py "<project-name>" "<project-summary>"
```

## Schema Reference

### Item Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
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

## Integration Points

### With Claude Code Skills

The `managing-roadmap-moscow` skill (`.claude/skills/managing-roadmap-moscow/`) provides validation, health checking, summary generation, and MoSCoW methodology guidance.

### With Spec Workflow

1. Click "Start Ideation" on roadmap item
2. Paste command in Claude Code terminal
3. Status updates to "in-progress"
4. Complete `/ideate-to-spec` workflow
5. Status updates to "completed" when done

## Do NOT

1. Import code from the main DorkOS apps (`apps/server/`, `apps/client/`)
2. Modify `roadmap.json` without updating timestamps
3. Skip validation after roadmap changes
4. Let Must-Have items exceed 60% of total effort
