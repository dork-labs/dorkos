---
slug: monorepo-turborepo-migration
last_decompose: 2026-02-11
---

# Tasks: Turborepo Monorepo Migration

## Overview

This document breaks the Turborepo monorepo migration specification into 16 actionable tasks across 7 phases. Each task is self-contained with full implementation details, acceptance criteria, and verification steps.

---

## Phase 1: Add Turborepo to Existing Structure

### Task 1.1: Install Turborepo and create turbo.json configuration

**Objective:** Add Turborepo as the monorepo task runner on top of the existing project structure without changing any source code.

**Implementation:**

1. Install turbo as a root devDependency:
```bash
npm install --save-dev turbo
```

2. Create `turbo.json` at the project root:
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

3. Update root `package.json` scripts to delegate to turbo (keep old scripts as `*:legacy`):
```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test",
    "test:run": "turbo test -- --run",
    "typecheck": "turbo typecheck",
    "dev:legacy": "concurrently \"tsx watch src/server/index.ts\" \"vite\""
  }
}
```

4. Add `packageManager` field to root `package.json`:
```json
{
  "packageManager": "npm@10.x.x"
}
```

5. Add `.turbo/` to `.gitignore`.

**Acceptance Criteria:**
- `turbo.json` exists with correct schema and task definitions
- `turbo` is listed in root `devDependencies`
- `turbo build` runs the existing build successfully
- `turbo dev` starts dev servers as before
- `.turbo/` is gitignored
- Legacy scripts still work via `npm run dev:legacy`

---

## Phase 2: Extract Shared Package + TypeScript Config

### Task 2.1: Create @lifeos/typescript-config package

**Objective:** Create a shared TypeScript configuration package with base, react, and node presets.

**Implementation:**

1. Create directory `packages/typescript-config/`.

2. Create `packages/typescript-config/package.json`:
```json
{
  "name": "@lifeos/typescript-config",
  "version": "0.0.0",
  "private": true,
  "files": ["base.json", "react.json", "node.json"]
}
```

3. Create `packages/typescript-config/base.json`:
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

4. Create `packages/typescript-config/react.json`:
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

