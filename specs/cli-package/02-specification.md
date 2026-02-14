---
slug: cli-package
---

# Specification: Publishable npm CLI Package (`@dork/os`)

## 1. Status

**Draft** — 2026-02-12

## 2. Overview

Create a `packages/cli` workspace package that bundles DorkOS into a publishable npm CLI tool. Users install via `npm install -g @dork/os` or run with `npx @dork/os`, getting the full web UI + Express API server + optional ngrok tunnel — no git clone required.

The CLI entry point parses arguments, sets environment variables, and dynamically imports the bundled server. The build pipeline uses esbuild to bundle the server (inlining `@dorkos/shared`) and Vite to build the React client as static assets.

## 3. Background / Problem Statement

Currently, running DorkOS requires cloning the monorepo, installing all workspace dependencies, and building from source. This is a barrier for non-developer users or quick setup on new machines. Packaging as an npm CLI enables one-command installation and aligns with how Claude Code itself is distributed.

## 4. Goals

- One-command install: `npm install -g @dork/os` or `npx @dork/os`
- CLI flags for port, tunnel, working directory, help, version
- Pre-built React client shipped as static assets inside the package
- Server bundled with `@dorkos/shared` inlined (no workspace dependency)
- Startup check for Claude Code CLI with helpful error message
- Existing monorepo dev workflow completely unaffected
- Minimal changes to `apps/server` (one env var addition)

## 5. Non-Goals

- Obsidian plugin build/distribution
- Publishing to npm registry (just the packaging infrastructure)
- CI/CD automation for releases
- README or documentation beyond inline `--help` text
- Auto-update mechanism
- Windows-specific path handling (Node.js handles this)

## 6. Technical Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `esbuild` | `^0.24` | Bundle server + shared into single JS file |
| `node:util` (parseArgs) | Node 18.3+ built-in | CLI argument parsing (zero deps) |
| All `apps/server` deps | (inherited) | Runtime dependencies declared in CLI package.json |

No new runtime dependencies are added. `esbuild` is a devDependency of `packages/cli` only.

## 7. Detailed Design

### 7.1 Package Structure

```
packages/cli/
├── package.json              # Published package config (@dork/os)
├── tsconfig.json             # Extends shared config
├── src/
│   ├── cli.ts                # CLI entry point (parseArgs → env vars → import server)
│   └── check-claude.ts       # Claude CLI availability check
├── scripts/
│   └── build.ts              # Build pipeline orchestrator
└── dist/                     # Build output (gitignored)
    ├── bin/
    │   └── cli.js            # Compiled CLI entry (shebang, ESM)
    ├── server/
    │   └── index.js          # Bundled server (shared inlined, node_modules external)
    └── client/               # Pre-built React SPA (copied from apps/client/dist)
        ├── index.html
        └── assets/
```

### 7.2 CLI Entry Point (`src/cli.ts`)

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    port:    { type: 'string',  short: 'p', default: '6942' },
    tunnel:  { type: 'boolean', short: 't', default: false },
    dir:     { type: 'string',  short: 'd', default: process.cwd() },
    help:    { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: false,
});

// --help
if (values.help) { /* print usage, exit */ }

// --version
if (values.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'));
  console.log(pkg.version);
  process.exit(0);
}

// Check for Claude CLI
await checkClaude();

// Set environment variables the server reads
process.env.GATEWAY_PORT = values.port;
process.env.NODE_ENV = 'production';
process.env.CLIENT_DIST_PATH = path.join(__dirname, '../client');

if (values.tunnel) process.env.TUNNEL_ENABLED = 'true';

const resolvedDir = path.resolve(values.dir!);
process.env.GATEWAY_CWD = resolvedDir;

// Load .env from user's cwd (project-local, optional)
const envPath = path.join(resolvedDir, '.env');
if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
}

// Start the server
await import('../server/index.js');
```

### 7.3 Claude CLI Check (`src/check-claude.ts`)

```typescript
import { execSync } from 'child_process';

