---
title: 'Tunnel Passcode Auth System — Design Research'
date: 2026-03-24
type: external-best-practices
status: active
tags:
  [
    security,
    passcode,
    PIN,
    ngrok,
    tunnel,
    session,
    brute-force,
    express,
    shadcn,
    otp-input,
    cookie,
    rate-limiting,
  ]
feature_slug: tunnel-passcode
searches_performed: 18
sources_count: 42
---

# Tunnel Passcode Auth System — Design Research

## Research Summary

This report covers the full design space for a 6-digit numeric passcode system protecting a local Express/React app exposed via ngrok tunnel. The scope is single-user, developer-tool threat model — not banking or multi-tenant SaaS. Six topics are addressed in depth: PIN storage/hashing, session management, brute-force protection, mobile UX for PIN entry, Express middleware patterns, and cross-cutting security considerations. Each section concludes with a concrete recommendation calibrated to the DorkOS context.

---

## Key Findings

### 1. PIN Storage: Use `crypto.scrypt` (Built-In), Not bcrypt or argon2

**Finding:** For a 6-digit numeric PIN (only 1,000,000 possible values), the threat model is radically different from password hashing. No hashing algorithm can compensate for the PIN's low entropy — the real defense is rate limiting and lockout. However, hashing is still necessary to prevent trivial offline cracking if the config file is ever read.

**Recommendation:** Use Node.js built-in `crypto.scrypt()` with a random 32-byte salt. This requires zero npm dependencies, is FIPS-acceptable, and produces a hash that is computationally expensive to crack offline.

- **Do NOT use bcrypt**: OWASP now classifies bcrypt as "legacy systems only." Its 72-byte input cap is irrelevant for a PIN but a code smell.
- **`argon2` npm package**: Best algorithm in isolation, but introduces a native addon dependency (`node-gyp`). The `@node-rs/argon2` alternative avoids `node-gyp` but adds a binary dependency. For a single-user developer tool stored in a local config file, the dependency cost is not worth it.
- **`crypto.scrypt` (built-in)**: Available since Node 10. Memory-hard. No external dependencies. Satisfies OWASP's "use a memory-hard function" requirement. Ideal for DorkOS's "no extra deps" philosophy.

**Why hashing still matters for a 6-digit PIN:**
If an attacker reads `~/.dork/config.json`, they would get the stored value. With a plain hash (MD5/SHA), they could crack all 1,000,000 possibilities in milliseconds. scrypt makes each attempt expensive. Combined with rate limiting on the network (the real first line of defense), the security posture is sufficient for this threat model.

**Salt handling:**
Cryptographic libraries (including `crypto.scrypt`) require the caller to provide a salt. The salt must be randomly generated (32 bytes via `crypto.randomBytes(32)`), unique per PIN change, and stored alongside the hash in the config file. Both the salt and derived key should be stored as hex strings.

**Implementation sketch:**

```typescript
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

export async function hashPin(pin: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(32).toString('hex');
  const derived = (await scryptAsync(pin, salt, KEY_LEN)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPin(
  inputPin: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  const derived = (await scryptAsync(inputPin, storedSalt, KEY_LEN)) as Buffer;
  const storedBuf = Buffer.from(storedHash, 'hex');
  // Both buffers must be same length for timingSafeEqual
  if (derived.length !== storedBuf.length) return false;
  return timingSafeEqual(derived, storedBuf);
}
```

**Stored in `~/.dork/config.json`:**

```json
{
  "tunnel": {
    "passcode": {
      "hash": "a3f4...hex...string",
      "salt": "b8c2...hex...string"
    }
  }
}
```

**Is 6 digits sufficient for this threat model?**
Yes, with compensating controls. The threat is an attacker who discovers the ngrok URL and tries to brute-force the PIN. With a 5-attempt lockout (30-second progressive delays, then 15-minute full lockout after 10 attempts), exhausting all 1,000,000 combinations would take years. The only realistic attack is if the attacker can read the config file directly — at which point they likely have local access anyway, making the tunnel passcode moot.

---

### 2. Session Management: `cookie-session` with Signed Cookies

**Finding:** For a single-user, no-database app, `cookie-session` (client-side signed cookie) is the right choice over `express-session` (server-side session store). `express-session` requires a persistent store — its default in-memory store is explicitly documented as not suitable for production and will lose sessions on server restart.

**Comparison:**

