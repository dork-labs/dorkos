---
slug: versioning-release-system
number: 33
created: 2026-02-16
status: decomposed
---

# Versioning, Release & Update System — Task Breakdown

**Spec**: [02-specification.md](./02-specification.md)
**Last Decompose**: 2026-02-16
**Total Tasks**: 11
**Phases**: 4

---

## Phase 1: Version Infrastructure

### Task 1.1: Create VERSION file and update spec status

**Objective**: Establish the single source of truth for the DorkOS version.

**Files to create:**

- `VERSION` at repo root

**Files to modify:**

- `specs/manifest.json` — update spec status to `implementing`

**Implementation:**

Create `VERSION` at repo root with content `0.1.0` — no trailing newline, no `v` prefix, no quotes:

```bash
printf "0.1.0" > VERSION
```

Edit `specs/manifest.json`: change the `versioning-release-system` entry's `status` from `"specified"` to `"implementing"`.

**Acceptance criteria:**

- `VERSION` file exists at repo root
- `cat VERSION` outputs exactly `0.1.0`
- Spec manifest shows `implementing` status
- File is committed to git

**Dependencies**: None (foundation task)

---

### Task 1.2: Create retroactive v0.1.0 git tag

**Objective**: Tag the commit published as v0.1.0 to npm so `git describe --tags` works.

**Implementation:**

1. Identify the correct commit SHA:

```bash
npm info dorkos time --json  # Find publish date
git log --oneline --after="<date>" --before="<date+1day>"  # Correlate
```

2. Create annotated tag:

```bash
git tag -a v0.1.0 -m "Release v0.1.0" <commit-sha>
git push origin v0.1.0
```

**Acceptance criteria:**

- `v0.1.0` annotated tag exists on the correct commit
- `git describe --tags` returns `v0.1.0` or `v0.1.0-N-gSHA`
- Tag is pushed to origin

**Dependencies**: Task 1.1

---

## Phase 2: CLI Startup Banner & Update Check

### Task 2.1: Create update-check.ts module

**Objective**: Implement npm registry version check with file-based 24h caching and 3s timeout.

**Files to create:**

- `packages/cli/src/update-check.ts`

**Implementation:**

Create `packages/cli/src/update-check.ts` with the following complete implementation:

```typescript
// packages/cli/src/update-check.ts

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

const CACHE_PATH = join(homedir(), '.dork', 'cache', 'update-check.json');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT = 3000; // 3 seconds

/**
 * Check the npm registry for a newer version of dorkos.
 *
 * @param currentVersion - The currently running version string (e.g., "0.1.0")
 * @returns The latest version string if newer than current, or null
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  // 1. Check cache
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const cache: UpdateCache = JSON.parse(raw);
    if (Date.now() - cache.checkedAt < CACHE_TTL) {
      return isNewer(cache.latestVersion, currentVersion) ? cache.latestVersion : null;
    }
  } catch {
    // Cache miss or corrupt — proceed to fetch
  }

  // 2. Fetch from npm registry (with timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch('https://registry.npmjs.org/dorkos/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };

    // 3. Write cache
    await mkdir(join(homedir(), '.dork', 'cache'), { recursive: true });
    await writeFile(
      CACHE_PATH,
      JSON.stringify({
        latestVersion: data.version,
        checkedAt: Date.now(),
      })
    );

    return isNewer(data.version, currentVersion) ? data.version : null;
  } catch {
    return null; // Network error, timeout, etc. — silently fail
  }
}

/**
 * Returns true if version `a` is newer than version `b` (simple semver comparison).
 *
 * @internal Exported for testing only.
 */
export function isNewer(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = a.split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('.').map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
```

Key design decisions:

