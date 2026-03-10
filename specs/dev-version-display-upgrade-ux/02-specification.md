---
slug: dev-version-display-upgrade-ux
number: 110
created: 2026-03-10
status: specified
---

# Dev Version Display & Upgrade UX Overhaul

**Status:** Specified
**Authors:** Claude Code, 2026-03-10
**Ideation:** `specs/dev-version-display-upgrade-ux/01-ideation.md`
**Research:** `research/20260310_dev_version_display_upgrade_ux.md`

---

## Overview

Fix the dev-mode version bug where the server reports `0.0.0` and the status bar shows a false "Upgrade available" prompt. Additionally, overhaul the version display UX with a dev-mode badge, per-version upgrade dismiss, and polished settings page version info.

## Background / Problem Statement

In dev mode (`pnpm dev`), the server starts via `tsx watch` without esbuild bundling. The `__CLI_VERSION__` constant is never injected, so `apps/server/src/lib/version.ts` falls back to reading `apps/server/package.json` — which is intentionally `0.0.0` (non-published workspace package). The update-checker unconditionally fetches npm registry and returns the latest published version (e.g., `0.9.0`). The client sees `0.0.0 < 0.9.0` and renders "Upgrade available" — a false positive that appears every dev session.

Secondary issues:
- The npm registry fetch in dev mode is unnecessary network traffic
- Users cannot dismiss upgrade notifications for versions they choose to skip
- The Settings ServerTab duplicates `isNewer()` logic from VersionItem
- No way to test the upgrade notification flow without publishing a real release

## Goals

- Detect dev builds reliably and show a `DEV` badge instead of false upgrade prompts
- Skip npm registry fetch entirely in dev mode (no phoning home)
- Add `DORKOS_VERSION_OVERRIDE` env var for testing the upgrade flow in dev
- Add per-version dismiss for upgrade notifications, persisted in user config
- Polish the Settings Server tab version display for both dev and production modes
- Ensure release notes link always resolves to the correct GitHub release page

## Non-Goals

- Changes to the release/publishing pipeline
- CLI-side update notification changes (already functional via `update-notifier`)
- Self-update mechanism (out of scope)
- About dialog or dedicated About tab in settings

## Technical Dependencies

- No new external libraries required
- Existing: Zod (config schema), TanStack Query (data fetching), Motion (animations)
- Existing: `configManager` for server-side config persistence

---

## Detailed Design

### 1. Server: Version Resolution & Dev Detection

**File:** `apps/server/src/lib/version.ts`

Add an `isDevBuild()` function and support `DORKOS_VERSION_OVERRIDE`:

```typescript
import { createRequire } from 'module';
import { env } from '../env.js';

declare const __CLI_VERSION__: string | undefined;

const DEV_VERSION_PATTERN = /^0\.0\.0/;

/**
 * Resolved server version string.
 *
 * Priority: DORKOS_VERSION_OVERRIDE > __CLI_VERSION__ (esbuild) > package.json fallback.
 */
export const SERVER_VERSION: string = resolveVersion();

/** Whether the server is running a development build (not from CLI bundle). */
export const IS_DEV_BUILD: boolean = checkDevBuild(SERVER_VERSION);

function resolveVersion(): string {
  if (env.DORKOS_VERSION_OVERRIDE) return env.DORKOS_VERSION_OVERRIDE;
  if (typeof __CLI_VERSION__ !== 'undefined') return __CLI_VERSION__;
  return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
}

function checkDevBuild(version: string): boolean {
  // Override explicitly opts out of dev mode
  if (env.DORKOS_VERSION_OVERRIDE) return false;
  // CLI bundle injects __CLI_VERSION__ — not a dev build
  if (typeof __CLI_VERSION__ !== 'undefined') return false;
  // Sentinel version from package.json
  return DEV_VERSION_PATTERN.test(version);
}
```

**File:** `apps/server/src/env.ts`

Rename `DORKOS_VERSION` to `DORKOS_VERSION_OVERRIDE`:

```typescript
DORKOS_VERSION_OVERRIDE: z.string().optional(),
```

Note: Also update `turbo.json` `globalPassThroughEnv` to rename `DORKOS_VERSION` → `DORKOS_VERSION_OVERRIDE`.

### 2. Server: Update Checker Guard

**File:** `apps/server/src/services/core/update-checker.ts`

Guard the fetch with dev build detection:

```typescript
import { IS_DEV_BUILD } from '../lib/version.js';

export async function getLatestVersion(): Promise<string | null> {
  // Skip npm registry fetch entirely in dev mode
  if (IS_DEV_BUILD) return null;

  if (Date.now() - lastChecked < CACHE_TTL) return cachedLatest;
  // ... existing fetch logic
}
```

