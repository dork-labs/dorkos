# Contributing to DorkOS

Welcome! We're excited that you're interested in contributing to DorkOS. This guide will help you get started with development, testing, and submitting contributions.

DorkOS is a web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK. It provides a chat UI for interacting with Claude Code sessions, with tool approval flows and slash command discovery.

## Prerequisites

Before you begin, ensure you have:

- **Node.js 20+**
- **npm 10+**
- **A Claude API key** (ANTHROPIC_API_KEY) — Get one from [console.anthropic.com](https://console.anthropic.com/)

## Getting Started

```bash
git clone https://github.com/dork-labs/dorkos.git
cd dorkos
npm install
cp .env.example .env  # Add your ANTHROPIC_API_KEY
npm run dev
```

The client will be available at `http://localhost:3000` and the server at `http://localhost:4242`.

## Monorepo Structure

This is a Turborepo monorepo with three apps and four shared packages:

| Directory | Package | Description |
|---|---|---|
| `apps/client` | `@dorkos/client` | React 19 SPA (Vite 6, Tailwind 4, shadcn/ui) |
| `apps/server` | `@dorkos/server` | Express API server |
| `apps/obsidian-plugin` | `@dorkos/obsidian-plugin` | Obsidian sidebar plugin |
| `packages/cli` | `dorkos` | Publishable npm CLI |
| `packages/shared` | `@dorkos/shared` | Zod schemas, shared types |
| `packages/typescript-config` | `@dorkos/typescript-config` | Shared tsconfig presets |
| `packages/test-utils` | `@dorkos/test-utils` | Mock factories, test helpers |

## Development Commands

| Command | Description |
|---|---|
| `npm run dev` | Start server + client dev servers |
| `npm test` | Run all tests (Vitest) |
| `npm test -- --run` | Single test run (no watch mode) |
| `npm run build` | Build all packages |
| `npm run typecheck` | Type-check all packages |
| `npm run lint` | ESLint across all packages |
| `npm run lint -- --fix` | Auto-fix ESLint issues |
| `npm run format` | Prettier format all files |
| `npm run format:check` | Check formatting without writing |

### Filtering Commands

To work on a single package:

```bash
dotenv -- turbo dev --filter=@dorkos/server   # Server only
dotenv -- turbo dev --filter=@dorkos/client   # Client only
dotenv -- turbo build --filter=@dorkos/obsidian-plugin  # Build plugin only
```

### Running Specific Tests

```bash
npx vitest run apps/server/src/services/__tests__/transcript-reader.test.ts
```

## Architecture

DorkOS uses a **hexagonal architecture** with a `Transport` interface that decouples the React client from its backend. Two adapters exist:

- **`HttpTransport`** — Standalone web (HTTP/SSE to Express)
- **`DirectTransport`** — Obsidian plugin (in-process services)

Transport is injected via React Context (`TransportContext`). For deeper details, see [guides/architecture.md](guides/architecture.md).

## Client Architecture

The client uses **Feature-Sliced Design (FSD)** with strict unidirectional layer imports:

```
shared ← entities ← features ← widgets ← app
```

**FSD Layers** (`apps/client/src/layers/`):

- **`shared/`** — Reusable UI primitives, hooks, utilities
- **`entities/`** — Domain-specific hooks (sessions, commands)
- **`features/`** — Feature modules (chat, session list, settings)
- **`widgets/`** — App-level layout components
- **`app/`** — App entry point

**Import rules**: Always import from barrel exports (e.g., `import { ChatPanel } from '@/layers/features/chat'`), never from internal paths.

For details, see [guides/01-project-structure.md](guides/01-project-structure.md) and [.claude/rules/fsd-layers.md](.claude/rules/fsd-layers.md).

## Testing

Tests use **Vitest** with **React Testing Library** for components. Tests live alongside source in `__tests__/` directories.

```bash
npm test                                    # Run all tests
npm test -- --run                           # Single run (no watch)
npx vitest run path/to/test.ts              # Run specific test
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

For more testing patterns, see [.claude/rules/testing.md](.claude/rules/testing.md).

## Code Style

ESLint 9 (flat config) + Prettier enforce code quality. Run before committing:

```bash
npm run lint
npm run format
```

### ESLint Rules

- **Warn-first approach**: Most rules are warnings to avoid blocking development
- **FSD layer enforcement**: Cross-layer imports are hard errors
- **TSDoc**: Enforced on exported functions/classes (warn-first)
- **React Compiler rules**: Bundled with `eslint-plugin-react-hooks` v7 (warnings)

### File Size Limits

- **Components**: 500 lines max
- **Services**: 800 lines max
- **General**: 1000 lines max

See [.claude/rules/file-size.md](.claude/rules/file-size.md) for enforcement details.

## Pull Request Process

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feat/my-feature`)
3. **Make your changes**
4. **Ensure tests pass** (`npm test -- --run`)
5. **Ensure linting is clean** (`npm run lint`)
6. **Ensure formatting is consistent** (`npm run format`)
7. **Open a pull request** with a clear description of your changes

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

- **CLAUDE.md** — Project overview, architecture updates
- **guides/** — Detailed guides (architecture, design system, etc.)
- **.claude/rules/** — Development rules and conventions
- **API docs** — Update Zod schemas in `packages/shared/src/schemas.ts` (auto-generates OpenAPI spec)

## Code of Conduct

We are committed to providing a welcoming and inclusive experience for all contributors. A formal Code of Conduct will be adopted soon. In the meantime, please:

- Be respectful and considerate
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Assume good intentions

## Need Help?

- **Documentation**: Start with [CLAUDE.md](CLAUDE.md) and [guides/](guides/)
- **Issues**: Check existing issues or open a new one
- **Discussions**: Start a discussion for questions or ideas

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

Thank you for contributing to DorkOS! 🎉
