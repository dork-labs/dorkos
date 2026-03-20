---
title: 'Settings: Reset All Data & Restart Server — UX Patterns, Technical Approaches, and Recommendations'
date: 2026-03-01
type: implementation
status: active
tags: [settings, ux, danger-zone, factory-reset, server-restart, nodejs, express]
feature_slug: settings-reset-restart
searches_performed: 8
sources_count: 18
---

# Settings: Reset All Data & Restart Server

## Research Summary

This report covers two dangerous-action features for the DorkOS Settings dialog: (1) "Reset All Data" which deletes `~/.dork` to factory-reset the app, and (2) "Restart Server" which triggers a Node.js/Express server restart from the client UI. Both features require careful UX (multi-step confirmation, danger zone placement) and specific technical implementation to work safely with DorkOS's existing service architecture. The recommended approach uses a dedicated server-side orchestration endpoint for reset (with ordered service teardown), a `process.exit(0)` + wrapper for restart, and a type-to-confirm pattern for the reset dialog.

---

## Key Findings

### 1. Danger Zone UX: Industry Standard Is Well-Established

- Platforms like GitHub, Vercel, Supabase, and Resend use a visually distinct "Danger Zone" section — typically at the bottom of settings, with a red border, warning icon, and destructive-styled buttons.
- For truly irreversible actions (data deletion), the most effective confirmation is **type-to-confirm** — requiring the user to type a specific string (e.g., "reset" or "DELETE") before the button activates. This is the GitHub/Resend standard for account deletion and repository deletion.
- For less catastrophic but still reversible actions (restart), a **two-step click** confirmation (click once to arm, click again to execute) is sufficient.
- Modal dialogs must include: explicit consequence statement ("This will permanently delete all schedules, relay config, mesh data..."), the specific action button labeled with the action verb (not "OK"), and a distinct cancel path.
- Users exhibit "cognitive inertia" — they click through generic "Are you sure?" dialogs without reading. Type-to-confirm forces deliberate action.

### 2. Factory Reset: Server-Side Orchestration Is Required

- The `~/.dork` directory contains multiple open resources at runtime: SQLite databases (PulseStore via `pulse.db`, Drizzle DB via `dork.db`, TraceStore), JSON files watched by chokidar (bindings, adapters, sessions), log files, and the config file.
- **Deleting a directory with open file handles causes platform-divergent behavior**: on macOS/Linux, the directory entry is unlinked but open handles remain valid until closed; on Windows, deletion fails with `EBUSY`. Since DorkOS targets both platforms (CLI runs on macOS/Linux, Windows support is implied by the npm package), handles must be closed before deletion.
- The existing `shutdown()` sequence in `apps/server/src/index.ts` already handles ordered teardown correctly. Reset must mirror this sequence: stop health check interval → stop SessionBroadcaster → stop SchedulerService → stop AdapterManager → close RelayCore → close TraceStore → stop MeshCore → stop Tunnel → then delete.
- After deletion, the ConfigManager must re-initialize (it uses `conf` which reads from the file at construction time). All in-memory service state becomes stale.
- **Recommended approach**: Reset is a two-phase server-side operation. Phase 1: teardown all services that hold file handles. Phase 2: `fs.rm(dorkHome, { recursive: true, force: true })` then respond 200. The client then polls for the server to come back up (same as the restart flow).
- Since the DB and config no longer exist after reset, the server must re-run its full startup sequence — meaning **reset implies restart**. The cleanest implementation calls `process.exit(0)` after deletion, relying on the same restart wrapper as the restart endpoint.

### 3. Restart Server: process.exit + External Wrapper Is the Right Pattern for CLI Mode

- Pure self-restart via `child_process.spawn` detached from within the process is unreliable for a CLI-started server. The spawned child would inherit the parent's stdio, signals, and environment but would not hold the same CLI argument context that set up `DORK_HOME`, port, etc.
- The DorkOS CLI (`packages/cli/src/cli.ts`) dynamically imports the server module — there is no parent process manager watching the child. `process.exit(0)` with a clean exit code will fully terminate the process without any auto-restart.
- **The correct pattern for dev mode**: Nodemon (already implied by turborepo `dev` scripts) watches for changes and restarts automatically. A `process.exit(0)` from the restart endpoint in dev mode will be caught by nodemon.
- **The correct pattern for CLI (production) mode**: The user runs `dorkos` directly, no process manager. `process.exit(0)` terminates the server. The client must show a "Restarting..." state, poll for the server to come back (health endpoint), and reload/reconnect when it does. However, since there is no process manager, the server will NOT come back automatically after `process.exit(0)` in standalone CLI mode.
- **Resolution**: The restart endpoint should use `child_process.spawn` to re-invoke `process.argv` with `{ detached: true, stdio: 'inherit' }` and then call `process.exit(0)`. This spawns a new server process and exits the current one. The child process inherits all environment variables set by the parent CLI.
- For dev mode with nodemon, `process.exit(0)` alone is sufficient (nodemon restarts).