### 3. Server: Config Response

**File:** `apps/server/src/routes/config.ts`

Add `isDevMode` to the response:

```typescript
import { SERVER_VERSION, IS_DEV_BUILD } from '../lib/version.js';

router.get('/', async (_req, res) => {
  // ...existing logic...
  const latestVersion = await getLatestVersion(); // Returns null in dev mode

  res.json({
    version: SERVER_VERSION,
    latestVersion,
    isDevMode: IS_DEV_BUILD,
    // ...rest unchanged
  });
});
```

### 4. Shared: Schema Update

**File:** `packages/shared/src/schemas.ts`

Add `isDevMode` to `ServerConfigSchema`:

```typescript
export const ServerConfigSchema = z
  .object({
    version: z.string().openapi({ description: 'Current server version' }),
    latestVersion: z.string().nullable()
      .openapi({ description: 'Latest available version from npm, or null if dev mode or unknown' }),
    isDevMode: z.boolean()
      .openapi({ description: 'Whether the server is running a development build' }),
    // ...rest unchanged
  })
```

**File:** `packages/shared/src/config-schema.ts`

Add `dismissedUpgradeVersions` to `UserConfigSchema` inside the `ui` section:

```typescript
ui: z.object({
  // ...existing fields...
  dismissedUpgradeVersions: z.array(z.string())
    .default(() => [])
    .describe('Version strings the user has dismissed upgrade notifications for'),
}),
```

### 5. Client: VersionItem Component

**File:** `apps/client/src/layers/features/status/ui/VersionItem.tsx`

Extend the component with dev mode and dismiss support:

```typescript
interface VersionItemProps {
  version: string;
  latestVersion: string | null;
  isDevMode?: boolean;
  isDismissed?: boolean;
  onDismiss?: (version: string) => void;
}

export function VersionItem({
  version,
  latestVersion,
  isDevMode,
  isDismissed,
  onDismiss,
}: VersionItemProps) {
  // Dev mode: render DEV badge
  if (isDevMode) {
    return (
      <span
        className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-amber-600 dark:text-amber-400"
        aria-label="Development build"
      >
        DEV
      </span>
    );
  }

  const hasUpdate = latestVersion !== null && isNewer(latestVersion, version);
  const isFeature = hasUpdate && isFeatureUpdate(latestVersion!, version);

  // No update or dismissed: show plain version
  if (!hasUpdate || isDismissed) {
    return (
      <span className="cursor-default text-xs text-muted-foreground" aria-label={`Version ${version}`}>
        v{version}
      </span>
    );
  }

  // Update available: render popover (existing logic with dismiss button added)
  return (
    <Popover>
      {/* ...existing trigger... */}
      <PopoverContent side="top" align="end" sideOffset={8} className="w-64 p-0">
        <div className="space-y-3 p-3">
          {/* ...existing content (version transition, copy command, release link)... */}

          {/* NEW: Dismiss button */}
          <button
            type="button"
            onClick={() => onDismiss?.(latestVersion!)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Dismiss this version
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

### 6. Client: StatusLine Integration

**File:** `apps/client/src/layers/features/status/ui/StatusLine.tsx`

Pass `isDevMode`, dismiss state, and dismiss handler to VersionItem:

```typescript
// Inside StatusLine component:
const dismissedVersions: string[] =
  (serverConfig?.dismissedUpgradeVersions as string[] | undefined) ?? [];

const handleDismissVersion = useCallback(
  async (version: string) => {
    const updated = [...dismissedVersions, version];
    await transport.updateConfig({
      ui: { dismissedUpgradeVersions: updated },
    });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  },
  [dismissedVersions, transport, queryClient]
);

// In the entries builder:
if (showStatusBarVersion && serverConfig) {
  const isDismissed = serverConfig.latestVersion
    ? dismissedVersions.includes(serverConfig.latestVersion)
    : false;

  entries.push({
    key: 'version',
    node: (
      <VersionItem
        version={serverConfig.version}
        latestVersion={serverConfig.latestVersion}
        isDevMode={serverConfig.isDevMode}
        isDismissed={isDismissed}
        onDismiss={handleDismissVersion}
      />
    ),
  });
}
```

Note: The `dismissedUpgradeVersions` will need to be read from the config response. Since config is fetched via `transport.getConfig()`, the dismiss list needs to be part of the config response or fetched from the `ui` config section. The simplest approach: read from the `serverConfig` which already includes the full config, or add a separate read. Since `GET /api/config` currently doesn't return `UserConfig` (it returns `ServerConfig` — runtime info), the dismiss list should be added to the `ServerConfig` response from the server by reading `configManager.get('ui')?.dismissedUpgradeVersions`.

**Updated `routes/config.ts`:**
```typescript
res.json({
  // ...existing fields...
  dismissedUpgradeVersions:
    configManager.get('ui')?.dismissedUpgradeVersions ?? [],
});
```

And add to `ServerConfigSchema`:
```typescript
dismissedUpgradeVersions: z.array(z.string())
  .openapi({ description: 'Versions the user has dismissed upgrade notifications for' }),
