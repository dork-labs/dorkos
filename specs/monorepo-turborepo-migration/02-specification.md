---
slug: monorepo-turborepo-migration
---

# Specification: Turborepo Monorepo Migration

**Status:** Under Review
**Authors:** Claude Code, 2026-02-11
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Migrate LifeOS Gateway from a monolithic single-package structure to a Turborepo monorepo with npm workspaces. The project currently ships three independent build targets (React SPA, Express API, Obsidian plugin) from one `package.json` with shared types inlined. This migration splits them into 6 workspace packages with proper dependency boundaries, build caching, and parallel task execution.

## 2. Background / Problem Statement

The project has outgrown its single-package structure:

- **One `package.json` with 36 dependencies** — React, Express, Obsidian SDK, Zod, TanStack, etc. are all flat. Every `npm install` touches everything.
- **Three independent build targets sharing one config** — `vite build` (client), `tsc -p tsconfig.server.json` (server), and `vite build --config vite.config.obsidian.ts` (plugin) run sequentially in a single `build` script.
- **Deep relative imports across boundaries** — The Obsidian plugin uses `../../server/services/agent-manager` and `../../client/App` to wire up DirectTransport. These fragile paths encode directory structure into business logic.
- **No build caching** — The 11MB Obsidian plugin build (with 4 custom Vite post-processing plugins) runs from scratch every time, even when plugin source hasn't changed.
- **Path alias confusion** — Client uses `@shared/*`, server uses `../../shared/schemas.js` (relative), and plugin uses both patterns depending on whether it's importing from client or server.

The hexagonal architecture (Transport interface with HttpTransport/DirectTransport adapters) already implies package boundaries — this migration makes them explicit.

## 3. Goals

- Split into 6 workspace packages with clear dependency boundaries
- Enable Turborepo build caching and parallel task execution
- Replace deep relative imports with proper package imports
- Each package owns its own dependencies, tsconfig, and build config
- Maintain all existing functionality (SSE streaming, DirectTransport, tool approval, etc.)
- Update all documentation and Claude Code configuration to reflect new structure

## 4. Non-Goals

- Changing the runtime architecture (Express, React 19, Obsidian plugin patterns)
- Adding new features during migration
- CI/CD pipeline changes or remote caching setup
- Switching package managers (staying on npm)
- Extracting a `@lifeos/ui` component library
- Adding TypeScript Project References (Turborepo advises against this)

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|-----------|---------|---------|
| `turbo` | latest | Monorepo task runner (new) |
| `npm` workspaces | built-in | Package linking and dependency management |
| `vite` | ^6.0.0 | Client and plugin builds (existing) |
| `typescript` | ^5.7.0 | Type checking and server compilation (existing) |
| `vitest` | ^2.1.0 | Test runner (existing, needs workspace config) |
| `tailwindcss` | ^4.0.0 | CSS framework (existing, needs `@source` updates) |

No new runtime dependencies. `turbo` is the only new devDependency at the root level.

## 6. Detailed Design

### 6.1 Package Structure

```
lifeos-gateway/
├── apps/
│   ├── client/                     # @lifeos/client
│   │   ├── src/                    # 62 files: components, hooks, stores, lib
│   │   ├── public/
│   │   ├── index.html
│   │   ├── components.json         # shadcn/ui config
│   │   ├── package.json
│   │   ├── tsconfig.json           # extends @lifeos/typescript-config/react
│   │   └── vite.config.ts
│   ├── server/                     # @lifeos/server
│   │   ├── src/                    # 25 files: routes, services, middleware
│   │   ├── package.json
│   │   └── tsconfig.json           # extends @lifeos/typescript-config/node
│   └── obsidian-plugin/            # @lifeos/obsidian-plugin
│       ├── src/                    # 10 files: plugin main, views, components
│       ├── build-plugins/          # 4 custom Vite plugins
│       │   ├── copy-manifest.ts
│       │   ├── fix-dirname-polyfill.ts
│       │   ├── safe-requires.ts
│       │   └── patch-electron-compat.ts
│       ├── manifest.json
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts
├── packages/
│   ├── shared/                     # @lifeos/shared
│   │   ├── src/
│   │   │   ├── schemas.ts          # Zod schemas + OpenAPI metadata
│   │   │   ├── transport.ts        # Transport interface
│   │   │   └── types.ts            # Re-exports from schemas
│   │   ├── package.json            # exports map → .ts source (JIT)
│   │   └── tsconfig.json
│   ├── typescript-config/          # @lifeos/typescript-config
│   │   ├── base.json
│   │   ├── react.json
│   │   ├── node.json
│   │   └── package.json
│   └── test-utils/                 # @lifeos/test-utils
│       ├── src/
│       │   ├── mock-factories.ts
│       │   ├── react-helpers.tsx
│       │   └── sse-helpers.ts
│       ├── package.json
│       └── tsconfig.json
├── guides/                         # Root-level (documents whole system)
├── specs/
├── .claude/                        # Updated for monorepo
├── turbo.json
├── vitest.workspace.ts
├── package.json                    # Root: workspaces + turbo only
├── CLAUDE.md
└── .env
```

