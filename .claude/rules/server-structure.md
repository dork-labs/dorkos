---
paths: apps/server/src/services/**/*.ts, apps/server/src/routes/**/*.ts
---

# Server Structure Rules

Express server: flat `routes/`, domain-grouped `services/`.

## Layout

```
apps/server/src/
├── routes/        # Thin HTTP handlers, flat — one file per resource
├── services/      # Business logic, grouped by domain:
│   │              #   activity/ core/ core-extensions/ extensions/ harness/
│   │              #   marketplace/ marketplace-mcp/ mesh/ relay/ runtimes/
│   │              #   session/ tasks/ workspace/
│   └── __tests__/ # Cross-domain integration tests
├── middleware/    # Cross-cutting HTTP concerns
└── lib/           # dork-home.ts, resolve-root.ts, small pure helpers
```

## Placing a New Service

- Put it in the existing domain it belongs to: `services/<domain>/<name>.ts`, test in `services/<domain>/__tests__/<name>.test.ts`. No loose files at `services/` root.
- Create a new domain directory only when a cohesive area emerges (several related services with a clear boundary) — never for a single orphan file. Cross-cutting infrastructure (config, registries, stream adapters) lives in `core/`.
- Runtime adapters go under `services/runtimes/<runtime>/`; each must pass the shared conformance suite (`runtimeConformance` from `@dorkos/test-utils`) and its SDK import is ESLint-confined to that directory.

## Naming

Kebab-case files with noun-style module names: `config-manager.ts`, `event-log.ts`, `aggregate-session-list.ts`.

## Route Handlers

Routes stay thin regardless of size: validate input with Zod, call a service, map errors to status codes. Never put business logic or direct data access in a route handler. Validation and error-shape patterns: `.claude/rules/api.md`.