### 4. Client Reconnection After Restart

- The client must detect that the server went down (SSE stream closes, requests start 503-ing) and show a "Restarting..." overlay.
- Poll `GET /api/health` every 1-2 seconds after detecting disconnection. When a 200 response returns, reload the app or re-establish SSE connections.
- The `SessionBroadcaster` SSE stream will close when the server exits — this is a natural trigger. The existing SSE reconnect logic (if any) should be leveraged; otherwise, add an `EventSource` `onerror` handler that triggers polling.
- Set a max polling timeout (e.g., 30 seconds) with a user-visible error if the server doesn't come back.

### 5. Security: Local-Only Context Reduces Risk

- DorkOS is a local-only tool by default (bound to `localhost` in `index.ts`). The restart and reset endpoints do not need additional authentication beyond what the CORS configuration already provides.
- **Rate limiting**: Apply a strict rate limit on both endpoints — 1 request per minute per IP is reasonable. Use `express-rate-limit` (already available in the ecosystem) on these routes specifically.
- **Reset endpoint**: Should require a confirmation token in the request body matching a server-generated nonce, OR simply rely on the UX friction (type-to-confirm) since this is a local tool. Given the local-only context, UX friction is sufficient.
- **Restart endpoint**: Two-step confirm in UI is sufficient security. No additional auth needed for local tool.
- **What if someone hits the reset API directly?**: Since the server is localhost-only by default, and since the tunnel (when enabled) uses HTTP basic auth, the attack surface is negligible. A rate limit is still good practice.

---

## Detailed Analysis

### A. "Danger Zone" UX Pattern

#### Visual Design

The industry standard from GitHub, Vercel, Supabase, and Resend:

- A visually separated section at the **bottom** of the settings panel/page
- Red border (`border-destructive`), warning icon (AlertTriangle), section heading "Danger Zone" or "Destructive Actions"
- Buttons styled as destructive (red/outlined-red background) but **not immediately clickable** — either disabled until confirmation or triggering a modal
- Each action has a clear consequence description below its label in muted text

For DorkOS's `SettingsDialog`, this maps to a new tab "Danger" or a section at the bottom of the "Server" tab with a `border-destructive rounded-md p-4` container.

#### Confirmation Patterns by Severity

| Action         | Pattern                 | Rationale                                    |
| -------------- | ----------------------- | -------------------------------------------- |
| Reset All Data | Type "reset" to confirm | Irreversible, destroys all user data         |
| Restart Server | Two-step click confirm  | Reversible (server comes back), lower stakes |

**Type-to-confirm implementation**:

```tsx
const [confirmText, setConfirmText] = useState('');
const canReset = confirmText === 'reset';
// Input placeholder: 'Type "reset" to confirm'
// Submit button disabled until canReset === true
```

**Two-step click for restart**:

```tsx
const [armed, setArmed] = useState(false);
// First click: setArmed(true), button label changes to "Click again to confirm"
// Second click within 5s: trigger restart
// Auto-disarm after 5s if no second click
```

#### Dialog Structure for Reset

```
AlertDialog (not regular Dialog — it's action-oriented)
  AlertDialogContent
    AlertDialogHeader
      AlertDialogTitle: "Reset All Data"
      AlertDialogDescription:
        "This will permanently delete all DorkOS data at ~/.dork, including:
         • All Pulse schedules and run history
         • All Relay configuration and message history
         • All Mesh agent registry data
         • Your config file (port, tunnel, preferences)
         This action cannot be undone. The server will restart automatically."
    Input
      placeholder='Type "reset" to confirm'
      value={confirmText}
      onChange={...}
    AlertDialogFooter
      AlertDialogCancel: "Cancel"
      AlertDialogAction (destructive, disabled={!canReset}): "Reset All Data"
```

### B. Server-Side Reset Implementation

#### What Lives in `~/.dork` (DORK_HOME)

