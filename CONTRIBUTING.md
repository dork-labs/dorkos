# Contributing to DorkOS

Welcome! We're excited that you're interested in contributing to DorkOS. This guide will help you get started with development, testing, and submitting contributions.

DorkOS is one place for every AI agent you run — Claude Code, Codex, and OpenCode, side by side in one window. It's a local-first web app and a REST/SSE API: a chat UI with tool approval flows, plus scheduled tasks, rooms, and a message bus your agents use to talk to each other.

## Prerequisites

Before you begin, ensure you have:

- **Node.js 22+**
- **pnpm 10+**
- **An authenticated Claude Code** — run `claude auth login` (see below before reaching for an API key)

## Getting Started

```bash
git clone https://github.com/dork-labs/dorkos.git
cd dorkos
pnpm install
cp .env.example .env  # Ports and paths
pnpm dev
```

### Authenticating your agent

**Under `pnpm dev`, sign in with the `claude` CLI (`claude auth login`).** The sign-in is read off disk, so it reaches the server no matter how the server was started, and it is the path this repo's own dev and eval workflows use.

Setting `ANTHROPIC_API_KEY` will _not_ work here, and it is worth knowing why before you lose an afternoon to it. `pnpm dev` runs through turbo, turbo runs strict, and a task only receives the variables it is declared to receive. `ANTHROPIC_API_KEY` is deliberately not one of them: it is passed to exactly one task, `e2e`, and that single carve-out is pinned by a test (`packages/evals/src/runner/__tests__/paid-provider.test.ts`) precisely so it cannot grow. This is a spending guard, not an oversight — **do not add the variable to `turbo.json` to make your key work.** The API-key route applies only to runs that turbo does not front: the built CLI, or running the server directly with node.

`.env.example` covers ports, storage paths, and optional features. It carries no `ANTHROPIC_API_KEY` line, for the reason above.

The client will be available at `http://localhost:6241` and the server at `http://localhost:6242`.

## Monorepo Structure

This is a Turborepo monorepo with six apps and seventeen shared packages:

| Directory                    | Package                     | Description                                          |
| ---------------------------- | --------------------------- | ---------------------------------------------------- |
| `apps/client`                | `@dorkos/client`            | React 19 SPA (Vite 6, Tailwind 4, shadcn/ui)         |
| `apps/server`                | `@dorkos/server`            | Express 5 API server                                 |
| `apps/site`                  | `@dorkos/site`              | Marketing site & docs (Next.js 16, Fumadocs)         |
| `apps/desktop`               | `@dorkos/desktop`           | Electron shell (macOS, Windows alpha)                |
| `apps/obsidian-plugin`       | `@dorkos/obsidian-plugin`   | Obsidian sidebar plugin                              |
| `apps/e2e`                   | `@dorkos/e2e`               | Playwright browser tests                             |
| `packages/cli`               | `dorkos`                    | Publishable npm CLI                                  |
| `packages/shared`            | `@dorkos/shared`            | Zod schemas, shared types, port interfaces           |
| `packages/db`                | `@dorkos/db`                | Drizzle ORM schemas (SQLite)                         |
| `packages/relay`             | `@dorkos/relay`             | Inter-agent message bus                              |
| `packages/mesh`              | `@dorkos/mesh`              | Agent discovery & registry                           |
| `packages/harness`           | `@dorkos/harness`           | Projects skills, commands & hooks to every agent CLI |
| `packages/memory`            | `@dorkos/memory`            | Agent memory engine behind the `MemoryProvider` port |
| `packages/skills`            | `@dorkos/skills`            | `SKILL.md` schemas, parser, writer, scanner          |
| `packages/operating-skills`  | `@dorkos/operating-skills`  | First-party skills that teach agents to run DorkOS   |
| `packages/marketplace`       | `@dorkos/marketplace`       | Package schemas, parser, validator, scaffolder       |
| `packages/a2a-gateway`       | `@dorkos/a2a-gateway`       | A2A protocol gateway                                 |
| `packages/extension-api`     | `@dorkos/extension-api`     | Public API contract for extension authors            |
| `packages/icons`             | `@dorkos/icons`             | SVG icon & logo registry                             |
| `packages/evals`             | `@dorkos/evals`             | Headless outcome-oracle eval harness                 |
| `packages/test-utils`        | `@dorkos/test-utils`        | Mock factories, test helpers, conformance suites     |
| `packages/eslint-config`     | `@dorkos/eslint-config`     | Shared ESLint flat configs                           |
| `packages/typescript-config` | `@dorkos/typescript-config` | Shared tsconfig presets                              |

## Development Commands

| Command              | Description                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Start server + client dev servers                                                                             |
| `pnpm test`          | Run all tests (Vitest)                                                                                        |
| `pnpm test -- --run` | Single test run (no watch mode)                                                                               |
| `pnpm build`         | Build all packages                                                                                            |
| `pnpm typecheck`     | Type-check all packages                                                                                       |
| `pnpm lint`          | ESLint across all packages                                                                                    |
| `pnpm lint -- --fix` | Auto-fix ESLint issues                                                                                        |
| `pnpm format`        | Prettier format all files                                                                                     |
| `pnpm format:check`  | Check formatting without writing                                                                              |
| `pnpm verify`        | The pre-PR check: script tests and root lint always run, then typecheck, lint and test over affected packages |

