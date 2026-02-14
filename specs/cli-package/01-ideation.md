# Ideation: `packages/cli` — Publishable npm CLI Package

## 1. Intent & Assumptions

**Intent**: Package DorkOS as a standalone npm CLI tool (`dorkos`) so anyone with Node.js can install and run it via `npx dorkos` or `npm install -g dorkos`, with optional `--tunnel` support for remote access.

**Assumptions**:
- Target users already have Node.js 18+ (Claude Code CLI is npm-distributed)
- Users have Claude Code CLI installed (`@anthropic-ai/claude-code` or native)
- The published package must work independently of the monorepo structure
- `@dorkos/shared` must be bundled into the server (not a separate npm package)
- `@ngrok/ngrok` stays as a regular dependency (npm handles platform binaries)
- The pre-built React client (Vite output) ships as static assets in the package

## 2. Pre-reading Log

| File | Key Finding |
|------|-------------|
| `turbo.json` | Build outputs to `dist/**`, env vars tracked: `NODE_ENV`, `VITE_*`, `GATEWAY_PORT`, `NGROK_*`, `TUNNEL_*` |
| `apps/server/src/index.ts` | Loads `.env` from `path.join(__dirname, '../../../.env')` — assumes monorepo structure |
| `apps/server/src/app.ts` | Production mode serves client from `path.join(__dirname, '../../client/dist')` — relative to `dist/app.js` |
| `apps/server/src/services/agent-manager.ts` | Default cwd: `path.resolve(__dirname, '../../../../')` (monorepo root). CLI resolution: SDK bundled `cli.js` → `which claude` → undefined |
| `apps/server/src/services/command-registry.ts` | Scans `{vaultRoot}/.claude/commands/` for slash commands |
| `apps/server/src/services/transcript-reader.ts` | Reads from `~/.claude/projects/{slug}/` — no monorepo dependency |
| `apps/server/src/services/tunnel-manager.ts` | Dynamic `import('@ngrok/ngrok')` — zero cost when disabled |
| `apps/client/vite.config.ts` | Outputs to `dist/`, proxy `/api` to `GATEWAY_PORT` in dev |
| `packages/shared/package.json` | Exports raw `.ts` files via package.json `exports` — JIT, no build step |
| `apps/server/package.json` | 11 dependencies including SDK, ngrok, express, zod, gray-matter |

## 3. Codebase Map

### Build Pipeline

```
                                    esbuild (bundle)
apps/server/src/**  ──────────────────────────────────→  packages/cli/dist/server/index.js
                          ↑ inlines @dorkos/shared
packages/shared/src/**  ──┘

apps/client/src/**  ──── vite build ──────────────────→  packages/cli/dist/client/
                                                          ├── index.html
                                                          └── assets/

packages/cli/src/cli.ts ── esbuild ───────────────────→  packages/cli/dist/bin/cli.js
```

### Path Resolution (Current vs CLI Package)

