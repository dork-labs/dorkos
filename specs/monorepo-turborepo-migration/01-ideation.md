# Turborepo Monorepo Migration

**Slug:** monorepo-turborepo-migration
**Author:** Claude Code
**Date:** 2026-02-11
**Branch:** preflight/monorepo-turborepo-migration
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Migrate the DorkOS project from a single-package structure to a Turborepo monorepo with proper package boundaries. The project currently has three distinct build targets (web client, Express server, Obsidian plugin) sharing a common types layer, all in one `package.json`. The migration should also update all developer guides in `guides/` and Claude Code commands/skills in `.claude/` to reflect the new structure.

**Assumptions:**
- npm workspaces will be the workspace protocol (project already uses npm)
- Four natural packages: `@dorkos/shared`, `@dorkos/server`, `@dorkos/client`, `@dorkos/obsidian-plugin`
- The existing hexagonal architecture and Transport abstraction remain unchanged
- All existing tests should continue to pass after migration
- The Obsidian plugin's custom Vite build plugins (dirname polyfill, safe requires, electron compat) remain necessary
- Internal packages use the "Just-in-Time" pattern (export TypeScript source directly, no pre-compilation)
- No CI/CD pipeline changes in this migration (can follow up)

**Out of scope:**
- Changing the runtime architecture (Express, React, Obsidian plugin patterns)
- Adding new features during migration
- CI/CD pipeline setup
- Switching package managers (staying on npm)
- Extracting a separate `@dorkos/ui` component library
- Remote caching setup (can be added later)

---

## 2) Pre-reading Log

### Config Files
- `package.json`: Single package with 22 dependencies + 14 devDependencies. Scripts: `dev` (concurrently tsx+vite), `build` (tsc+vite sequential), `build:obsidian` (vite+cp+mv). All deps are flat — React, Express, Obsidian, Zod, etc. in one file.
- `tsconfig.json`: Target ES2022, module ESNext, bundler resolution, paths `@/*` → `./src/client/*` and `@shared/*` → `./src/shared/*`. Includes all of `src/**/*`.
- `tsconfig.server.json`: Extends base, overrides to NodeNext module/resolution, outputs to `dist-server/`, includes `src/server/**/*` and `src/shared/**/*`.
- `vite.config.ts`: React + Tailwind plugins, path aliases matching tsconfig, proxy `/api` to Express on port 6942, output to `dist/`.
- `vite.config.obsidian.ts`: CJS library mode, 4 custom Vite plugins (copyManifest, fixDirnamePolyfill, safeRequires, patchElectronCompat), externals for Obsidian/Electron/Node builtins/CodeMirror, inline dynamic imports, output to `dist-obsidian/`, target node18.
- `.env`: Contains `GATEWAY_PORT=6942`.
- `manifest.json`: Obsidian plugin manifest (dorkos-copilot v0.1.0).
- `components.json`: shadcn/ui configuration (new-york style, neutral palette).

### Source Code
- `src/shared/` (3 files): `schemas.ts` (393 lines, Zod schemas with OpenAPI metadata), `transport.ts` (Transport interface), `types.ts` (re-exports from schemas). Zero external dependencies beyond `zod` and `@asteasolutions/zod-to-openapi`.
- `src/client/` (62 files): React 19, Zustand store, TanStack Query hooks, shadcn/ui components, Streamdown markdown rendering. All imports from shared use `@shared/*` alias.
- `src/server/` (25 files): Express routes (sessions, commands, health), 3 services (AgentManager, TranscriptReader, CommandRegistryService), SSE streaming. Uses relative imports to shared (e.g., `../../shared/schemas.js`).
- `src/plugin/` (10 files): Obsidian ItemView, CopilotView, DirectTransport. Imports from both `../../server/services/` and `../../client/` with deep relative paths.
- `src/test-utils/`: Mock factories, transport helpers shared across client tests.

### Guide Files (5)
- `guides/architecture.md`: Hexagonal architecture, Transport pattern, Electron compat layer, data flow diagrams
- `guides/design-system.md`: Color palette, typography, spacing, motion specs
- `guides/obsidian-plugin-development.md`: Plugin lifecycle, Vite build, Electron quirks
- `guides/api-reference.md`: OpenAPI spec, Zod schema patterns
- `guides/interactive-tools.md`: Tool approval, AskUserQuestion flows

