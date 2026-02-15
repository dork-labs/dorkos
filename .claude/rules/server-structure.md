---
paths: apps/server/src/services/**/*.ts, apps/server/src/routes/**/*.ts
---

# Server Structure Rules

These rules apply to Express server route handlers and service modules.

## Current Architecture

The server uses flat `routes/` + `services/` organization:

```
apps/server/src/
├── routes/      # Thin HTTP handlers (delegate to services)
├── services/    # Business logic
└── middleware/   # Cross-cutting concerns
```

## Size-Aware Structure Monitoring

**When adding a new service file**, count the total `.ts` files in `services/`:

### Thresholds

| Service Count | Guidance |
|---------------|----------|
| **< 15** | Current flat structure is fine. No action needed. |
| **15-20** | Suggest domain grouping. Mention to the user: "The server has [N] service files. Consider grouping into domain directories (session/, agent/, commands/, shared/) for clearer ownership." |
| **20+** | Strongly recommend domain grouping. The flat structure is becoming hard to navigate. |

### Domain Grouping Template

When the threshold is reached, suggest this structure:

```
domains/
├── session/          # Session lifecycle
│   ├── transcript-reader.ts
│   ├── session-broadcaster.ts
│   └── stream-adapter.ts
├── agent/            # Claude Agent SDK
│   └── agent-manager.ts
├── commands/         # Slash commands
│   └── command-registry.ts
└── shared/           # Cross-cutting infrastructure
    ├── openapi-registry.ts
    ├── file-lister.ts
    ├── git-status.ts
    └── tunnel-manager.ts
```

Routes stay flat regardless of service count — they're thin HTTP handlers.

### When to Proactively Suggest

Also suggest restructuring when:
- A single domain has **4+ service files** (e.g., 4 session-related services)
- A developer asks "where does this new service go?"
- Two services have circular or unclear dependencies
- A new team member would struggle to understand service relationships

## Route Handler Rules

(See also: `.claude/rules/api.md` for validation and error handling patterns)

- Routes are thin — validate input, call service, return response
- Never put business logic in route handlers
- Use service layer for all data access and processing