- File-based cache at `~/.dork/cache/update-check.json` (survives process restarts)
- 24-hour cache TTL (CLI is short-lived, don't check every run)
- 3-second fetch timeout (don't delay startup)
- All errors silently return null (never block CLI startup)
- `isNewer` exported for direct testing

**Acceptance criteria:**

- Module exports `checkForUpdate(currentVersion: string): Promise<string | null>`
- Module exports `isNewer(a: string, b: string): boolean`
- Cache is read/written to `~/.dork/cache/update-check.json`
- Fetch has 3-second timeout via AbortController
- All errors return null silently

**Dependencies**: Task 1.1

---

### Task 2.2: Add CLI startup banner and non-blocking update notification

**Objective**: Display version, local URL, and network URL after server starts. Fire-and-forget update check with boxed notification.

**Files to modify:**

- `packages/cli/src/cli.ts`

**Implementation:**

Modify `packages/cli/src/cli.ts` to:

1. After `await import('../server/index.js');` at line 160, add the startup banner:

```typescript
import { networkInterfaces } from 'node:os';
import { checkForUpdate } from './update-check.js';

// ... after server import ...

// Print startup banner
const port = process.env.DORKOS_PORT || '4242';
console.log('');
console.log(`  DorkOS v${__CLI_VERSION__}`);
console.log(`  Local:   http://localhost:${port}`);

// Find first non-internal IPv4 address
const nets = networkInterfaces();
let networkUrl: string | null = null;
for (const name of Object.keys(nets)) {
  for (const net of nets[name] ?? []) {
    if (net.family === 'IPv4' && !net.internal) {
      networkUrl = `http://${net.address}:${port}`;
      break;
    }
  }
  if (networkUrl) break;
}
if (networkUrl) {
  console.log(`  Network: ${networkUrl}`);
}
console.log('');

// Non-blocking update check (fire-and-forget)
checkForUpdate(__CLI_VERSION__)
  .then((latestVersion) => {
    if (latestVersion) {
      const msg = `Update available: ${__CLI_VERSION__} → ${latestVersion}`;
      const cmd = 'Run npm update -g dorkos to update';
      const width = Math.max(msg.length, cmd.length) + 6;
      const pad = (s: string) => `│   ${s}${' '.repeat(width - s.length - 6)}   │`;
      console.log('');
      console.log(`┌${'─'.repeat(width - 2)}┐`);
      console.log(pad(msg));
      console.log(pad(cmd));
      console.log(`└${'─'.repeat(width - 2)}┘`);
      console.log('');
    }
  })
  .catch(() => {
    // Silently ignore — never interrupt server
  });
```

2. Move the `import` for `checkForUpdate` and `networkInterfaces` to the top of the file (with other imports).

**Banner output example:**

```
  DorkOS v0.1.0
  Local:   http://localhost:4242
  Network: http://192.168.1.5:4242
```

**Update notification example (if newer version exists):**

```
┌─────────────────────────────────────────┐
│   Update available: 0.1.0 → 0.2.0      │
│   Run npm update -g dorkos to update    │
└─────────────────────────────────────────┘
```

**Acceptance criteria:**

- `dorkos` shows startup banner with version and Local URL after server starts
- Network URL is shown if a non-internal IPv4 interface exists, omitted otherwise
- Update check fires after banner, does not block server startup
- If newer version, boxed message prints asynchronously
- If check fails, nothing is displayed (no error output)

**Dependencies**: Task 2.1

---

### Task 2.3: Write unit tests for update-check.ts

**Objective**: Full test coverage for the CLI update check module.

**Files to create:**

- `packages/cli/src/__tests__/update-check.test.ts`

**Implementation:**

Create `packages/cli/src/__tests__/update-check.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkForUpdate, isNewer } from '../update-check.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { readFile, writeFile, mkdir } from 'node:fs/promises';

describe('isNewer', () => {
  it('returns true when major is higher', () => {
    expect(isNewer('2.0.0', '1.0.0')).toBe(true);
  });

  it('returns true when minor is higher', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
  });

  it('returns true when patch is higher', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when version is older', () => {
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
  });

  it('returns false when lower major despite higher minor', () => {
    expect(isNewer('0.99.0', '1.0.0')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns cached result when cache is fresh', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.2.0',
        checkedAt: Date.now() - 1000, // 1 second ago
      })
    );

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.2.0');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null from cache when current version is up to date', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.1.0',
        checkedAt: Date.now() - 1000,
      })
    );

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('fetches from registry when cache is stale', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        latestVersion: '0.1.0',
        checkedAt: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      })
    );
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.3.0' }),
    });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.3.0');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/dorkos/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('fetches from registry when no cache file exists', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.2.0');
  });

  it('returns null on network timeout', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    mockFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    mockFetch.mockRejectedValue(new Error('Network failure'));

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('returns null when registry returns non-ok response', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    mockFetch.mockResolvedValue({ ok: false });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBeNull();
  });

  it('treats corrupt cache as cache miss', async () => {
    vi.mocked(readFile).mockResolvedValue('not-json!!!');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    const result = await checkForUpdate('0.1.0');
    expect(result).toBe('0.2.0');
  });

  it('writes cache after successful fetch', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    await checkForUpdate('0.1.0');
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('update-check.json'),
      expect.stringContaining('"latestVersion":"0.2.0"')
    );
  });
});
```

**Test cases (10 total):**

1. `isNewer` — major version higher
2. `isNewer` — minor version higher
3. `isNewer` — patch version higher
4. `isNewer` — equal versions
5. `isNewer` — older version
6. `isNewer` — lower major despite higher minor
7. `checkForUpdate` — returns cached result when fresh
8. `checkForUpdate` — returns null when up to date (from cache)
9. `checkForUpdate` — fetches when cache stale
10. `checkForUpdate` — fetches when no cache
11. `checkForUpdate` — returns null on timeout
12. `checkForUpdate` — returns null on network error
13. `checkForUpdate` — returns null on non-ok response
14. `checkForUpdate` — treats corrupt cache as miss
15. `checkForUpdate` — writes cache after fetch

**Acceptance criteria:**

- All tests pass with `npx vitest run packages/cli/src/__tests__/update-check.test.ts`
- No real network or file I/O (all mocked)
- Tests cover cache hit, cache miss, network failure, version comparison

**Dependencies**: Task 2.1

---

## Phase 3: Web UI Update Indicator

### Task 3.1: Create server-side update-checker.ts service

**Objective**: Provide latest version info to the config endpoint via an in-memory cached npm registry check.

**Files to create:**

- `apps/server/src/services/update-checker.ts`

**Implementation:**

Create `apps/server/src/services/update-checker.ts`:

```typescript
/**
 * Server-side npm registry check with in-memory cache.
 *
 * Key differences from CLI update check:
 * - In-memory cache only (no file I/O — server is long-running)
 * - 1-hour TTL (server stays running, should reflect updates sooner)
 * - 5-second timeout (server has more tolerance than CLI startup)
 *
 * @module services/update-checker
 */

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT = 5000; // 5 seconds

