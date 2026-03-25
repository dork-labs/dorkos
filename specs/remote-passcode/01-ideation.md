---
slug: remote-passcode
number: 180
created: 2026-03-24
status: ideation
---

# Remote Access Passcode

**Slug:** remote-passcode
**Author:** Claude Code
**Date:** 2026-03-24

---

## 1) Intent & Assumptions

- **Task brief:** Add an application-level 6-digit numeric passcode required when accessing DorkOS through the ngrok tunnel. The passcode is configured in the existing Remote settings dialog, protects only remote access (localhost is unrestricted), and includes brute-force protection and inactivity timeout.
- **Assumptions:**
  - Single-user system — the passcode owner is the same person who configured it
  - ngrok always terminates TLS, so `secure: true` cookies are safe
  - The passcode is a convenience gate (not banking-grade) — the real security comes from ngrok's inherent URL obscurity + rate limiting
  - The DorkOS logo exists as a reusable component for the login screen
  - `express-rate-limit` (already in server deps) is sufficient for rate limiting
- **Out of scope:**
  - Multi-user authentication or role-based access
  - OAuth/SSO/third-party auth providers
  - Password-based auth (this is a 6-digit numeric PIN only)
  - Encryption of tunnel traffic (handled by ngrok TLS)
  - Tunnel auto-shutdown on failed attempts (decided against — too disruptive)

## 2) Pre-reading Log

- `apps/server/src/services/core/tunnel-manager.ts`: Singleton EventEmitter managing ngrok lifecycle. Status includes `enabled`, `connected`, `url`, `port`, `domain`. No auth layer.
- `apps/server/src/routes/tunnel.ts`: HTTP routes for `/start`, `/stop`, `/stream` (SSE), `/status`. Reads tunnel config from configManager.
- `apps/server/src/middleware/mcp-origin.ts`: Validates Origin header against localhost + tunnel URL dynamically. **Key pattern for detecting tunnel requests.**
- `apps/server/src/middleware/mcp-auth.ts`: Bearer token auth middleware. Shows existing auth middleware structure.
- `apps/server/src/app.ts`: Express setup with CORS, middleware, route registration. Dynamic origin callback checks `tunnelManager.status.url`.
- `apps/server/src/index.ts`: Tunnel auto-start on server boot if `TUNNEL_ENABLED` env var set.
- `packages/shared/src/config-schema.ts`: Tunnel config section with `enabled`, `domain`, `authtoken`, `auth` fields. No passcode field yet.
- `packages/shared/src/schemas.ts`: `TunnelStatusSchema` with connection state fields. No passcode indicator.
- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`: Full tunnel management UI — auth token input, custom domain, QR code, session link sharing, latency indicator. ~600 lines.
- `apps/client/src/layers/entities/tunnel/model/use-tunnel-status.ts`: TanStack Query hook fetching tunnel status every 30s.
- `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts`: Cross-tab (BroadcastChannel) + cross-device (SSE) sync for tunnel state.
- `apps/client/src/layers/shared/lib/transport/http-transport.ts`: Every request includes `X-Client-Id` header. Uses `fetchJSON` helper with credentials.
- `apps/client/src/main.tsx`: Root app — QueryClient, RouterProvider, TransportProvider. Gate must be above or conditional within this.
- `apps/client/src/router.tsx`: TanStack Router with `_shell` layout route + named routes. Has `beforeLoad` hooks.
- `apps/server/package.json`: Has `express-rate-limit` (^8.2.1). No `cookie-parser` or `express-session`.
- `apps/client/src/layers/shared/ui/`: 48+ shadcn components. No `InputOTP` yet — needs installation.
- `contributing/design-system.md`: Color palette (zinc-based dark theme), typography (Geist Sans/Mono), spacing (8pt grid), motion specs.
- `contributing/architecture.md`: Hexagonal architecture, Transport interface decouples client from server.

## 3) Codebase Map

**Primary components to modify:**

| File                                                            | Role                     | Change                                                      |
| --------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `packages/shared/src/config-schema.ts`                          | Tunnel config schema     | Add `passcode` field (hashed string + salt, nullable)       |
| `packages/shared/src/schemas.ts`                                | TunnelStatus type        | Add `passcodeEnabled` boolean field                         |
| `packages/shared/src/transport.ts`                              | Transport interface      | Add `validatePasscode()` method                             |
| `apps/server/src/middleware/tunnel-auth.ts`                     | **NEW**                  | Middleware: detect tunnel requests, validate session cookie |
| `apps/server/src/routes/tunnel.ts`                              | Tunnel API routes        | Add `POST /api/tunnel/verify-passcode` endpoint             |
| `apps/server/src/app.ts`                                        | Express middleware stack | Register tunnel-auth middleware, set `trust proxy: 1`       |
| `apps/server/src/env.ts`                                        | Server env vars          | No changes needed (config-driven, not env-driven)           |
| `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`  | Tunnel settings UI       | Add passcode input section (set/update/toggle)              |
| `apps/client/src/layers/shared/lib/transport/http-transport.ts` | HTTP transport           | Add `validatePasscode()` implementation                     |
| `apps/client/src/main.tsx` or `apps/client/src/App.tsx`         | App root                 | Add passcode gate above router for tunnel access            |

**New files:**

| File                                             | Role                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `apps/server/src/middleware/tunnel-auth.ts`      | Express middleware for tunnel passcode verification               |
| `apps/client/src/layers/features/tunnel-gate/`   | Full-screen passcode entry component                              |
| `apps/client/src/layers/shared/ui/input-otp.tsx` | shadcn InputOTP component (via `npx shadcn@latest add input-otp`) |

**Shared dependencies:**

- `crypto` (Node.js built-in) — scrypt hashing + timingSafeEqual
- `express-rate-limit` (already installed) — brute-force protection
- `cookie-session` (new, lightweight) — signed session cookies
- `input-otp` (new, pulled by shadcn InputOTP) — digit box input component

**Data flow:**

```
[Remote user hits tunnel URL]
  → Express receives request
  → tunnel-auth middleware checks: is hostname !== localhost?
    → No: pass through (local access unrestricted)
    → Yes: check for valid signed session cookie
      → Valid + not expired: pass through
      → Invalid/missing/expired: return 401 (except exempt routes)
  → Client receives 401
  → App renders PasscodeGate instead of main app
  → User enters 6-digit PIN
  → POST /api/tunnel/verify-passcode { passcode: "123456" }
    → Rate limiter checks (5 consecutive / 10 per 15min)
    → Server hashes input with stored salt, timingSafeEqual comparison
    → Match: Set-Cookie (httpOnly, secure, sameSite=strict, maxAge=24h), return 200
    → Mismatch: return 401, increment rate limiter
  → Client receives 200 + cookie
  → Re-render: session valid, show main app