| Dimension                      | `express-session`                      | `cookie-session`                        |
| ------------------------------ | -------------------------------------- | --------------------------------------- |
| Storage                        | Server-side (requires store)           | Client-side (cookie payload)            |
| Database needed                | Yes (or memory, which is volatile)     | No                                      |
| Session data size              | Unlimited (stored on server)           | ~4 KB browser cookie limit              |
| Revocation                     | Trivial (delete from store)            | Hard (must rotate secret or use expiry) |
| Restart behavior               | Sessions lost without persistent store | Sessions survive server restart         |
| Session data visible to client | No                                     | Yes (but signed, not encrypted)         |

For DorkOS, the session payload is trivially small: `{ authenticated: true, authenticatedAt: number }`. The 4 KB limit is not a concern.

**Cookie-session implementation:**

```typescript
import cookieSession from 'cookie-session';

app.use(
  cookieSession({
    name: 'dorkos-session',
    secret: process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex'),
    httpOnly: true, // Never accessible to JS
    secure: true, // HTTPS only (ngrok always serves HTTPS)
    sameSite: 'strict', // Strict: only same-origin requests include cookie
    maxAge: 24 * 60 * 60 * 1000, // 24-hour session (rolling via middleware)
  })
);
```

**Note on `SESSION_SECRET`:** Generate this once at first startup and persist it to `~/.dork/config.json`. If a random one is used per startup, all sessions are invalidated on server restart. The secret should be at least 32 bytes of random data.

**Session timeout — what is appropriate for a developer tool?**

This is not banking. Appropriate defaults:

- **Active session duration:** 24 hours with rolling expiry (each request refreshes the expiry). This matches the "developer opened the URL on their phone, might use it all day" pattern.
- **Maximum session age:** 7 days absolute (even if rolling). Prevents a forgotten open browser tab from being valid indefinitely.
- **Inactivity timeout:** Rolling `maxAge` of 24h functions as an inactivity timeout — if no request is made in 24 hours, the cookie expires. No separate idle timer needed.

**Rolling sessions with `cookie-session`:**
`cookie-session` does not support rolling natively. Implement it with middleware:

```typescript
app.use((req, res, next) => {
  if (req.session?.authenticated) {
    req.sessionOptions.maxAge = 24 * 60 * 60 * 1000; // Refresh on every request
  }
  next();
});
```

**`express-session` with file store — viable alternative:**
If server-side session data ever becomes necessary, use `session-file-store`:

```typescript
import FileStore from 'session-file-store';
import session from 'express-session';
const Store = FileStore(session);

app.use(
  session({
    store: new Store({ path: path.join(dorkHome, 'sessions') }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
```

This persists sessions to `~/.dork/sessions/*.json` — consistent with the existing DorkOS config-file-on-disk pattern. But for the initial implementation, `cookie-session` is simpler and sufficient.

**Cookie attribute rationale for ngrok (HTTPS):**

- **`httpOnly: true`** — Essential. Prevents XSS from stealing the auth cookie.
- **`secure: true`** — Safe to set unconditionally because ngrok always terminates TLS and serves HTTPS. Express sees `X-Forwarded-Proto: https`; set `trust proxy: 1` so `req.secure === true`.
- **`sameSite: 'strict'`** — The tunnel URL is the same origin for all browser requests (same-origin policy). `'strict'` is safe here. If the app had a separate domain making credentialed requests, `'lax'` would be needed.
- **`maxAge`** — Set to the inactivity window (24h). The browser auto-expires the cookie.

---

### 3. Brute Force Protection: `rate-limiter-flexible` with In-Memory Store

**Finding:** `express-rate-limit` is the standard general-purpose rate limiter, but `rate-limiter-flexible` is specifically designed for login/PIN protection with progressive lockout semantics. It supports per-IP tracking, block duration, and consecutive-failure patterns — all without Redis for single-process use.

**Industry standard for PIN lockout:**

- Banking/financial: 3 attempts → permanent lockout (requires manual reset)
- Consumer apps: 5–10 attempts → temporary lockout (5–30 min)
- Developer tools: 10 attempts → 15-minute lockout is reasonable

For DorkOS, 5 consecutive failures triggers a 60-second progressive delay, and 10 total failures in a 15-minute window triggers a 15-minute full lockout. This is aggressive enough to prevent automated attacks while not locking out a legitimate user who fat-fingered their PIN on mobile.

**Implementation using `rate-limiter-flexible`:**