From the server startup code, the following files/subdirectories exist:

- `config.json` — ConfigManager (Conf library, file-watched internally)
- `dork.db` — Drizzle consolidated SQLite database (open SQLite connection via `better-sqlite3`)
- `logs/` — Log files (rotating file logger)
- `relay/` — `adapters.json`, `bindings.json`, `sessions.json` (chokidar-watched)
- `pulse/` — `presets.json`

All of these have active file handles or watchers in a running server.

#### Correct Teardown Order for Reset

Must mirror `shutdown()` in `apps/server/src/index.ts`, then additionally close the DB:

```
1. clearInterval(healthCheckInterval)
2. sessionBroadcaster.shutdown()        // closes chokidar watcher + SSE clients
3. schedulerService.stop()              // stops cron jobs
4. adapterManager.shutdown()            // drains adapters
5. relayCore.close()                    // closes relay
6. traceStore.close()                   // closes SQLite connection in trace store
7. meshCore.stopPeriodicReconciliation() + meshCore.close()
8. tunnelManager.stop()
9. db.close()                           // close consolidated Drizzle DB (better-sqlite3)
10. fs.rm(dorkHome, { recursive: true, force: true })  // delete directory
11. process.exit(0)   // restart wrapper (see below) re-spawns the server
```

#### API Endpoint Design

```typescript
// POST /api/admin/reset
// Body: { confirm: 'reset' }
router.post('/reset', resetLimiter, async (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'reset') {
    return res.status(400).json({ error: 'Confirmation required' });
  }

  // Respond immediately — client will poll for restart
  res.json({ message: 'Reset initiated. Server will restart.' });

  // Run teardown asynchronously after response is sent
  setImmediate(() => performResetAndRestart());
});
```

The key pattern: **respond first, then act**. The client receives the 200 before the server begins teardown. This prevents the response from being lost during shutdown.

### C. Server-Side Restart Implementation

#### The Spawn-and-Exit Pattern

For CLI mode, spawn a fresh copy of the current process before exiting:

```typescript
// In restart handler — after responding to client
import { spawn } from 'child_process';

function spawnAndExit() {
  // Re-invoke the same entry point with the same arguments
  const child = spawn(process.argv[0], process.argv.slice(1), {
    detached: true,
    stdio: 'inherit',
    env: process.env, // Inherit all env vars set by CLI
  });
  child.unref(); // Allow parent to exit independently
  process.exit(0);
}
```

This works because:

- `process.argv[0]` is `node` (or the CLI binary)
- `process.argv.slice(1)` is the CLI entry script + its args
- All env vars set during CLI startup (`DORK_HOME`, `DORKOS_PORT`, etc.) are inherited
- The child process starts fresh, re-runs `start()`, and picks up from a clean state

#### Dev Mode Consideration

In dev mode, the server runs under nodemon/turbo watch. `process.exit(0)` alone triggers an automatic restart. The spawn-and-exit approach would create a double restart.

Solution: Check `NODE_ENV` — if `development`, just `process.exit(0)`. If `production`, use spawn-and-exit.

```typescript
function triggerRestart() {
  if (process.env.NODE_ENV === 'development') {
    process.exit(0); // nodemon handles restart
  } else {
    spawnAndExit(); // spawn fresh process for CLI mode
  }
}
```

#### API Endpoint Design

```typescript
// POST /api/admin/restart
router.post('/restart', restartLimiter, async (_req, res) => {
  res.json({ message: 'Restart initiated' });
  setImmediate(triggerRestart);
});
```

### D. Client-Side Reconnection Logic

After triggering reset or restart, the client must:

1. Show a "Restarting..." overlay (non-dismissable modal or full-screen state)
2. Close/ignore the current SSE stream (it will error out)
3. Poll `GET /api/health` every 1500ms
4. On successful health response: `window.location.reload()` to re-initialize all state
5. If polling exceeds 30 seconds: show error "Server did not restart. Check terminal."

```typescript
async function waitForRestart() {
  const maxWaitMs = 30_000;
  const pollIntervalMs = 1_500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // Server still down — keep polling
    }
  }

  // Timeout
  setRestartError('Server did not come back after 30 seconds. Check terminal.');
}
```

### E. Route Organization

Both endpoints belong in a new `apps/server/src/routes/admin.ts` route file:

```
POST /api/admin/reset    — factory reset
POST /api/admin/restart  — server restart
```

This groups dangerous administrative operations under a clear namespace. Register in `app.ts`:

```typescript
import adminRoutes from './routes/admin.js';
app.use('/api/admin', adminRoutes);
```

The route handler needs access to the global service references (`sessionBroadcaster`, `schedulerService`, `relayCore`, etc.) that are currently local to `index.ts`. These need to be exposed via a module-level registry or passed to the route factory.

**Implementation pattern**: Export a `createAdminRouter(deps: AdminDeps)` factory (matches the pattern used by `createMeshRouter`, `createPulseRouter`, etc.):

```typescript
interface AdminDeps {
  dorkHome: string;
  db: DrizzleDB;
  sessionBroadcaster: SessionBroadcaster | null;
  schedulerService: SchedulerService | null;
  relayCore: RelayCore | undefined;
  adapterManager: AdapterManager | undefined;
  traceStore: TraceStore | undefined;
  meshCore: MeshCore | undefined;
  healthCheckInterval: ReturnType<typeof setInterval> | undefined;
}
```

### F. Transport Interface Extension

Following the FSD patterns in DorkOS, the Transport interface needs two new methods:

```typescript
// packages/shared/src/transport.ts
resetAllData(confirm: string): Promise<{ message: string }>;
restartServer(): Promise<{ message: string }>;
```

HTTP Transport: POST to `/api/admin/reset` and `/api/admin/restart`
Direct Transport (Obsidian plugin): Both throw `new Error('Not supported in Obsidian plugin')` or are no-ops.

---

## Approach Comparison

### For Reset

| Approach                             | Pros                        | Cons                                                      | Verdict                |
| ------------------------------------ | --------------------------- | --------------------------------------------------------- | ---------------------- |
| 1. Delete entire `~/.dork` dir       | Clean slate, simplest code  | Requires ordered teardown, implies restart                | **Recommended**        |
| 2. Delete contents only              | Directory stays             | Same file-lock issues, more complex glob                  | Unnecessary complexity |
| 3. Each service clears its own data  | Surgical, no restart needed | Complex orchestration, stale in-memory state still exists | Too complex, fragile   |
| 4. Server-side orchestrated endpoint | What we're proposing        | Requires exposing service refs to route                   | **Recommended**        |

Verdict: **Delete entire directory + exit** is the right approach. Approach 1 and 4 are the same thing — a server-side endpoint that tears down services, deletes, and exits.

### For Restart

| Approach                  | Pros                                | Cons                                        | Verdict                        |
| ------------------------- | ----------------------------------- | ------------------------------------------- | ------------------------------ |
| 1. `process.exit(0)` only | Simple                              | Doesn't restart in CLI mode                 | Dev-mode only                  |
| 2. spawn-and-exit         | Works in CLI mode, inherits all env | Slightly more complex                       | **Recommended for production** |
| 3. cluster module         | Zero-downtime                       | Massive overkill for single-user local tool | Not appropriate                |
| 4. pm2/systemd            | Reliable                            | External dependency, not DorkOS's concern   | Out of scope                   |

Verdict: **spawn-and-exit in production, exit-only in development** (detect via `NODE_ENV`).

---

## Final Recommendations

### UX

1. Add a "Danger" section to the existing Settings dialog. The current `SettingsDialog.tsx` uses a tabs UI — add a new tab or add a visually separated section to the Server tab. A dedicated section within the Server tab (after the existing config rows) is simpler than a new tab.

2. The section should have:
   - A `border border-destructive rounded-md p-3 space-y-3` container
   - A heading "Danger Zone" with a `TriangleAlert` icon in `text-destructive`
   - Two rows: Reset All Data + Restart Server, each with a description and a destructive-variant button

3. **Reset confirmation**: Open an AlertDialog. Require typing `reset` in an input before the submit button enables. Include an explicit list of what will be deleted.

4. **Restart confirmation**: Two-step confirm pattern in a smaller AlertDialog. First step shows consequences ("All active sessions will be interrupted"). Confirm button triggers restart.

5. Show a full-screen "Restarting..." overlay in the client while waiting for the server to come back.

### Implementation

**Server side:**

- New `apps/server/src/routes/admin.ts` with `createAdminRouter(deps)` factory
- `POST /api/admin/reset` — validates body, responds 200, then tears down services and calls `fs.rm` + `process.exit(0)` (spawn-and-exit in production)
- `POST /api/admin/restart` — responds 200, then `process.exit(0)` (spawn-and-exit in production)
- Rate limit both endpoints: 3 requests per 5 minutes (generous enough for testing, restrictive enough to prevent loops)
- Mount in `index.ts` alongside other admin-type routes, passing the service references via the factory