5. Create `packages/typescript-config/node.json`:
```json
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

6. Add `"workspaces": ["packages/*"]` to root `package.json` (will be expanded to `["apps/*", "packages/*"]` in Phase 3).

7. Run `npm install` to link the workspace.

**Acceptance Criteria:**
- `packages/typescript-config/` exists with `package.json`, `base.json`, `react.json`, `node.json`
- `npm ls @lifeos/typescript-config` resolves the workspace package
- Each config file contains the correct compiler options as specified
- The base config has `target: ES2022`, `strict: true`, `declaration: true`, etc.
- The react config extends base and adds `jsx: react-jsx`, `moduleResolution: bundler`
- The node config extends base and adds `module: NodeNext`, `moduleResolution: NodeNext`

---

### Task 2.2: Create @lifeos/shared package and migrate shared source files

**Objective:** Extract `src/shared/` into a standalone workspace package using the JIT (Just-in-Time) pattern where exports point to TypeScript source directly.

**Implementation:**

1. Create directory `packages/shared/src/`.

2. Create `packages/shared/package.json`:
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

3. Create `packages/shared/tsconfig.json`:
```json
{
  "extends": "@lifeos/typescript-config/base",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler"
  },
  "include": ["src/**/*"]
}
```

4. Move files:
   - `src/shared/schemas.ts` -> `packages/shared/src/schemas.ts`
   - `src/shared/transport.ts` -> `packages/shared/src/transport.ts`
   - `src/shared/types.ts` -> `packages/shared/src/types.ts`

5. Run `npm install` to link the workspace.

**Acceptance Criteria:**
- `packages/shared/src/` contains `schemas.ts`, `transport.ts`, `types.ts`
- `package.json` exports map points to `.ts` source files (JIT pattern)
- `npm ls @lifeos/shared` resolves the workspace package
- `@lifeos/shared` depends on `zod` and `@asteasolutions/zod-to-openapi`
- No build step is needed for this package (consumers compile on the fly)
- TypeScript compiles without errors: `npx tsc --noEmit -p packages/shared/tsconfig.json`

---

### Task 2.3: Update all imports from @shared/* and ../../shared/* to @lifeos/shared/*

**Objective:** Replace all existing imports referencing the old shared location with the new `@lifeos/shared/*` package imports.

**Implementation:**

1. Update all **client** files (~25 files) that use `@shared/*`:
   - `import { X } from '@shared/types'` -> `import { X } from '@lifeos/shared/types'`
   - `import { X } from '@shared/transport'` -> `import { X } from '@lifeos/shared/transport'`
   - `import { X } from '@shared/schemas'` -> `import { X } from '@lifeos/shared/schemas'`

2. Update all **server** files (~8 files) that use relative `../../shared/*`:
   - `import { X } from '../../shared/schemas.js'` -> `import { X } from '@lifeos/shared/schemas'`
   - `import { X } from '../../shared/types.js'` -> `import { X } from '@lifeos/shared/types'`

3. Update any **plugin** files that use `@shared/*`:
   - `import { X } from '@shared/types'` -> `import { X } from '@lifeos/shared/types'`

4. Remove the `@shared` path alias from `vite.config.ts` and `tsconfig.json` if present (the `@` alias for client-internal imports stays).

5. Add `@lifeos/shared` as a workspace dependency in the root `package.json` (temporary, until client/server are extracted).

**Acceptance Criteria:**
- Zero files import from `@shared/*` (verify with `grep -r "from '@shared/" src/`)
- Zero files import from `../../shared/` (verify with `grep -r "from '../../shared/" src/`)
- All imports use `@lifeos/shared/schemas`, `@lifeos/shared/transport`, or `@lifeos/shared/types`
- `turbo build` succeeds
- `turbo test` passes all existing tests
- TypeScript compiles without errors

---

## Phase 3: Extract Client App

### Task 3.1: Create @lifeos/client package and move client source files

**Objective:** Move `src/client/` into `apps/client/` as a standalone workspace package with its own Vite and TypeScript configuration.

**Implementation:**

1. Create directory structure: `apps/client/src/`, `apps/client/public/`.

2. Create `apps/client/package.json`:
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

3. Create `apps/client/tsconfig.json`:
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

4. Create `apps/client/vite.config.ts` based on existing root `vite.config.ts`:
   - `resolve.alias`: `@` -> `path.resolve(__dirname, './src')` (remove `@shared` alias)
   - `server.proxy`: unchanged (proxies `/api` to Express)
   - `build.outDir`: `dist` (relative to package)
   - `test` config: `environment: 'jsdom'`, `globals: true`, `setupFiles`

5. Move files:
   - `src/client/**/*` -> `apps/client/src/**/*` (all 62 files)
   - `index.html` -> `apps/client/index.html`
   - `public/` -> `apps/client/public/`
   - `components.json` -> `apps/client/components.json`

6. Update `apps/client/src/index.css` `@source` directive:
```css
@import "tailwindcss";
@source "../node_modules/streamdown/dist/*.js";
```

7. Update root `package.json` workspaces to `["apps/*", "packages/*"]`.

8. Remove client-specific dependencies from root `package.json`.

9. Run `npm install` to relink.

**Acceptance Criteria:**
- `apps/client/` contains all 62 client source files, `index.html`, `public/`, `components.json`
- `apps/client/package.json` lists all client dependencies
- `vite` dev server starts from `apps/client/`: `cd apps/client && npx vite`
- HMR works correctly
- `@/` path alias resolves within client source
- `@lifeos/shared/*` imports resolve
- `turbo build` produces client dist in `apps/client/dist/`
- The `@source` directive in `index.css` correctly includes streamdown classes
- `src/client/` directory is empty/removed

---

## Phase 4: Extract Server App

### Task 4.1: Create @lifeos/server package and move server source files

**Objective:** Move `src/server/` into `apps/server/` as a standalone workspace package with its own TypeScript configuration and exports for the Obsidian plugin.

**Implementation:**

1. Create directory: `apps/server/src/`.

2. Create `apps/server/package.json`:
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

3. Create `apps/server/tsconfig.json`:
```json
{
  "extends": "@lifeos/typescript-config/node",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"]
}
```

4. Move files:
   - `src/server/**/*` -> `apps/server/src/**/*` (all 25 files)

5. Update `__dirname` resolution paths in server files:
   - `app.ts`: `path.join(__dirname, '../../dist')` -> `path.join(__dirname, '../../client/dist')` (production static serving)
   - `index.ts`: `path.join(__dirname, '../../.env')` -> `path.join(__dirname, '../../../.env')` (.env loading)
   - `services/agent-manager.ts`: vault root resolution stays `path.resolve(__dirname, '../../../../')` (same depth in compiled output)
   - `routes/sessions.ts`: vault root stays same
   - `routes/commands.ts`: vault root stays same

6. Remove server-specific dependencies from root `package.json`.

7. Run `npm install` to relink.

**Acceptance Criteria:**
- `apps/server/` contains all 25 server source files
- `apps/server/package.json` lists all server dependencies
- Exports field exposes 3 service modules for the Obsidian plugin
- `tsx watch apps/server/src/index.ts` starts Express on port 6942
- API endpoints respond correctly
- SSE streaming works
- `__dirname` paths resolve correctly for: .env loading, static file serving, vault root
- `turbo dev` starts both client and server
- `turbo build` compiles server with `tsc`
- `src/server/` directory is empty/removed

---

## Phase 5: Extract Obsidian Plugin

### Task 5.1: Create @lifeos/obsidian-plugin package structure

**Objective:** Create the Obsidian plugin workspace package with its own Vite config and modular build plugins.

**Implementation:**

1. Create directories: `apps/obsidian-plugin/src/`, `apps/obsidian-plugin/build-plugins/`.

2. Create `apps/obsidian-plugin/package.json`:
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

3. Create `apps/obsidian-plugin/tsconfig.json`:
```json
{
  "extends": "@lifeos/typescript-config/react",
  "compilerOptions": {
    "paths": {
      "@/*": ["../../apps/client/src/*"]
    }
  },
  "include": ["src/**/*"]
}
```

4. Extract the 4 custom Vite build plugins from root `vite.config.obsidian.ts` into separate module files:
   - `apps/obsidian-plugin/build-plugins/copy-manifest.ts` - Copies `manifest.json` to dist
   - `apps/obsidian-plugin/build-plugins/fix-dirname-polyfill.ts` - Patches Vite's `__dirname` for Electron
   - `apps/obsidian-plugin/build-plugins/safe-requires.ts` - Wraps optional `require()` calls
   - `apps/obsidian-plugin/build-plugins/patch-electron-compat.ts` - Patches `spawn()` + `setMaxListeners()`

   Each file exports a function returning a Vite `Plugin` object.

5. Create `apps/obsidian-plugin/vite.config.ts` that imports and uses the build plugins:
```typescript
import { copyManifest } from './build-plugins/copy-manifest';
import { fixDirnamePolyfill } from './build-plugins/fix-dirname-polyfill';
import { safeRequires } from './build-plugins/safe-requires';
import { patchElectronCompat } from './build-plugins/patch-electron-compat';
```
   - Update output paths from `dist-obsidian/` to `dist/` (relative to plugin package)

**Acceptance Criteria:**
- `apps/obsidian-plugin/` has `package.json`, `tsconfig.json`, `vite.config.ts`
- `build-plugins/` contains 4 separate plugin modules
- Each build plugin exports a named function returning a Vite `Plugin`
- `vite.config.ts` imports all 4 build plugins

---

### Task 5.2: Move plugin source files and update imports

**Objective:** Move all Obsidian plugin source files and update their imports to use workspace package references instead of deep relative paths.

**Implementation:**

1. Move files:
   - `src/plugin/**/*` -> `apps/obsidian-plugin/src/**/*` (10 files)
   - `manifest.json` -> `apps/obsidian-plugin/manifest.json`

2. Update server imports in plugin files (~3 files):
   - `import { AgentManager } from '../../server/services/agent-manager'` -> `import { AgentManager } from '@lifeos/server/services/agent-manager'`
   - `import { TranscriptReader } from '../../server/services/transcript-reader'` -> `import { TranscriptReader } from '@lifeos/server/services/transcript-reader'`
   - `import { CommandRegistryService } from '../../server/services/command-registry'` -> `import { CommandRegistryService } from '@lifeos/server/services/command-registry'`

3. Update client imports in plugin files (~5 files):
   - `import { App } from '../../client/App'` -> `import { App } from '@lifeos/client/App'`
   - `import { useAppStore } from '../../client/stores/app-store'` -> `import { useAppStore } from '@lifeos/client/stores/app-store'`
   - `import { TransportProvider } from '../../client/contexts/TransportContext'` -> `import { TransportProvider } from '@lifeos/client/contexts/TransportContext'`
   - `import { DirectTransport } from '../../client/lib/direct-transport'` -> `import { DirectTransport } from '@lifeos/client/lib/direct-transport'`
   - `import { X } from '@shared/types'` -> `import { X } from '@lifeos/shared/types'`

4. Delete root `vite.config.obsidian.ts` (logic is now in `apps/obsidian-plugin/vite.config.ts` and `build-plugins/`).

5. Run `npm install` to relink.

**Acceptance Criteria:**
- `apps/obsidian-plugin/src/` contains all 10 plugin source files
- `manifest.json` is in `apps/obsidian-plugin/`
- Zero imports use `../../server/` (verify: `grep -r "from '../../server/" apps/obsidian-plugin/`)
- Zero imports use `../../client/` (verify: `grep -r "from '../../client/" apps/obsidian-plugin/`)
- Zero imports use `@shared/` (verify: `grep -r "from '@shared/" apps/obsidian-plugin/`)
- Plugin builds successfully: `cd apps/obsidian-plugin && npx vite build`
- Build output contains `main.js`, `styles.css`, `manifest.json` in `apps/obsidian-plugin/dist/`
- Root `vite.config.obsidian.ts` is deleted
- `turbo build` succeeds for all packages

---

## Phase 6: Extract Test Utils & Configure Vitest

### Task 6.1: Create @lifeos/test-utils package

**Objective:** Extract shared test utilities into a dedicated workspace package.

**Implementation:**

1. Create directory: `packages/test-utils/src/`.

2. Create `packages/test-utils/package.json`:
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

3. Create `packages/test-utils/tsconfig.json`:
```json
{
  "extends": "@lifeos/typescript-config/react",
  "include": ["src/**/*"]
}
```

4. Create `packages/test-utils/src/index.ts` that re-exports from all modules:
```typescript
export * from './mock-factories';
export * from './react-helpers';
export * from './sse-helpers';
```

5. Move files:
   - `src/test-utils/mock-factories.ts` -> `packages/test-utils/src/mock-factories.ts`
   - `src/test-utils/react-helpers.tsx` -> `packages/test-utils/src/react-helpers.tsx`
   - `src/test-utils/sse-helpers.ts` -> `packages/test-utils/src/sse-helpers.ts`

6. Update all client test files that import from test-utils:
   - `import { X } from '../../test-utils/...'` -> `import { X } from '@lifeos/test-utils/...'`

7. Run `npm install` to relink.

**Acceptance Criteria:**
- `packages/test-utils/src/` contains `index.ts`, `mock-factories.ts`, `react-helpers.tsx`, `sse-helpers.ts`
- `package.json` exports map provides individual and barrel imports
- All test files import from `@lifeos/test-utils/*` not relative paths
- `npm ls @lifeos/test-utils` resolves correctly

---

### Task 6.2: Configure Vitest workspace and per-package test configs

**Objective:** Set up Vitest workspace configuration so `turbo test` runs tests across all packages with correct environments.

**Implementation:**

1. Create `vitest.workspace.ts` at the project root:
```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/client',
  'apps/server',
  'packages/shared',
]);
```

2. Ensure `apps/client/vite.config.ts` includes vitest config:
```typescript
export default defineConfig({
  // ... existing vite config
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'], // if exists
  },
});
```

3. Create or update `apps/server/vitest.config.ts` if needed:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
});
```

4. Clean up old configuration:
   - Delete root `vite.config.ts` if it only contained test config (build moved to client, tests moved to per-package)
   - Delete `tsconfig.server.json` (replaced by `apps/server/tsconfig.json`)
   - Verify `src/` directory is empty and remove it

**Acceptance Criteria:**
- `vitest.workspace.ts` exists at root with correct workspace paths
- Client tests run with `jsdom` environment
- Server tests run with `node` environment
- `turbo test` executes tests across all workspaces and all pass
- `npx vitest run` from root uses workspace config
- Coverage reports work: `turbo test -- --coverage`
- Root `vite.config.ts` is removed (if only test config)
- `tsconfig.server.json` is removed
- `src/` directory is removed (empty)

---

## Phase 7: Update Documentation & Claude Code Configuration

### Task 7.1: Update CLAUDE.md for monorepo structure

**Objective:** Rewrite key sections of CLAUDE.md to reflect the new monorepo structure, commands, paths, and architecture.

**Implementation:**

Update the following sections:

1. **Commands section** - Replace all commands:
   - `npm run dev` -> `turbo dev` (starts Express + Vite in parallel)
   - `npm run dev:server` -> `turbo dev --filter=@lifeos/server`
   - `npm run dev:client` -> `turbo dev --filter=@lifeos/client`
   - `npm run test` -> `turbo test`
   - `npm run test:run` -> `turbo test -- --run`
   - `npm run build` -> `turbo build`
   - `npm start` -> `cd apps/server && npm start`
   - Obsidian build: `turbo build --filter=@lifeos/obsidian-plugin`
   - Single test file: `npx vitest run apps/server/src/services/__tests__/transcript-reader.test.ts`

2. **Architecture section** - Update directory structure to show:
   - `apps/client/`, `apps/server/`, `apps/obsidian-plugin/`
   - `packages/shared/`, `packages/typescript-config/`, `packages/test-utils/`
   - New root files: `turbo.json`, `vitest.workspace.ts`

3. **Server section** - Update all paths from `src/server/` to `apps/server/src/`

4. **Client section** - Update all paths from `src/client/` to `apps/client/src/`

5. **Shared section** - Document JIT exports pattern, `packages/shared/src/`

6. **Plugin section** - Update paths, document `build-plugins/` directory

7. **Path Aliases section**:
   - `@/*` -> scoped per-app (client only)
   - `@shared/*` -> replaced by `@lifeos/shared/*`

8. **Testing section** - Document vitest workspace, per-package configs

9. **Vault Root Resolution** - Update `__dirname` resolution table

**Acceptance Criteria:**
- All command examples in CLAUDE.md work correctly when executed
- All file paths referenced in CLAUDE.md exist in the new structure
- Architecture section accurately describes the monorepo layout
- No references to old paths (`src/client/`, `src/server/`, `src/shared/`, `@shared/`)

---

### Task 7.2: Update guide documentation files

**Objective:** Update all 5 guide files to reflect new monorepo paths, build commands, and structure.

**Implementation:**

1. **`guides/architecture.md`**:
   - Update module layout diagram to show `apps/` and `packages/` structure
   - Update source paths throughout
   - Update build command references to turbo
   - Update data flow diagrams if they reference file paths
   - Update import examples to use `@lifeos/shared/*`, `@lifeos/server/*`, `@lifeos/client/*`

2. **`guides/design-system.md`**:
   - Update component file path references from `src/client/components/` to `apps/client/src/components/`
   - Update any import examples

3. **`guides/obsidian-plugin-development.md`**:
   - Update build config section for new `apps/obsidian-plugin/vite.config.ts`
   - Document `build-plugins/` directory with 4 modular plugin files
   - Update plugin file structure
   - Update build commands
   - Update import examples to use workspace packages

4. **`guides/api-reference.md`**:
   - Update server file paths from `src/server/` to `apps/server/src/`
   - Update schema import patterns to use `@lifeos/shared/schemas`

5. **`guides/interactive-tools.md`**:
   - Update component path references from `src/client/` to `apps/client/src/`

**Acceptance Criteria:**
- All 5 guide files reference correct monorepo paths
- No remaining references to old paths (`src/client/`, `src/server/`, `src/shared/`)
- Build command references use turbo
- Import examples use `@lifeos/shared/*` package imports

---

### Task 7.3: Update .claude/ rules, commands, and hooks

**Objective:** Update all Claude Code configuration files (.claude/ directory) to use monorepo paths and turbo commands.

**Implementation:**

1. **Rules** (glob patterns):
   - `.claude/rules/api.md`: Update `paths: src/app/api/**/*.ts` -> `paths: apps/server/src/routes/**/*.ts` (also fixes incorrect Next.js convention)
   - `.claude/rules/dal.md`: Update glob patterns from `src/server/` to `apps/server/src/`
   - `.claude/rules/testing.md`: Update glob patterns for test file locations

2. **Commands** (file paths and build commands):
   - `.claude/commands/dev/scaffold.md`: Update scaffold target paths to monorepo structure
   - `.claude/commands/git/commit.md`: Update build/test commands to use turbo
   - `.claude/commands/git/push.md`: Update build/test commands to use turbo
   - `.claude/commands/app/cleanup.md`: Update dependency management for workspaces (npm workspace commands)
   - `.claude/commands/app/upgrade.md`: Update dependency management for workspaces
   - `.claude/commands/spec/execute.md`: Update file path patterns
   - `.claude/commands/docs/reconcile.md`: Update guide file references

3. **Hooks** (scripts):
   - `.claude/scripts/hooks/typecheck-changed.sh`: Update tsconfig references to per-package tsconfigs
   - `.claude/scripts/hooks/test-changed.sh`: Update test paths to new locations
   - `.claude/scripts/hooks/file-guard.mjs`: Update allowed file paths to match monorepo structure

**Acceptance Criteria:**
- All `.claude/rules/*.md` files use correct monorepo glob patterns
- All `.claude/commands/*.md` files reference correct paths and use turbo commands
- All hook scripts work with the new directory structure
- `api.md` no longer has the incorrect Next.js path pattern
- Running hooks manually produces correct results (e.g., typecheck hook finds the right tsconfig)

---

### Task 7.4: Final verification and cleanup

**Objective:** Run comprehensive verification to ensure the migration is complete and no remnants of the old structure remain.

**Implementation:**

1. Run import verification (should return zero results):
```bash
grep -r "from '\.\./\.\./server/" apps/
grep -r "from '\.\./\.\./client/" apps/
grep -r "from '@shared/" apps/
grep -r "from '\.\./\.\./shared/" apps/
```

2. Run all builds:
```bash
turbo build
```
   Verify outputs:
   - `apps/client/dist/` contains built React SPA
   - `apps/server/dist/` contains compiled JS
   - `apps/obsidian-plugin/dist/` contains `main.js`, `styles.css`, `manifest.json`

3. Run all tests:
```bash
turbo test
```
   All 30 existing test files pass.

4. Run dev mode:
```bash
turbo dev
```
   Verify:
   - Vite dev server starts on port 3000
   - Express server starts on port 6942
   - HMR works
   - API proxy works

5. Verify old files are removed:
   - `src/` directory does not exist
   - Root `vite.config.ts` does not exist (unless needed)
   - Root `vite.config.obsidian.ts` does not exist
   - Root `tsconfig.server.json` does not exist

6. Verify turbo caching works:
```bash
turbo build  # First run
turbo build  # Second run should show cache hits
```

7. Clean up root `package.json`:
   - Only `turbo` and `concurrently` in devDependencies
   - No runtime dependencies (all moved to workspace packages)
   - Workspaces set to `["apps/*", "packages/*"]`

**Acceptance Criteria:**
- Zero deep relative cross-package imports
- Zero `@shared/` imports
- All 3 build targets produce correct output
- All 30 test files pass
- Dev mode works with HMR and API proxy
- Turbo caching works (second build shows cache hits)
- Root `package.json` has no orphaned dependencies
- Old files (`src/`, `vite.config.obsidian.ts`, `tsconfig.server.json`) are removed
- `turbo build`, `turbo test`, `turbo typecheck` all succeed
