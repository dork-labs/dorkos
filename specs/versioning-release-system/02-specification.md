---
slug: versioning-release-system
number: 33
created: 2026-02-16
status: specified
---

# Versioning, Release & Update System

**Status:** Specified
**Authors:** Claude Code, 2026-02-16
**Spec:** #33
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [research/versioning-and-release-system.md](../../research/versioning-and-release-system.md)

---

## Overview

Establish a complete versioning, release, and update notification system for DorkOS. This creates a single source of truth for the project version, adds startup banners and update notifications to the CLI, surfaces version and update availability in the web UI, and overhauls the `/system:release` Claude Code command into a semi-autonomous release orchestrator.

## Background / Problem Statement

DorkOS is currently at version 0.1.0 with no git tags, no update notifications, and a fragmented version story:

- **Version scattered**: Root `package.json` and `packages/cli/package.json` both declare 0.1.0 with no sync mechanism. `apps/server/package.json` is 0.0.0, so the server health and config endpoints report the wrong version.
- **No release automation**: Publishing requires manual `npm version patch` + `npm publish -w packages/cli`. No changelog finalization, no git tags, no GitHub Releases.
- **No update notifications**: Users have no way to know when a new version is available — neither in the CLI nor the web UI.
- **Broken release command**: `.claude/commands/system/release.md` references a `VERSION` file and `changelog_backfill.py` that don't exist, and has wrong GitHub URLs.

## Goals

- Single source of truth for the DorkOS version (`VERSION` file at repo root)
- Retroactive `v0.1.0` annotated git tag on the published commit
- CLI startup banner showing version, server URL, and network URL
- Non-blocking CLI update notification (npm registry check, 24h cache, 3s timeout)
- Web UI version badge in the status bar with update indicator
- Settings > Server tab shows current vs latest version with update instructions
- Fully functional `/system:release` command that handles version bump, changelog, git tag, npm publish, and GitHub Release
- Zero new runtime dependencies

## Non-Goals

- GitHub Actions CI/CD pipeline (future work)
- Changesets library (designed for multi-package publishing)
- Auto-publish on merge (human-in-the-loop via `/system:release`)
- Pre-release version support (alpha/beta/rc — deferred until approaching 1.0)
- Obsidian plugin versioning (separate release cycle)
- Post-commit changelog auto-population hook (too aggressive for OSS)
- Conventional commit enforcement

## Technical Dependencies

- **Node.js `fetch`** — Built-in since Node 18. Used for npm registry checks. No new dependency.
- **`semver`** — Already available transitively. Used for version comparison. If not present, implement a minimal `isNewer(a, b)` comparison (~10 lines).
- **`fs/promises`** — Built-in. Used for cache file I/O.
- **`os.networkInterfaces()`** — Built-in. Used for network URL in startup banner.

No new npm dependencies are introduced by this spec.

## Detailed Design

### 1. Version Source of Truth

Create a plain-text `VERSION` file at the repo root containing the current version:

```
0.1.0
```

No trailing newline, no `v` prefix, no quotes. This is the canonical version for the entire DorkOS project.

**Sync flow during release:**

```
VERSION (edited by /system:release)
  → packages/cli/package.json   (synced by /system:release)
  → package.json (root)         (synced by /system:release)
  → esbuild define              (reads cli/package.json at build time)
     → __CLI_VERSION__           (runtime constant in CLI + server)
```

The build script (`packages/cli/scripts/build.ts`) continues reading from `packages/cli/package.json` — no change needed there. The release command ensures the package.json files match VERSION before building.

### 2. Retroactive Git Tag

Tag the commit that was published as 0.1.0 to npm:

```bash
git tag -a v0.1.0 -m "Release v0.1.0" <commit-sha>
git push origin v0.1.0
```

The specific commit SHA should be identified by checking `npm info dorkos` for the publish date and correlating with `git log`.

### 3. CLI Startup Banner

Modify `packages/cli/src/cli.ts` to display a startup banner after the server starts:

```
  DorkOS v0.1.0
  Local:   http://localhost:4242
  Network: http://192.168.1.5:4242
```

Implementation:

- After the server binds, print the banner to stdout
- Use `os.networkInterfaces()` to find the first non-internal IPv4 address for the Network line
- If no network interface is found, omit the Network line
- The banner prints after the server is ready, not before

### 4. CLI Update Check (`packages/cli/src/update-check.ts`)

A ~30-line module that checks the npm registry for newer versions:

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