| Purpose | Current (monorepo) | CLI Package |
|---------|--------------------|-------------|
| `.env` | `__dirname + '../../../.env'` | User's `cwd/.env` → skip if missing |
| Client assets | `__dirname + '../../client/dist'` | `__dirname + '../client'` (co-located in package) |
| Default cwd | Monorepo root | `process.cwd()` (user's project dir) |
| Commands dir | `{monorepoRoot}/.claude/commands/` | `{cwd}/.claude/commands/` (per-project) |
| SDK transcripts | `~/.claude/projects/{slug}/` | Same (no change needed) |

### Dependencies to Bundle vs Externalize

| Package | Strategy | Reason |
|---------|----------|--------|
| `@dorkos/shared` | **Bundle** (inline) | Workspace package, not published to npm |
| `@anthropic-ai/claude-agent-sdk` | **Externalize** | Complex, spawns processes, should be installed normally |
| `@ngrok/ngrok` | **Externalize** | Native bindings, platform-specific |
| `express` | **Externalize** | Large, common, well-tested |
| `zod` | **Externalize** | Runtime schema validation |
| `cors`, `dotenv`, `gray-matter`, `uuid` | **Externalize** | Pure JS, small, install normally |
| `@scalar/express-api-reference` | **Externalize** | Large UI bundle |
| `@asteasolutions/zod-to-openapi` | **Externalize** | OpenAPI generation |

### What Must Change in Server Code

1. **`.env` loading** — Look in `cwd` first, then fall back (no error if missing)
2. **Client dist path** — Resolve relative to `__dirname` within the package structure
3. **Default cwd** — Use `process.cwd()` or `--dir` flag instead of monorepo root
4. **Commands dir** — Use cwd-relative `.claude/commands/` (already works per-project)

## 4. Research

### Bundling: esbuild

- **Best fit**: Fast, handles TypeScript natively, tree-shakes, externalizes node_modules
- `--bundle --platform=node --target=node18 --format=esm`
- `--external:@ngrok/ngrok --external:express` etc. for native/large deps
- `@dorkos/shared` is NOT externalized, so it gets inlined into the server bundle
- **Alternative considered**: tsup (esbuild wrapper with DTS support) — unnecessary complexity for a CLI

### CLI Entry Point: `node:util` parseArgs

- Zero dependencies, built into Node 18.3+
- Supports `--port`, `--tunnel`, `--dir`, `--help`, `--version` flags
- Maps CLI flags to environment variables before importing the server

### Static Asset Strategy

- Vite builds client to `dist/client/` within the package
- Express serves via `express.static(path.join(__dirname, '../client'))`
- `package.json` `files` field whitelists `dist/` and `bin/`
- Expected package size: ~1-2MB (server bundle ~500KB + minified client ~500KB)

### Native Dependencies

- `@ngrok/ngrok` uses NAPI-RS with prebuilt platform binaries
- npm automatically installs correct platform binary via `os`/`cpu` fields in sub-packages
- Keep as regular `dependencies` (not `optionalDependencies`)

### Publishing

- `prepublishOnly` script runs full build pipeline
- `files` whitelist: `["dist/", "bin/"]`
- `engines: { "node": ">=18.0.0" }`
- `bin: { "dorkos": "./bin/cli.js" }`
- Semantic versioning starting at `0.1.0` (pre-release while stabilizing)

### Reference Packages

- **`serve`** (Vercel): Zero-config static server, `npx serve` pattern
- **`http-server`**: Simple CLI, minimal deps, clear defaults
- **`@anthropic-ai/claude-code`**: bin mapping to `start.js`, Node 18+ requirement

## 5. Open Questions / Clarifications

1. **Package name**: `dorkos` or scoped `@dork/os`? Scoped requires npm org. Unscoped is simpler for `npx`.

2. **Server code modifications**: Should we modify `apps/server` source to support both monorepo and CLI contexts (via env vars / flags), or should `packages/cli` have its own entry point that wraps the server with CLI-specific path resolution?

3. **Claude Code CLI dependency**: Should we check for `claude` CLI at startup and show a helpful error, or just let the SDK fail naturally?

4. **Scope of first release**: Just the server + client + tunnel? Or also include the Obsidian plugin build pipeline?

5. **`.env` handling**: In CLI mode, should we look for `.env` in the user's cwd (project-local), `~/.dorkos/.env` (global config), or just rely on env vars / CLI flags?

## 6. Proposed Architecture

### Package Structure

```
packages/cli/
├── package.json          # Published package config
├── src/
│   └── cli.ts            # CLI entry point (parseArgs → env vars → import server)
├── scripts/
│   └── build.ts          # Build pipeline: esbuild server + vite client + copy bin
├── bin/
│   └── cli.js            # Compiled CLI entry (shebang, ESM)
└── dist/                 # Build output (not committed)
    ├── bin/cli.js
    ├── server/index.js   # Bundled server (shared inlined)
    └── client/           # Pre-built React SPA
        ├── index.html
        └── assets/
```

### CLI Interface

```
dorkos [options]

Options:
  -p, --port <port>     Port to listen on (default: 6942)
  -t, --tunnel          Enable ngrok tunnel
  -d, --dir <path>      Working directory for Claude sessions (default: cwd)
  -h, --help            Show help
  -v, --version         Show version

Environment:
  NGROK_AUTHTOKEN       ngrok auth token (required for --tunnel)
  TUNNEL_AUTH           HTTP basic auth for tunnel (user:pass)
  TUNNEL_DOMAIN         Custom ngrok domain

Examples:
  npx dorkos
  npx dorkos --tunnel
  npx dorkos --port 8080 --dir ~/projects/myapp
```

### Build Pipeline

1. `vite build` — Builds client SPA to `dist/client/`
2. `esbuild` — Bundles server + shared into `dist/server/index.js`, externalizing node_modules
3. `esbuild` — Compiles CLI entry to `dist/bin/cli.js`
4. Copy + chmod bin script

### Server Modifications Needed

The key insight: rather than modifying `apps/server` extensively, the CLI entry point sets environment variables that the server already reads:

- `GATEWAY_PORT` — already used
- `TUNNEL_ENABLED` — already used
- `NODE_ENV=production` — triggers static file serving

The only server change needed: make the client dist path configurable via `CLIENT_DIST_PATH` env var (fallback to current relative path for monorepo compatibility).
