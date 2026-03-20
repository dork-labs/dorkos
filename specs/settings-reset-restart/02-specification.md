---
slug: settings-reset-restart
number: 82
created: 2026-03-01
status: specified
authors: [Claude Code]
---

# Settings Reset & Server Restart

## Status

Specified

## Overview

Add two dangerous-action capabilities to the Settings dialog via a new "Advanced" tab: **Reset All Data** (factory-reset by deleting the `.dork` directory + clearing browser localStorage) and **Restart Server** (graceful restart via spawn-and-exit). Both use industry-standard Danger Zone UX with appropriate confirmation friction to prevent accidental use.

## Background / Problem Statement

DorkOS accumulates persistent state across multiple subsystems: config files, SQLite databases (Pulse schedules, Relay traces, Mesh registry), JSON stores (adapter configs, bindings, access rules), and log files. Users currently have no way to factory-reset this state without manually locating and deleting the `.dork` directory, which varies by environment (dev vs prod vs custom `DORK_HOME`). Similarly, restarting the server requires terminating the process manually via the terminal.

Both operations are common needs during development, debugging, and when onboarding state becomes corrupted. Providing safe, well-guarded UI for these operations improves the developer experience significantly.

## Goals

- Provide a "Reset All Data" button that deletes all DorkOS persistent state and restarts the server
- Provide a "Restart Server" button that gracefully restarts the server process
- Prevent accidental use via type-to-confirm (reset) and confirmation dialog (restart)
- Handle the variable `.dork` directory location correctly across all environments
- Ensure all deleted data is lazily re-created on next server startup
- Clear browser localStorage as part of reset for a complete factory-reset experience
- Show a reconnection overlay while the server restarts, with automatic reload on recovery

## Non-Goals

- Deleting Claude SDK transcript files (`~/.claude/projects/`)
- Selective reset (e.g., "only clear Pulse data" or "only clear Relay data")
- External process manager integration (pm2, systemd)
- Zero-downtime restart (cluster module)
- Additional authentication beyond existing CORS (localhost-only tool)

## Technical Dependencies

- `express-rate-limit` — New dependency for rate limiting admin endpoints (add to `apps/server/package.json`)
- Existing: `better-sqlite3`, `chokidar`, `conf`, `@dorkos/relay`, `@dorkos/mesh`, `@dorkos/db`
- Existing: Radix UI AlertDialog (already in `apps/client/src/layers/shared/ui/alert-dialog.tsx`)
- Existing: `lucide-react` for TriangleAlert icon

## Detailed Design

### A. Server: Admin Route (`apps/server/src/routes/admin.ts`)

New route file using the established factory pattern:

```typescript
interface AdminDeps {
  dorkHome: string;
  shutdownServices: () => Promise<void>;
  closeDb: () => void;
}

export function createAdminRouter(deps: AdminDeps): Router;
```

#### POST `/api/admin/reset`

1. Validate request body: `{ confirm: 'reset' }` — return 400 if missing/incorrect
2. Respond 200 with `{ message: 'Reset initiated. Server will restart.' }` immediately
3. Via `setImmediate()`, asynchronously:
   a. Call `deps.shutdownServices()` — mirrors the existing `shutdown()` teardown order
   b. Call `deps.closeDb()` — close the Drizzle/better-sqlite3 connection
   c. Call `fs.rm(deps.dorkHome, { recursive: true, force: true })`
   d. Call `triggerRestart()` (see restart logic below)

#### POST `/api/admin/restart`

1. Respond 200 with `{ message: 'Restart initiated.' }` immediately
2. Via `setImmediate()`, asynchronously:
   a. Call `deps.shutdownServices()` — same ordered teardown
   b. Call `triggerRestart()`

#### `triggerRestart()` helper

```typescript
function triggerRestart(): void {
  if (process.env.NODE_ENV === 'development') {
    // Dev mode: nodemon/turbo watches for exit and restarts
    process.exit(0);
  } else {
    // Production/CLI mode: spawn new process, then exit
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: 'inherit',
      env: process.env,
    });
    child.unref();
    process.exit(0);
  }
}
```

#### Rate Limiting

Apply `express-rate-limit` to the admin router: 3 requests per 5-minute window per IP.

```typescript
const adminLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  message: { error: 'Too many admin requests. Try again later.' },
});
router.use(adminLimiter);
```

### B. Server: Index Changes (`apps/server/src/index.ts`)