### Filtering Commands

To work on a single package:

```bash
pnpm exec dotenv -- turbo dev --filter=@dorkos/server   # Server only
pnpm exec dotenv -- turbo dev --filter=@dorkos/client   # Client only
pnpm exec dotenv -- turbo build --filter=@dorkos/obsidian-plugin  # Build plugin only
```

`dotenv` loads the root `.env` and lives in `node_modules/.bin`, so it needs the `pnpm exec` prefix.

### Running Specific Tests

```bash
pnpm vitest run apps/server/src/services/session/__tests__/aggregate-session-list.test.ts
```

## Architecture

DorkOS uses a **hexagonal architecture** with a `Transport` interface that decouples the React client from its backend. Two adapters exist:

- **`HttpTransport`** — Standalone web (HTTP/SSE to Express)
- **`DirectTransport`** — Obsidian plugin (in-process services)

Transport is injected via React Context (`TransportContext`). For deeper details, see [contributing/architecture.md](contributing/architecture.md).

## Subsystems

Three subsystems extend agents beyond a single interactive chat. All three are **on by default**:

| Subsystem | Code                                                 | Switch                                                              | Description                                                                                                                  |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Tasks** | `apps/server/src/services/tasks/`                    | `scheduler.enabled` in config, overridden by `DORKOS_TASKS_ENABLED` | Cron-based agent scheduler with SQLite run history, approval workflows, and configurable concurrency                         |
| **Relay** | `packages/relay` + `apps/server/src/services/relay/` | `relay.enabled` in config, overridden by `DORKOS_RELAY_ENABLED`     | Inter-agent message bus with NATS-style subject matching, Maildir persistence, delivery tracing, and external adapters       |
| **Mesh**  | `packages/mesh` + `apps/server/src/services/mesh/`   | none — always on (ADR-0062)                                         | Agent discovery and registry with pluggable strategies (Claude Code, Cursor, Codex), network topology, and health monitoring |

Tasks and Relay read their stored setting from `~/.dork/config.json` (both default to `true`). The environment variable is an override, not the setting: when it is present in the environment its value wins, and when it is absent the stored setting decides. Mesh has no switch of either kind — it boots unconditionally, and when Relay is up it bridges to it for lifecycle event broadcasting.

Tasks carries a second gate that catches people out: **being enabled is not the same as firing.** With `DORKOS_TASKS_ENABLED` unset, `resolveTasksFiring` only lets schedules fire when `NODE_ENV` is `production`, so in a dev checkout tasks are listed and editable but never run on their own. Set `DORKOS_TASKS_ENABLED=true` to override that and watch one fire.

Older docs call the scheduler **Pulse** and name `DORKOS_PULSE_ENABLED` and `DORKOS_MESH_ENABLED`. Those names are gone: the scheduler is Tasks, and Mesh lost its flag in ADR-0062. Before writing any environment variable down, check it: `apps/server/src/env.ts` holds the schema the server parses at boot and is where a new variable belongs, and [contributing/environment-variables.md](contributing/environment-variables.md) is the reference guide — including the handful of variables that are read straight off `process.env` instead (`DORKOS_CORS_ORIGIN`, `BETTER_AUTH_SECRET`), which is why `env.ts` alone is not a complete list.

## Client Architecture

The client uses **Feature-Sliced Design (FSD)** with strict unidirectional layer imports:

```
shared ← entities ← features ← widgets
```

**FSD Layers** (`apps/client/src/layers/`):

- **`shared/`** — Reusable UI primitives, hooks, utilities
- **`entities/`** — Domain-specific hooks (sessions, agents, commands)
- **`features/`** — Feature modules (chat, agents list, approvals, settings)
- **`widgets/`** — App-level layout components

The app shell — `App.tsx`, `AppShell.tsx`, `router.tsx`, `main.tsx` and `app/` — sits at the `apps/client/src/` root, outside `layers/`, and may import from any layer.

**Import rules**: Always import from barrel exports (e.g., `import { ChatPanel } from '@/layers/features/chat'`), never from internal paths.

For details, see [contributing/project-structure.md](contributing/project-structure.md) and [.claude/rules/fsd-layers.md](.claude/rules/fsd-layers.md).

## Testing

Tests use **Vitest** with **React Testing Library** for components. Tests live alongside source in `__tests__/` directories.

```bash
pnpm test                                   # Run all tests
pnpm test -- --run                          # Single run (no watch)
pnpm vitest run path/to/test.ts             # Run specific test
```

### Testing Conventions

- Component tests require `@vitest-environment jsdom` directive
- Always provide a mock `Transport` via `createMockTransport()` from `@dorkos/test-utils`
- Wrap components in context providers (TransportProvider, QueryClientProvider, etc.)
- Use `@testing-library/jest-dom` matchers

Example:

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';