let cachedLatest: string | null = null;
let lastChecked = 0;

/**
 * Get the latest published version of dorkos from the npm registry.
 *
 * Returns from in-memory cache if within TTL. On fetch failure,
 * returns the stale cached value (or null if never fetched).
 *
 * @returns The latest version string, or null if unknown
 */
export async function getLatestVersion(): Promise<string | null> {
  if (Date.now() - lastChecked < CACHE_TTL) return cachedLatest;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch('https://registry.npmjs.org/dorkos/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return cachedLatest;
    const data = (await res.json()) as { version: string };
    cachedLatest = data.version;
    lastChecked = Date.now();
    return cachedLatest;
  } catch {
    return cachedLatest; // Return stale cache on error
  }
}

/**
 * Reset the in-memory cache. Useful for testing.
 *
 * @internal Exported for testing only.
 */
export function resetCache(): void {
  cachedLatest = null;
  lastChecked = 0;
}
```

**Acceptance criteria:**

- Module exports `getLatestVersion(): Promise<string | null>`
- In-memory cache with 1-hour TTL
- 5-second fetch timeout
- Returns stale cache on error (not null)
- No file I/O (in-memory only)
- `resetCache()` exported for testing

**Dependencies**: Task 1.1

---

### Task 3.2: Add latestVersion to ServerConfigSchema, config route, and fix server version

**Objective**: Wire the update checker into the API response, fix the server version to use the correct source.

**Files to modify:**

- `packages/shared/src/schemas.ts` — add `latestVersion` to `ServerConfigSchema`
- `apps/server/src/routes/config.ts` — include `latestVersion` in response, fix version source
- `apps/server/src/routes/health.ts` — fix version to not read from server package.json (0.0.0)
- `packages/cli/scripts/build.ts` — add `__CLI_VERSION__` define to server bundle step

**Implementation details:**

**1. Schema change** (`packages/shared/src/schemas.ts`):

Add `latestVersion` field to `ServerConfigSchema`:

```typescript
export const ServerConfigSchema = z
  .object({
    version: z.string().openapi({ description: 'Current server version' }),
    latestVersion: z
      .string()
      .nullable()
      .openapi({ description: 'Latest available version from npm, or null if unknown' }),
    port: z.number().int(),
    uptime: z.number(),
    workingDirectory: z.string(),
    nodeVersion: z.string(),
    claudeCliPath: z.string().nullable(),
    tunnel: z.object({
      enabled: z.boolean(),
      connected: z.boolean(),
      url: z.string().nullable(),
      authEnabled: z.boolean(),
      tokenConfigured: z.boolean(),
    }),
  })
  .openapi('ServerConfig');
