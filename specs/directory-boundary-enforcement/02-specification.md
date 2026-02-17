---
slug: directory-boundary-enforcement
number: 34
created: 2026-02-16
status: specified
---

# Centralized Directory Boundary Enforcement

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-16

## Overview

Centralize the directory boundary check into a shared utility, enforce it across all API endpoints and services that accept `cwd`/`path`/`dir` parameters, and make the boundary configurable via `server.boundary` in `~/.dork/config.json`. This closes security gaps where 9 of 10 cwd-accepting endpoints currently perform zero boundary validation.

## Background / Problem Statement

DorkOS restricts directory browsing to `~/` via a hardcoded check in `routes/directory.ts`. However, this is the **only** endpoint with boundary enforcement. Nine other endpoints accept arbitrary `cwd`/`path`/`dir` parameters and pass them directly to services that perform filesystem operations (`execFile`, `readdir`, `readFile`) without validation.

**Current security gaps:**
- `POST /api/sessions` — creates agent sessions in arbitrary directories
- `GET /api/sessions` — lists transcripts from arbitrary project slugs
- `GET /api/sessions/:id`, `/messages`, `/tasks` — reads transcripts from arbitrary paths
- `GET /api/files` — lists files in arbitrary directories via `git ls-files` or `readdir`
- `GET /api/commands` — scans `.claude/commands/` from arbitrary roots
- `GET /api/git/status` — executes `git status` in arbitrary directories

Additionally, the existing boundary check has a prefix collision bug: `startsWith(HOME)` without `path.sep` means a home directory of `/home/user` would incorrectly allow access to `/home/username`.

## Goals

- Centralize boundary validation into a single shared utility function
- Enforce boundary at both route and service layers (defense-in-depth)
- Make the boundary configurable via `server.boundary` config, `DORKOS_BOUNDARY` env var, and `--boundary` CLI flag
- Fix the `startsWith` prefix collision bug
- Validate `DORKOS_DEFAULT_CWD` against boundary at startup with graceful fallback
- Maintain backward compatibility — default behavior (boundary = `~/`) unchanged

## Non-Goals

- DirectTransport (Obsidian plugin) boundary refactor (follow-up spec)
- Windows path compatibility (noted, not addressed)
- Settings UI for boundary configuration
- Per-user boundary scoping
- Authentication or authorization

## Technical Dependencies

- No new external libraries required
- Uses existing: `fs/promises` (`realpath`), `path` (`resolve`, `sep`), `os` (`homedir`)
- Existing `conf` package for config persistence (already in use)
- Zod for schema validation (already in use)

## Detailed Design

### 1. Shared Boundary Utility

**New file:** `apps/server/src/lib/boundary.ts`

```typescript
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/** Error thrown when a path violates the directory boundary. */
export class BoundaryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
  }
}

/** Resolved boundary root, set once at startup via initBoundary(). */
let resolvedBoundary: string | null = null;

/**
 * Initialize the boundary root. Must be called once at server startup.
 * Resolves symlinks and stores the canonical path.
 *
 * @param boundary - Configured boundary path, or null for os.homedir()
 */
export async function initBoundary(boundary?: string | null): Promise<string> {
  const raw = boundary ?? os.homedir();
  resolvedBoundary = await fs.realpath(raw);
  return resolvedBoundary;
}

/** Get the resolved boundary. Throws if initBoundary() hasn't been called. */
export function getBoundary(): string {
  if (!resolvedBoundary) {
    throw new Error('Boundary not initialized. Call initBoundary() at startup.');
  }
  return resolvedBoundary;
}

/**
 * Validate that a path is within the directory boundary.
 *
 * @param userPath - User-supplied path (absolute)
 * @param boundary - Optional boundary override (defaults to initialized boundary)
 * @returns Resolved canonical path
 * @throws BoundaryError if path is outside boundary or invalid
 */
export async function validateBoundary(
  userPath: string,
  boundary?: string
): Promise<string> {
  const root = boundary ?? getBoundary();

  // Reject null bytes
  if (userPath.includes('\0')) {
    throw new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE');
  }

  // Resolve and follow symlinks
  let resolved: string;
  try {
    resolved = await fs.realpath(userPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Path doesn't exist yet — resolve without symlink follow
      resolved = path.resolve(userPath);
    } else if (code === 'EACCES') {
      throw new BoundaryError('Permission denied', 'PERMISSION_DENIED');
    } else {
      throw err;
    }
  }

  // Boundary check: path must equal boundary or be a child of it
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new BoundaryError(
      'Access denied: path outside directory boundary',
      'OUTSIDE_BOUNDARY'
    );
  }

  return resolved;
}

/**
 * Check if a path is within the boundary without throwing.
 *
 * @returns true if within boundary, false otherwise
 */
export async function isWithinBoundary(
  userPath: string,
  boundary?: string
): Promise<boolean> {
  try {
    await validateBoundary(userPath, boundary);
    return true;
  } catch {
    return false;
  }
}
```