```

### 7. Client: Settings ServerTab Update

**File:** `apps/client/src/layers/features/settings/ui/ServerTab.tsx`

Update the version display to handle dev mode and remove duplicate `isNewer()`:

```typescript
import { isNewer } from '@/layers/features/status'; // Export from status module

export function ServerTab({ config, isLoading, onOpenTunnelDialog }: ServerTabProps) {
  return (
    <div className="space-y-3">
      {/* ...existing... */}

      {config?.isDevMode ? (
        // Dev mode: show dev indicator instead of version
        <div className="bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 -mx-1 rounded border px-2 py-1.5">
          <span className="text-amber-800 dark:text-amber-200 text-sm font-medium">
            Development Build
          </span>
          <p className="text-amber-700 dark:text-amber-300 mt-0.5 text-xs">
            Running from source — version checks disabled
          </p>
        </div>
      ) : (
        <>
          <ConfigRow label="Version" value={config.version} />
          {/* Update notice — reuse isNewer from status module */}
          {config.latestVersion && isNewer(config.latestVersion, config.version) && (
            /* ...existing update notice card... */
          )}
        </>
      )}
    </div>
  );
}
```

Extract `isNewer()` and `isFeatureUpdate()` from VersionItem into a shared utility in the status module's `lib/` segment (e.g., `apps/client/src/layers/features/status/lib/version-compare.ts`) and export from the barrel. This eliminates the duplicate in ServerTab.

### 8. Env & Config Documentation

**File:** `.env.example`

```bash
# Override version for testing upgrade notifications in dev mode.
# When set, dev detection is bypassed and this value is used as the current version.
# Example: DORKOS_VERSION_OVERRIDE=0.1.0 makes the UI show upgrade available for any version > 0.1.0
# DORKOS_VERSION_OVERRIDE=
```

**File:** `turbo.json`

Rename in `globalPassThroughEnv`:
```json
"DORKOS_VERSION_OVERRIDE"  // was "DORKOS_VERSION"
```

**File:** `contributing/configuration.md`

Add `DORKOS_VERSION_OVERRIDE` to the environment variables table with description and usage example.

**File:** `contributing/api-reference.md`

Document `isDevMode` boolean and `dismissedUpgradeVersions` array in the `GET /api/config` response schema.

---

## User Experience

### Dev Mode (running `pnpm dev`)

Status bar shows a small amber `DEV` badge where the version number would normally appear. No upgrade popover, no amber dot, no "Upgrade available" text. The Settings Server tab shows "Development Build — Running from source, version checks disabled" instead of a version number.

### Production Mode (installed via npm)

**Up to date:** Status bar shows `v1.2.3` in muted text. Settings shows version in the config list.

**Patch update available (e.g., 1.2.3 → 1.2.4):** Status bar shows `v1.2.4 available` with a static amber dot. Click opens popover with version transition, copy-able update command, and "Dismiss this version" link.

**Feature update available (e.g., 1.2.3 → 1.3.0):** Status bar shows `Upgrade available` in amber text with a pulsing amber dot. Click opens popover with version transition, copy-able update command, "What's new" link to GitHub release, and "Dismiss this version" link.

**Dismissed:** Status bar shows `v1.2.3` (current version, clean) with no update indicator. If a newer version is published later (e.g., 1.4.0), the notification reappears.

### Testing with DORKOS_VERSION_OVERRIDE

Developer adds `DORKOS_VERSION_OVERRIDE=0.1.0` to `.env`, restarts dev server. The status bar now behaves as if running v0.1.0 in production — showing the upgrade popover with the real latest version from npm. This allows full QA of the upgrade flow without publishing.

---

## Testing Strategy

### Server Tests

**`apps/server/src/lib/__tests__/version.test.ts`** (new file):

```typescript
describe('version resolution', () => {
  it('uses DORKOS_VERSION_OVERRIDE when set');
  it('uses __CLI_VERSION__ when defined and no override');
  it('falls back to package.json version');
  it('detects dev build when version is 0.0.0');
  it('detects dev build when version is 0.0.0-dev');
  it('is not dev build when DORKOS_VERSION_OVERRIDE is set');
  it('is not dev build when __CLI_VERSION__ is defined');
});
```

**`apps/server/src/services/core/__tests__/update-checker.test.ts`** (new or extend):

```typescript
describe('getLatestVersion', () => {
  it('returns null immediately when IS_DEV_BUILD is true');
  it('does not make network request in dev mode');
  it('fetches from npm registry in production mode');
  // ...existing cache tests...
});
```

### Client Tests

**`apps/client/src/layers/features/status/__tests__/VersionItem.test.tsx`** (extend):

```typescript
describe('dev mode', () => {
  it('renders DEV badge when isDevMode is true');
  it('does not show upgrade indicator in dev mode');
  it('has correct aria-label for dev badge');
});

