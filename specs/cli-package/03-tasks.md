---
slug: cli-package
generated: 2026-02-12
---

# Task Breakdown: Publishable npm CLI Package (`@lifeos/gateway`)

## Phase 1: Server Modifications

### Task 1.1: [cli-package] [P1] Add environment variable overrides to apps/server

**activeForm**: Adding environment variable overrides to server entry, app, routes, and services

**Dependencies**: None

**Description**:

Make four targeted changes to `apps/server` to support CLI-mode operation via environment variables. Every change includes a fallback that preserves current monorepo behavior.

#### 1. `apps/server/src/app.ts` — Add `CLIENT_DIST_PATH` env var (section 7.4)

```typescript
// Before (line 37):
const distPath = path.join(__dirname, '../../client/dist');

// After:
const distPath = process.env.CLIENT_DIST_PATH
  ?? path.join(__dirname, '../../client/dist');
```

#### 2. `apps/server/src/index.ts` — Conditional .env loading (section 7.5 item 1)

```typescript
// Before (line 9):
dotenv.config({ path: path.join(__dirname, '../../../.env') });

// After:
if (!process.env.CLIENT_DIST_PATH) {
  dotenv.config({ path: path.join(__dirname, '../../../.env') });
}
```

#### 3. `apps/server/src/index.ts` — Listen host toggle (section 7.5 item 2)

```typescript
// Before (line 15):
app.listen(PORT, 'localhost', () => {

// After:
const host = process.env.TUNNEL_ENABLED === 'true' ? '0.0.0.0' : 'localhost';
app.listen(PORT, host, () => {
```

#### 4. `apps/server/src/routes/commands.ts` — Add `GATEWAY_CWD` env var (section 7.6)

```typescript
// Before (line 8):
const vaultRoot = path.resolve(__dirname, '../../../../');

// After:
const vaultRoot = process.env.GATEWAY_CWD ?? path.resolve(__dirname, '../../../../');
```

#### 5. `apps/server/src/services/agent-manager.ts` — Add `GATEWAY_CWD` env var (section 7.7)

```typescript
// Before (line 178):
this.cwd = cwd ?? path.resolve(__dirname, '../../../../');

// After:
this.cwd = cwd ?? process.env.GATEWAY_CWD ?? path.resolve(__dirname, '../../../../');
```

**Acceptance Criteria**:
- All existing tests still pass (`turbo test`)
- Without any env vars set, server behavior is identical to before
- With `CLIENT_DIST_PATH` set, server uses that path for static file serving
- With `GATEWAY_CWD` set, agent-manager and commands use that directory
- With `TUNNEL_ENABLED=true`, server listens on `0.0.0.0` instead of `localhost`
- With `CLIENT_DIST_PATH` set, .env loading from monorepo root is skipped

---

### Task 1.2: [cli-package] [P1] Create packages/cli workspace package scaffold

**activeForm**: Creating the packages/cli workspace scaffold with package.json, tsconfig, and directory structure

**Dependencies**: None

**Description**:

Create the `packages/cli/` directory with the package scaffold. This establishes the workspace package that will be published as `@lifeos/gateway`.

#### 1. Create directory structure

```
packages/cli/
├── package.json
├── tsconfig.json
├── src/
├── scripts/
└── bin/
```

#### 2. `packages/cli/package.json` (section 7.9)

```json
{
  "name": "@lifeos/gateway",
  "version": "0.1.0",
  "description": "Web-based interface and REST/SSE API for Claude Code",
  "type": "module",
  "bin": {
    "lifeos-gateway": "./dist/bin/cli.js"
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
    "@lifeos/typescript-config": "*",
    "esbuild": "^0.24.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

#### 3. `packages/cli/tsconfig.json`

Extends shared TypeScript config with appropriate settings for the CLI package.

#### 4. Add `pack` task to `turbo.json` (section 7.10)

```json
{
  "pack": {
    "dependsOn": ["^build"],
    "outputs": ["dist/**"],
    "cache": false
  }
}
```

**Acceptance Criteria**:
- `npm install` from root succeeds and resolves `@lifeos/gateway` workspace
- `turbo` recognizes the new workspace in `npx turbo ls`
- The `pack` task is listed in turbo tasks
- Directory structure is in place for subsequent tasks

---

## Phase 2: CLI Implementation

### Task 2.1: [cli-package] [P2] Implement CLI entry point (src/cli.ts)

**activeForm**: Implementing the CLI entry point with argument parsing and server bootstrapping

**Dependencies**: Task 1.2

**Description**:

Implement the main CLI entry point that parses arguments, sets environment variables, and dynamically imports the bundled server.

#### `packages/cli/src/cli.ts` (section 7.2)

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

The `--help` handler should print usage text similar to:

```
Usage: lifeos-gateway [options]