```typescript
import { RateLimiterMemory } from 'rate-limiter-flexible';

// Progressive delay: 5 failures = 60s block
const pinConsecutiveLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60, // Reset after 60 seconds
  blockDuration: 60, // Block for 60 seconds after 5 failures
});

// Total attempts: 10 failures in 15 minutes = 15-minute lockout
const pinTotalLimiter = new RateLimiterMemory({
  points: 10,
  duration: 15 * 60, // 15-minute window
  blockDuration: 15 * 60, // 15-minute lockout
});

export async function checkPinRateLimit(ip: string): Promise<void> {
  // Consume from both limiters on each attempt; throw if either is exhausted
  await Promise.all([pinConsecutiveLimiter.consume(ip), pinTotalLimiter.consume(ip)]);
}

export async function resetPinRateLimit(ip: string): Promise<void> {
  // On successful auth, reward/reset consecutive limiter
  await pinConsecutiveLimiter.delete(ip);
  await pinTotalLimiter.delete(ip);
}
```

**Responding to lockout:**

```typescript
// In the POST /auth/verify route:
try {
  await checkPinRateLimit(req.ip!);
} catch (err: any) {
  const retrySecs = Math.round(err.msBeforeNextReset / 1000) || 1;
  res.set('Retry-After', String(retrySecs));
  return res.status(429).json({
    error: 'Too many attempts',
    retryAfter: retrySecs,
  });
}
```

**What to do on lockout?**

- **Temporary lockout only** — 15 minutes is enough for this threat model. Shutting down the tunnel is too disruptive for a legitimate user at their desk.
- **Log the event** — Write a warning to the DorkOS log (existing logger) so the user can see "3 failed PIN attempts from 123.45.67.89 at 14:32."
- **No CAPTCHA** — This is a developer tool; CAPTCHA is patronizing for the target persona.
- **No permanent lockout** — A developer could legitimately forget their PIN and need more than 10 attempts. The 15-minute timeout is the right balance.

**Per-IP vs. global:**
Rate limit per IP. The tunnel has exactly one legitimate user (the owner). Any IP that is not the user's mobile device should be blocked quickly. Global rate limiting would allow an attacker to deny service to the legitimate user by exhausting the global pool.

**Trust proxy for correct `req.ip`:**
Critical: `app.set('trust proxy', 1)` is required when behind ngrok. Without it, `req.ip` is always `127.0.0.1` (the ngrok agent process), making per-IP rate limiting useless.

**Timing attack prevention:**
Use `crypto.timingSafeEqual()` for PIN comparison (already shown in the `verifyPin` function above). Never use `===` for secret comparison. The function compares byte-by-byte in constant time regardless of where the first difference is. Both buffers must be the same length — scrypt produces a fixed-length output so this is guaranteed.

---

### 4. Mobile UX: shadcn `InputOTP` Component

**Finding:** shadcn/ui ships an `InputOTP` component that is exactly the right primitive for a 6-digit passcode entry form. It is built on the `input-otp` library by Guilherme Rodriguez, uses individual digit slots (the standard mobile code-entry UX), and natively supports triggering the numeric keyboard on mobile.

**Component structure:**

```tsx
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/shared/ui/input-otp';
import { REGEXP_ONLY_DIGITS } from 'input-otp';

<InputOTP
  maxLength={6}
  pattern={REGEXP_ONLY_DIGITS}
  inputMode="numeric" // Triggers numeric keyboard on iOS and Android
  autoFocus
  onComplete={(value) => handleSubmit(value)}
>
  <InputOTPGroup>
    <InputOTPSlot index={0} />
    <InputOTPSlot index={1} />
    <InputOTPSlot index={2} />
  </InputOTPGroup>
  <InputOTPSeparator />
  <InputOTPGroup>
    <InputOTPSlot index={3} />
    <InputOTPSlot index={4} />
    <InputOTPSlot index={5} />
  </InputOTPGroup>
</InputOTP>;
```

**Triggering the numeric keyboard — the definitive answer:**
Multiple attributes work together for cross-platform coverage:

| Attribute             | Effect                                              | Coverage                                                    |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `inputMode="numeric"` | Numeric keypad (0–9 only, no decimal, no operators) | Chrome on Android, Chrome/Safari on iOS                     |
| `pattern="[0-9]*"`    | Supplements inputMode for older iOS Safari          | iOS Safari pre-15                                           |
| `type="text"`         | Keep as text, not `type="number"`                   | Prevents iOS numeric-only keyboard quirks with step/min/max |

The `input-otp` library uses `inputMode="numeric"` by default when `REGEXP_ONLY_DIGITS` pattern is set. No extra configuration needed.

**`type="tel"` alternative:**
`type="tel"` also triggers a phone keypad on mobile, which includes \*, #, and special symbols. For pure digit PINs, `inputMode="numeric"` with `type="text"` is cleaner (no asterisk/pound keys displayed).

**Auto-submit on completion:**
The `onComplete` callback fires when all 6 slots are filled. Wire it directly to the submit handler — no "Submit" button needed. This is the standard UX for OTP/PIN entry (same as Apple Pay, banking apps, 2FA prompts).