export function checkClaude(): void {
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: Claude Code CLI not found in PATH.');
    console.error('');
    console.error('DorkOS requires the Claude Code CLI to function.');
    console.error('Install it with:  npm install -g @anthropic-ai/claude-code');
    console.error('');
    console.error('More info: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }
}
```

### 7.4 Modification to `apps/server/src/app.ts`

One change: read `CLIENT_DIST_PATH` env var with fallback to current relative path.

```typescript
// Before (line 37):
const distPath = path.join(__dirname, '../../client/dist');

// After:
const distPath = process.env.CLIENT_DIST_PATH
  ?? path.join(__dirname, '../../client/dist');
```

This is the **only** change to `apps/server`. The fallback preserves monorepo behavior.

### 7.5 Modification to `apps/server/src/index.ts`

Two changes:

1. **`.env` loading**: Make conditional — skip if `CLIENT_DIST_PATH` is set (CLI mode handles its own .env).

```typescript
// Before (line 9):
dotenv.config({ path: path.join(__dirname, '../../../.env') });

// After:
if (!process.env.CLIENT_DIST_PATH) {
  dotenv.config({ path: path.join(__dirname, '../../../.env') });
}
```

2. **Listen host**: Change from `'localhost'` to `'0.0.0.0'` when tunnel is enabled, so ngrok can reach the server. Otherwise keep `'localhost'`.

```typescript
// Before (line 15):
app.listen(PORT, 'localhost', () => {

// After:
const host = process.env.TUNNEL_ENABLED === 'true' ? '0.0.0.0' : 'localhost';
app.listen(PORT, host, () => {
```

### 7.6 Modification to `apps/server/src/routes/commands.ts`

Make vault root configurable via `GATEWAY_CWD` env var:

```typescript
// Before (line 8):
const vaultRoot = path.resolve(__dirname, '../../../../');

// After:
const vaultRoot = process.env.GATEWAY_CWD ?? path.resolve(__dirname, '../../../../');
```

### 7.7 Modification to `apps/server/src/services/agent-manager.ts`

Make default cwd configurable via `GATEWAY_CWD` env var:

```typescript
// Before (line 178):
this.cwd = cwd ?? path.resolve(__dirname, '../../../../');

// After:
this.cwd = cwd ?? process.env.GATEWAY_CWD ?? path.resolve(__dirname, '../../../../');
```

### 7.8 Build Script (`scripts/build.ts`)

```typescript
import { build } from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT = path.resolve(import.meta.dirname, '../dist');

async function buildCLI() {
  // Clean
  await fs.rm(OUT, { recursive: true, force: true });

  // 1. Build client (Vite)
  console.log('[1/3] Building client...');
  execSync('npx turbo build --filter=@dorkos/client', { cwd: ROOT, stdio: 'inherit' });
  await fs.cp(path.join(ROOT, 'apps/client/dist'), path.join(OUT, 'client'), { recursive: true });

  // 2. Bundle server (esbuild) — inlines @dorkos/shared, externalizes node_modules
  console.log('[2/3] Bundling server...');
  await build({
    entryPoints: [path.join(ROOT, 'apps/server/src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'server/index.js'),
    external: [
      '@anthropic-ai/claude-agent-sdk',
      '@ngrok/ngrok',
      '@scalar/express-api-reference',
      '@asteasolutions/zod-to-openapi',
      'express',
      'cors',
      'dotenv',
      'gray-matter',
      'uuid',
      'zod',
    ],
    sourcemap: true,
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });

  // 3. Compile CLI entry
  console.log('[3/3] Compiling CLI...');
  await build({
    entryPoints: [path.join(ROOT, 'packages/cli/src/cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: path.join(OUT, 'bin/cli.js'),
    external: ['dotenv'],
    banner: { js: '#!/usr/bin/env node' },
  });

  // Make executable
  await fs.chmod(path.join(OUT, 'bin/cli.js'), 0o755);

  console.log('Build complete.');
}

buildCLI();
```

### 7.9 `packages/cli/package.json`

```json
{
  "name": "@dork/os",
  "version": "0.1.0",
  "description": "Web-based interface and REST/SSE API for Claude Code",
  "type": "module",
  "bin": {
    "dorkos": "./dist/bin/cli.js"
  },
  "files": [
    "dist/"
  ],
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsx scripts/build.ts",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "@asteasolutions/zod-to-openapi": "^8.4.0",
    "@ngrok/ngrok": "^1.7.0",
    "@scalar/express-api-reference": "^0.8.40",
    "cors": "^2.8.5",
    "dotenv": "^16.4.0",
    "express": "^4.21.0",
    "gray-matter": "^4.0.3",
    "uuid": "^10.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@dorkos/typescript-config": "*",
    "esbuild": "^0.24.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

### 7.10 Turbo & Workspace Integration

**Root `package.json`**: Already has `"packages/*"` in workspaces — `packages/cli` is auto-discovered.

**`turbo.json`**: Add `"pack"` task (no cache, depends on client + server build):

```json
{
  "pack": {
    "dependsOn": ["^build"],
    "outputs": ["dist/**"],
    "cache": false
  }
}
```

The CLI's `build` script calls `turbo build --filter=@dorkos/client` internally, but having a turbo task allows `turbo run pack --filter=@dork/os` as a top-level command.

### 7.11 Environment Variable Flow

```
CLI flags              CLI sets env vars           Server reads env vars
─────────              ─────────────────           ─────────────────────
--port 8080     →      GATEWAY_PORT=8080     →     PORT = parseInt(GATEWAY_PORT)
--tunnel        →      TUNNEL_ENABLED=true   →     if (TUNNEL_ENABLED === 'true')
--dir ~/proj    →      GATEWAY_CWD=~/proj    →     agentManager.cwd, commandRegistry
(implicit)      →      NODE_ENV=production   →     app.ts serves static files
(implicit)      →      CLIENT_DIST_PATH=...  →     app.ts uses custom dist path
cwd/.env        →      (dotenv loads)        →     NGROK_AUTHTOKEN, TUNNEL_AUTH, etc.
```

## 8. User Experience

### Installation

```bash
# Global install
npm install -g @dork/os

# Or run directly
npx @dork/os
```

### Usage

```bash
# Start with defaults (port 6942, no tunnel)
dorkos

# Start with tunnel
dorkos --tunnel

# Custom port and working directory
dorkos --port 8080 --dir ~/projects/myapp

# Help
dorkos --help
```

### Output

```
DorkOS running on http://localhost:6942

┌─────────────────────────────────────────────────┐
│  ngrok tunnel active                            │
│  URL:  https://abc123.ngrok-free.app            │
│  Port: 6942                                     │
└─────────────────────────────────────────────────┘
```

### Error: Claude CLI not found

```
Error: Claude Code CLI not found in PATH.

DorkOS requires the Claude Code CLI to function.
Install it with:  npm install -g @anthropic-ai/claude-code

More info: https://docs.anthropic.com/en/docs/claude-code
```

## 9. Testing Strategy

### Unit Tests (`packages/cli/src/__tests__/`)

**`check-claude.test.ts`** — Tests the Claude CLI availability check:
- Exits with error when `claude` not found (mock `execSync` to throw)
- Succeeds silently when `claude` is found (mock `execSync` to return)
- Error message includes install instructions

**`cli.test.ts`** — Tests CLI argument parsing:
- `--help` prints usage and exits 0
- `--version` reads package.json version and exits 0
- `--port 8080` sets `GATEWAY_PORT` env var
- `--tunnel` sets `TUNNEL_ENABLED=true`
- `--dir /tmp` sets `GATEWAY_CWD` and resolves to absolute path
- Default values: port 6942, no tunnel, cwd = process.cwd()

### Integration Tests

**`build.test.ts`** — Tests the build pipeline (can be slow, tagged):
- `dist/bin/cli.js` exists and has shebang
- `dist/server/index.js` exists and is a valid ESM module
- `dist/client/index.html` exists
- `dist/bin/cli.js` is executable (chmod 755)

### Existing Test Suites

All existing tests in `apps/server` and `apps/client` must continue passing. The env var changes use fallback values that preserve current behavior.

### Manual Verification

```bash
# Build the CLI package
cd packages/cli && npm run build

# Test locally (from monorepo root)
node packages/cli/dist/bin/cli.js --help
node packages/cli/dist/bin/cli.js --version
node packages/cli/dist/bin/cli.js --port 8080

# Test npm pack
cd packages/cli && npm pack --dry-run
```

## 10. Performance Considerations

- **Startup time**: The CLI adds ~50ms overhead (parseArgs + claude check + dotenv). Server startup dominates at ~200-500ms.
- **Package size**: Target ~1-2MB for the published package (server bundle ~500KB + client assets ~500KB). Node modules installed separately by npm.
- **esbuild**: Bundling is fast (<1s for the server). Vite client build is the bottleneck (~5-10s).
- **Dynamic import of `@ngrok/ngrok`**: Already lazy-loaded in tunnel-manager.ts, so no startup cost when tunnel is disabled.

## 11. Security Considerations

- **No credentials in package**: The CLI reads `.env` from user's cwd at runtime; nothing sensitive is bundled.
- **execSync for claude check**: Only runs `claude --version` with `stdio: 'pipe'` — no user input, no shell injection vector.
- **PATH-based resolution**: The CLI relies on `claude` being in PATH, which is the standard pattern for CLI tools.

## 12. Documentation

- `dorkos --help` provides inline usage documentation
- CLAUDE.md should be updated with the new `packages/cli` workspace and its commands
- No separate guide needed for the first release

## 13. Implementation Phases

### Phase 1: Core CLI Package

1. Create `packages/cli/` with `package.json`, `tsconfig.json`
2. Implement `src/cli.ts` (parseArgs, env var setup, dynamic import)
3. Implement `src/check-claude.ts` (Claude CLI availability check)
4. Implement `scripts/build.ts` (esbuild + vite + copy)
5. Add `CLIENT_DIST_PATH` env var to `apps/server/src/app.ts`
6. Add `GATEWAY_CWD` env var to `apps/server/src/routes/commands.ts` and `apps/server/src/services/agent-manager.ts`
7. Make `.env` loading conditional in `apps/server/src/index.ts`
8. Add listen host toggle for tunnel mode in `apps/server/src/index.ts`

### Phase 2: Testing & Validation

9. Write unit tests for CLI entry point and claude check
10. Write build integration test
11. Verify all existing tests still pass
12. Manual end-to-end test: `node dist/bin/cli.js` serves the UI
13. Manual test: `npm pack --dry-run` shows expected file list

### Phase 3: Turbo Integration

14. Add `pack` task to `turbo.json`
15. Update CLAUDE.md with new package and commands

## 14. Open Questions

None — all questions were resolved during ideation.

## 15. References

- Ideation: `specs/cli-package/01-ideation.md`
- Research: `/tmp/research_20260212_nodejs_monorepo_npm_packaging.md`
- esbuild docs: https://esbuild.github.io/
- Node.js parseArgs: https://nodejs.org/api/util.html#utilparseargsconfig
- npm package.json spec: https://docs.npmjs.com/cli/v10/configuring-npm/package-json
