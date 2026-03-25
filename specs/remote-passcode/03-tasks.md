# Remote Access Passcode — Task Breakdown

**Spec:** `specs/remote-passcode/02-specification.md`
**Generated:** 2026-03-24
**Mode:** Full

---

## Phase 1: Server Foundation

### Task 1.1 — Add passcode fields to shared schemas and constants

**Size:** Medium | **Priority:** High | **Dependencies:** None

Update four files in `packages/shared/src/`:

1. **`config-schema.ts`** — Add `passcodeEnabled`, `passcodeHash`, `passcodeSalt` to the `tunnel` object in `UserConfigSchema`. Add top-level `sessionSecret` field. Add `tunnel.passcodeHash` and `tunnel.passcodeSalt` to `SENSITIVE_CONFIG_KEYS`.

2. **`schemas.ts`** — Add `passcodeEnabled: z.boolean()` to `TunnelStatusSchema`. Add `PasscodeVerifyRequestSchema`, `PasscodeVerifyResponseSchema`, and `PasscodeSessionResponseSchema`.

3. **`constants.ts`** — Add `PASSCODE_LENGTH`, `PASSCODE_SESSION_MAX_AGE_MS`, `PASSCODE_RATE_LIMIT_WINDOW_MS`, `PASSCODE_RATE_LIMIT_MAX`, `PASSCODE_CONSECUTIVE_LIMIT`, `PASSCODE_CONSECUTIVE_BLOCK_MS`.

4. **`transport.ts`** — Add `verifyTunnelPasscode` and `checkTunnelSession` methods to the `Transport` interface.

**Acceptance:** `pnpm typecheck` passes. All new schemas parse correctly. Transport interface compiles with new methods.

---

### Task 1.2 — Create passcode-hash utility module with scrypt hashing

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Create `apps/server/src/lib/passcode-hash.ts` with `hashPasscode` and `verifyPasscode` functions using Node.js `crypto.scrypt` (64-byte key, 32-byte random salt, timing-safe comparison).

Write 8 tests in `apps/server/src/lib/__tests__/passcode-hash.test.ts`:

- Hash returns hex strings of correct length
- Unique salts per call
- Correct passcode verifies true
- Incorrect passcode verifies false
- Length mismatch returns false (no throw)
- Cross-salt verification fails

**Acceptance:** All 8 test scenarios pass.

---

### Task 1.3 — Install cookie-session and configure session middleware in app.ts

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2

Install `cookie-session` + `@types/cookie-session`. Configure in `apps/server/src/app.ts` after `requestLogger` and before route handlers. Auto-generate session secret on first run via `crypto.randomBytes(32)`, persist to config. Set `trust proxy: 1`. Cookie config: `name: 'dorkos_session'`, `httpOnly: true`, `secure: true`, `sameSite: 'strict'`, `maxAge: PASSCODE_SESSION_MAX_AGE_MS`. Add TypeScript type augmentation for `req.session.tunnelAuthenticated`.

**Acceptance:** `pnpm build` succeeds. `req.session.tunnelAuthenticated` typechecks. Session secret persists across restarts.

---

### Task 1.4 — Create tunnel-auth middleware for passcode gate enforcement

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.3

Create `apps/server/src/middleware/tunnel-auth.ts`. Passes through for localhost/127.0.0.1, when passcode is not enabled/configured, for exempt routes (`/api/tunnel/verify-passcode`, `/api/tunnel/session`, `/api/health`, `/assets/*`, `/favicon.ico`), and when `req.session.tunnelAuthenticated` is true. Returns 401 otherwise. Register in `app.ts` after `cookieSession`.

Write 11 tests in `apps/server/src/middleware/__tests__/tunnel-auth.test.ts` covering all pass-through and block scenarios.

**Acceptance:** All 11 test scenarios pass. Middleware is registered in correct order in `app.ts`.

---

### Task 1.5 — Add passcode verify, session, and set-passcode routes to tunnel router

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.2, 1.3

Add three endpoints to `apps/server/src/routes/tunnel.ts`:

1. **`POST /api/tunnel/verify-passcode`** — Rate-limited, validates with `PasscodeVerifyRequestSchema`, verifies against stored hash, sets session cookie on success.
2. **`GET /api/tunnel/session`** — Returns `{ authenticated, passcodeRequired }`.
3. **`POST /api/tunnel/set-passcode`** — Localhost-only (403 for tunnel), hashes passcode before storage, supports disable via `{ enabled: false }`, calls `tunnelManager.refreshStatus()`.

Write 10 tests in `apps/server/src/routes/__tests__/tunnel-passcode.test.ts`.

**Acceptance:** All 10 test scenarios pass. Passcode is never stored in plaintext. Rate limiter blocks after 10 attempts per 15-minute window.

---

### Task 1.6 — Update tunnel-manager status getter and add refreshStatus method

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2, 1.3