**Error/retry state:**
After a failed attempt, clear the input (`value=""`) and add `aria-invalid="true"` on the slot group with an error message below:

```tsx
<InputOTP value={pinValue} onChange={setPinValue} onComplete={handleVerify} aria-invalid={hasError}>
  {/* slots */}
</InputOTP>;
{
  hasError && (
    <p className="text-destructive text-sm" role="alert">
      Incorrect passcode. {attemptsRemaining} attempts remaining.
    </p>
  );
}
```

**Password manager suppression:**
The `input-otp` library includes `pushPasswordManagerStrategy` which prevents iOS/Android password manager badges from overlapping the input slots. This is enabled by default.

**Accessibility considerations:**

- The component uses semantic HTML with proper focus management — focus advances automatically between slots.
- Screen readers will announce the slot positions. Add `aria-label="Enter 6-digit passcode"` on the `<InputOTP>` wrapper.
- After completion, focus should move to a confirmation state or the error message.
- The `disabled` prop locks all slots during the submission request (prevents double-submit).

**Full passcode page design:**

```
┌─────────────────────────────┐
│        DorkOS               │
│                             │
│  Enter passcode to access   │
│  remote session             │
│                             │
│  [●][●][●]─[●][●][●]       │
│                             │
│  ⚠ Incorrect passcode.      │
│  4 attempts remaining.      │
│                             │
│  Connection secured by      │
│  ngrok HTTPS tunnel         │
└─────────────────────────────┘
```

No "Cancel" button, no "Forgot passcode" link (this is a single-user tool — the user set the PIN and can reset it via CLI/settings), no logo animations. Minimal and clear.

---

### 5. Express Middleware Pattern

**Finding:** The cleanest pattern for selective auth in Express is a scoped router that wraps all protected routes, combined with a separate un-scoped check to detect whether the request is tunneled at all.

#### Detecting if a request is tunneled

ngrok forwards three standard headers to the upstream server:

- `X-Forwarded-For` — client IP chain (e.g., `174.73.243.140`)
- `X-Forwarded-Host` — the ngrok hostname (e.g., `abc123.ngrok-free.app`)
- `X-Forwarded-Proto` — always `https` for ngrok HTTPS endpoints

The reliable way to detect a tunneled request is `req.hostname`. When accessed via ngrok, `req.hostname` returns the ngrok subdomain. When accessed via `localhost`, `req.hostname` returns `localhost`.

With `trust proxy: 1` set (required for correct `req.ip`), Express derives `req.hostname` from `X-Forwarded-Host` when that header is present.

```typescript
function isTunneledRequest(req: Request): boolean {
  // req.hostname reflects X-Forwarded-Host when trust proxy is set
  return req.hostname !== 'localhost' && req.hostname !== '127.0.0.1';
}
```

**Alternative: check the raw socket address:**

```typescript
function isTunneledRequest(req: Request): boolean {
  // req.socket.remoteAddress is always the direct connection (ngrok agent = 127.0.0.1)
  // If the stated hostname differs from localhost, the request came through a proxy
  return !['localhost', '127.0.0.1', '::1'].includes(req.hostname);
}
```

**Edge case — Docker/container environments:**
If DorkOS runs inside a container and the tunnel connects from outside, `req.socket.remoteAddress` may not be `127.0.0.1`. The `req.hostname` approach (checking for known tunnel hostnames) is more robust.

#### Middleware structure

```typescript
// middleware/tunnel-auth.ts

const EXEMPT_PATHS = new Set([
  '/auth/verify', // The passcode submission endpoint itself
  '/auth/session', // Session check endpoint
  '/', // The passcode entry page (SPA root)
  '/health', // Health check (ngrok circuit breaker uses this)
  '/favicon.ico',
]);

// Detect tunnel + require auth
export function requireTunnelAuth(req: Request, res: Response, next: NextFunction): void {
  // Local access is always allowed — tunnel auth only applies to tunneled requests
  if (!isTunneledRequest(req)) return next();

  // Exempt the auth routes themselves
  if (EXEMPT_PATHS.has(req.path)) return next();

  // Static assets (Vite-built): /assets/*, *.js, *.css, *.woff2
  if (req.path.startsWith('/assets/')) return next();

  // Check session
  if (req.session?.authenticated === true) return next();

  // API requests get 401 JSON; page requests get redirect to passcode page
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'Authentication required' });
  } else {
    res.redirect('/?auth_required=1');
  }
}
```

**Registration:**