Web-based interface and REST/SSE API for Claude Code

Options:
  -p, --port <port>  Port to listen on (default: 6942)
  -t, --tunnel       Enable ngrok tunnel
  -d, --dir <path>   Working directory (default: current directory)
  -h, --help         Show this help message
  -v, --version      Show version number
```

**Acceptance Criteria**:
- `--help` prints usage and exits with code 0
- `--version` reads version from package.json and exits with code 0
- `--port 8080` sets `GATEWAY_PORT=8080`
- `--tunnel` sets `TUNNEL_ENABLED=true`
- `--dir /tmp` sets `GATEWAY_CWD=/tmp` (resolved to absolute path)
- Default values: port 6942, no tunnel, dir = process.cwd()
- `.env` from target directory is loaded if it exists
- `CLIENT_DIST_PATH` is set to the correct relative dist/client path

---

### Task 2.2: [cli-package] [P2] Implement Claude CLI check (src/check-claude.ts)

**activeForm**: Implementing the Claude CLI availability check with helpful error messaging

**Dependencies**: Task 1.2

**Description**:

Implement the Claude CLI availability check that runs before server startup.

#### `packages/cli/src/check-claude.ts` (section 7.3)

```typescript
import { execSync } from 'child_process';

export function checkClaude(): void {
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: Claude Code CLI not found in PATH.');
    console.error('');
    console.error('LifeOS Gateway requires the Claude Code CLI to function.');
    console.error('Install it with:  npm install -g @anthropic-ai/claude-code');
    console.error('');
    console.error('More info: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }
}
```

**Acceptance Criteria**:
- When `claude` is in PATH, function returns silently (no output)
- When `claude` is NOT in PATH, function prints error with install instructions and exits with code 1
- Error message includes `npm install -g @anthropic-ai/claude-code`
- Error message includes documentation link
- Function is exported and importable from cli.ts

---

## Phase 3: Build Pipeline

### Task 3.1: [cli-package] [P3] Implement build script (scripts/build.ts)

**activeForm**: Implementing the three-step build pipeline with Vite client build, esbuild server bundle, and CLI compilation

**Dependencies**: Task 1.1, Task 1.2, Task 2.1, Task 2.2

**Description**:

Implement the build script that produces the final distributable package. Three steps: Vite client build, esbuild server bundle (inlining @lifeos/shared), esbuild CLI entry compilation.

#### `packages/cli/scripts/build.ts` (section 7.8)

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
  execSync('npx turbo build --filter=@lifeos/client', { cwd: ROOT, stdio: 'inherit' });
  await fs.cp(path.join(ROOT, 'apps/client/dist'), path.join(OUT, 'client'), { recursive: true });

  // 2. Bundle server (esbuild) — inlines @lifeos/shared, externalizes node_modules
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

**Acceptance Criteria**:
- Running `npm run build` in `packages/cli/` produces:
  - `dist/bin/cli.js` — executable CLI entry with shebang
  - `dist/server/index.js` — bundled server with `@lifeos/shared` inlined
  - `dist/server/index.js.map` — source map
  - `dist/client/index.html` — built React SPA
  - `dist/client/assets/` — client static assets
- `dist/bin/cli.js` has executable permissions (chmod 755)
- `dist/bin/cli.js` starts with `#!/usr/bin/env node`
- Server bundle externalizes all listed node_modules
- Server bundle includes `createRequire` banner for CJS compatibility

---

## Phase 4: Testing & Validation

### Task 4.1: [cli-package] [P4] Write unit tests for CLI and claude check

**activeForm**: Writing unit tests for the CLI entry point argument parsing and Claude CLI availability check

**Dependencies**: Task 2.1, Task 2.2

**Description**:

Write unit tests for the two CLI source files. Tests live in `packages/cli/src/__tests__/`.

#### `packages/cli/src/__tests__/check-claude.test.ts` (section 9)

Tests for the Claude CLI availability check:
- Exits with error when `claude` not found (mock `execSync` to throw)
- Succeeds silently when `claude` is found (mock `execSync` to return)
- Error message includes install instructions (`npm install -g @anthropic-ai/claude-code`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

describe('checkClaude', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds silently when claude is found', () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from('1.0.0'));
    // import and call checkClaude, expect no throw
  });

  it('exits with error when claude not found', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // import and call checkClaude
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('Claude Code CLI not found'));
    mockExit.mockRestore();
    mockError.mockRestore();
  });

  it('error message includes install instructions', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // import and call checkClaude
    expect(mockError).toHaveBeenCalledWith(expect.stringContaining('npm install -g @anthropic-ai/claude-code'));
    mockExit.mockRestore();
    mockError.mockRestore();
  });
});
```

#### `packages/cli/src/__tests__/cli.test.ts` (section 9)

Tests for CLI argument parsing:
- `--help` prints usage and exits 0
- `--version` reads package.json version and exits 0
- `--port 8080` sets `GATEWAY_PORT` env var
- `--tunnel` sets `TUNNEL_ENABLED=true`
- `--dir /tmp` sets `GATEWAY_CWD` and resolves to absolute path
- Default values: port 6942, no tunnel, cwd = process.cwd()

**Acceptance Criteria**:
- All new tests pass (`npx vitest run packages/cli/src/__tests__/`)
- All existing tests still pass (`turbo test`)
- Tests properly mock `execSync`, `process.exit`, `console.error`
- Tests clean up mocks in `afterEach`/`beforeEach`

---

### Task 4.2: [cli-package] [P4] End-to-end build validation and manual testing

**activeForm**: Validating the end-to-end build pipeline and performing manual smoke tests

**Dependencies**: Task 3.1

**Description**:

Validate that the full build pipeline works and the CLI serves the web UI.

#### Build Integration Test (section 9)

Verify after build:
- `dist/bin/cli.js` exists and has shebang (`#!/usr/bin/env node`)
- `dist/server/index.js` exists and is a valid ESM module
- `dist/client/index.html` exists
- `dist/bin/cli.js` is executable (chmod 755)