### 6.2 Dependency Graph

```
@lifeos/typescript-config (no deps)
         │
@lifeos/shared (zod, @asteasolutions/zod-to-openapi)
    ┌────┼────────────┐
    ▼    ▼            ▼
@lifeos/ @lifeos/   @lifeos/
client   server     test-utils
    │    │
    ▼    ▼
@lifeos/obsidian-plugin
```

### 6.3 Root package.json

```json
{
  "name": "lifeos-gateway",
  "private": true,
  "packageManager": "npm@10.x.x",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test",
    "test:run": "turbo test -- --run",
    "typecheck": "turbo typecheck",
    "dev:legacy": "concurrently \"tsx watch apps/server/src/index.ts\" \"vite --config apps/client/vite.config.ts\""
  },
  "devDependencies": {
    "turbo": "latest",
    "concurrently": "^9.0.0"
  }
}
```

### 6.4 turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"],
      "env": ["NODE_ENV", "VITE_*", "GATEWAY_PORT"]
    },
    "dev": {
      "cache": false,
      "persistent": true,
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"],
      "cache": true
    },
    "test:watch": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "cache": true
    }
  }
}
```

### 6.5 Package Configurations

#### @lifeos/shared (packages/shared/package.json)

```json
{
  "name": "@lifeos/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./schemas": "./src/schemas.ts",
    "./transport": "./src/transport.ts",
    "./types": "./src/types.ts"
  },
  "dependencies": {
    "zod": "^4.3.6",
    "@asteasolutions/zod-to-openapi": "^8.4.0"
  },
  "devDependencies": {
    "@lifeos/typescript-config": "workspace:*",
    "typescript": "^5.7.0"
  }
}
```

Just-in-Time pattern: `exports` point directly to `.ts` source files. Consumers (Vite, tsc) compile on the fly. No build step needed for this package.

#### @lifeos/typescript-config (packages/typescript-config/package.json)

```json
{
  "name": "@lifeos/typescript-config",
  "version": "0.0.0",
  "private": true,
  "files": ["base.json", "react.json", "node.json"]
}
```

**base.json:**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**react.json:**
```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx"
  }
}
```

**node.json:**
```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

#### @lifeos/client (apps/client/package.json)

```json
{
  "name": "@lifeos/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./App": "./src/App.tsx",
    "./stores/app-store": "./src/stores/app-store.ts",
    "./contexts/TransportContext": "./src/contexts/TransportContext.tsx",
    "./lib/direct-transport": "./src/lib/direct-transport.ts",
    "./lib/platform": "./src/lib/platform.ts"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@lifeos/shared": "workspace:*",
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-dropdown-menu": "^2.1.16",
    "@tanstack/react-query": "^5.62.0",
    "@tanstack/react-query-devtools": "^5.91.3",
    "@tanstack/react-virtual": "^3.11.0",
    "clsx": "^2.1.1",
    "lucide-react": "latest",
    "motion": "^12.33.0",
    "nuqs": "^2.8.8",
    "radix-ui": "^1.4.3",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "streamdown": "latest",
    "tailwind-merge": "^3.4.0",
    "uuid": "^10.0.0",
    "vaul": "^1.1.2",
    "zustand": "^5.0.0"
  },
  "devDependencies": {
    "@lifeos/typescript-config": "workspace:*",
    "@lifeos/test-utils": "workspace:*",
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/uuid": "^10.0.0",
    "@vitejs/plugin-react": "latest",
    "@vitest/coverage-v8": "^2.1.9",
    "jsdom": "^28.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "vitest": "^2.1.0"
  }
}
```