**Key design decisions:**
- **Module-level state** (`resolvedBoundary`): Set once at startup, avoids passing boundary through every call. The `getBoundary()` accessor throws if not initialized, preventing silent misuse.
- **`resolved === root` check**: Allows the boundary root itself to be a valid path (e.g., `~/` when boundary is `~/`).
- **ENOENT fallback**: For session creation, the target directory may not exist yet (SDK creates it). We use `path.resolve()` without `realpath()` in this case — the symlink resolution matters less than the boundary containment check.
- **No URL decoding**: DorkOS paths come from JSON request bodies (already decoded by Express), not URL path segments. Iterative URL decoding is unnecessary.

### 2. Config Schema Update

**Modified file:** `packages/shared/src/config-schema.ts`

Add `boundary` to the `server` object:

```typescript
server: z.object({
  port: z.number().int().min(1024).max(65535).default(4242),
  cwd: z.string().nullable().default(null),
  boundary: z.string().nullable().default(null),  // NEW
}).default(() => ({ port: 4242, cwd: null, boundary: null })),
```

`null` means "use `os.homedir()`" — consistent with how `cwd: null` means "use `process.cwd()`".

### 3. CLI Entry Point Update

**Modified file:** `packages/cli/src/cli.ts`

Add `--boundary` flag and `DORKOS_BOUNDARY` env var handling:

```typescript
const { values, positionals } = parseArgs({
  options: {
    // ... existing options ...
    boundary: { type: 'string', short: 'b' },  // NEW
  },
  allowPositionals: true,
});
```

After config manager init, add boundary resolution:

```typescript
// Boundary: CLI flag > env var > config > os.homedir()
const cliBoundary = values.boundary;
if (cliBoundary) {
  process.env.DORKOS_BOUNDARY = path.resolve(cliBoundary);
} else if (!process.env.DORKOS_BOUNDARY) {
  const configBoundary = cfgMgr.getDot('server.boundary') as string | null;
  if (configBoundary) {
    process.env.DORKOS_BOUNDARY = path.resolve(configBoundary);
  }
  // If still not set, server will default to os.homedir() in initBoundary()
}

// Warn if boundary is above home directory
const boundaryVal = process.env.DORKOS_BOUNDARY;
const home = os.homedir();
if (boundaryVal && !boundaryVal.startsWith(home + path.sep) && boundaryVal !== home) {
  console.warn(
    `[Warning] Directory boundary "${boundaryVal}" is above home directory "${home}". ` +
    `This grants access to system directories.`
  );
}
```

After setting `DORKOS_DEFAULT_CWD`, validate it against boundary:

```typescript
// Validate default CWD is within boundary
const effectiveBoundary = process.env.DORKOS_BOUNDARY || home;
const resolvedDir = process.env.DORKOS_DEFAULT_CWD!;
if (
  resolvedDir !== effectiveBoundary &&
  !resolvedDir.startsWith(effectiveBoundary + path.sep)
) {
  console.warn(
    `[Warning] Default CWD "${resolvedDir}" is outside boundary "${effectiveBoundary}". ` +
    `Falling back to boundary root.`
  );
  process.env.DORKOS_DEFAULT_CWD = effectiveBoundary;
}
```