```

**2. Server version fix** (`packages/cli/scripts/build.ts`):

Add `define` to the server bundle step (step 2) so `__CLI_VERSION__` is available in the bundled server:

```typescript
// Step 2: Bundle server
await build({
  // ... existing config ...
  define: { __CLI_VERSION__: JSON.stringify(version) },
});
```

**3. Config route** (`apps/server/src/routes/config.ts`):

Replace the `createRequire` + `package.json` version reading with `__CLI_VERSION__`:

```typescript
import { getLatestVersion } from '../services/update-checker.js';

// Remove: const require = createRequire(import.meta.url);
// Remove: const { version: SERVER_VERSION } = require('../../package.json');

// Add at top:
declare const __CLI_VERSION__: string;
const SERVER_VERSION =
  typeof __CLI_VERSION__ !== 'undefined'
    ? __CLI_VERSION__
    : (() => {
        // Dev mode fallback: read from root package.json
        const { createRequire } = await import('module');
        const req = createRequire(import.meta.url);
        return (req('../../../package.json') as { version: string }).version;
      })();
```

Note: The dev-mode fallback needs careful handling since the server isn't bundled in dev. A simpler approach: keep the `createRequire` pattern for dev, but read from `../../package.json` (the root package.json which the release command keeps in sync). For the bundled build, `__CLI_VERSION__` takes precedence.

Simpler implementation:

```typescript
import { getLatestVersion } from '../services/update-checker.js';

declare const __CLI_VERSION__: string | undefined;

// Use build-time injected version, fallback to root package.json for dev mode
let SERVER_VERSION: string;
if (typeof __CLI_VERSION__ !== 'undefined') {
  SERVER_VERSION = __CLI_VERSION__;
} else {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  SERVER_VERSION = (require('../../package.json') as { version: string }).version;
}
```

In the GET handler, add `latestVersion`:

```typescript
router.get('/', async (_req, res) => {
  const latestVersion = await getLatestVersion();
  // ... existing code ...
  res.json({
    version: SERVER_VERSION,
    latestVersion,
    port: /* ... */,
    // ... rest unchanged
  });
});
```

Note: The handler must become `async` to await `getLatestVersion()`.

**4. Health route** (`apps/server/src/routes/health.ts`):

Same version fix — replace `createRequire` + server package.json with `__CLI_VERSION__` or root package.json fallback:

```typescript
declare const __CLI_VERSION__: string | undefined;