1. Extract a `shutdownServices()` function from the existing `shutdown()` function body (lines 284-310). The existing `shutdown()` becomes `shutdownServices()` + `process.exit(0)`.
2. Mount admin router after other routes:
   ```typescript
   app.use(
     '/api/admin',
     createAdminRouter({
       dorkHome,
       shutdownServices,
       closeDb: () => db.close(),
     })
   );
   ```
3. The `shutdown()` signal handler (SIGINT/SIGTERM) calls `shutdownServices()` then `process.exit(0)` as before.

#### `shutdownServices()` teardown order

```
1. clearInterval(healthCheckInterval)
2. sessionBroadcaster?.shutdown()
3. schedulerService?.stop()
4. adapterManager?.shutdown()
5. relayCore?.close()
6. traceStore?.close()
7. meshCore?.stopPeriodicReconciliation() + meshCore?.close()
8. tunnelManager.stop()
```

This is the exact existing order from `shutdown()`. The refactor just extracts it into a reusable function.

### C. Transport Interface (`packages/shared/src/transport.ts`)

Add two new methods to the `Transport` interface:

```typescript
resetAllData(confirm: string): Promise<{ message: string }>;
restartServer(): Promise<{ message: string }>;
```

**HttpTransport** implementation:

```typescript
async resetAllData(confirm: string): Promise<{ message: string }> {
  const res = await fetch(`${this.baseUrl}/api/admin/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async restartServer(): Promise<{ message: string }> {
  const res = await fetch(`${this.baseUrl}/api/admin/restart`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

**DirectTransport** (Obsidian plugin): Both methods throw `new Error('Reset and restart are not supported in Obsidian plugin mode.')`.

### D. Client: SettingsDialog Changes

#### SettingsDialog.tsx modifications

1. Add "Advanced" tab trigger to the TabsList (change `grid-cols-4` to `grid-cols-5`)
2. Add `TabsContent` for the Advanced tab rendering `<AdvancedTab />`
3. Add state for `restartOverlayOpen` — when true, renders `<ServerRestartOverlay />` as a portal

#### New component: `AdvancedTab.tsx`

Danger Zone section layout:

```
┌─────────────────────────────────────────────┐
│  Advanced                                    │
│                                              │
│  ┌─ border-destructive ──────────────────┐  │
│  │  ⚠ Danger Zone                        │  │
│  │                                        │  │
│  │  Reset All Data                        │  │
│  │  Permanently delete all DorkOS data    │  │
│  │  and restart the server.         [Reset]│  │
│  │                                        │  │
│  │  ─────────────────────────────────     │  │
│  │                                        │  │
│  │  Restart Server                        │  │
│  │  Restart the DorkOS server process.    │  │
│  │  Active sessions will be      [Restart]│  │
│  │  interrupted.                          │  │
│  └────────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- Container: `border border-destructive/50 rounded-lg p-4 space-y-4`
- Heading: `TriangleAlert` icon + "Danger Zone" in `text-destructive text-sm font-semibold`
- Each row: flex with title/description on left, destructive-variant Button on right
- Separator between rows using `<Separator />`

Props:

```typescript
interface AdvancedTabProps {
  onResetComplete: () => void; // triggers restart overlay
  onRestartComplete: () => void; // triggers restart overlay
}
```

Each button opens its respective dialog (ResetDialog or RestartDialog).

#### New component: `ResetDialog.tsx`

AlertDialog with type-to-confirm pattern:

```
┌───────────────────────────────────────────┐
│  Reset All Data                            │
│                                            │
│  This will permanently delete all DorkOS   │
│  data, including:                          │
│                                            │
│  • All Pulse schedules and run history     │
│  • All Relay configuration and messages    │
│  • All Mesh agent registry data            │
│  • Your config file and preferences        │
│  • All server logs                         │
│                                            │
│  The server will restart automatically.    │
│  Your UI preferences will also be cleared. │
│                                            │
│  This action cannot be undone.             │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ Type "reset" to confirm             │  │
│  └──────────────────────────────────────┘  │
│                                            │
│            [Cancel]  [Reset All Data]      │
│                       (disabled until      │
│                        "reset" typed)      │
└───────────────────────────────────────────┘
```

On confirm:

1. Call `transport.resetAllData('reset')`
2. On success: call `localStorage.clear()`, then trigger restart overlay via callback
3. On error: show toast with error message

#### New component: `RestartDialog.tsx`

Simpler AlertDialog confirmation:

```
┌───────────────────────────────────────────┐
│  Restart Server                            │
│                                            │
│  This will restart the DorkOS server.      │
│  All active sessions will be interrupted.  │
│                                            │
│            [Cancel]  [Restart Server]      │
└───────────────────────────────────────────┘
```

On confirm:

1. Call `transport.restartServer()`
2. On success: trigger restart overlay via callback
3. On error: show toast with error message

#### New component: `ServerRestartOverlay.tsx`

Full-screen overlay rendered via React portal (above everything):

```
┌───────────────────────────────────────────┐
│                                            │
│                                            │
│              ◌  (spinner)                  │
│                                            │
│         Restarting server...               │
│    Waiting for server to come back...      │
│                                            │
│                                            │
└───────────────────────────────────────────┘
```

Behavior:

1. On mount: start polling `GET /api/health` every 1500ms
2. On successful health response: call `window.location.reload()` (forces fresh state)
3. After 30 seconds without success: show error state:
   ```
   Server did not restart within 30 seconds.
   Check your terminal for errors.
   [Try Again]  [Dismiss]
   ```
4. "Try Again" resets the 30s timer and resumes polling
5. "Dismiss" closes the overlay

Styling: `fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm flex items-center justify-center`

### E. File Organization (FSD)

All new client files go in `apps/client/src/layers/features/settings/ui/`:

```
features/settings/
├── ui/
│   ├── SettingsDialog.tsx      (MODIFY - add Advanced tab)
│   ├── ServerTab.tsx           (no changes)
│   ├── AdvancedTab.tsx         (NEW)
│   ├── ResetDialog.tsx         (NEW)
│   ├── RestartDialog.tsx       (NEW)
│   ├── ServerRestartOverlay.tsx (NEW)
│   ├── TunnelDialog.tsx        (no changes)
│   └── TunnelOnboarding.tsx    (no changes)
└── index.ts                    (no changes needed - SettingsDialog barrel handles it)
```

Server:

```
routes/
├── admin.ts                    (NEW)
├── config.ts                   (no changes)
├── sessions.ts                 (no changes)
└── ...
```

## User Experience

### Discovery

Users find these features in Settings (gear icon) > "Advanced" tab. The Danger Zone is visually prominent with a red border, ensuring users understand the gravity of these actions.

### Reset Flow

1. User clicks "Reset" button in Danger Zone
2. AlertDialog opens with explicit consequence list
3. User types "reset" in the confirmation input
4. Button enables; user clicks "Reset All Data"
5. Dialog closes, `localStorage.clear()` runs immediately
6. Full-screen "Restarting server..." overlay appears
7. Client polls health endpoint every 1.5s
8. Server comes back (fresh state), client auto-reloads
9. User sees fresh DorkOS with all defaults restored

### Restart Flow

1. User clicks "Restart" button in Danger Zone
2. Simple AlertDialog asks for confirmation
3. User clicks "Restart Server"
4. Dialog closes, full-screen overlay appears
5. Client polls health endpoint
6. Server comes back, client auto-reloads
7. User continues with preserved data

### Error States

- **Server doesn't come back (30s timeout)**: Overlay shows error message with "Try Again" and "Dismiss" buttons
- **Network error during reset/restart call**: Toast notification with error message, no overlay
- **Rate limited**: Toast shows "Too many admin requests. Try again later."
- **Obsidian plugin mode**: Both buttons would call DirectTransport methods that throw a helpful error; however, since the Advanced tab is only relevant in standalone mode, consider hiding or disabling the entire tab when using DirectTransport

## Testing Strategy

### Server Tests (`apps/server/src/routes/__tests__/admin.test.ts`)

1. **Reset endpoint validation**: POST `/api/admin/reset` without `{ confirm: 'reset' }` returns 400
2. **Reset endpoint success**: POST with correct body returns 200, calls shutdownServices, calls fs.rm with correct dorkHome path, calls triggerRestart
3. **Restart endpoint success**: POST `/api/admin/restart` returns 200, calls shutdownServices (not fs.rm), calls triggerRestart
4. **Rate limiting**: Fourth request within 5 minutes returns 429
5. **triggerRestart dev mode**: When `NODE_ENV=development`, calls `process.exit(0)` without spawning
6. **triggerRestart prod mode**: When `NODE_ENV=production`, calls `spawn()` with correct args then `process.exit(0)`

Mock `fs.rm`, `child_process.spawn`, `process.exit`, and the `shutdownServices` function.

### Client Tests

#### `AdvancedTab.test.tsx`

1. **Renders danger zone**: Verify "Danger Zone" heading, TriangleAlert icon, both buttons visible
2. **Reset button opens dialog**: Click "Reset" → ResetDialog appears
3. **Restart button opens dialog**: Click "Restart" → RestartDialog appears

#### `ResetDialog.test.tsx`

1. **Submit disabled initially**: Reset button is disabled when input is empty
2. **Submit disabled with wrong text**: Typing "delete" doesn't enable the button
3. **Submit enabled with correct text**: Typing "reset" enables the button
4. **Calls transport on submit**: After typing "reset" and clicking submit, `transport.resetAllData('reset')` is called
5. **Clears localStorage on success**: After successful API call, `localStorage.clear()` is called
6. **Calls onResetComplete callback**: Triggers the restart overlay

#### `RestartDialog.test.tsx`

1. **Shows confirmation text**: Dialog displays "All active sessions will be interrupted"
2. **Calls transport on confirm**: Clicking "Restart Server" calls `transport.restartServer()`
3. **Calls onRestartComplete callback**: Triggers the restart overlay

#### `ServerRestartOverlay.test.tsx`

1. **Renders loading state**: Shows spinner and "Restarting server..." text
2. **Polls health endpoint**: Verify fetch is called with `/api/health` at intervals
3. **Reloads on health success**: When health responds 200, `window.location.reload()` is called
4. **Shows error after timeout**: After 30s without health response, error message appears
5. **Try Again resets timer**: Clicking "Try Again" resumes polling

Use `vi.useFakeTimers()` for timeout testing. Mock `fetch` for health polling. Mock `window.location.reload`.

## Performance Considerations

- **Rate limiting** prevents abuse (3 req / 5 min)
- **Health polling at 1.5s intervals** is lightweight (simple GET, small JSON response)
- **`setImmediate()` for async teardown** ensures the 200 response is sent before heavy I/O begins
- **`fs.rm` with `recursive: true, force: true`** handles large directories efficiently (Node.js built-in)
- No impact on normal operation — these are infrequent admin actions

## Security Considerations

- **Localhost-only by default**: Server binds to `localhost`, CORS restricts origins
- **Rate limiting**: Prevents rapid-fire abuse of admin endpoints
- **Type-to-confirm**: Primary safeguard against accidental reset
- **Server-side body validation**: Reset requires exact `{ confirm: 'reset' }` match
- **Respond-first pattern**: Server sends 200 before teardown, preventing response loss
- **No secrets in response**: Endpoints return simple status messages only
- **Tunnel exposure**: When ngrok tunnel is active with basic auth, admin endpoints are accessible but protected by the tunnel's authentication layer. Rate limiting provides an additional layer.

## Documentation

- Update `contributing/configuration.md` to document the new admin endpoints
- Add keyboard shortcut documentation if any shortcuts are added
- No external user-facing docs changes needed (admin features are self-explanatory in the UI)

## Implementation Phases

### Phase 1: Server Infrastructure

- Add `express-rate-limit` dependency
- Refactor `shutdown()` in `index.ts` to extract `shutdownServices()`
- Create `routes/admin.ts` with `createAdminRouter(deps)`
- Implement `POST /api/admin/reset` and `POST /api/admin/restart`
- Implement `triggerRestart()` with dev/prod branching
- Mount admin router in `index.ts`
- Write server tests

### Phase 2: Transport & Client UI

- Add `resetAllData()` and `restartServer()` to Transport interface
- Implement in HttpTransport and DirectTransport
- Create `AdvancedTab.tsx` with Danger Zone layout
- Create `ResetDialog.tsx` with type-to-confirm
- Create `RestartDialog.tsx` with simple confirm
- Modify `SettingsDialog.tsx` to add Advanced tab
- Write client component tests

### Phase 3: Reconnection Overlay

- Create `ServerRestartOverlay.tsx` with health polling
- Wire overlay into SettingsDialog state
- Handle timeout and error states
- Write overlay tests
- End-to-end manual testing of full reset and restart flows

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

No existing ADRs directly related. This feature may produce a draft ADR for the spawn-and-exit restart pattern if it proves to be a significant architectural decision.

## References

- Ideation: `specs/settings-reset-restart/01-ideation.md`
- Research: `research/20260301_settings_reset_restart.md`
- Existing shutdown sequence: `apps/server/src/index.ts:284-312`
- DORK_HOME resolution: `apps/server/src/lib/dork-home.ts`
- Transport interface: `packages/shared/src/transport.ts`
- AlertDialog primitives: `apps/client/src/layers/shared/ui/alert-dialog.tsx`
- App store (localStorage): `apps/client/src/layers/shared/model/app-store.ts`
- Danger Zone UX research: [Smashing Magazine](https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/), [NN/g](https://www.nngroup.com/articles/confirmation-dialog/)