```

**Potential blast radius:**

- Direct: ~10 files (listed above)
- Indirect: SSE tunnel stream may need to emit passcode config changes
- Tests: Server middleware tests, route tests, client gate component tests
- Config migration: Existing `config.json` files gain new nullable `passcode` field (backwards compatible)

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Full research saved to `research/20260324_tunnel_passcode_auth_system.md`.

### Passcode Storage

| Approach                           | Pros                                             | Cons                                     | Recommendation           |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------------ |
| `crypto.scrypt` (Node.js built-in) | Zero dependencies, OWASP-acceptable, memory-hard | Slightly less studied than argon2        | **Recommended**          |
| `argon2id` (via `argon2` npm)      | Gold standard, OWASP top pick                    | Requires native binary compilation       | Overkill for 6-digit PIN |
| `bcrypt`                           | Well-known, battle-tested                        | OWASP "legacy only", limited to 72 bytes | Outdated recommendation  |

**Decision:** `crypto.scrypt` with 32-byte random salt. Store `{ hash, salt }` as hex strings. Always compare with `crypto.timingSafeEqual()`.

### Session Management

| Approach                                | Pros                                     | Cons                                           | Recommendation         |
| --------------------------------------- | ---------------------------------------- | ---------------------------------------------- | ---------------------- |
| `cookie-session` (signed client cookie) | No server store, survives restarts, tiny | Payload visible (but signed, not secret)       | **Recommended**        |
| `express-session` + MemoryStore         | More features                            | Loses sessions on restart, memory leak warning | Not suitable           |
| Raw `Set-Cookie`                        | Zero deps                                | Must implement signing manually                | Unnecessary complexity |

**Decision:** `cookie-session` with auto-generated `SESSION_SECRET` persisted to config. Cookie flags: `httpOnly`, `secure`, `sameSite: strict`, `maxAge: 24h` rolling.

### Brute Force Protection

| Approach                  | Pros                                         | Cons                                                          | Recommendation  |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------- | --------------- |
| Progressive rate limiting | Effective, non-disruptive, industry standard | Attacker can wait out blocks                                  | **Recommended** |
| Tunnel shutdown           | Maximum security                             | Disrupts legitimate user, requires physical access to restart | Too disruptive  |
| CAPTCHA                   | Stops bots                                   | No CAPTCHA service in a local dev tool                        | Not applicable  |

**Decision:** `express-rate-limit` with two tiers: 5 consecutive failures → 60s block, 10 in 15min → 15min lockout. Reset counters on successful auth.

### Mobile UX

**Decision:** shadcn `InputOTP` component with `inputMode="numeric"` + `pattern="[0-9]*"` + `REGEXP_ONLY_DIGITS`. Auto-submits on 6th digit via `onComplete`. Individual digit boxes with auto-advance.

### Middleware Pattern

**Decision:** `req.hostname !== 'localhost'` with `trust proxy: 1` (exactly `1`, not `true` — prevents spoofing). Exempt routes: `/api/tunnel/verify-passcode`, `/assets/*`, `/health`, `/favicon.ico`.

### Security Summary

| Concern          | Mitigation                                                       |
| ---------------- | ---------------------------------------------------------------- |
| Timing attacks   | `crypto.timingSafeEqual()` — mandatory                           |
| CSRF             | `SameSite: strict` + Origin header check on verify endpoint      |
| PIN in transit   | POST body (JSON), never URL param                                |
| Tunnel detection | `trust proxy: 1` + `req.hostname` check                          |
| Localhost bypass | Unconditional — local access means machine access                |
| PIN entropy      | Low (10^6 = 1M combinations) — rate limiting is the real defense |

## 6) Decisions

| #   | Decision         | Choice                    | Rationale                                                                                                                                                                               |
| --- | ---------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lockout behavior | Progressive rate limiting | Tunnel shutdown is too disruptive — a locked-out attacker can't get in anyway, and the user would need physical access to restart. 5 failures → 60s block, 10 in 15min → 15min lockout. |
| 2   | Session timeout  | 24-hour rolling session   | Developer tool with single user — frequent re-auth on a 6-digit PIN is friction without security gain. Resets on each request, so active users never see it.                            |
| 3   | Config UX        | Inline in Remote dialog   | All tunnel config lives together in TunnelDialog. Toggle on/off, enter/change PIN, disabled while connected. Follows existing pattern.                                                  |