let SERVER_VERSION: string;
if (typeof __CLI_VERSION__ !== 'undefined') {
  SERVER_VERSION = __CLI_VERSION__;
} else {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  SERVER_VERSION = (require('../../package.json') as { version: string }).version;
}
```

**Acceptance criteria:**

- `ServerConfigSchema` includes `latestVersion: z.string().nullable()`
- `GET /api/config` returns `latestVersion` field (string or null)
- `GET /api/health` returns correct version (not `0.0.0`)
- Server version uses `__CLI_VERSION__` when bundled, fallback to root package.json in dev
- TypeScript compiles without errors
- Existing tests still pass

**Dependencies**: Task 3.1

---

### Task 3.3: Create VersionItem status bar component

**Objective**: Add a version badge to the status bar with update indicator.

**Files to create:**

- `apps/client/src/layers/features/status/ui/VersionItem.tsx`

**Files to modify:**

- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — add VersionItem as last entry
- `apps/client/src/layers/features/status/index.ts` — export VersionItem
- `apps/client/src/layers/shared/model/app-store.ts` — add `showStatusBarVersion` toggle

**Implementation:**

**1. VersionItem component** (`apps/client/src/layers/features/status/ui/VersionItem.tsx`):

```tsx
import { useState } from 'react';
import { cn } from '@/layers/shared/lib';

interface VersionItemProps {
  version: string;
  latestVersion: string | null;
}

/**
 * Status bar version badge with optional update indicator.
 *
 * Shows `v{version}` in muted text when up to date.
 * Shows `↑ v{latestVersion}` with accent color when update available.
 * Click opens a tooltip with update instructions.
 */
export function VersionItem({ version, latestVersion }: VersionItemProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const hasUpdate = latestVersion !== null && isNewer(latestVersion, version);

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        className={cn(
          'cursor-default text-xs',
          hasUpdate
            ? 'cursor-pointer text-amber-600 hover:underline dark:text-amber-400'
            : 'text-muted-foreground'
        )}
        onClick={() => hasUpdate && setShowTooltip(!showTooltip)}
        aria-label={hasUpdate ? `Update available: v${latestVersion}` : `Version ${version}`}
      >
        {hasUpdate ? `↑ v${latestVersion}` : `v${version}`}
      </button>

      {showTooltip && hasUpdate && (
        <div
          className="bg-popover text-popover-foreground border-border absolute right-0 bottom-full z-50 mb-2 w-64 rounded-md border p-3 text-xs shadow-md"
          role="tooltip"
        >
          <p className="font-medium">
            Update available: v{version} → v{latestVersion}
          </p>
          <p className="text-muted-foreground mt-1">
            Run{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
              npm update -g dorkos
            </code>{' '}
            to update
          </p>
        </div>
      )}
    </span>
  );
}