```typescript
// Register before any route handlers
app.set('trust proxy', 1);
app.use(cookieSession({ ... }));
app.use(requireTunnelAuth);

// Protected API routes
app.use('/api', apiRouter);
```

**Routes that must be exempt:**

1. `POST /auth/verify` — The endpoint that accepts the PIN
2. `GET /auth/session` — Lets the SPA check if it's currently authenticated
3. `GET /` (and all SPA routes) — The React app HTML must load so the passcode UI can render
4. `/assets/*` — The SPA's JS/CSS bundles must load before auth can happen
5. `/health` — Used by ngrok's circuit breaker feature
6. `/favicon.ico` — Avoid a redirect loop for browser favicon requests

**Serving the passcode page:**
The SPA serves all its HTML from `/`. The React app itself needs to detect the `?auth_required=1` query param and show the passcode UI instead of the main app. Two options:

- **Option A (simpler):** A separate static HTML page at `/auth` — the server redirects to `/auth` and serves a minimal HTML page. No SPA needed.
- **Option B (integrated):** The React SPA checks `GET /auth/session` on mount and renders a passcode gate if unauthenticated. This is cleaner from a UX perspective (no page reload, animations, branded experience).

Option B is the right choice for DorkOS. The SPA architecture already handles conditional rendering. On the client:

```typescript
// In App.tsx or top-level provider
const { data: session } = useQuery({ queryKey: ['auth/session'], queryFn: checkAuthSession });
if (session?.requiresAuth && !session?.authenticated) {
  return <PasscodePage />;
}
```

---

### 6. Security Considerations

#### CSRF Protection

**For a PIN submission, CSRF protection is less critical than for a cookie-auth'd API** because:

1. The passcode submission happens before the session cookie is set (attacker can't CSRF a pre-auth request meaningfully)
2. The passcode page is gated behind knowing the ngrok URL, which provides baseline obscurity
3. `SameSite: strict` on the session cookie prevents cookie-based CSRF for all subsequent requests

However, for defense-in-depth, include the `Origin` header check for the PIN submission endpoint:

```typescript
app.post('/auth/verify', (req, res) => {
  const origin = req.headers.origin;
  // ngrok HTTPS URL will have origin matching the tunnel hostname
  if (origin && !origin.includes(req.hostname)) {
    return res.status(403).json({ error: 'Invalid origin' });
  }
  // ...PIN verification logic
});
```

Full CSRF tokens (CSRF middleware like `csurf`) are not necessary here. The combination of SameSite cookies + Origin check is sufficient for this threat model.

#### Timing-safe PIN comparison

Already covered in Section 1. **Never use `===` or `.includes()` for secret comparison.** Always use `crypto.timingSafeEqual()` after deriving the hash.

#### ngrok-specific headers

ngrok adds to forwarded HTTP requests:

- `X-Forwarded-For: <client-ip>` — set `trust proxy: 1` to use this for `req.ip`
- `X-Forwarded-Host: <ngrok-subdomain>.ngrok-free.app` — used for tunnel detection
- `X-Forwarded-Proto: https` — with `trust proxy: 1`, makes `req.secure === true`
- `Host: <ngrok-subdomain>.ngrok-free.app` — rewritten to match the endpoint

ngrok also adds a `Ngrok-Agent-Ips` header to **responses** (for free tier endpoint disclosure), but this is on responses not requests. It does not affect upstream request processing.

**Security implication:** With `trust proxy: 1`, Express trusts the `X-Forwarded-*` headers as-is. Since ngrok is the only proxy (and it's localhost to localhost), this is safe. Do **not** set `trust proxy: true` (unconditional trust of all hops) — use `trust proxy: 1` (trust exactly one hop).

#### Transmit PIN in POST body, not a custom header

The PIN should be sent as a POST body field (`application/json` or `application/x-www-form-urlencoded`), not in a custom header or URL parameter:

- URL parameters appear in server access logs — never put secrets there
- Custom headers can be cached by some proxies
- POST body is the standard for auth credential transmission
- With HTTPS (guaranteed by ngrok), the POST body is encrypted in transit

```typescript
// Client sends:
POST /auth/verify
Content-Type: application/json
{ "pin": "123456" }

// Server responds:
200 OK
Set-Cookie: dorkos-session=...; HttpOnly; Secure; SameSite=Strict
{ "authenticated": true }
```

#### Should the PIN gate be bypassed for localhost?

Yes. Local access (direct `localhost:6242`) should never require a PIN. This is consistent with the design principle that the passcode protects the public tunnel URL, not the local server. The `isTunneledRequest()` guard achieves this.

If someone has local access, they are on the same machine as the server — they could read the config file directly. The passcode is not a local security control.

#### Preventing enumeration

If the passcode entry page is accessible, attackers already know an auth page exists. To prevent leaking information:

- Return the same error message for wrong PIN vs. locked out: "Incorrect passcode." (not "Account locked — try in 5 minutes")
- The `Retry-After` header on 429 responses does reveal the lockout state, but this is acceptable (standard practice, helps legitimate users)
- Do not reveal attempts remaining until the last 2 attempts, to avoid "gamification" of the lockout

---

## Detailed Analysis

### Architecture: Where Auth Lives

```
[Mobile Browser]
        │ HTTPS
        ▼
[ngrok edge] ─── X-Forwarded-For, X-Forwarded-Host, X-Forwarded-Proto
        │
        │ HTTP (localhost)
        ▼
[Express Server — localhost:6242]
        │
        ├── cookieSession middleware
        ├── requireTunnelAuth middleware
        │     ├── isTunneledRequest() → true
        │     ├── isExemptPath() → false for protected routes
        │     └── req.session.authenticated check
        │
        ├── POST /auth/verify
        │     ├── rate limit check (rate-limiter-flexible)
        │     ├── verifyPin(input, storedHash, storedSalt)
        │     └── set session
        │
        └── /api/* (protected)
```

### Config File Schema

Extend the existing config schema in `packages/shared/src/config-schema.ts`:

```typescript
// In the tunnel config section:
tunnel: {
  enabled: boolean;
  passcode: {
    enabled: boolean;
    hash: string;   // hex-encoded scrypt output
    salt: string;   // hex-encoded random salt
  } | null;
}
```

When `passcode.enabled` is false or `passcode` is null, all tunneled requests are allowed without authentication. The UI should warn loudly when tunnel is enabled with no passcode set.

### Setting a New Passcode via CLI

The CLI (`packages/cli`) should support:

```
dorkos config set-passcode
```

Which prompts for a new 6-digit PIN (no echo), hashes it with scrypt, and writes to `~/.dork/config.json`. The settings UI should also expose this via a "Change Passcode" flow.

### Full Route Flow

```
1. User opens ngrok URL on phone
2. requireTunnelAuth: isTunneledRequest() = true, not exempt path, session not set
3. Redirect to /?auth_required=1
4. SPA loads, detects auth_required, renders PasscodePage
5. User enters 6-digit PIN via InputOTP
6. onComplete() fires → POST /auth/verify { pin: "123456" }
7. Server: rate limit check → pass
8. Server: verifyPin(pin, storedHash, storedSalt) → true
9. Server: set req.session = { authenticated: true, authenticatedAt: Date.now() }
10. Server: resetPinRateLimit(ip)
11. Server: 200 OK
12. Client: SPA re-fetches /auth/session → authenticated = true
13. SPA renders the main DorkOS app
```

### Session Secret Lifecycle

The session signing secret must:

1. Be generated on first startup if not present: `crypto.randomBytes(32).toString('hex')`
2. Be persisted to `~/.dork/config.json` as `session.secret`
3. Never be committed to version control
4. Be rotatable (changing it invalidates all existing sessions — acceptable for a dev tool)

This is analogous to the existing `NGROK_AUTHTOKEN` storage pattern.

---

## Sources & Evidence

### Passcode Storage

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Argon2 vs bcrypt vs scrypt — Stytch blog](https://stytch.com/blog/argon2-vs-bcrypt-vs-scrypt/)
- [Password Hashing Guide 2026 — guptadeepak.com](https://guptadeepak.com/the-complete-guide-to-password-hashing-argon2-vs-bcrypt-vs-scrypt-vs-pbkdf2-2026/)
- [Timing Attacks in Node.js — DEV Community](https://dev.to/silentwatcher_95/timing-attacks-in-nodejs-4pmb)
- [crypto.timingSafeEqual — Node.js docs / GeeksforGeeks](https://www.geeksforgeeks.org/node-js/node-js-crypto-timingsafeequal-function/)
- [Using timingSafeEqual — Cloudflare Workers docs](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)
- [argon2 npm package](https://www.npmjs.com/package//argon2)
- [@node-rs/argon2 npm package](https://www.npmjs.com/package/@node-rs/argon2)
- [Node.js crypto.scrypt() Method — GeeksforGeeks](https://www.geeksforgeeks.org/node-js/node-js-crypto-scrypt-method/)

### Session Management

- [Express cookie-session middleware docs](https://expressjs.com/en/resources/middleware/cookie-session.html)
- [express-session npm docs](https://www.npmjs.com/package/express-session)
- [cookie-session vs express-session — pablobm blog](https://blog.pablobm.com/2017/12/10/keep-it-simple-express-session-vs-cookie-session/)
- [JWT vs session auth — stytch.com](https://stytch.com/blog/jwts-vs-sessions-which-is-right-for-you/)
- [Session vs JWT Auth in Express.js — DEV Community](https://dev.to/riturajps/session-vs-jwt-auth-in-expressjs-which-wins-4p86)
- [Securing Cookies and Session Management in Node.js — Medium](https://medium.com/@lavanyapreethi.manoharan/securing-cookies-and-session-management-in-node-js-and-express-3ae4a4b53521)
- [Rolling session with absolute expiry — express-session GitHub issue](https://github.com/expressjs/session/issues/557)

### Brute Force Protection

- [rate-limiter-flexible GitHub](https://github.com/animir/node-rate-limiter-flexible)
- [rate-limiter-flexible npm](https://www.npmjs.com/package/rate-limiter-flexible)
- [Login route rate limiting with rate-limiter-flexible — DEV Community](https://dev.to/mattdclarke/how-to-rate-limit-a-login-route-in-express-using-node-rate-limiter-flexible-and-redis-1i1k)
- [Node.js best practices: login rate limit — goldbergyoni/nodebestpractices](https://github.com/goldbergyoni/nodebestpractices/blob/master/sections/security/login-rate-limit.md)
- [Rate Limiting in Express.js — BetterStack](https://betterstack.com/community/guides/scaling-nodejs/rate-limiting-express/)
- [Brute force protection middleware — express-brute GitHub](https://github.com/AdamPflug/express-brute)

### Mobile UX / InputOTP

- [shadcn/ui InputOTP docs](https://ui.shadcn.com/docs/components/radix/input-otp)
- [input-otp GitHub — guilhermerodz](https://github.com/guilhermerodz/input-otp)
- [React Input OTP — Numeric Only (shadcn.io)](https://www.shadcn.io/patterns/input-otp-variants-1)
- [inputMode attribute — CSS-Tricks](https://css-tricks.com/everything-you-ever-wanted-to-know-about-inputmode/)
- [Finger-friendly numerical inputs — CSS-Tricks](https://css-tricks.com/finger-friendly-numerical-inputs-with-inputmode/)
- [HTML inputMode — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode)

### Middleware Pattern

- [Express behind proxies — Express.js official docs](https://expressjs.com/en/guide/behind-proxies.html)
- [X-Forwarded-Host — MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Forwarded-Host)
- [How to skip middleware in Express.js — GeeksforGeeks](https://www.geeksforgeeks.org/how-to-skip-a-middleware-in-express-js/)

### Security / CSRF / ngrok Headers

- [CSRF Prevention — OWASP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [CSRF and SameSite cookies — MDN](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/CSRF)
- [Do SameSite cookies solve CSRF — airman604 Medium](https://airman604.medium.com/do-samesite-cookies-solve-csrf-6dcd02dc9383)
- [ngrok forwarded headers — ngrok Forward Internal docs](https://ngrok.com/docs/traffic-policy/actions/forward-internal)
- [ngrok API gateway header manipulation — ngrok blog](https://ngrok.com/blog/api-gateway-policy-headers)
- [ngrok-agent-ips header — search results via ngrok docs](https://ngrok.com/docs/agent/changelog)
- [Cookie Security Guide — barrion.io](https://barrion.io/blog/cookie-security-best-practices)

---

## Recommendations Summary

| Topic                 | Recommendation                                                        | Key Reason                                            |
| --------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| PIN hashing           | `crypto.scrypt` built-in                                              | No extra deps, memory-hard, OWASP-acceptable          |
| Salt                  | `crypto.randomBytes(32)`                                              | 128-bit salt per OWASP minimum                        |
| Algorithm alternative | `@node-rs/argon2` if willing to accept binary dep                     | Best algorithm, no node-gyp                           |
| Session type          | `cookie-session` (client-side signed cookie)                          | No DB required, survives server restart               |
| Session timeout       | 24h rolling `maxAge`                                                  | Developer tool, not banking                           |
| Session secret        | Persist to `~/.dork/config.json` on first startup                     | Stable across restarts                                |
| Brute-force           | `rate-limiter-flexible` (RateLimiterMemory)                           | Purpose-built for auth protection, no Redis needed    |
| Lockout policy        | 5 consecutive → 60s; 10 in 15min → 15min lockout                      | Aggressive enough without locking out legitimate user |
| Per-IP tracking       | Yes, using `req.ip` with `trust proxy: 1`                             | Without trust proxy, all IPs look like 127.0.0.1      |
| PIN input component   | shadcn `InputOTP` with `REGEXP_ONLY_DIGITS`                           | Already in project, perfect UX, auto-submits          |
| Mobile keyboard       | `inputMode="numeric"` + `pattern="[0-9]*"`                            | Both needed for full iOS/Android coverage             |
| Auto-submit           | Yes, via `onComplete` callback                                        | Standard OTP/PIN UX pattern                           |
| Auth middleware       | `requireTunnelAuth` on all routes, exempt list for static/auth routes | Scoped protection                                     |
| Tunnel detection      | `req.hostname !== 'localhost'` (with trust proxy)                     | Reliable, uses ngrok's `X-Forwarded-Host`             |
| Localhost bypass      | Yes, unconditional                                                    | Local access = same machine, PIN moot                 |
| CSRF                  | SameSite Strict + Origin check on /auth/verify                        | Sufficient for this threat model                      |
| PIN transmission      | POST body (JSON)                                                      | Never in URL, custom headers add complexity           |
| Cookie attributes     | `httpOnly`, `secure`, `sameSite: 'strict'`                            | ngrok is always HTTPS, strict SameSite safe           |
| Timing safety         | `crypto.timingSafeEqual` after scrypt                                 | Required for any secret comparison                    |

---

## Research Gaps & Limitations

- **scrypt parameters for PIN-specific tuning**: The default Node.js `crypto.scrypt` parameters (N=16384, r=8, p=1) are appropriate for passwords. For a 6-digit PIN where the entropy is so low, reducing N to 8192 would be reasonable (faster but still prevents rapid offline cracking). The literature does not give specific recommendations for low-entropy inputs — this is a judgment call.
- **`cookie-session` vs. `cookie-session` 2.x**: The `cookie-session` npm package has a v2.x branch that is not yet stable. The stable v1.x API is used in all examples above. Verify the latest stable version before implementing.
- **ngrok free vs. paid plan session handling**: On the free plan, the ngrok browser interstitial page (for free URLs) may affect the initial page load flow. Test whether the interstitial interferes with the passcode redirect chain. If it does, the user must configure a static dev domain (`NGROK_STATIC_DOMAIN`) to bypass the interstitial.
- **Session invalidation on passcode change**: If the user changes their PIN, existing sessions should be invalidated. This requires either server-side session tracking (invalidate by session ID) or rotating the session secret. `cookie-session` does not support server-side invalidation — rotating the secret is the available mechanism.
- **Multiple simultaneous mobile sessions**: The single-user assumption means this is not a concern. But if a user opens the URL in two browsers simultaneously, both can hold valid sessions. This is acceptable behavior.

---

## Contradictions & Disputes

- **bcrypt "still fine" vs. "legacy":** Many community articles from 2022–2024 still recommend bcrypt as the first choice. OWASP's 2025 Cheat Sheet explicitly moved bcrypt to "legacy systems only." For new code, use scrypt (built-in) or argon2id. Do not start new implementations with bcrypt.
- **SameSite: 'strict' vs. 'lax' for SPAs:** Some sources recommend 'lax' for SPAs to allow top-level navigation from external links. For the DorkOS tunnel passcode flow, 'strict' is safe because: (a) all relevant navigation is within the same origin, and (b) the entry point is the user opening the URL directly (not following a link from another site).
- **CSRF tokens for PIN endpoints:** The traditional view requires CSRF tokens for any state-changing POST request. The modern consensus (after SameSite cookie adoption) is that SameSite Strict + Origin validation provides equivalent protection for same-domain SPAs. The `csurf` library is deprecated and unmaintained — do not use it.
- **`trust proxy: true` vs. `trust proxy: 1`:** Many blog posts use `trust proxy: true` for simplicity. The Express documentation recommends `trust proxy: 1` (numeric hop count) for single-proxy setups — it trusts exactly one hop, preventing header spoofing by intermediate proxies.

---

## Search Methodology

- Searches performed: 18
- Most productive search terms: `bcrypt argon2 scrypt 6 digit PIN numeric security`, `cookie-session vs express-session no database single user`, `rate-limiter-flexible login lockout Node.js in-memory`, `shadcn InputOTP mobile numeric keyboard`, `express detect localhost tunnel X-Forwarded-Host`, `ngrok forwarded headers middleware Express`, `CSRF protection SPA Express SameSite 2025`, `crypto.timingSafeEqual PIN verification Node.js`
- Primary information sources: OWASP Cheat Sheets, Express.js official docs, shadcn/ui docs, input-otp GitHub, rate-limiter-flexible GitHub, ngrok Traffic Policy docs, MDN Web Docs, CSS-Tricks