/** Returns true if `a` is newer than `b` (simple semver comparison) */
function isNewer(a: string, b: string): boolean {
  const [aMaj, aMin, aPat] = a.split('.').map(Number);
  const [bMaj, bMin, bPat] = b.split('.').map(Number);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
}
```

**CLI integration** (`packages/cli/src/cli.ts`):

- After server starts and banner prints, fire `checkForUpdate(__CLI_VERSION__)` without awaiting
- Attach a `.then()` that prints a boxed update message if a newer version exists:

```
┌─────────────────────────────────────────┐
│   Update available: 0.1.0 → 0.2.0      │
│   Run npm update -g dorkos to update    │
└─────────────────────────────────────────┘
```

- The check is non-blocking — server startup is never delayed by the update check
- If the check fails (network error, timeout), nothing is displayed

### 5. Server-Side Update Check (`apps/server/src/services/update-checker.ts`)

A new service that provides the latest version to the config endpoint:

```typescript
// apps/server/src/services/update-checker.ts

const CACHE_TTL = 60 * 60 * 1000; // 1 hour (more frequent than CLI since server is long-running)
const FETCH_TIMEOUT = 5000;

let cachedLatest: string | null = null;
let lastChecked = 0;

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
```

Key differences from CLI update check:

- In-memory cache only (no file I/O — server is long-running)
- 1-hour TTL (server stays running, should reflect updates sooner)
- 5-second timeout (server has more tolerance than CLI startup)

### 6. Schema Changes (`packages/shared/src/schemas.ts`)

Add `latestVersion` to `ServerConfigSchema`:

```typescript
export const ServerConfigSchema = z.object({
  version: z.string().openapi({ description: 'Current server version' }),
  latestVersion: z
    .string()
    .nullable()
    .openapi({ description: 'Latest available version from npm, or null if unknown' }),
  port: z.number().int(),
  // ... rest unchanged
});
```

### 7. Config Route Update (`apps/server/src/routes/config.ts`)

Import and call `getLatestVersion()`:

```typescript
import { getLatestVersion } from '../services/update-checker.js';