**apps/client/tsconfig.json:**
```json
{
  "extends": "@lifeos/typescript-config/react",
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"]
}
```

**apps/client/vite.config.ts** — Key changes from current:
- `resolve.alias`: `@` → `path.resolve(__dirname, './src')` (no more `@shared`)
- `server.proxy`: unchanged (proxies `/api` to Express)
- `build.outDir`: `dist` (relative to package)
- `test` config: `environment: 'jsdom'`

#### @lifeos/server (apps/server/package.json)

```json
{
  "name": "@lifeos/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./services/agent-manager": "./src/services/agent-manager.ts",
    "./services/transcript-reader": "./src/services/transcript-reader.ts",
    "./services/command-registry": "./src/services/command-registry.ts"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "NODE_ENV=production node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@lifeos/shared": "workspace:*",
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@asteasolutions/zod-to-openapi": "^8.4.0",
    "@scalar/express-api-reference": "^0.8.40",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "express": "^4.21.0",
    "gray-matter": "^4.0.3",
    "uuid": "^10.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@lifeos/typescript-config": "workspace:*",
    "@types/cors": "^2.8.0",
    "@types/express": "^5.0.0",
    "@types/uuid": "^10.0.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.2.2",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

**Note:** The `exports` field with `./services/*` allows the Obsidian plugin to import `@lifeos/server/services/agent-manager` etc. This maps to TypeScript source (JIT pattern).

**apps/server/tsconfig.json:**
```json
{
  "extends": "@lifeos/typescript-config/node",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

#### @lifeos/obsidian-plugin (apps/obsidian-plugin/package.json)

```json
{
  "name": "@lifeos/obsidian-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build && mv dist/*.css dist/styles.css",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@lifeos/shared": "workspace:*",
    "@lifeos/server": "workspace:*",
    "@lifeos/client": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@lifeos/typescript-config": "workspace:*",
    "@tailwindcss/vite": "^4.0.0",
    "@vitejs/plugin-react": "latest",
    "obsidian": "latest",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

The plugin's `vite.config.ts` moves the 4 custom build plugins from the root `vite.config.obsidian.ts` into `build-plugins/` as separate modules and imports them.

#### @lifeos/test-utils (packages/test-utils/package.json)

```json
{
  "name": "@lifeos/test-utils",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./mock-factories": "./src/mock-factories.ts",
    "./react-helpers": "./src/react-helpers.tsx",
    "./sse-helpers": "./src/sse-helpers.ts"
  },
  "dependencies": {
    "@lifeos/shared": "workspace:*"
  },
  "devDependencies": {
    "@lifeos/typescript-config": "workspace:*",
    "@testing-library/react": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^5.7.0"
  }
}
```

### 6.6 Import Migration Map

#### Client imports (62 files)

| Current Pattern | New Pattern |
|----------------|-------------|
| `import { X } from '@shared/types'` | `import { X } from '@lifeos/shared/types'` |
| `import { X } from '@shared/transport'` | `import { X } from '@lifeos/shared/transport'` |
| `import { X } from '@shared/schemas'` | `import { X } from '@lifeos/shared/schemas'` |
| `import { X } from '@/components/...'` | `import { X } from '@/components/...'` (unchanged) |

#### Server imports (25 files)

| Current Pattern | New Pattern |
|----------------|-------------|
| `import { X } from '../../shared/schemas.js'` | `import { X } from '@lifeos/shared/schemas'` |
| `import { X } from '../../shared/types.js'` | `import { X } from '@lifeos/shared/types'` |
| Relative service imports | Unchanged (within same package) |

#### Plugin imports (10 files)

| Current Pattern | New Pattern |
|----------------|-------------|
| `import { AgentManager } from '../../server/services/agent-manager'` | `import { AgentManager } from '@lifeos/server/services/agent-manager'` |
| `import { TranscriptReader } from '../../server/services/transcript-reader'` | `import { TranscriptReader } from '@lifeos/server/services/transcript-reader'` |
| `import { CommandRegistryService } from '../../server/services/command-registry'` | `import { CommandRegistryService } from '@lifeos/server/services/command-registry'` |
| `import { App } from '../../client/App'` | `import { App } from '@lifeos/client/App'` |
| `import { useAppStore } from '../../client/stores/app-store'` | `import { useAppStore } from '@lifeos/client/stores/app-store'` |
| `import { TransportProvider } from '../../client/contexts/TransportContext'` | `import { TransportProvider } from '@lifeos/client/contexts/TransportContext'` |
| `import { DirectTransport } from '../../client/lib/direct-transport'` | `import { DirectTransport } from '@lifeos/client/lib/direct-transport'` |
| `import { X } from '@shared/types'` | `import { X } from '@lifeos/shared/types'` |

### 6.7 Vitest Workspace Configuration

**vitest.workspace.ts** (root):
```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/client',
  'apps/server',
  'packages/shared',
]);
```

Each app has its own vitest config in its `vite.config.ts` (client: jsdom) or a standalone `vitest.config.ts` (server: node).

### 6.8 Tailwind CSS Configuration

Only `apps/client` uses Tailwind. The `@source` directive in `apps/client/src/index.css` must be updated:

```css
@import "tailwindcss";
@source "../node_modules/streamdown/dist/*.js";
```

The streamdown `@source` directive is **critical** — it ensures the `streamdown` library's Tailwind classes are included in the CSS output for markdown rendering. The path changes from `../node_modules/streamdown/dist/*.js` (relative to `src/client/`) to the same pattern relative to `apps/client/src/`.

If shared components are added later from other packages, add:
```css
@source "../../packages/shared/src";
```

### 6.9 Server `__dirname` Resolution Updates

Five server files use `__dirname` with relative path resolution that must change:

| File | Current Resolution | New Resolution | Purpose |
|------|-------------------|----------------|---------|
| `app.ts` | `path.join(__dirname, '../../dist')` | `path.join(__dirname, '../../client/dist')` | Static file serving (production) |
| `index.ts` | `path.join(__dirname, '../../.env')` | `path.join(__dirname, '../../../.env')` | .env file loading |
| `services/agent-manager.ts` | `path.resolve(__dirname, '../../../../')` | `path.resolve(__dirname, '../../../../')` | SDK working directory (vault root) |
| `routes/sessions.ts` | `path.resolve(__dirname, '../../../../')` | `path.resolve(__dirname, '../../../../')` | Vault root |
| `routes/commands.ts` | `path.resolve(__dirname, '../../../../')` | `path.resolve(__dirname, '../../../../')` | Vault root for .claude/commands |

**Note:** Files resolving to vault root (`../../../../`) remain the same depth because: current = `dist-server/server/services/` (3 levels from root) → new = `apps/server/dist/services/` (still 4 levels from monorepo root, matching compiled output). The `.env` and static serving paths change because they reference sibling files/directories.

All files use the ESM pattern: `const __dirname = path.dirname(fileURLToPath(import.meta.url));`

### 6.10 Obsidian Plugin Build Plugins

The 4 custom Vite plugins move from root `vite.config.obsidian.ts` into modular files:

```
apps/obsidian-plugin/build-plugins/
├── copy-manifest.ts       # Copies manifest.json to dist/
├── fix-dirname-polyfill.ts # Patches Vite's __dirname for Electron
├── safe-requires.ts       # Wraps optional require() calls
└── patch-electron-compat.ts # Patches spawn() + setMaxListeners()
```

Each exports a function returning a Vite `Plugin`. The plugin's `vite.config.ts` imports and uses them:

```typescript
import { copyManifest } from './build-plugins/copy-manifest';
import { fixDirnamePolyfill } from './build-plugins/fix-dirname-polyfill';
import { safeRequires } from './build-plugins/safe-requires';
import { patchElectronCompat } from './build-plugins/patch-electron-compat';
```

Path references within these plugins change from `path.resolve(__dirname, 'dist-obsidian/...')` to `path.resolve(__dirname, 'dist/...')` since output is now `dist/` relative to the plugin package.

## 7. User Experience

No user-facing changes. The web UI, API endpoints, and Obsidian plugin all behave identically after migration.

Developer experience improves:
- `turbo dev` replaces `concurrently` for dev mode
- `turbo build` with caching skips unchanged packages
- Clear package boundaries make it obvious where code belongs

## 8. Testing Strategy

### Existing Tests (must pass after migration)

All 30 existing test files continue to work:
- **Server tests** (9 files): Route tests with supertest, service unit tests with mocked `fs/promises`
- **Client tests** (10+ files): Component tests with React Testing Library, hook tests with mock Transport injection
- **No plugin tests** currently exist (unchanged)

### Migration Verification Tests

After each phase, verify:
1. `turbo test` — all tests pass
2. `turbo build` — all 3 build targets produce output
3. `turbo dev` — dev servers start and HMR works
4. Manual: Obsidian plugin loads and creates sessions

### Import Verification

After Phase 5, run a grep to confirm no deep relative imports remain:

```bash
# Should return zero results
grep -r "from '\.\./\.\./server/" apps/
grep -r "from '\.\./\.\./client/" apps/
grep -r "from '@shared/" apps/
```

## 9. Performance Considerations

- **Build time improvement**: Turborepo caching means unchanged packages skip entirely. Client and server build in parallel (both depend only on shared).
- **Install time**: npm workspaces hoist shared dependencies, reducing total install size.
- **Dev startup**: `turbo dev` runs all dev tasks in parallel with proper dependency ordering — shared compiles first (if needed), then client+server in parallel.
- **Obsidian plugin build**: The most expensive build (11MB output, 4 post-processing plugins) benefits most from caching.

## 10. Security Considerations

No security implications. All packages are private (`"private": true`). No new network access, authentication, or data handling.

## 11. Documentation Updates

### CLAUDE.md (complete rewrite of key sections)

| Section | Changes |
|---------|---------|
| Commands | `npm run dev` → `turbo dev`, `npm run build` → `turbo build`, etc. |
| Architecture | New directory structure, package descriptions |
| Path Aliases | `@/*` scoped per-app, `@shared/*` → `@lifeos/shared/*` |
| Server section | `apps/server/src/` paths |
| Client section | `apps/client/src/` paths |
| Plugin section | `apps/obsidian-plugin/src/` paths, build-plugins/ |
| Shared section | `packages/shared/src/` paths, JIT exports |
| Testing | Vitest workspace, per-package configs |
| Vault Root Resolution | Updated `__dirname` resolution paths |

### Guide Files (5 files)

| Guide | Key Changes |
|-------|------------|
| `guides/architecture.md` | Module layout diagram, source paths, build commands, data flow |
| `guides/design-system.md` | Component file path references |
| `guides/obsidian-plugin-development.md` | Build config, Vite plugin paths, plugin file structure |
| `guides/api-reference.md` | Server file paths, schema import patterns |
| `guides/interactive-tools.md` | Component path references |

### .claude/ Configuration

| Category | Files | Changes |
|----------|-------|---------|
| Rules | `api.md`, `dal.md`, `testing.md` | Update glob patterns (`src/server/` → `apps/server/src/`, etc.). **Note:** `api.md` currently has `paths: src/app/api/**/*.ts` which is incorrect (Next.js convention) — fix to `apps/server/src/routes/**/*.ts` |
| Commands | `dev/scaffold.md` | Update scaffold target paths |
| Commands | `git/commit.md`, `git/push.md` | Update build/test commands to turbo |
| Commands | `app/cleanup.md`, `app/upgrade.md` | Update dependency management for workspaces |
| Commands | `spec/execute.md` | Update file path patterns |
| Commands | `docs/reconcile.md` | Update guide file references |
| Skills | `organizing-fsd-architecture/` | Update to monorepo structure |
| Skills | `styling-with-tailwind-shadcn/` | Update Tailwind config paths |
| Hooks | `typecheck-changed.sh` | Update tsconfig references |
| Hooks | `test-changed.sh` | Update test paths |
| Hooks | `file-guard.mjs` | Update allowed file paths |

## 12. Implementation Phases

### Phase 1: Add Turborepo to Existing Structure

**Files created:**
- `turbo.json`

**Files modified:**
- `package.json` — add `turbo` devDependency, `packageManager` field, update scripts to delegate to turbo

**Verification:** `turbo build` and `turbo dev` produce same results as current `npm run build` / `npm run dev`.

### Phase 2: Extract Shared Package + TypeScript Config

**Files created:**
- `packages/shared/package.json`
- `packages/shared/tsconfig.json`
- `packages/typescript-config/package.json`
- `packages/typescript-config/base.json`
- `packages/typescript-config/react.json`
- `packages/typescript-config/node.json`

**Files moved:**
- `src/shared/schemas.ts` → `packages/shared/src/schemas.ts`
- `src/shared/transport.ts` → `packages/shared/src/transport.ts`
- `src/shared/types.ts` → `packages/shared/src/types.ts`

**Files modified:**
- `package.json` — add `"workspaces": ["packages/*"]`
- All client files importing `@shared/*` → `@lifeos/shared/*` (~25 files)
- All server files importing `../../shared/*` → `@lifeos/shared/*` (~8 files)

**Verification:** `turbo test` passes, `turbo build` succeeds.

### Phase 3: Extract Client App

**Files created:**
- `apps/client/package.json`
- `apps/client/tsconfig.json`
- `apps/client/vite.config.ts`

**Files moved:**
- `src/client/**/*` → `apps/client/src/**/*` (62 files)
- `index.html` → `apps/client/index.html`
- `public/` → `apps/client/public/`
- `components.json` → `apps/client/components.json`

**Files modified:**
- Root `package.json` — update workspaces to `["apps/*", "packages/*"]`, move client deps to `apps/client/package.json`
- `apps/client/vite.config.ts` — update `@` alias to `./src`, remove `@shared` alias
- `apps/client/src/index.css` — update `@source` directive if needed

**Verification:** HMR works, `turbo build` produces client dist, proxy to server works.

### Phase 4: Extract Server App

**Files created:**
- `apps/server/package.json`
- `apps/server/tsconfig.json`

**Files moved:**
- `src/server/**/*` → `apps/server/src/**/*` (25 files)

**Files modified:**
- Root `package.json` — move server deps to `apps/server/package.json`
- `apps/server/src/app.ts` or `index.ts` — update static file serving path for production

**Verification:** `turbo dev` starts Express on port 6942, API endpoints respond, SSE streaming works.

### Phase 5: Extract Obsidian Plugin

**Files created:**
- `apps/obsidian-plugin/package.json`
- `apps/obsidian-plugin/tsconfig.json`
- `apps/obsidian-plugin/vite.config.ts`
- `apps/obsidian-plugin/build-plugins/copy-manifest.ts`
- `apps/obsidian-plugin/build-plugins/fix-dirname-polyfill.ts`
- `apps/obsidian-plugin/build-plugins/safe-requires.ts`
- `apps/obsidian-plugin/build-plugins/patch-electron-compat.ts`

**Files moved:**
- `src/plugin/**/*` → `apps/obsidian-plugin/src/**/*` (10 files)
- `manifest.json` → `apps/obsidian-plugin/manifest.json`

**Files modified:**
- All plugin files with `../../server/` imports → `@lifeos/server/...` (~3 files)
- All plugin files with `../../client/` imports → `@lifeos/client/...` (~5 files)

**Files deleted:**
- `vite.config.obsidian.ts` (root) — logic moves to `apps/obsidian-plugin/vite.config.ts`

**Verification:** Plugin builds, `main.js` + `styles.css` + `manifest.json` in output, loads in Obsidian.

### Phase 6: Extract Test Utils & Configure Vitest

**Files created:**
- `packages/test-utils/package.json`
- `packages/test-utils/tsconfig.json`
- `packages/test-utils/src/index.ts`
- `vitest.workspace.ts` (root)

**Files moved:**
- `src/test-utils/**/*` → `packages/test-utils/src/**/*` (3 files)

**Files modified:**
- Client test files importing from `../../test-utils/` → `@lifeos/test-utils/...`
- `apps/client/vite.config.ts` — vitest config for jsdom
- `apps/server/` — add vitest config for node environment

**Files deleted:**
- Root `vite.config.ts` — test config moves to per-package, build config moves to `apps/client/vite.config.ts`
- `tsconfig.server.json` — replaced by `apps/server/tsconfig.json`
- `src/` directory (should be empty after all moves)

**Verification:** `turbo test` runs all tests across workspaces, coverage works.

### Phase 7: Update Documentation & Claude Code

**Files modified:**
- `CLAUDE.md` — complete update of architecture, commands, paths
- `guides/architecture.md` — module layout, paths, build commands
- `guides/design-system.md` — component path references
- `guides/obsidian-plugin-development.md` — build config, file structure
- `guides/api-reference.md` — server paths, schema imports
- `guides/interactive-tools.md` — component paths
- `.claude/rules/api.md` — glob patterns
- `.claude/rules/dal.md` — glob patterns
- `.claude/rules/testing.md` — glob patterns
- `.claude/commands/dev/scaffold.md` — scaffold paths
- `.claude/commands/git/commit.md` — build commands
- `.claude/commands/git/push.md` — build commands
- `.claude/commands/app/cleanup.md` — dependency management
- `.claude/commands/app/upgrade.md` — dependency management
- `.claude/scripts/hooks/file-guard.mjs` — allowed paths
- `.claude/scripts/hooks/typecheck-changed.sh` — tsconfig references
- `.claude/scripts/hooks/test-changed.sh` — test paths

**Verification:** All commands run without path errors, hooks trigger correctly.

## 13. Open Questions (Resolved)

1. **`@lifeos/client` and `@lifeos/server` exports for plugin** — **Resolved: Use explicit entries.**
   The plugin imports 3 server modules (`agent-manager`, `transcript-reader`, `command-registry`) and 5 client modules (`App`, `app-store`, `TransportContext`, `direct-transport`, `platform`). Use explicit exports rather than wildcards for type safety and clarity:
   - Server: `"./services/agent-manager"`, `"./services/transcript-reader"`, `"./services/command-registry"`
   - Client: `"./App"`, `"./stores/app-store"`, `"./contexts/TransportContext"`, `"./lib/direct-transport"`, `"./lib/platform"`

2. **Server production build path resolution** — **Resolved: Works via Node module resolution.**
   The server currently uses relative imports with `.js` extensions (`../../shared/types.js`) and `tsconfig.server.json` includes `src/shared/**/*`. After migration, `@lifeos/shared` becomes a workspace dependency resolved via Node module resolution. Since the JIT pattern exports `.ts` source, `tsc` resolves it through `node_modules/@lifeos/shared` → workspace symlink → `packages/shared/src/*.ts`. No additional `paths` config needed.

3. **Obsidian plugin dev workflow** — **Resolved: Keep separate from `turbo dev`.**
   Currently `dev:obsidian` runs separately from `npm run dev`. Maintain this pattern: `turbo dev` runs client + server only (the common workflow). The plugin's `dev` script (`vite build --watch`) runs independently via `turbo dev --filter=@lifeos/obsidian-plugin` or directly in the plugin directory. This avoids starting the plugin watcher when doing web-only development.

## 14. References

- [Turborepo: Structuring a Repository](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository)
- [Turborepo: Internal Packages (JIT pattern)](https://turborepo.dev/docs/core-concepts/internal-packages)
- [Turborepo: You Might Not Need TypeScript Project References](https://turborepo.dev/blog/you-might-not-need-typescript-project-references)
- [Turborepo: Managing Dependencies](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies)
- [Vite TypeScript Monorepo RFC](https://github.com/vitejs/vite-ts-monorepo-rfc)
- [Ideation Document](./01-ideation.md)