#### Manual Verification Steps (section 9)

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

Verify `npm pack --dry-run` shows expected files:
- `dist/bin/cli.js`
- `dist/server/index.js`
- `dist/client/index.html`
- `dist/client/assets/*`
- `package.json`

#### Update CLAUDE.md

Add `packages/cli` to the monorepo structure section and document the new commands:
- `npm run build` in `packages/cli` — build the CLI package
- `turbo run pack --filter=@lifeos/gateway` — build via turbo
- `node packages/cli/dist/bin/cli.js` — run locally

**Acceptance Criteria**:
- Full build completes without errors
- `node packages/cli/dist/bin/cli.js --help` prints usage
- `node packages/cli/dist/bin/cli.js --version` prints `0.1.0`
- `npm pack --dry-run` shows only expected files
- CLAUDE.md is updated with new package info
- All existing tests still pass

---

## Dependency Graph

```
Task 1.1 (server env vars)  ──────────────────────────────┐
                                                           │
Task 1.2 (package scaffold) ──┬──────────────────────────┐ │
                              │                          │ │
                              ├── Task 2.1 (cli.ts) ─────┼─┼── Task 3.1 (build script) ── Task 4.2 (e2e validation)
                              │                          │ │
                              └── Task 2.2 (check-claude) ┘ │
                                        │                   │
                                        └── Task 4.1 (unit tests)
```

## Parallel Opportunities

- **Phase 1**: Tasks 1.1 and 1.2 can run in parallel (no dependencies)
- **Phase 2**: Tasks 2.1 and 2.2 can run in parallel (both depend only on 1.2)
- **Phase 4**: Task 4.1 can start as soon as 2.1 and 2.2 are done (doesn't need build)

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| P1 | 1.1, 1.2 | Server modifications + package scaffold |
| P2 | 2.1, 2.2 | CLI entry point + Claude check |
| P3 | 3.1 | Build pipeline |
| P4 | 4.1, 4.2 | Tests + validation |

**Total**: 7 tasks across 4 phases
**Critical path**: 1.2 → 2.1 → 3.1 → 4.2