**Client side:**

- Add `resetAllData()` and `restartServer()` methods to Transport interface + implementations
- New `DangerSection.tsx` component in `apps/client/src/layers/features/settings/ui/`
- New `ResetDialog.tsx` with type-to-confirm pattern
- New `RestartDialog.tsx` with two-step confirm
- Shared `useServerRestart` hook that manages the polling/reconnect state
- `ServerRestartOverlay.tsx` — full-screen overlay shown during restart/reset polling

**File locations (following FSD and server conventions):**

- `apps/server/src/routes/admin.ts` — new route file
- `apps/client/src/layers/features/settings/ui/DangerSection.tsx`
- `apps/client/src/layers/features/settings/ui/ResetDialog.tsx`
- `apps/client/src/layers/features/settings/ui/RestartDialog.tsx`
- `apps/client/src/layers/features/settings/model/use-server-restart.ts`
- `apps/client/src/layers/features/settings/ui/ServerRestartOverlay.tsx`

### Security

- Both endpoints are localhost-only (existing CORS config) — additional auth not required
- Apply `express-rate-limit` specifically to the admin router (3 req / 5 min window)
- The reset body requires `{ confirm: 'reset' }` — server validates this before acting
- The UX type-to-confirm is the primary safeguard; server-side body validation is a secondary layer

---

## Research Gaps & Limitations

- The spawn-and-exit approach on Windows in CLI mode: `process.argv[0]` may be the compiled binary path rather than `node`. Needs testing on Windows. Fallback: detect OS and use `process.exit(0)` only on Windows (user must re-run CLI manually).
- If the reset takes >30 seconds (very large log directory), the client timeout will show a false error. The 30-second timeout is conservative but might need tuning.
- The DorkOS server currently binds to `localhost` only. If `DORKOS_CORS_ORIGIN` is set to `*`, the admin endpoints become accessible from any origin — the rate limiter should also check for this and add stricter controls.

---

## Sources & Evidence

- "Danger Zone" confirmation UX patterns — [How To Manage Dangerous Actions In User Interfaces — Smashing Magazine](https://www.smashingmagazine.com/2024/09/how-manage-dangerous-actions-user-interfaces/) (2024)
- Type-to-confirm for irreversible actions — [A UX guide to destructive actions: their use case and best practices](https://medium.com/design-bootcamp/a-ux-guide-to-destructive-actions-their-use-cases-and-best-practices-f1d8a9478d03)
- NN/g on confirmation dialogs — [Confirmation Dialogs Can Prevent User Errors (If Not Overused)](https://www.nngroup.com/articles/confirmation-dialog/)
- GitLab Pajamas Design System destructive actions — [Destructive actions | Pajamas Design System](https://design.gitlab.com/patterns/destructive-actions/)
- Node.js graceful shutdown patterns — [Health Checks and Graceful Shutdown — Express.js docs](https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html)
- Graceful shutdown with Node.js — [How to Build a Graceful Shutdown Handler in Node.js](https://oneuptime.com/blog/post/2026-01-06-nodejs-graceful-shutdown-handler/view)
- child_process.spawn detached — [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html)
- Node.js `fs.rm` recursive delete — [Node.js fs.rm() Method — GeeksforGeeks](https://www.geeksforgeeks.org/node-js/node-js-fs-rm-method/)
- File locking in Node.js — [Understanding Node.js file locking — LogRocket Blog](https://blog.logrocket.com/understanding-node-js-file-locking/)
- Express rate limiting — [Rate Limiting in Express.js | Better Stack Community](https://betterstack.com/community/guides/scaling-nodejs/rate-limiting-express/)
- DorkOS server startup/shutdown — `apps/server/src/index.ts` (project source)
- DorkOS CLI entry — `packages/cli/src/cli.ts` (project source)
- DorkOS settings dialog — `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` (project source)
- DorkOS config route — `apps/server/src/routes/config.ts` (project source)

## Search Methodology

- Searches performed: 8
- Most productive search terms: "danger zone UX patterns confirmation dialog web apps 2024", "Node.js Express graceful shutdown respawn", "Node.js restart itself child_process spawn detached", "fs.rm recursive delete directory SQLite"
- Primary information sources: Smashing Magazine, NN/g, Express.js docs, Node.js docs, DorkOS source code