/** Simple semver comparison: returns true if a > b */
function isNewer(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = a.split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('.').map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
```

**2. App store** (`apps/client/src/layers/shared/model/app-store.ts`):

Add `showStatusBarVersion` boolean toggle following the existing pattern:

- Add to `AppState` interface: `showStatusBarVersion: boolean;`
- Add to `BOOL_KEYS`: `showStatusBarVersion: 'dorkos-show-status-bar-version'`
- Add to `BOOL_DEFAULTS`: `showStatusBarVersion: true`
- Add initialization with `readBool` and setter with `writeBool`

**3. StatusLine** (`apps/client/src/layers/features/status/ui/StatusLine.tsx`):

Import VersionItem and add it as the last entry in the entries array:

```typescript
import { VersionItem } from './VersionItem';

// In StatusLine component, after the sound entry:
// Need to get config data — use useServerConfig or pass via props
// The simplest approach: add version/latestVersion to StatusLine props
// or use the existing server config query

if (showStatusBarVersion) {
  entries.push({
    key: 'version',
    node: <VersionItem version={serverConfig?.version ?? ''} latestVersion={serverConfig?.latestVersion ?? null} />,
  });
}
```

Note: StatusLine needs access to the server config. This can come from a hook (`useServerConfig`) or from props passed down from the parent. Since StatusLine already receives `sessionStatus`, adding `serverConfig` as an optional prop is the cleanest approach. The parent (`ChatPanel` or wherever StatusLine is rendered) already fetches server config for Settings.

**4. Index barrel** (`apps/client/src/layers/features/status/index.ts`):

Add: `export { VersionItem } from './ui/VersionItem';`

**Acceptance criteria:**

- VersionItem renders `v{version}` when no update available
- VersionItem renders `↑ v{latestVersion}` with accent color when update exists
- Clicking update badge shows tooltip with instructions
- Status bar shows version as rightmost item
- `showStatusBarVersion` toggle exists in app store
- VersionItem is exported from status barrel

**Dependencies**: Task 3.2

---

### Task 3.4: Add update notice to Settings ServerTab

**Objective**: Show a colored update notice row when a newer version is available.

**Files to modify:**

- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`

**Implementation:**

After the version `ConfigRow` (line 27), add conditional update notice:

```tsx
<ConfigRow label="Version" value={config.version} />;

{
  /* Update notice — shown when latestVersion is newer */
}
{
  config.latestVersion && isNewer(config.latestVersion, config.version) && (
    <div className="-mx-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 dark:border-amber-800 dark:bg-amber-950/30">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
          Update available: v{config.latestVersion}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
        Run{' '}
        <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[10px] dark:bg-amber-900/50">
          npm update -g dorkos
        </code>{' '}
        to update
      </p>
    </div>
  );
}
```

Add the `isNewer` helper function to the file (same implementation as in VersionItem):

```typescript
function isNewer(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = a.split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('.').map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
```

Note: If `isNewer` is needed in 3+ places, consider extracting to `packages/shared/src/version-utils.ts`. For now, 2 places is acceptable (VersionItem + ServerTab).

**Acceptance criteria:**

- Settings > Server tab shows colored update notice when `latestVersion` is newer
- Notice includes version and `npm update -g dorkos` command
- Notice uses amber/warning colors (not alarming)
- No notice shown when `latestVersion` is null or same as current

**Dependencies**: Task 3.2

---

### Task 3.5: Write server update-checker tests

**Objective**: Unit tests for the server-side update checker service.

**Files to create:**

- `apps/server/src/services/__tests__/update-checker.test.ts`

**Implementation:**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLatestVersion, resetCache } from '../update-checker.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('update-checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-16T12:00:00Z'));
    resetCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches and caches on first call', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    const result = await getLatestVersion();
    expect(result).toBe('0.2.0');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached value within TTL', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: '0.2.0' }),
    });

    await getLatestVersion(); // First call — fetches
    const result = await getLatestVersion(); // Second call — cache hit
    expect(result).toBe('0.2.0');
    expect(mockFetch).toHaveBeenCalledTimes(1); // Only one fetch
  });

  it('re-fetches after TTL expires', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.3.0' }),
      });

    await getLatestVersion(); // First call
    vi.advanceTimersByTime(61 * 60 * 1000); // Advance past 1-hour TTL
    const result = await getLatestVersion(); // Should re-fetch
    expect(result).toBe('0.3.0');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns stale cache on fetch failure', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      })
      .mockRejectedValueOnce(new Error('Network error'));

    await getLatestVersion(); // Populate cache
    vi.advanceTimersByTime(61 * 60 * 1000); // Expire TTL
    const result = await getLatestVersion(); // Fetch fails
    expect(result).toBe('0.2.0'); // Returns stale
  });

  it('returns null when never fetched and fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await getLatestVersion();
    expect(result).toBeNull();
  });

  it('returns stale cache on non-ok response', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ version: '0.2.0' }),
      })
      .mockResolvedValueOnce({ ok: false });

    await getLatestVersion();
    vi.advanceTimersByTime(61 * 60 * 1000);
    const result = await getLatestVersion();
    expect(result).toBe('0.2.0');
  });
});
```

**Test cases (6 total):**

1. First call fetches and caches
2. Returns cached value within TTL
3. Re-fetches after TTL expires
4. Returns stale cache on fetch failure
5. Returns null when never fetched and fetch fails
6. Returns stale cache on non-ok response

**Acceptance criteria:**

- All tests pass with `npx vitest run apps/server/src/services/__tests__/update-checker.test.ts`
- No real network I/O (fetch is mocked)
- Tests verify caching behavior, TTL, and error handling

**Dependencies**: Task 3.1

---

### Task 3.6: Write VersionItem component tests

**Objective**: UI tests for the version badge component.

**Files to create:**

- `apps/client/src/layers/features/status/__tests__/VersionItem.test.tsx`

**Implementation:**

```tsx
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { VersionItem } from '../ui/VersionItem';