Modify `apps/server/src/services/core/tunnel-manager.ts`:

1. Add `passcodeEnabled: false` to `DEFAULT_STATUS`
2. Update `status` getter to dynamically read passcode config: `passcodeEnabled: !!(tunnelConfig?.passcodeEnabled && tunnelConfig?.passcodeHash)`
3. Add `refreshStatus()` method that emits `status_change` event
4. Import `configManager`

**Acceptance:** `tunnelManager.status.passcodeEnabled` reflects config state. `refreshStatus()` emits event. `pnpm typecheck` passes.

---

## Phase 2: Client Gate

### Task 2.1 — Install shadcn InputOTP component and add transport methods

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

1. Install shadcn InputOTP: `cd apps/client && npx shadcn@latest add input-otp`
2. Export from shared UI barrel
3. Add `verifyTunnelPasscode` and `checkTunnelSession` to `HttpTransport` (calls `POST /tunnel/verify-passcode` and `GET /tunnel/session`)
4. Add stubs to `DirectTransport` (returns `{ ok: true }` and `{ authenticated: true, passcodeRequired: false }`)
5. Add both methods to mock transport factory in test-utils

**Acceptance:** `pnpm typecheck` passes. InputOTP component renders. Both transports implement the new methods.

---

### Task 2.2 — Create PasscodeGate and PasscodeGateWrapper components

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

Create `apps/client/src/layers/features/tunnel-gate/` FSD feature module:

1. **`ui/PasscodeGate.tsx`** — Full-screen passcode entry: DorkLogo, heading, InputOTP with 6 numeric slots, auto-submit on completion, error display, disabled state during verification.
2. **`ui/PasscodeGateWrapper.tsx`** — Orchestrator: checks `window.location.hostname`, calls `checkTunnelSession` on tunnel URLs, renders gate or children.
3. **`index.ts`** — Barrel export.

**Acceptance:** Gate renders correctly. Wrapper bypasses on localhost. Wrapper shows gate for unauthenticated tunnel requests. Wrapper passes through on session check failure (fail-open).

---

### Task 2.3 — Integrate PasscodeGateWrapper in main.tsx and write client gate tests

**Size:** Large | **Priority:** High | **Dependencies:** 2.2

1. Modify `apps/client/src/main.tsx` to wrap `RouterProvider` in `PasscodeGateWrapper` inside `TransportProvider`
2. Write 5 tests for `PasscodeGate` (renders UI, calls verify, shows errors, calls onSuccess, handles network failure)
3. Write 5 tests for `PasscodeGateWrapper` (localhost bypass, locked state, authenticated state, not-required state, fail-open)

**Acceptance:** All 10 test scenarios pass across both test files.

---

## Phase 3: Settings UI

### Task 3.1 — Add passcode configuration section to TunnelDialog

**Size:** Large | **Priority:** High | **Dependencies:** 2.1, 1.5

Modify `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`:

1. Add `passcodeEnabled` and `passcodeInput` state
2. Add `useEffect` to sync `passcodeEnabled` from server config
3. Add `handlePasscodeToggle` (calls `POST /api/tunnel/set-passcode` with `{ enabled: false }` to disable)
4. Add `handleSavePasscode` (calls `POST /api/tunnel/set-passcode` with `{ passcode, enabled: true }`)
5. Add JSX section between Custom Domain and Connected state: toggle switch, InputOTP, save button
6. Save button text: "Set passcode" (new) vs "Update passcode" (existing)
7. Button disabled when fewer than 6 digits entered

Write 5 tests in `apps/client/src/layers/features/settings/__tests__/TunnelDialog-passcode.test.tsx`.

**Acceptance:** All test scenarios pass. Passcode section visible only when token is configured and tunnel is not connected. Toggle, input, and save all function correctly.

---

## Parallel Opportunities

| Task | Can run parallel with |
| ---- | --------------------- |
| 1.1  | 1.2                   |
| 1.2  | 1.1, 1.6              |
| 1.3  | 1.2, 1.6              |
| 1.6  | 1.2, 1.3              |

Phase 1 critical path: 1.1 -> 1.3 -> 1.4 -> 1.5 (with 1.2 and 1.6 parallel)
Phase 2 is sequential: 2.1 -> 2.2 -> 2.3
Phase 3 depends on both 2.1 and 1.5

## Summary

| Phase                 | Tasks                        | Total  |
| --------------------- | ---------------------------- | ------ |
| P1: Server Foundation | 1.1, 1.2, 1.3, 1.4, 1.5, 1.6 | 6      |
| P2: Client Gate       | 2.1, 2.2, 2.3                | 3      |
| P3: Settings UI       | 3.1                          | 1      |
| **Total**             |                              | **10** |

**Size distribution:** 3 small, 4 medium, 3 large
**All tasks are high priority.**