const mockTransport = createMockTransport();

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <TransportProvider transport={mockTransport}>
      {children}
    </TransportProvider>
  );
}

describe('MyComponent', () => {
  it('renders expected content', () => {
    render(<MyComponent />, { wrapper: Wrapper });
    expect(screen.getByText('Expected')).toBeInTheDocument();
  });
});
```

### CLI Smoke Tests & Integration Tests

The CLI package is validated via Docker and GitHub Actions to ensure `npm install -g dorkos` works in clean environments:

```bash
pnpm smoke:docker        # Quick smoke test (--version, --help, init)
pnpm smoke:integration   # Full integration test (starts server, validates API + client)
pnpm smoke:npm           # Integration test against published npm package
```

The CI workflow (`.github/workflows/cli-smoke-test.yml`) runs on every push to `main`, and on pull requests that touch what the tarball bundles: `packages/cli`, `packages/shared`, `apps/server`, `apps/client`, `Dockerfile`, `.dockerignore`, `scripts/smoke-test.sh`, `pnpm-lock.yaml`, and the workflow file itself. It uses bare Ubuntu runners (Node 22/24 matrix), an isolated Docker smoke test, and a full integration test that starts the server and validates API endpoints and client SPA serving.

For the full target/install-mode model and troubleshooting, see [contributing/docker-testing.md](contributing/docker-testing.md).

### Running DorkOS in Docker

```bash
pnpm docker:build    # Build runnable image from local code
pnpm docker:run      # Start dorkos on port 4242
```

Or from the published npm package:

```bash
docker build --build-arg INSTALL_MODE=npm -t dorkos .
docker run --rm -p 4242:4242 -e ANTHROPIC_API_KEY=your-key dorkos
```

Pass `--port` to use a custom port: `docker run --rm -p 8080:8080 dorkos --port 8080`

For more testing patterns, see [.claude/rules/testing.md](.claude/rules/testing.md).

## Code Style

ESLint 9 (flat config) + Prettier enforce code quality. Run before committing:

```bash
pnpm lint
pnpm format
```

### ESLint Rules

Severity is the gate here: `lint` passes no `--max-warnings 0`, so anything meant to fail CI sits at `error` and a `warn` rule fails nothing.

- **FSD layer enforcement**: Cross-layer imports are `error`
- **TSDoc**: `error` on exported functions and classes — a missing or empty description fails `pnpm lint` (DOR-627)
- **SDK confinement and `os.homedir()`**: `error` — see the Hard Rules in [AGENTS.md](AGENTS.md)
- **Everything else** (`max-lines`, `no-unused-vars`): `warn`, so it reports without blocking
- **React Compiler rules**: Bundled with `eslint-plugin-react-hooks` v7 (warnings)

### File Size Limits

- **< 300 lines**: ideal, no action needed
- **300–500 lines**: consider splitting if the file has multiple responsibilities
- **500+ lines**: must split — enforced by the `max-lines` ESLint rule (warn), which
  excludes blank lines and comments from the count

See [.claude/rules/conventions.md](.claude/rules/conventions.md) for extraction
patterns and exceptions, and `packages/eslint-config/base.js` for the enforced rule.

## Pull Request Process

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feat/my-feature`)
3. **Make your changes**
4. **Add a changelog fragment** in `changelog/unreleased/` — see [changelog/README.md](changelog/README.md). Docs-only changes skip this with the `skip-changelog` label
5. **Run the checks** (`pnpm verify` covers typecheck, lint, and the affected tests; `pnpm format` fixes formatting)
6. **Open a pull request** with a clear description of your changes

Nothing is pushed straight to `main` — it is branch-protected, and every change lands through a pull request and the merge queue. The queue builds your branch on top of `main` plus whatever is ahead of it and runs the required checks against that combined tree, so a branch that has fallen behind `main` is fine and does not need updating.

## Commit Conventions

Use conventional-style prefixes:

- `feat:` — New features
- `fix:` — Bug fixes
- `refactor:` — Code restructuring
- `chore:` — Build, tooling, dependencies
- `docs:` — Documentation changes
- `test:` — Test additions or fixes

Example:

```
feat: add session export functionality

- Add export button to session sidebar
- Implement JSONL download endpoint
- Add unit tests for export service
```

## Documentation

When adding features, update relevant documentation:

- **AGENTS.md** — Project overview, architecture updates
- **contributing/** — Detailed guides (architecture, design system, etc.)
- **.claude/rules/** — Development rules and conventions
- **API docs** — Update Zod schemas in `packages/shared/src/schemas.ts` (auto-generates OpenAPI spec)

## Code of Conduct

We are committed to providing a welcoming and inclusive experience for all contributors. A formal Code of Conduct will be adopted soon. In the meantime, please:

- Be respectful and considerate
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Assume good intentions

## Need Help?

- **Documentation**: Start with [AGENTS.md](AGENTS.md) and [contributing/](contributing/)
- **Issues**: Check existing issues or open a new one
- **Discussions**: Start a discussion for questions or ideas

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

Thank you for contributing to DorkOS! 🎉