// Mock motion/react to render plain elements
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === 'string') {
          return ({ children, ...props }: any) => {
            const Tag = prop as keyof JSX.IntrinsicElements;
            return <Tag {...props}>{children}</Tag>;
          };
        }
      },
    }
  ),
  AnimatePresence: ({ children }: any) => children,
}));

describe('VersionItem', () => {
  it('renders current version when no update available', () => {
    render(<VersionItem version="0.1.0" latestVersion={null} />);
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
  });

  it('renders current version when latestVersion equals version', () => {
    render(<VersionItem version="0.1.0" latestVersion="0.1.0" />);
    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
  });

  it('renders update indicator when latestVersion is newer', () => {
    render(<VersionItem version="0.1.0" latestVersion="0.2.0" />);
    expect(screen.getByText('↑ v0.2.0')).toBeInTheDocument();
  });

  it('shows tooltip with update instructions on click', async () => {
    const user = userEvent.setup();
    render(<VersionItem version="0.1.0" latestVersion="0.2.0" />);

    await user.click(screen.getByText('↑ v0.2.0'));
    expect(screen.getByText(/npm update -g dorkos/)).toBeInTheDocument();
    expect(screen.getByText(/v0.1.0 → v0.2.0/)).toBeInTheDocument();
  });

  it('does not show tooltip when clicking and no update', async () => {
    const user = userEvent.setup();
    render(<VersionItem version="0.1.0" latestVersion={null} />);

    await user.click(screen.getByText('v0.1.0'));
    expect(screen.queryByText(/npm update/)).not.toBeInTheDocument();
  });

  it('has correct aria-label for update available', () => {
    render(<VersionItem version="0.1.0" latestVersion="0.2.0" />);
    expect(screen.getByLabelText('Update available: v0.2.0')).toBeInTheDocument();
  });

  it('has correct aria-label for current version', () => {
    render(<VersionItem version="0.1.0" latestVersion={null} />);
    expect(screen.getByLabelText('Version 0.1.0')).toBeInTheDocument();
  });
});
```

**Test cases (7 total):**

1. Renders current version when `latestVersion` is null
2. Renders current version when `latestVersion` equals `version`
3. Renders update indicator when `latestVersion` is newer
4. Shows tooltip with instructions on click (update available)
5. Does not show tooltip on click when no update
6. Correct aria-label for update available
7. Correct aria-label for current version

**Acceptance criteria:**

- All tests pass
- Tests verify visual output, click interaction, and accessibility
- Motion library is mocked

**Dependencies**: Task 3.3

---

## Phase 4: Release Command Overhaul

### Task 4.1: Rewrite /system:release command

**Objective**: Complete rewrite of `.claude/commands/system/release.md` with VERSION file support, correct GitHub URLs, npm publish, and GitHub Release creation.

**Files to modify:**

- `.claude/commands/system/release.md` — complete rewrite

**Implementation:**

The release command must be completely rewritten to:

1. **Fix GitHub URLs**: All references must use `dork-labs/dorkos` (not `doriancollier/dorkian-next-stack`)

2. **Remove Python dependency**: Replace `python3 .claude/scripts/changelog_backfill.py` with inline git log analysis (the Python script doesn't exist)

3. **Add VERSION file support**: Read version from `VERSION` file, sync to `packages/cli/package.json` and root `package.json`

4. **Add npm publish step**: After git tag push, offer `npm publish -w packages/cli`

5. **Update Co-Author**: Use current model name in commit message

6. **Fix Phase 2 changelog backfill**: Replace Python script with `git log v{current}..HEAD --oneline` approach:
   - Get commits since last tag
   - Present them organized by conventional commit type
   - Offer to update CHANGELOG.md with missing entries
   - Use the `/writing-changelogs` skill for user-friendly language

7. **Add Phase 5 npm publish step**:

   ```
   AskUserQuestion: "Publish to npm?"
   If yes: npm publish -w packages/cli
   ```

8. **Fix Phase 5 file updates**: VERSION sync flow:

   ```bash
   # 5.2: Update VERSION
   printf "0.6.0" > VERSION

   # 5.2b: Sync package.json files
   npm version 0.6.0 --no-git-tag-version -w packages/cli
   npm version 0.6.0 --no-git-tag-version

   # 5.4: Stage all changed files
   git add VERSION CHANGELOG.md packages/cli/package.json package.json package-lock.json
   ```

9. **Fix Phase 6 report URLs**:

   ```
   - npm: https://www.npmjs.com/package/dorkos
   - Tag: https://github.com/dork-labs/dorkos/releases/tag/v{version}
   - Compare: https://github.com/dork-labs/dorkos/compare/v{prev}...v{new}
   ```

10. **Update commit message**:

    ```
    chore(release): v{version}

    Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
    ```

Key structural changes:

- Phase 1: Parse arguments (unchanged)
- Phase 2: Pre-flight checks — use `cat VERSION` and `git log` instead of Python script
- Phase 3: Version analysis — subagent for auto-detect (unchanged approach)
- Phase 4: User confirmation (unchanged approach)
- Phase 5: Execute — add VERSION sync to package.json, add npm publish step, fix URLs
- Phase 6: Report — fix all URLs to dork-labs/dorkos, add npm URL

**Acceptance criteria:**

- Command reads version from `VERSION` file (not package.json)
- Command syncs VERSION to both package.json files during release
- All GitHub URLs reference `dork-labs/dorkos`
- No references to Python scripts
- npm publish step included with confirmation
- GitHub Release creation with `gh release create`
- Commit message uses `chore(release): v{version}` format

**Dependencies**: Task 1.1

---

## Dependency Graph

```
1.1 (VERSION file)
 ├─→ 1.2 (git tag)
 ├─→ 2.1 (update-check.ts)
 │    ├─→ 2.2 (CLI banner)
 │    └─→ 2.3 (update-check tests)
 ├─→ 3.1 (server update-checker)
 │    ├─→ 3.2 (schema + config route)
 │    │    ├─→ 3.3 (VersionItem)
 │    │    │    └─→ 3.6 (VersionItem tests)
 │    │    └─→ 3.4 (ServerTab update)
 │    └─→ 3.5 (server update-checker tests)
 └─→ 4.1 (release command)
```

## Parallel Execution Opportunities

After Task 1.1 completes, these can start simultaneously:

- **Task 1.2** (git tag — manual)
- **Task 2.1** (CLI update check module)
- **Task 3.1** (server update checker)
- **Task 4.1** (release command rewrite)

After Task 2.1:

- **Task 2.2** and **Task 2.3** can run in parallel

After Task 3.1:

- **Task 3.2** and **Task 3.5** can run in parallel

After Task 3.2:

- **Task 3.3** and **Task 3.4** can run in parallel

After Task 3.3:

- **Task 3.6** can start

## Critical Path

1.1 → 3.1 → 3.2 → 3.3 → 3.6 (longest chain: 5 tasks)