// In GET /api/config handler:
const latestVersion = await getLatestVersion();
res.json({
  version: SERVER_VERSION,
  latestVersion,
  port: /* ... */,
  // ... rest unchanged
});
```

Note: The `await` here is fast because `getLatestVersion()` returns from in-memory cache. The first call after server start may take up to 5 seconds, but subsequent calls are instant.

### 8. Server Version Fix

Currently `apps/server/src/routes/config.ts` and `health.ts` read version from `apps/server/package.json` (which is 0.0.0). This needs to be fixed.

**Option A (recommended):** Change server routes to read from `packages/cli/package.json` at build time via the CLI build script. The CLI already bundles the server, so the version is available as a build-time constant.

**Option B:** Read from root `package.json` which the release command keeps in sync.

**Implementation:** The CLI build script already injects `__CLI_VERSION__`. Since the server is bundled by the CLI's esbuild step, we can add the same `define` to the server bundle step. Then `config.ts` and `health.ts` use `__CLI_VERSION__` instead of reading from `package.json`.

If the server runs in dev mode (not bundled), it falls back to reading `package.json` from the repo root.

### 9. Web UI — VersionItem Status Bar Component

Create `apps/client/src/layers/features/status/ui/VersionItem.tsx`:

```typescript
// Renders in the status bar
// When no update: subtle "v0.1.0" badge
// When update available: "↑ v0.2.0" with accent color
```

Behavior:

- Reads `version` and `latestVersion` from the server config query (already fetched by Settings)
- If `latestVersion` is null or equal to `version`: show `v{version}` in muted text
- If `latestVersion` is newer: show `↑ v{latestVersion}` with the accent/warning color
- Clicking the badge when an update is available opens a tooltip or small popover with: "Update available: v0.1.0 → v0.2.0. Run `npm update -g dorkos` to update."
- Position: rightmost item in the status bar (after CostItem/ContextItem)

Add to `StatusLine.tsx` render list and to the status bar toggle settings.

### 10. Web UI — Settings Server Tab Update

Modify `apps/client/src/layers/features/settings/ui/ServerTab.tsx`:

- After the version ConfigRow, add a conditional update notice:
  - If `latestVersion` exists and is newer than `version`: show a colored row "Update available: v{latestVersion}" with instructions "Run `npm update -g dorkos` to update"
  - Use a subtle info/accent style — not alarming

### 11. `/system:release` Command Overhaul

Complete rewrite of `.claude/commands/system/release.md`. The command accepts an optional argument: `patch`, `minor`, `major`, or an explicit version like `1.2.3`. If omitted, the command auto-detects the bump type.

**Phase 1: Pre-flight Checks**

- Verify clean git working tree (`git status --porcelain` is empty)
- Verify on `main` branch
- Verify `VERSION` file exists
- Read current version from `VERSION`
- Verify npm authentication (`npm whoami`)

**Phase 2: Changelog Backfill**

- Run `git log v{current}..HEAD --oneline` to get commits since last tag
- Present commits to user, organized by conventional commit type
- Identify any commits that aren't reflected in `CHANGELOG.md` `[Unreleased]` section
- Offer to add missing entries (using the `/writing-changelogs` skill for user-friendly language)
- User can edit, approve, or skip

**Phase 3: Version Analysis**

- If bump type not specified, launch a subagent (haiku model) to analyze:
  - CHANGELOG.md `[Unreleased]` entries
  - Commit messages since last tag
  - Presence of breaking changes, new features, or only fixes
- Subagent returns recommended bump type with reasoning
- Present recommendation to user

**Phase 4: User Confirmation**

- Display: current version → new version
- Show changelog entries that will be included
- Show files that will be modified
- AskUserQuestion: "Proceed with release v{new}?" with options: Yes / Change bump type / Abort

**Phase 5: Execute**

1. Update `VERSION` file with new version
2. Update `packages/cli/package.json` version field
3. Update root `package.json` version field
4. Finalize `CHANGELOG.md`: rename `[Unreleased]` to `[{new version}] - {date}`, add new empty `[Unreleased]` section, update comparison links
5. Git commit: `chore(release): v{new version}`
6. Git tag: `git tag -a v{new} -m "Release v{new}"`
7. Git push: `git push && git push origin v{new}`
8. AskUserQuestion: "Publish to npm?" — if yes, run `npm publish -w packages/cli`
9. Create GitHub Release via `gh release create v{new} --title "v{new}" --notes-file -` with narrative release notes (generated using `/writing-changelogs` skill patterns)

**Phase 6: Report**

- Print summary with links: npm package URL, GitHub Release URL, git tag
- Confirm all steps completed successfully

**GitHub URLs:** All references updated to `dork-labs/dorkos`.

## User Experience

### CLI User

1. **Install/Update**: `npm install -g dorkos`
2. **Run**: `dorkos` — sees startup banner with version
3. **Update notification**: If outdated, sees a boxed message after startup suggesting the update command
4. **Check version**: `dorkos --version` or `dorkos -v` — prints version and exits

### Web UI User

1. **Status bar**: Sees subtle version badge at far right (e.g., "v0.1.0")
2. **Update available**: Badge changes to "↑ v0.2.0" with accent styling
3. **Click badge**: Tooltip shows update instructions
4. **Settings > Server**: Version row shows current version; when update available, shows colored update notice with instructions

### Maintainer (Release)

1. Run `/system:release` in Claude Code
2. Review changelog backfill suggestions
3. Confirm bump type (auto-detected or override)
4. Review and confirm release preview
5. Command executes: VERSION update, package.json sync, changelog finalization, git commit + tag + push, npm publish, GitHub Release
6. See summary with all relevant links

## Testing Strategy

### Unit Tests

**`packages/cli/src/__tests__/update-check.test.ts`**

- Test cache hit (returns cached result when fresh)
- Test cache miss (fetches from registry when stale)
- Test cache miss (fetches when no cache file exists)
- Test network timeout (returns null after 3s)
- Test network error (returns null silently)
- Test version comparison (`isNewer` function)
- Test corrupt cache file (treated as cache miss)
- Mock `fetch` and `fs/promises` — no real network or file I/O

**`apps/server/src/services/__tests__/update-checker.test.ts`**

- Test in-memory cache behavior (returns cached value within TTL)
- Test cache expiry (re-fetches after TTL)
- Test fetch failure (returns stale cached value)
- Test first call (fetches and caches)
- Mock `fetch` — no real network I/O

**`apps/client/src/layers/features/status/__tests__/VersionItem.test.tsx`**

- Test renders current version when no update available
- Test renders update indicator when `latestVersion > version`
- Test renders nothing / current version when `latestVersion` is null
- Test click interaction shows update instructions
- Mock server config via TransportProvider

### Integration Tests

- Server `/api/config` endpoint returns `latestVersion` field
- Server `/api/health` endpoint returns correct version (not 0.0.0)

### What NOT to Test

- Actual npm registry fetches (mocked in all tests)
- The `/system:release` command (Claude Code command, not testable via vitest)
- Git tag creation (manual verification during first release)

## Performance Considerations

- **CLI startup**: Update check is non-blocking. It fires after server start and prints asynchronously. Zero impact on time-to-first-request.
- **Server config endpoint**: `getLatestVersion()` returns from in-memory cache in <1ms for all calls except the first (which may take up to 5s). The first call is triggered eagerly at server startup, not on first request.
- **Client**: No additional network requests. The `latestVersion` field piggybacks on the existing config fetch.
- **Cache I/O**: CLI writes a ~50-byte JSON file to `~/.dork/cache/` once every 24 hours. Negligible.

## Security Considerations

- **npm registry fetch**: Read-only GET request to a public endpoint. No authentication tokens sent. No user data transmitted.
- **Cache file**: Stored in `~/.dork/cache/update-check.json` with standard user permissions. Contains only a version string and timestamp — no sensitive data.
- **Version display**: Version strings are rendered as text, not interpreted as HTML or executed. No injection risk.
- **Release command**: npm publish requires authentication (existing `dorkos-publish` token). The command prompts for confirmation before publishing.

## Documentation

### Files to Update

- `AGENTS.md` — Add VERSION file to project structure, document release workflow
- `guides/configuration.md` — Document `~/.dork/cache/` directory and update-check behavior
- `docs/getting-started.md` — Mention `--version` flag and update notifications

### Files to Create

- No new documentation files required. Release notes are generated per-release via the `/system:release` command.

## Implementation Phases

### Phase 1: Version Infrastructure

**Files created:**

- `VERSION` — plain text file, content: `0.1.0`

**Files modified:**

- `specs/manifest.json` — update status to `implementing`

**Manual steps:**

- Create retroactive `v0.1.0` annotated git tag
- Push tag to origin

**Acceptance criteria:**

- `VERSION` file exists at repo root
- `v0.1.0` tag exists on the correct commit
- `git describe --tags` returns `v0.1.0` (or `v0.1.0-N-gSHA` if commits exist after)

### Phase 2: CLI Startup Banner & Update Check

**Files created:**

- `packages/cli/src/update-check.ts` — npm registry check with file-based caching

**Files modified:**

- `packages/cli/src/cli.ts` — startup banner + non-blocking update notification

**Tests created:**

- `packages/cli/src/__tests__/update-check.test.ts`

**Acceptance criteria:**

- `dorkos` shows startup banner with version and URLs
- `dorkos` shows update notification when a newer version exists on npm (from cache)
- Update check does not delay server startup
- All tests pass

### Phase 3: Web UI Update Indicator

**Files created:**

- `apps/server/src/services/update-checker.ts` — server-side npm check with in-memory cache
- `apps/client/src/layers/features/status/ui/VersionItem.tsx` — status bar version badge

**Files modified:**

- `packages/shared/src/schemas.ts` — add `latestVersion` to `ServerConfigSchema`
- `apps/server/src/routes/config.ts` — include `latestVersion` in response
- `apps/server/src/routes/health.ts` — fix version to use correct source (not server package.json)
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — add VersionItem
- `apps/client/src/layers/features/status/index.ts` — export VersionItem
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx` — add update notice