describe('dismiss', () => {
  it('renders dismiss button in upgrade popover');
  it('calls onDismiss with version when dismiss clicked');
  it('shows plain version when isDismissed is true');
  it('does not show upgrade indicator when dismissed');
});
```

### Integration Testing

- Manual: run `pnpm dev` → verify DEV badge shows, no "Upgrade available"
- Manual: set `DORKOS_VERSION_OVERRIDE=0.1.0` → verify upgrade flow works
- Manual: dismiss upgrade → refresh page → verify dismiss persists

---

## Performance Considerations

- **Dev mode optimization:** Skipping the npm registry fetch eliminates a 5-second timeout potential and reduces dev startup by removing one network request
- **Dismiss state:** Stored server-side in config JSON file — negligible I/O (read once at startup, write only on dismiss)
- **No new queries:** Uses existing `['config']` TanStack Query with 5-minute stale time

## Security Considerations

- **Privacy:** Dev mode no longer phones home to npm registry — no version fingerprinting in dev
- **Config validation:** `dismissedUpgradeVersions` is validated by Zod as `z.array(z.string())` — cannot be exploited for injection
- **Env var safety:** `DORKOS_VERSION_OVERRIDE` is a non-sensitive development convenience variable

## Documentation

- Update `contributing/configuration.md` — add `DORKOS_VERSION_OVERRIDE` env var with usage
- Update `contributing/api-reference.md` — document `isDevMode` and `dismissedUpgradeVersions` in config response
- Update `.env.example` — rename and redocument the env var
- Update `contributing/environment-variables.md` — if it has a separate table of env vars

---

## Implementation Phases

### Phase 1: Fix Dev-Mode Bug (Server)

- Add `isDevBuild()` and `DORKOS_VERSION_OVERRIDE` support to `version.ts`
- Rename `DORKOS_VERSION` → `DORKOS_VERSION_OVERRIDE` in `env.ts` and `turbo.json`
- Guard `update-checker.ts` to skip fetch in dev mode
- Add `isDevMode` to config route response and `ServerConfigSchema`
- Write server-side tests

### Phase 2: Dev-Mode UI (Client)

- Add `isDevMode` prop to `VersionItem` — render DEV badge
- Pass `isDevMode` from `StatusLine` using `serverConfig.isDevMode`
- Update `ServerTab` to show dev-mode indicator
- Extract `isNewer()`/`isFeatureUpdate()` to shared `lib/version-compare.ts`
- Remove duplicate `isNewer()` from ServerTab
- Write client-side dev mode tests

### Phase 3: Upgrade Dismiss UX (Client + Server)

- Add `dismissedUpgradeVersions` to `UserConfigSchema` and config response
- Add `isDismissed` and `onDismiss` props to `VersionItem`
- Wire dismiss handler in `StatusLine` using `transport.updateConfig()`
- Add "Dismiss this version" button to upgrade popover
- Ensure release notes link uses `latestVersion` correctly
- Write dismiss tests

### Phase 4: Documentation

- Update `.env.example`
- Update `contributing/configuration.md`
- Update `contributing/api-reference.md`
- Update `contributing/environment-variables.md`

---

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

None currently. This spec may produce a draft ADR for "dev-mode detection pattern" if the approach proves reusable.

## References

- Ideation: `specs/dev-version-display-upgrade-ux/01-ideation.md`
- Research: `research/20260310_dev_version_display_upgrade_ux.md`
- Prior spec: `specs/versioning-release-system/02-specification.md` (original version system)
- Prior research: `research/20260217_cli_self_update_patterns.md`
- GitHub CLI update detection: `cli/cli/internal/update/update.go`
- Containerlab version management: `0.0.0` sentinel pattern
- `update-notifier` skip conditions: no `0.0.0` exemption (confirmed from source)
