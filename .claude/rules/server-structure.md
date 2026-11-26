---
paths: apps/server/src/services/**/*.ts, apps/server/src/routes/**/*.ts
---

# Server Structure Rules

Hono server. New endpoints are capabilities with an `http` surface, served by `routes/capability-http.ts`; `routes/` keeps hand routes for shapes a capability cannot carry yet. The request chain is `http/`. Business logic lives in `services/`, one folder per domain: run `ls apps/server/src/services` for the current list.

## Layout

```
apps/server/src/
├── http/          # The Hono app and the one request chain
├── routes/        # Thin HTTP handlers and the capability mount
├── services/      # Business logic, one folder per domain
│   └── __tests__/ # Cross-domain integration tests
├── middleware/    # Cross-cutting HTTP concerns
└── lib/           # dork-home.ts, resolve-root.ts, small pure helpers
```

## Before You Add a Domain or a Feature

1. **Apply the core test** (ADR `261124-150519`). A feature goes in the server only if the core itself acts on it, only the core can see what it needs, or a mini app cannot do it correctly. If all three are no, build a mini app (`contributing/extension-authoring.md`) or a schedule with a skill. A watcher (a pull request, a pipeline, an outside app) is a mini app.
2. **No new process or service** unless its lifetime or its trust level differs from the server's (ADR `261124-150516`). Never split one off for a feature: there is no separate Relay, orchestrator or web-server service.
3. **Pick a side.** New code is either space side (it holds or decides over space data: members, agents, conversations, rules, memory, schedules, connections, settings, documents, mini apps) or computer side (it runs turns: runtimes, workspaces, terminals, the agent's browser). Do not add a new import from one side into the other's internals. Space-side code that starts or watches a turn goes through the turn code's existing entry points, `services/session/message-dispatcher.ts` and `services/session/launch/launch-session.ts`, until the turn port exists. The target is in `contributing/architecture-target.md`. Today the lint walls between domains are `rooms` against `spaces` (`apps/server/eslint-rules/space-boundary.js`), turn code against the work graph (`work-graph-boundary.js`), and `session` against `runtimes` (`session-runtimes-boundary.js`: the runtimes build on session, never the reverse; an adapter's own fact reaches session through a port such as `session/resolution/claude-code-facts.ts`); and between every domain, `import-boundary.js` (DOR-4924). A domain is a folder under `services/`, and each folder under `services/core/` is its own; one domain may import another only along a pair already in `import-boundary.baseline.json`, and those pairs and their counts only fall (`pnpm check:import-boundary -- --update` after removing some; never add one by hand). Type-only imports and tests are free. Reach another domain through an interface or port it exports, or move a shared type to `packages/shared`. A pull request that moves a folder updates `sides.json` and this baseline together.

## Placing a New Service

- Put it in the existing domain it belongs to: `services/<domain>/<name>.ts`, test in `services/<domain>/__tests__/<name>.test.ts`. No loose files at `services/` root.
- Create a new domain directory only when the core test passes and a cohesive area emerges (several related services with a clear boundary), never for a single orphan file. Cross-cutting infrastructure (config, registries, stream helpers) lives in `core/`.
- A middleware step calls a service, never the reverse: lint refuses a service that imports from `middleware/` (`MIDDLEWARE_BAN` in `apps/server/eslint.config.js`, DOR-4922). A pure helper both need (it reads headers or strings, and imports no service, config or Hono context) goes in `lib/`. For anything else, the service declares the narrow function type it needs and its composition root passes the step's function in.
- Runtime adapters go under `services/runtimes/<runtime>/`; each must pass the shared conformance suite (`runtimeConformance` from `@dorkos/test-utils`, called from its `__tests__/conformance.test.ts`; `scripts/__tests__/runtime-conformance-census.test.ts` fails on a runtime folder without one) and its SDK import is ESLint-confined to that directory.

## Naming

Kebab-case files with noun-style module names: `config-manager.ts`, `event-log.ts`, `aggregate-session-list.ts`.

## Route Handlers

Routes stay thin regardless of size: validate input with Zod, call a service, map errors to status codes. Never put business logic or direct data access in a route handler. Validation and error-shape patterns: `.claude/rules/api.md`.

A route imports a service, never the reverse. Lint refuses a service that imports from `routes/` (`ROUTES_BAN` in `apps/server/eslint.config.js`, DOR-4922): a service that needs a route's function declares the narrow function type it needs, and its composition root (the startup or wiring code that builds it) passes the route's function in. `middleware/` has the same rule (`MIDDLEWARE_BAN`, above).