Update help text to include the new flag:

```
  -b, --boundary <path>  Directory boundary (default: home directory)
```

### 4. Server Startup Initialization

**Modified file:** `apps/server/src/index.ts`

Add boundary initialization in the `start()` function, after `initConfigManager()`:

```typescript
import { initBoundary } from './lib/boundary.js';

async function start() {
  initConfigManager();

  // Initialize directory boundary (must happen before app creation)
  const boundaryConfig = process.env.DORKOS_BOUNDARY || undefined;
  const resolvedBoundary = await initBoundary(boundaryConfig);
  console.log(`[Boundary] Directory boundary: ${resolvedBoundary}`);

  const app = createApp();
  // ... rest unchanged
}
```

### 5. Route-Level Enforcement

Each route handler that accepts `cwd`/`path`/`dir` must validate before passing to services.

**Helper pattern** (used in each route file):

```typescript
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

// In route handler, after Zod parse:
try {
  const validatedCwd = await validateBoundary(cwd);
  // use validatedCwd
} catch (err) {
  if (err instanceof BoundaryError) {
    return res.status(403).json({ error: err.message, code: err.code });
  }
  throw err;
}
```

#### `routes/directory.ts` — Refactor

Remove hardcoded `const HOME = os.homedir()`. Replace with shared utility:

```typescript
import { validateBoundary, getBoundary, BoundaryError } from '../lib/boundary.js';

router.get('/', async (req, res) => {
  // ... Zod parse ...
  const boundary = getBoundary();
  const targetPath = userPath || boundary;

  if (targetPath.includes('\0')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  let resolved: string;
  try {
    resolved = await validateBoundary(targetPath);
  } catch (err) {
    if (err instanceof BoundaryError) {
      if (err.code === 'OUTSIDE_BOUNDARY') {
        return res.status(403).json({ error: 'Access denied: path outside directory boundary' });
      }
      return res.status(403).json({ error: err.message });
    }
    // ENOENT, EACCES handled by validateBoundary
    throw err;
  }

  // ... readdir logic unchanged ...

  const parent = path.dirname(resolved);
  const hasParent = parent !== resolved &&
    (parent === boundary || parent.startsWith(boundary + path.sep));

  res.json({ path: resolved, entries, parent: hasParent ? parent : null });
});
```

The `/default` endpoint also needs boundary awareness:

```typescript
router.get('/default', (_req, res) => {
  // Return the effective default CWD (already validated at startup)
  res.json({ path: process.env.DORKOS_DEFAULT_CWD || process.cwd() });
});
```

#### `routes/sessions.ts` — Add Validation

For each endpoint accepting `cwd`:

**POST `/api/sessions`** (line 29):
```typescript
const { permissionMode = 'default', cwd } = parsed.data;
let validatedCwd = cwd;
if (cwd) {
  try {
    validatedCwd = await validateBoundary(cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}
agentManager.ensureSession(sessionId, { permissionMode, cwd: validatedCwd });
```

**GET endpoints** (list, detail, messages, tasks) — all follow the same pattern:
```typescript
const rawCwd = (req.query.cwd as string) || parsed.data.cwd;
let projectDir = rawCwd || vaultRoot;
if (rawCwd) {
  try {
    projectDir = await validateBoundary(rawCwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}
```

#### `routes/files.ts` — Add Validation

```typescript
const parsed = FileListQuerySchema.safeParse(req.query);
if (!parsed.success) { /* 400 */ }
try {
  const validatedCwd = await validateBoundary(parsed.data.cwd);
  const result = await fileLister.listFiles(validatedCwd);
  res.json(result);
} catch (err) {
  if (err instanceof BoundaryError) {
    return res.status(403).json({ error: err.message, code: err.code });
  }
  throw err;
}
```

#### `routes/commands.ts` — Add Validation