### Claude Code Configuration (90+ files)
- `.claude/settings.json` and `.claude/settings.local.json`: Project settings
- `.claude/rules/` (4 files): api.md, dal.md, security.md, testing.md
- `.claude/commands/` (~30 commands): debug/*, spec/*, roadmap/*, git/*, system/*, app/*, db/*, cc/*
- `.claude/skills/` (~10 skills): designing-frontend, styling-with-tailwind-shadcn, working-with-prisma, organizing-fsd-architecture, etc.
- `.claude/agents/` (6 agents): research-expert, product-manager, code-search, typescript-expert, prisma-expert, react-tanstack-expert, zod-forms-expert
- `.claude/scripts/hooks/` (7 hooks): file-guard.mjs, typecheck-changed.sh, test-changed.sh, lint-changed.sh, etc.

---

## 3) Codebase Map

### Primary Modules & Build Targets

| Module | Source | Build Tool | Output | Format |
|--------|--------|-----------|--------|--------|
| Web Client | `src/client/` | Vite 6 | `dist/` | ESM (browser) |
| Express Server | `src/server/` | tsc (NodeNext) | `dist-server/` | ESM (Node) |
| Obsidian Plugin | `src/plugin/` | Vite 6 (lib mode) | `dist-obsidian/` | CJS (Electron) |
| Shared Types | `src/shared/` | (consumed raw) | — | TypeScript source |

### Cross-Boundary Import Map

**Client → Shared** (25+ imports via `@shared/*` alias):
- `@shared/types` (Session, Message, StreamEvent, etc.)
- `@shared/transport` (Transport interface, HttpTransport)
- `@shared/schemas` (Zod schemas for validation)

**Server → Shared** (via relative imports `../../shared/schemas.js`):
- Zod schemas for request validation
- Type definitions for StreamEvent, Session, etc.

**Plugin → Server** (6 deep relative imports):
- `../../server/services/agent-manager` → AgentManager class
- `../../server/services/transcript-reader` → TranscriptReader class
- `../../server/services/command-registry` → CommandRegistryService class

**Plugin → Client** (direct component imports):
- `../../client/App` → Root React component
- `../../client/stores/app-store` → Zustand store
- `../../client/contexts/TransportContext` → React context
- `../../client/hooks/*` → Various hooks

### Dependency Graph
```
@dorkos/shared (schemas, transport interface, types)
  ├─→ @dorkos/server (Express app + services)
  │     └─→ @dorkos/obsidian-plugin (DirectTransport uses services)
  ├─→ @dorkos/client (React SPA + HttpTransport)
  │     └─→ @dorkos/obsidian-plugin (embeds React components)
  └─→ @dorkos/obsidian-plugin (uses shared types)
```

### Shared Dependencies (used by multiple modules)
- `zod` — shared, server, client (validation)
- `react`, `react-dom` — client, plugin
- `@asteasolutions/zod-to-openapi` — shared, server (OpenAPI)
- `uuid` — server, client

### Potential Blast Radius
- **Direct**: package.json, all tsconfig files, both vite configs, CLAUDE.md, all 5 guides
- **Import paths**: Every file in `src/plugin/` (deep relative → package imports), all `@shared/*` imports
- **Config**: `.claude/` commands/skills that reference file paths or build scripts
- **Build scripts**: All npm scripts change to `turbo` commands

---

## 4) Root Cause Analysis

N/A — this is a migration, not a bug fix.

---

## 5) Research

### Potential Solutions

**1. Turborepo + npm Workspaces (Recommended)**
- Description: Add Turborepo as the task runner on top of npm workspaces. Split into `apps/` and `packages/` directories. Use Just-in-Time compilation (export TypeScript source from shared packages, let consumers compile).
- Pros:
  - Minimal config — Turborepo is lightweight compared to Nx
  - Build caching saves significant time (especially the 11MB Obsidian plugin build)
  - Parallel builds for independent packages (client + server)
  - npm workspaces already mature and well-supported
  - `turbo watch` replaces `concurrently` for dev mode
  - Strict env var handling prevents build reproducibility issues
- Cons:
  - Non-trivial migration effort (file moves, import updates, config splitting)
  - npm workspaces hoisting can occasionally cause issues
  - Need to carefully declare `outputs` and `env` in turbo.json
- Complexity: Medium
- Maintenance: Low (Turborepo is minimal config)

**2. Nx**
- Description: Full-featured monorepo tool with generators, project graph, and extensive plugin ecosystem.
- Pros:
  - More features (generators, affected commands, project graph visualization)
  - Strong TypeScript support
  - Plugin ecosystem for Vite, React, etc.
- Cons:
  - Much heavier — overkill for 4 packages
  - Steeper learning curve
  - More config files and conventions to learn
  - Plugin lock-in
- Complexity: High
- Maintenance: Medium-High

**3. npm Workspaces Only (No Task Runner)**
- Description: Use npm workspaces for package management without Turborepo or Nx.
- Pros:
  - Zero additional dependencies
  - Simple mental model
- Cons:
  - No build caching
  - No parallel task execution with dependency awareness
  - Manual build ordering required
  - No incremental build support
- Complexity: Low
- Maintenance: Low but manual

### Key Research Findings

**TypeScript Configuration:**
- Turborepo explicitly advises against TypeScript Project References — use their task graph instead
- Use a `@dorkos/typescript-config` package with base/react/node configs
- Internal packages should use "Just-in-Time" pattern: export `.ts` source directly via `package.json` exports, let Vite/tsc consumers compile it
- Replace `@shared/*` path alias with `@dorkos/shared` package exports at package boundaries
- Keep `@/*` as a local alias within each app

**Vitest:**
- Use root-level `vitest.workspace.ts` pointing to `apps/*` and `packages/*`
- Each package can have its own vitest config extending a shared base
- Turborepo caches test results per-package

**Tailwind CSS 4:**
- Per-app configuration is simplest (only client uses Tailwind heavily)
- Use `@source` directives to point to workspace package source directories
- No shared Tailwind config package needed until 5+ apps exist

**Dependency Management:**
- Install dependencies in the packages that use them, not the root
- Root should only have monorepo tools: `turbo`, `concurrently` (if kept), `typescript`
- Use `"@dorkos/shared": "workspace:*"` for internal dependencies

**Migration Strategy:**
- Incremental, phased approach is strongly recommended
- Keep `dev:legacy` scripts during migration as fallback
- Verify tests pass after each phase

### Recommendation

**Turborepo + npm Workspaces** with Just-in-Time internal packages.

Rationale: The project already has clear package boundaries and a dependency graph that maps cleanly to a monorepo. Turborepo's caching will save significant build time (especially the Obsidian plugin's complex build with 4 custom Vite post-processing plugins). The lightweight config aligns with the project's clean, minimal approach. npm workspaces avoid a package manager switch.

---

## 6) Clarification

1. **Package naming convention**: Should packages use `@dorkos/` scope (e.g., `@dorkos/shared`, `@dorkos/client`) or a different scope? These are private packages so it doesn't matter for npm registry, but it affects all import statements.

2. **Directory layout preference**: Standard Turborepo convention is `apps/` for deployable apps and `packages/` for shared libraries. Should the Obsidian plugin go in `apps/obsidian-plugin/` (it's a deployable artifact) or `packages/obsidian-plugin/` (it's a library/plugin)? Recommendation: `apps/` since it produces a deployable build.

3. **Shared config packages**: Should we create `@dorkos/typescript-config` and `@dorkos/vitest-config` packages for shared configs, or keep configs local to each package? With only 4 packages, shared config packages add structure but may be premature. Recommendation: Create `@dorkos/typescript-config` (low effort, high value), skip vitest-config for now.

4. **Server service extraction**: The Obsidian plugin imports server services directly (AgentManager, TranscriptReader, CommandRegistryService). Should these services stay in `@dorkos/server` with the plugin depending on the full server package, or should we extract them to a separate `@dorkos/server-core` package? Recommendation: Keep in server for now, extract later if the dependency feels too heavy.

5. **Claude Code commands/skills scope**: Many commands in `.claude/` reference paths like `src/server/`, `src/client/`, etc. and build scripts. Should we update all commands to use new paths during migration, or handle as a follow-up? Recommendation: Update during migration since stale paths will break commands.

6. **`guides/` location**: Should guide files remain at the monorepo root (`guides/`) or move into a specific package? Since they document the overall system (not one package), keeping them at root makes sense. Recommendation: Keep at root, update all path references inside them.

7. **Test utilities**: `src/test-utils/` contains shared mock factories. Should this become its own package `@dorkos/test-utils` or stay co-located with client tests? Recommendation: Extract to `packages/test-utils/` since both client and plugin tests may need them.

---

## 7) Proposed Package Structure

```
dorkos/
├── apps/
│   ├── client/                     # @dorkos/client
│   │   ├── src/                    # React components, hooks, stores
│   │   ├── public/
│   │   ├── index.html
│   │   ├── package.json
│   │   ├── tsconfig.json           # extends @dorkos/typescript-config/react
│   │   └── vite.config.ts
│   ├── server/                     # @dorkos/server
│   │   ├── src/                    # Express routes, services, middleware
│   │   ├── package.json
│   │   └── tsconfig.json           # extends @dorkos/typescript-config/node
│   └── obsidian-plugin/            # @dorkos/obsidian-plugin
│       ├── src/                    # Plugin main, views, DirectTransport
│       ├── build-plugins/          # Custom Vite plugins (dirname, safeRequires, etc.)
│       ├── manifest.json
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts
├── packages/
│   ├── shared/                     # @dorkos/shared
│   │   ├── src/
│   │   │   ├── schemas.ts
│   │   │   ├── transport.ts
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── typescript-config/          # @dorkos/typescript-config
│   │   ├── base.json
│   │   ├── react.json
│   │   ├── node.json
│   │   └── package.json
│   └── test-utils/                 # @dorkos/test-utils
│       ├── src/
│       ├── package.json
│       └── tsconfig.json
├── guides/                         # Stays at root (documents whole system)
├── specs/                          # Stays at root
├── .claude/                        # Updated commands/skills/rules
├── turbo.json
├── vitest.workspace.ts
├── package.json                    # Root workspace config
├── CLAUDE.md                       # Updated for monorepo
└── .env
```

---

## 8) Migration Phases

### Phase 1: Add Turborepo to Existing Structure
- Install `turbo` as devDependency
- Create minimal `turbo.json`
- Add `packageManager` field to root `package.json`
- Update top-level scripts to use `turbo`
- Verify existing dev/build/test still work
- **Commit: "chore: add Turborepo to existing project"**

### Phase 2: Extract Shared Package
- Create `packages/shared/` with `package.json` using exports map
- Move `src/shared/` → `packages/shared/src/`
- Create `packages/typescript-config/` with base/react/node configs
- Add workspace config: `"workspaces": ["packages/*"]`
- Update client imports: `@shared/*` → `@dorkos/shared/*`
- Update server imports: relative paths → `@dorkos/shared/*`
- Run tests, verify TypeScript compiles
- **Commit: "refactor: extract shared and typescript-config packages"**

### Phase 3: Extract Client App
- Create `apps/client/` with its own `package.json` and `vite.config.ts`
- Move `src/client/` → `apps/client/src/`
- Move `index.html` → `apps/client/`
- Move `public/` → `apps/client/`
- Move `components.json` → `apps/client/`
- Update workspace config: `"workspaces": ["apps/*", "packages/*"]`
- Update path alias `@/*` to resolve within `apps/client/src/`
- Verify HMR and build work
- **Commit: "refactor: extract client app"**

### Phase 4: Extract Server App
- Create `apps/server/` with its own `package.json` and `tsconfig.json`
- Move `src/server/` → `apps/server/src/`
- Update Express static file serving path
- Verify dev server starts and API endpoints work
- **Commit: "refactor: extract server app"**

### Phase 5: Extract Obsidian Plugin
- Create `apps/obsidian-plugin/` with its own `package.json` and `vite.config.ts`
- Move `src/plugin/` → `apps/obsidian-plugin/src/`
- Move custom Vite plugins to `apps/obsidian-plugin/build-plugins/`
- Move `manifest.json` → `apps/obsidian-plugin/`
- Update deep relative imports to package imports (`@dorkos/server`, `@dorkos/client`)
- Test build and load in Obsidian
- **Commit: "refactor: extract Obsidian plugin app"**

### Phase 6: Extract Test Utils & Finalize
- Create `packages/test-utils/` with shared mock factories
- Configure `vitest.workspace.ts` at root
- Set up per-package vitest configs
- Update Tailwind `@source` directives in client
- Clean up legacy scripts and unused root files
- **Commit: "refactor: extract test-utils and configure Vitest workspace"**

### Phase 7: Update Documentation & Claude Code
- Update all 5 guide files with new paths and monorepo-aware instructions
- Update `CLAUDE.md` with new architecture, commands, directory structure
- Update `.claude/commands/` that reference file paths or build scripts
- Update `.claude/rules/` if any reference specific file paths
- Update `.claude/skills/` if any reference project structure
- Update hook scripts in `.claude/scripts/hooks/` if they reference file paths
- **Commit: "docs: update guides and Claude Code config for monorepo"**

---

## 9) Files Requiring Updates (Documentation & Claude Code)

### Guide Files
| File | Changes Needed |
|------|---------------|
| `guides/architecture.md` | Update all source paths, build commands, module layout diagram, data flow |
| `guides/design-system.md` | Update component file paths if referenced |
| `guides/obsidian-plugin-development.md` | Update build config paths, Vite plugin locations, file structure |
| `guides/api-reference.md` | Update server file paths, schema import paths |
| `guides/interactive-tools.md` | Update component paths if referenced |

### CLAUDE.md
- Complete rewrite of Architecture section (new directory structure)
- Update all Commands (`npm run dev` → `turbo dev`, etc.)
- Update Path Aliases section
- Update server/client/plugin/shared descriptions with new paths
- Update build instructions

### .claude/ Files
| Category | Files | Changes |
|----------|-------|---------|
| Commands | `dev/scaffold.md` | Update scaffold paths |
| Commands | `git/commit.md`, `git/push.md` | Update build/test commands |
| Commands | `app/cleanup.md`, `app/upgrade.md` | Update dependency management |
| Commands | `spec/execute.md` | Update file path patterns |
| Commands | `docs/reconcile.md` | Update guide file paths |
| Rules | `api.md`, `dal.md`, `testing.md` | Update import patterns, file paths |
| Skills | `organizing-fsd-architecture/` | Update to monorepo structure |
| Skills | `styling-with-tailwind-shadcn/` | Update Tailwind config paths |
| Hooks | `typecheck-changed.sh` | Update tsconfig references |
| Hooks | `test-changed.sh` | Update test paths |
| Hooks | `file-guard.mjs` | Update allowed paths |

---

## 10) Proposed turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "ui": "tui",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "dist-obsidian/**"],
      "env": ["NODE_ENV", "VITE_*", "GATEWAY_PORT"]
    },
    "dev": {
      "cache": false,
      "persistent": true
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
    },
    "lint": {
      "cache": true,
      "outputs": []
    }
  }
}
```

---

## 11) Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Obsidian plugin build breaks due to path changes | High | High | Test early in Phase 5, keep legacy build script as fallback |
| Path alias resolution breaks in Vite | Medium | Medium | Use `vite-tsconfig-paths` plugin if needed |
| Deep relative imports in plugin miss conversion | Medium | High | Grep for `../../server/` and `../../client/` patterns |
| Tailwind CSS stops finding classes after move | Medium | Medium | Update `@source` directives, verify visually |
| Claude Code hooks break due to path changes | High | Low | Update hooks in Phase 7, test manually |
| npm workspace hoisting causes module resolution issues | Low | High | Use `.npmrc` with `hoist=true` if needed |
| Dev HMR breaks for cross-package changes | Medium | Medium | Vite resolves workspace symlinks, but may need config |