**Tests created:**

- `apps/server/src/services/__tests__/update-checker.test.ts`
- `apps/client/src/layers/features/status/__tests__/VersionItem.test.tsx`

**Acceptance criteria:**

- Status bar shows version badge
- When update is available, badge shows update indicator with accent styling
- Settings > Server tab shows update notice when outdated
- `/api/config` returns `latestVersion` field
- `/api/health` returns correct version (matching CLI version)
- All tests pass

### Phase 4: `/system:release` Command Overhaul

**Files modified:**

- `.claude/commands/system/release.md` — complete rewrite

**Acceptance criteria:**

- Command reads version from `VERSION` file
- Command syncs VERSION → package.json files
- Command finalizes CHANGELOG.md correctly
- Command creates annotated git tag
- Command publishes to npm (with confirmation)
- Command creates GitHub Release
- All GitHub URLs reference `dork-labs/dorkos`

## Open Questions

None. All design decisions were resolved during ideation (see [01-ideation.md](./01-ideation.md) Section 7).

## Related ADRs

No existing ADRs directly relate to this spec. Consider creating:

- **ADR: VERSION file as single source of truth** — Documents the decision to use a plain-text VERSION file instead of relying solely on package.json

## References

- [Ideation document](./01-ideation.md)
- [Research: Versioning & Release System](../../research/versioning-and-release-system.md)
- [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
- [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
- [npm registry API](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
- [update-notifier pattern](https://github.com/yeoman/update-notifier) — inspiration for the update check approach