```typescript
const rawCwd = parsed.data.cwd;
let validatedRoot: string | undefined;
if (rawCwd) {
  try {
    validatedRoot = await validateBoundary(rawCwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}
const registry = getRegistry(validatedRoot);
```

#### `routes/git.ts` — Add Validation

```typescript
const rawDir = parsed.data.dir;
let cwd = rawDir || process.cwd();
if (rawDir) {
  try {
    cwd = await validateBoundary(rawDir);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}
const result = await getGitStatus(cwd);
```

### 6. Service-Level Enforcement (Defense-in-Depth)

Services validate independently of routes. This protects against future code paths that bypass route handlers (e.g., direct service calls from new features, Obsidian plugin's DirectTransport).

**Pattern**: Import `validateBoundary` and call it at the service entry point. Use a try/catch that re-throws as the service's native error type, or let `BoundaryError` propagate.

#### `services/agent-manager.ts`

Validate in `ensureSession()` when `cwd` is provided:

```typescript
import { validateBoundary } from '../lib/boundary.js';

ensureSession(
  sessionId: string,
  opts: { permissionMode: PermissionMode; cwd?: string; hasStarted?: boolean }
): void {
  // Validate cwd if provided (async validation done at route level,
  // but sync check here as defense-in-depth)
  if (!this.sessions.has(sessionId)) {
    this.sessions.set(sessionId, {
      sdkSessionId: sessionId,
      lastActivity: Date.now(),
      permissionMode: opts.permissionMode,
      cwd: opts.cwd,  // Already validated by route
      hasStarted: opts.hasStarted ?? false,
      pendingInteractions: new Map(),
      eventQueue: [],
    });
  }
}
```

For `AgentManager`, defense-in-depth validation happens in `sendMessage()` before the SDK call:

```typescript
async *sendMessage(
  sessionId: string,
  content: string,
  opts?: { permissionMode?: PermissionMode; cwd?: string }
): AsyncGenerator<StreamEvent> {
  // ... existing session setup ...

  const effectiveCwd = session.cwd ?? this.cwd;

  // Defense-in-depth: validate the cwd that will be passed to SDK
  try {
    await validateBoundary(effectiveCwd);
  } catch (err) {
    yield {
      type: 'error',
      data: { message: `Directory boundary violation: ${effectiveCwd}` },
    };
    return;
  }

  const sdkOptions: Options = {
    cwd: effectiveCwd,
    // ... rest unchanged
  };
```

#### `services/file-lister.ts`

Validate at the start of `listFiles()`:

```typescript
import { validateBoundary } from '../lib/boundary.js';

async listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }> {
  // Defense-in-depth boundary check
  await validateBoundary(cwd);

  const cached = this.cache.get(cwd);
  // ... rest unchanged
}
```

#### `services/git-status.ts`

Validate at the start of `getGitStatus()`:

```typescript
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

export async function getGitStatus(cwd: string): Promise<GitStatusResponse | GitStatusError> {
  // Defense-in-depth boundary check
  try {
    await validateBoundary(cwd);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return { error: 'not_git_repo' as const };
    }
    throw err;
  }

  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], {
      cwd,
      timeout: GIT.STATUS_TIMEOUT_MS,
    });
    return parsePorcelainOutput(stdout);
  } catch {
    return { error: 'not_git_repo' as const };
  }
}
```

#### `services/transcript-reader.ts`

Validate `vaultRoot` in methods that accept it:

```typescript
import { validateBoundary } from '../lib/boundary.js';

async listSessions(vaultRoot: string): Promise<Session[]> {
  await validateBoundary(vaultRoot);
  const transcriptsDir = this.getTranscriptsDir(vaultRoot);
  // ... rest unchanged
}
```

Same pattern for `getSession()`, `readTranscript()`, `readTasks()`, `readFromOffset()`, `getTranscriptETag()`.

#### `services/command-registry.ts`

Validate in the constructor:

```typescript
import { validateBoundary } from '../lib/boundary.js';

export class CommandRegistryService {
  private commandsDir: string;

  constructor(vaultRoot: string) {
    this.commandsDir = path.join(vaultRoot, '.claude', 'commands');
    // Note: constructor can't be async, so validation happens at call site
    // (route handler or getRegistry() helper validates before constructing)
  }
}
```

Since the constructor can't be `async`, the `getRegistry()` helper in `routes/commands.ts` validates before construction. The service trusts that input is pre-validated.

## User Experience

No visible UI changes. The boundary is transparent — users interact with the directory picker and session management as before. The default boundary (`~/`) matches the existing hardcoded behavior.

**New configuration surface:**

```bash
# CLI flag
dorkos --boundary ~/projects

# Environment variable
DORKOS_BOUNDARY=~/projects dorkos

# Config file
dorkos config set server.boundary ~/projects
dorkos config get server.boundary
```

**Error experience**: If a user (or API caller) provides a `cwd` outside the boundary, they receive a `403` with:
```json
{
  "error": "Access denied: path outside directory boundary",
  "code": "OUTSIDE_BOUNDARY"
}
```

## Testing Strategy

### Unit Tests: Boundary Utility

**New file:** `apps/server/src/lib/__tests__/boundary.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('validateBoundary', () => {
  // Core validation
  it('allows paths within boundary', async () => { /* /home/user/projects within /home/user */ });
  it('allows the boundary root itself', async () => { /* /home/user within /home/user */ });
  it('rejects paths outside boundary', async () => { /* /etc within /home/user */ });

  // Prefix collision fix (the bug we're fixing)
  it('rejects /home/username when boundary is /home/user', async () => {
    /* This is the critical test for the path.sep fix */
  });

  // Security
  it('rejects null bytes', async () => { /* path containing \0 */ });
  it('rejects paths with .. that escape boundary', async () => {
    /* /home/user/../etc resolves to /etc → rejected */
  });
  it('follows symlinks when checking boundary', async () => {
    /* symlink inside boundary pointing outside → rejected */
  });

  // Edge cases
  it('handles ENOENT gracefully (path.resolve fallback)', async () => {
    /* Non-existent path still checked against boundary */
  });
  it('throws PERMISSION_DENIED for EACCES', async () => { });
  it('works with trailing slashes', async () => { });
});

describe('initBoundary', () => {
  it('resolves symlinks at startup', async () => { });
  it('defaults to os.homedir() when null', async () => { });
  it('stores resolved path for getBoundary()', async () => { });
});

describe('isWithinBoundary', () => {
  it('returns true for valid paths', async () => { });
  it('returns false for invalid paths (does not throw)', async () => { });
});
```

### Updated Tests: Directory Route

**Modified file:** `apps/server/src/routes/__tests__/directory.test.ts`

Update existing tests to use the initialized boundary instead of hardcoded `HOME`. Mock `initBoundary()` to set a test boundary. Key changes:

- Replace hardcoded `os.homedir()` expectations with boundary-relative assertions
- Add test: "rejects paths outside configured boundary (not just HOME)"
- Add test: "parent navigation stops at boundary root"

### Integration Tests: Route Boundary Enforcement

Add boundary rejection tests to existing route test files (or create new ones):

- `routes/__tests__/sessions.test.ts`: POST create with cwd outside boundary → 403
- `routes/__tests__/files.test.ts`: GET with cwd outside boundary → 403
- `routes/__tests__/commands.test.ts`: GET with cwd outside boundary → 403
- `routes/__tests__/git.test.ts`: GET with dir outside boundary → 403

### Config Schema Tests

**Modified file:** `packages/shared/src/__tests__/config-schema.test.ts`

- Add: `server.boundary` defaults to `null`
- Add: `server.boundary` accepts string paths
- Add: Full config round-trip with boundary field

## Performance Considerations

- **`fs.realpath()` on every request**: ~0.1ms for local paths. Negligible overhead for the request volumes DorkOS handles (interactive tool, not high-throughput API).
- **Defense-in-depth double-validation**: Same path validated at route and service level. The second `realpath()` call hits the OS filesystem cache. Cost is ~0.05ms — acceptable for security guarantee.
- **Boundary initialization at startup**: Single `fs.realpath()` call. No ongoing cost.

## Security Considerations

- **Boundary is enforced server-side**: Client cannot bypass it. Even with a crafted HTTP request, all cwd-accepting endpoints validate.
- **Symlink resolution**: `fs.realpath()` follows symlinks to their real target, preventing symlink-based boundary escapes.
- **Null byte rejection**: Prevents null byte injection attacks that could truncate paths.
- **`path.sep` suffix**: Prevents prefix collision where `/home/user` boundary incorrectly allows `/home/username`.
- **Defense-in-depth**: Even if a route handler is added without boundary validation, the service layer catches it.
- **ENOENT handling**: Non-existent paths are still boundary-checked via `path.resolve()` — prevents speculative path creation outside boundary.
- **Not addressed (out of scope)**: TOCTOU races (acceptable for a local tool), Windows case-insensitivity, Unicode normalization attacks.

## Documentation

Files to update after implementation:

- `guides/configuration.md` — Add `server.boundary` reference, env var, CLI flag
- `CLAUDE.md` — Update CLI commands section with `--boundary` flag
- `packages/cli/README.md` — Update CLI help reference
- `docs/getting-started/configuration.mdx` — Add `DORKOS_BOUNDARY` to env var table

## Implementation Phases

### Phase 1: Core Infrastructure

1. Create `apps/server/src/lib/boundary.ts` with `initBoundary()`, `getBoundary()`, `validateBoundary()`, `isWithinBoundary()`, and `BoundaryError`
2. Create `apps/server/src/lib/__tests__/boundary.test.ts` with comprehensive tests
3. Update `packages/shared/src/config-schema.ts` — add `server.boundary` field
4. Update `packages/cli/src/cli.ts` — add `--boundary` flag, env var handling, startup validation

### Phase 2: Server Initialization

5. Update `apps/server/src/index.ts` — call `initBoundary()` at startup

### Phase 3: Route-Level Enforcement

6. Refactor `routes/directory.ts` — replace hardcoded HOME with shared utility
7. Update `routes/sessions.ts` — add validation to all 5 cwd-accepting endpoints
8. Update `routes/files.ts` — add validation
9. Update `routes/commands.ts` — add validation
10. Update `routes/git.ts` — add validation

### Phase 4: Service-Level Enforcement

11. Update `services/agent-manager.ts` — validate in sendMessage()
12. Update `services/transcript-reader.ts` — validate vaultRoot in all public methods
13. Update `services/file-lister.ts` — validate in listFiles()
14. Update `services/git-status.ts` — validate in getGitStatus()

### Phase 5: Tests & Documentation

15. Update `routes/__tests__/directory.test.ts` for configurable boundary
16. Add boundary rejection tests for sessions, files, commands, git routes
17. Update config schema tests
18. Update documentation (guides, CLAUDE.md, docs/)

## Open Questions

None — all clarifications resolved during ideation.

## Related ADRs

- **ADR-0001**: Use Hexagonal Architecture — the boundary utility follows the pattern of framework-agnostic business logic callable from both Express routes and DirectTransport
- **ADR-0003**: SDK JSONL as Single Source of Truth — transcript reading paths are among those needing boundary validation

A new ADR should be created post-implementation: "Use centralized directory boundary enforcement with defense-in-depth validation."

## References

- [Ideation document](./01-ideation.md)
- [Research: Directory Boundary Sandbox](../../research/20260216_directory_boundary_sandbox.md) — 40+ sources on path traversal security, production patterns (FileBrowser, VS Code Server), and implementation approaches
- [Node.js Path Traversal Security](https://nodejsdesignpatterns.com/blog/nodejs-path-traversal-security/) — canonical `safeResolve()` pattern
- [StackHawk Path Traversal Guide](https://www.stackhawk.com/blog/node-js-path-traversal-guide-examples-and-prevention/) — null byte validation, path.sep suffix
- [FileBrowser Configuration](https://filebrowser.org/cli/filebrowser-config-set) — root + scope pattern (industry standard)
