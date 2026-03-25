---
slug: remote-passcode
number: 180
created: 2026-03-24
status: draft
---

# Remote Access Passcode

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-24
**Ideation:** `specs/remote-passcode/01-ideation.md`
**Research:** `research/20260324_tunnel_passcode_auth_system.md`

---

## Overview

Add an application-level 6-digit numeric passcode gate for remote tunnel access. When a user accesses DorkOS through the ngrok tunnel URL, they must enter a PIN before seeing the app. Local access (localhost) is always unrestricted. The passcode is configured inline in the existing Remote settings dialog, hashed with `crypto.scrypt` before storage, and protected by progressive rate limiting.

## Background / Problem Statement

DorkOS exposes a public URL via ngrok tunnel for remote access. Currently, anyone with the tunnel URL has full access to the application — all sessions, agent controls, and configuration. While ngrok URLs are random and hard to guess, they can be shared accidentally (e.g., copied from QR code, visible in screenshots, or leaked in browser history). A lightweight passcode gate adds a practical security layer without the complexity of full authentication.

## Goals

- Gate remote tunnel access behind a 6-digit numeric PIN
- Keep local (localhost) access completely unrestricted
- Provide a polished, branded passcode entry experience on both desktop and mobile
- Protect against brute-force attacks with progressive rate limiting
- Allow passcode configuration inline in the existing TunnelDialog
- Use industry-standard security practices (hashed storage, timing-safe comparison, signed cookies)

## Non-Goals

- Multi-user authentication or role-based access
- OAuth, SSO, or third-party auth provider integration
- Password-based auth (letters, special characters)
- Tunnel auto-shutdown on failed attempts
- Server-side session store (no database-backed sessions)
- Passcode recovery mechanism (user has local access to reset)

## Technical Dependencies

| Dependency                  | Version   | Purpose                                            | Status                                  |
| --------------------------- | --------- | -------------------------------------------------- | --------------------------------------- |
| `crypto` (Node.js built-in) | N/A       | `scrypt` hashing, `timingSafeEqual`, `randomBytes` | Available                               |
| `express-rate-limit`        | ^8.2.1    | Brute-force protection                             | Already installed                       |
| `cookie-session`            | latest    | Signed client-side session cookies                 | **New dependency (server)**             |
| `input-otp`                 | latest    | Digit box input component                          | **New dependency (client, via shadcn)** |
| `@dorkos/icons`             | workspace | `DorkLogo` component for login screen              | Available                               |

## Detailed Design

### 1. Shared Schema Changes

#### `packages/shared/src/config-schema.ts`

Add passcode fields to the tunnel config section:

```typescript
tunnel: z
  .object({
    enabled: z.boolean().default(false),
    domain: z.string().nullable().default(null),
    authtoken: z.string().nullable().default(null),
    auth: z.string().nullable().default(null),
    // NEW: Passcode gate
    passcodeEnabled: z.boolean().default(false),
    passcodeHash: z.string().nullable().default(null),
    passcodeSalt: z.string().nullable().default(null),
  })
  .default(() => ({
    enabled: false,
    domain: null,
    authtoken: null,
    auth: null,
    passcodeEnabled: false,
    passcodeHash: null,
    passcodeSalt: null,
  })),
```

Add `tunnel.passcodeHash` and `tunnel.passcodeSalt` to `SENSITIVE_CONFIG_KEYS`.

Also add a `sessionSecret` field at the top level of `UserConfigSchema` for the cookie signing key:

```typescript
sessionSecret: z.string().nullable().default(null),
```

#### `packages/shared/src/schemas.ts`

Add `passcodeEnabled` to `TunnelStatusSchema`:

```typescript
export const TunnelStatusSchema = z
  .object({
    enabled: z.boolean(),
    connected: z.boolean(),
    url: z.string().nullable(),
    port: z.number().int().nullable(),
    startedAt: z.string().nullable(),
    authEnabled: z.boolean(),
    tokenConfigured: z.boolean(),
    domain: z.string().nullable(),
    passcodeEnabled: z.boolean(), // NEW
  })
  .openapi('TunnelStatus');
```

Add request/response schemas for the verify endpoint:

```typescript
export const PasscodeVerifyRequestSchema = z.object({
  passcode: z.string().regex(/^\d{6}$/),
});

export const PasscodeVerifyResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  retryAfter: z.number().optional(),
});

export const PasscodeSessionResponseSchema = z.object({
  authenticated: z.boolean(),
  passcodeRequired: z.boolean(),
});
```

#### `packages/shared/src/transport.ts`

Add two methods to the `Transport` interface:

```typescript
/** Verify a 6-digit passcode for remote tunnel access. */
verifyTunnelPasscode(passcode: string): Promise<{ ok: boolean; error?: string; retryAfter?: number }>;

/** Check if the current session is authenticated for tunnel access. */
checkTunnelSession(): Promise<{ authenticated: boolean; passcodeRequired: boolean }>;
```

#### `packages/shared/src/constants.ts`

Add passcode-related constants:

```typescript
export const PASSCODE_LENGTH = 6;
export const PASSCODE_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
export const PASSCODE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const PASSCODE_RATE_LIMIT_MAX = 10; // max attempts per window
export const PASSCODE_CONSECUTIVE_LIMIT = 5; // consecutive failures before short block
export const PASSCODE_CONSECUTIVE_BLOCK_MS = 60 * 1000; // 60 second block
```

### 2. Server Implementation

#### `apps/server/src/lib/passcode-hash.ts` (NEW)

Utility module for hashing and verifying passcodes:

```typescript
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPasscode(passcode: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(32).toString('hex');
  const derived = (await scryptAsync(passcode, salt, KEY_LENGTH)) as Buffer;
  return { hash: derived.toString('hex'), salt };
}

export async function verifyPasscode(
  passcode: string,
  storedHash: string,
  storedSalt: string
): Promise<boolean> {
  const derived = (await scryptAsync(passcode, storedSalt, KEY_LENGTH)) as Buffer;
  const hashBuffer = Buffer.from(storedHash, 'hex');
  if (derived.length !== hashBuffer.length) return false;
  return timingSafeEqual(derived, hashBuffer);
}
```

#### `apps/server/src/middleware/tunnel-auth.ts` (NEW)

Express middleware that gates tunnel requests behind passcode authentication:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { tunnelManager } from '../services/core/tunnel-manager.js';
import { configManager } from '../services/core/config-manager.js';

const EXEMPT_PREFIXES = [
  '/api/tunnel/verify-passcode',
  '/api/tunnel/session',
  '/api/health',
  '/assets/',
  '/favicon.ico',
];

function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isTunnelRequest(req: Request): boolean {
  const hostname = req.hostname;
  return hostname !== 'localhost' && hostname !== '127.0.0.1';
}

export function tunnelPasscodeAuth(req: Request, res: Response, next: NextFunction): void {
  // Local access is always unrestricted
  if (!isTunnelRequest(req)) {
    next();
    return;
  }

  // Check if passcode is configured and enabled
  const tunnelConfig = configManager.get('tunnel');
  if (!tunnelConfig?.passcodeEnabled || !tunnelConfig?.passcodeHash) {
    next();
    return;
  }

  // Exempt routes (passcode entry page, health checks, static assets)
  if (isExempt(req.path)) {
    next();
    return;
  }

  // Check session cookie (set by cookie-session middleware)
  if (req.session?.tunnelAuthenticated) {
    next();
    return;
  }

  // Not authenticated — return 401
  res.status(401).json({ error: 'Passcode required' });
}
```

#### `apps/server/src/routes/tunnel.ts` (MODIFY)

Add two new endpoints to the existing tunnel router:

**`POST /api/tunnel/verify-passcode`** — Validates the passcode and sets a session cookie:

```typescript
router.post('/verify-passcode', passcodeRateLimiter, async (req, res) => {
  const parsed = PasscodeVerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: 'Invalid passcode format' });
  }

  const tunnelConfig = configManager.get('tunnel');
  if (!tunnelConfig?.passcodeHash || !tunnelConfig?.passcodeSalt) {
    return res.status(400).json({ ok: false, error: 'No passcode configured' });
  }

  const valid = await verifyPasscode(
    parsed.data.passcode,
    tunnelConfig.passcodeHash,
    tunnelConfig.passcodeSalt
  );

  if (!valid) {
    return res.status(401).json({ ok: false, error: 'Incorrect passcode' });
  }

  // Set session
  req.session!.tunnelAuthenticated = true;
  return res.json({ ok: true });
});
```

**`GET /api/tunnel/session`** — Returns current session authentication status:

```typescript
router.get('/session', (_req, res) => {
  const tunnelConfig = configManager.get('tunnel');
  const passcodeRequired = !!(tunnelConfig?.passcodeEnabled && tunnelConfig?.passcodeHash);
  const authenticated = !!_req.session?.tunnelAuthenticated;

  return res.json({ authenticated, passcodeRequired });
});
```

**Rate limiter** (defined in the same file or as a separate helper):

```typescript
import rateLimit from 'express-rate-limit';
import { PASSCODE_RATE_LIMIT_WINDOW_MS, PASSCODE_RATE_LIMIT_MAX } from '@dorkos/shared/constants';

const passcodeRateLimiter = rateLimit({
  windowMs: PASSCODE_RATE_LIMIT_WINDOW_MS,
  max: PASSCODE_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Try again later.', retryAfter: 900 },
  keyGenerator: (req) => req.ip ?? 'unknown',
});
```

#### `apps/server/src/routes/tunnel.ts` — Set Passcode Endpoint

Add an endpoint for setting/updating the passcode (called from TunnelDialog):

**`POST /api/tunnel/set-passcode`** — Hashes and stores a new passcode:

```typescript
router.post('/set-passcode', async (req, res) => {
  // Only allow from localhost (passcode management is local-only)
  if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') {
    return res.status(403).json({ error: 'Passcode can only be changed locally' });
  }

  const { passcode, enabled } = req.body;

  // Handle disable (clear passcode)
  if (enabled === false) {
    const tunnelConfig = configManager.get('tunnel');
    configManager.set('tunnel', {
      ...tunnelConfig,
      passcodeEnabled: false,
    });
    tunnelManager.refreshStatus(); // emit status_change
    return res.json({ ok: true });
  }

  // Validate passcode format
  if (!passcode || !/^\d{6}$/.test(passcode)) {
    return res.status(400).json({ error: 'Passcode must be exactly 6 digits' });
  }

  const { hash, salt } = await hashPasscode(passcode);
  const tunnelConfig = configManager.get('tunnel');
  configManager.set('tunnel', {
    ...tunnelConfig,
    passcodeEnabled: true,
    passcodeHash: hash,
    passcodeSalt: salt,
  });

  tunnelManager.refreshStatus(); // emit status_change
  return res.json({ ok: true });
});
```

#### `apps/server/src/app.ts` (MODIFY)

Register `cookie-session` middleware and `tunnelPasscodeAuth`:

```typescript
import cookieSession from 'cookie-session';
import { tunnelPasscodeAuth } from './middleware/tunnel-auth.js';

// After CORS, before routes:
app.set('trust proxy', 1);

// Session secret: auto-generate on first run, persist to config
let sessionSecret = configManager.get('sessionSecret');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  configManager.set('sessionSecret', sessionSecret);
}

app.use(
  cookieSession({
    name: 'dorkos_session',
    keys: [sessionSecret],
    maxAge: PASSCODE_SESSION_MAX_AGE_MS,
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  })
);

app.use(tunnelPasscodeAuth);
```

**Middleware order** (updated):

1. CORS
2. `express.json()`
3. `requestLogger`
4. `cookieSession`
5. `tunnelPasscodeAuth`
6. Route handlers

#### `apps/server/src/services/core/tunnel-manager.ts` (MODIFY)

Update the `status` getter to include `passcodeEnabled`:

```typescript
get status(): TunnelStatus {
  const tunnelConfig = configManager.get('tunnel');
  return {
    ...this._status,
    passcodeEnabled: !!(tunnelConfig?.passcodeEnabled && tunnelConfig?.passcodeHash),
  };
}
```

Add a `refreshStatus()` method that emits `status_change` (to broadcast passcode config changes via SSE):

```typescript
refreshStatus(): void {
  this.emit('status_change');
}
```

### 3. Client Implementation

#### Install shadcn InputOTP

```bash
cd apps/client && npx shadcn@latest add input-otp
```

This installs `input-otp` and creates `apps/client/src/layers/shared/ui/input-otp.tsx`.

#### `apps/client/src/layers/shared/lib/transport/http-transport.ts` (MODIFY)

Add the two new transport methods:

```typescript
async verifyTunnelPasscode(
  passcode: string,
): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  return fetchJSON(this.baseUrl, '/tunnel/verify-passcode', {
    method: 'POST',
    body: JSON.stringify({ passcode }),
  });
}

async checkTunnelSession(): Promise<{ authenticated: boolean; passcodeRequired: boolean }> {
  return fetchJSON(this.baseUrl, '/tunnel/session', { method: 'GET' });
}
```

#### `apps/client/src/layers/features/tunnel-gate/` (NEW — feature module)

**FSD placement:** `features/tunnel-gate` — this is a user-facing feature that gates the entire application. It lives in the `features` layer because it orchestrates UI + transport calls.

**`ui/PasscodeGate.tsx`** — Full-screen passcode entry component:

```tsx
import { DorkLogo } from '@dorkos/icons';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/layers/shared/ui/input-otp';
import { REGEXP_ONLY_DIGITS } from 'input-otp';

interface PasscodeGateProps {
  onSuccess: () => void;
}

export function PasscodeGate({ onSuccess }: PasscodeGateProps) {
  const transport = useTransport();
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [value, setValue] = useState('');

  const handleComplete = useCallback(
    async (passcode: string) => {
      setIsVerifying(true);
      setError(null);

      try {
        const result = await transport.verifyTunnelPasscode(passcode);
        if (result.ok) {
          onSuccess();
        } else {
          setError(result.error ?? 'Incorrect passcode');
          setValue('');
        }
      } catch {
        setError('Connection error. Try again.');
        setValue('');
      } finally {
        setIsVerifying(false);
      }
    },
    [transport, onSuccess]
  );

  return (
    <div className="bg-background flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-8">
        <DorkLogo variant="white" size={120} />

        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-foreground text-lg font-semibold">Enter passcode</h1>
          <p className="text-muted-foreground text-sm">
            Enter your 6-digit passcode to access this instance.
          </p>
        </div>

        <InputOTP
          maxLength={6}
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          value={value}
          onChange={setValue}
          onComplete={handleComplete}
          disabled={isVerifying}
          autoFocus
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <InputOTPSlot key={i} index={i} className={error ? 'border-destructive' : ''} />
            ))}
          </InputOTPGroup>
        </InputOTP>

        {error && <p className="text-destructive text-sm">{error}</p>}

        {isVerifying && <p className="text-muted-foreground text-sm">Verifying...</p>}
      </div>
    </div>
  );
}
```

**Key design details:**

- Full viewport (`min-h-dvh`) centered layout
- `bg-background` — uses the dark theme automatically
- `DorkLogo` at `variant="white"` + `size={120}` — prominent but not overwhelming
- InputOTP with `inputMode="numeric"` triggers numeric keyboard on mobile
- `pattern={REGEXP_ONLY_DIGITS}` rejects non-numeric input
- `autoFocus` immediately focuses the first digit box
- `onComplete` auto-submits when all 6 digits are entered — no submit button needed
- Error state: `border-destructive` on digit boxes + error message below
- Disabled state during verification prevents double-submit
- Value is cleared on failure so user can retry immediately

**`ui/PasscodeGateWrapper.tsx`** — Orchestrates session check + gate rendering:

```tsx
interface PasscodeGateWrapperProps {
  children: React.ReactNode;
}

export function PasscodeGateWrapper({ children }: PasscodeGateWrapperProps) {
  const transport = useTransport();
  const [state, setState] = useState<'checking' | 'locked' | 'unlocked'>('checking');

  useEffect(() => {
    // Only gate if we're on a tunnel URL (not localhost)
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      setState('unlocked');
      return;
    }

    transport
      .checkTunnelSession()
      .then((result) => {
        if (!result.passcodeRequired || result.authenticated) {
          setState('unlocked');
        } else {
          setState('locked');
        }
      })
      .catch(() => {
        // If session check fails, assume unlocked (fail-open for localhost fallback)
        setState('unlocked');
      });
  }, [transport]);

  if (state === 'checking') {
    return null; // Brief blank screen during session check
  }

  if (state === 'locked') {
    return <PasscodeGate onSuccess={() => setState('unlocked')} />;
  }

  return <>{children}</>;
}
```

**`index.ts`** — Barrel export:

```typescript
export { PasscodeGate } from './ui/PasscodeGate.js';
export { PasscodeGateWrapper } from './ui/PasscodeGateWrapper.js';
```

#### `apps/client/src/main.tsx` (MODIFY)

Wrap the router/app in the `PasscodeGateWrapper`:

```tsx
import { PasscodeGateWrapper } from '@/layers/features/tunnel-gate';

// Inside Root component, after TransportProvider but before RouterProvider:
<TransportProvider transport={transport}>
  <PasscodeGateWrapper>
    <RouterProvider router={router} />
  </PasscodeGateWrapper>
</TransportProvider>;
```

The gate wrapper checks `window.location.hostname` — on localhost it renders children immediately. On a tunnel hostname, it calls `GET /api/tunnel/session` first.

#### `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx` (MODIFY)

Add a passcode configuration section between the Custom Domain section and the Toggle section. Shown when `tunnel.tokenConfigured && state !== 'connected'`:

```tsx
{
  /* Passcode Section */
}
{
  tunnel?.tokenConfigured && state !== 'connected' && (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Passcode</p>
          <p className="text-muted-foreground text-xs">Require a 6-digit PIN for remote access</p>
        </div>
        <Switch
          checked={passcodeEnabled}
          onCheckedChange={handlePasscodeToggle}
          disabled={state === 'connected'}
        />
      </div>

      {passcodeEnabled && (
        <div className="space-y-2">
          <InputOTP
            maxLength={6}
            pattern={REGEXP_ONLY_DIGITS}
            inputMode="numeric"
            value={passcodeInput}
            onChange={setPasscodeInput}
            disabled={state === 'connected'}
          >
            <InputOTPGroup>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <Button
            size="sm"
            onClick={handleSavePasscode}
            disabled={passcodeInput.length !== 6 || state === 'connected'}
          >
            {tunnel.passcodeEnabled ? 'Update passcode' : 'Set passcode'}
          </Button>
        </div>
      )}
    </div>
  );
}
```

**State additions to TunnelDialog:**

```typescript
const [passcodeEnabled, setPasscodeEnabled] = useState(false);
const [passcodeInput, setPasscodeInput] = useState('');
```

**Handlers:**

```typescript
const handlePasscodeToggle = useCallback(
  async (checked: boolean) => {
    if (!checked) {
      // Disable passcode
      await fetchJSON(transport.baseUrl, '/tunnel/set-passcode', {
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      });
      setPasscodeEnabled(false);
      setPasscodeInput('');
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } else {
      setPasscodeEnabled(true);
    }
  },
  [transport, queryClient]
);

const handleSavePasscode = useCallback(async () => {
  try {
    await fetchJSON(transport.baseUrl, '/tunnel/set-passcode', {
      method: 'POST',
      body: JSON.stringify({ passcode: passcodeInput, enabled: true }),
    });
    setPasscodeInput('');
    queryClient.invalidateQueries({ queryKey: ['config'] });
    toast.success('Passcode saved');
  } catch {
    toast.error('Failed to save passcode');
  }
}, [passcodeInput, transport, queryClient]);
```

**Sync passcodeEnabled from server state:**

```typescript
useEffect(() => {
  if (tunnel?.passcodeEnabled !== undefined) {
    setPasscodeEnabled(tunnel.passcodeEnabled);
  }
}, [tunnel?.passcodeEnabled]);
```

### 4. Data Model Summary

**Config file (`~/.dork/config.json`):**

```json
{
  "tunnel": {
    "enabled": true,
    "domain": "my-app.ngrok-free.app",
    "authtoken": null,
    "auth": null,
    "passcodeEnabled": true,
    "passcodeHash": "a1b2c3...hex...",
    "passcodeSalt": "d4e5f6...hex..."
  },
  "sessionSecret": "random-hex-string..."
}
```

**TunnelStatus (API response):**

```json
{
  "enabled": true,
  "connected": true,
  "url": "https://abc123.ngrok-free.app",
  "port": 6241,
  "startedAt": "2026-03-24T10:00:00Z",
  "authEnabled": false,
  "tokenConfigured": true,
  "domain": "my-app.ngrok-free.app",
  "passcodeEnabled": true
}
```

### 5. API Changes

| Method | Path                          | Purpose                                    | Auth                                  |
| ------ | ----------------------------- | ------------------------------------------ | ------------------------------------- |
| `POST` | `/api/tunnel/verify-passcode` | Submit 6-digit PIN, receive session cookie | Rate-limited, exempt from tunnel-auth |
| `GET`  | `/api/tunnel/session`         | Check if current session is authenticated  | Exempt from tunnel-auth               |
| `POST` | `/api/tunnel/set-passcode`    | Set/update/disable passcode                | **Localhost only**                    |

**Existing endpoints unchanged:** `/api/tunnel/start`, `/api/tunnel/stop`, `/api/tunnel/status`, `/api/tunnel/stream`.

## User Experience

### Setting Up a Passcode (Local)

1. Open Settings → Server → Remote → Manage
2. TunnelDialog opens with existing controls
3. Below "Custom Domain", a new "Passcode" section appears (only when disconnected)
4. Toggle "Require passcode for remote access" ON
5. Enter 6 digits in the InputOTP boxes
6. Click "Set passcode" → toast confirms "Passcode saved"
7. Start the tunnel as normal — passcode is now enforced

### Accessing Remotely

1. Open tunnel URL on phone/tablet/another machine
2. Full-screen passcode gate appears: DorkOS logo, "Enter passcode" heading, 6 digit boxes
3. Numeric keyboard opens automatically on mobile
4. Enter 6 digits — auto-submits on the 6th digit
5. On success: gate dissolves, main app appears
6. Session persists for 24 hours of activity (rolling)

### Error States

- **Wrong passcode:** Digit boxes flash red border, "Incorrect passcode" message, boxes clear for retry
- **Rate limited:** "Too many attempts. Try again in X seconds." with countdown
- **Connection error:** "Connection error. Try again." with clear boxes

### Updating Passcode (Local)

1. Open TunnelDialog while tunnel is disconnected
2. Enter new 6 digits in the passcode input
3. Click "Update passcode" → toast confirms
4. Old passcode immediately invalid (hash replaced)

### Disabling Passcode

1. Toggle passcode switch OFF in TunnelDialog
2. Passcode section collapses
3. Remote access is now ungated

## Testing Strategy

### Server Tests

**`apps/server/src/lib/__tests__/passcode-hash.test.ts`:**

- `hashPasscode` returns hash and salt as hex strings
- `verifyPasscode` returns true for correct passcode
- `verifyPasscode` returns false for incorrect passcode
- Different salts produce different hashes for the same input
- Timing-safe comparison (verify hash length mismatch returns false, not throws)

**`apps/server/src/middleware/__tests__/tunnel-auth.test.ts`:**

- Passes through for localhost requests (hostname = 'localhost')
- Passes through for 127.0.0.1 requests
- Passes through when passcode is not enabled
- Passes through when passcode is not configured (hash is null)
- Passes through for exempt routes (`/api/tunnel/verify-passcode`, `/api/health`, `/assets/*`)
- Returns 401 for tunnel requests without session cookie
- Passes through for tunnel requests with valid session cookie
- Returns 401 for tunnel requests with expired/invalid session cookie

**`apps/server/src/routes/__tests__/tunnel-passcode.test.ts`:**

- `POST /verify-passcode` returns 200 + session cookie for correct passcode
- `POST /verify-passcode` returns 401 for incorrect passcode
- `POST /verify-passcode` returns 400 for invalid format (non-numeric, wrong length)
- `POST /verify-passcode` returns 429 after rate limit exceeded
- `GET /session` returns `{ authenticated: false, passcodeRequired: true }` for unauthenticated tunnel request with passcode enabled
- `GET /session` returns `{ authenticated: true, passcodeRequired: true }` for authenticated session
- `GET /session` returns `{ passcodeRequired: false }` when passcode is disabled
- `POST /set-passcode` stores hashed passcode (never plaintext)
- `POST /set-passcode` returns 403 from non-localhost request
- `POST /set-passcode` with `enabled: false` clears passcodeEnabled flag
- `POST /set-passcode` rejects non-6-digit input

### Client Tests

**`apps/client/src/layers/features/tunnel-gate/__tests__/PasscodeGate.test.tsx`:**

- Renders DorkOS logo, heading, and 6 digit input boxes
- Calls `verifyTunnelPasscode` when 6 digits entered
- Shows error message on failed verification
- Clears input on failed verification
- Disables input during verification
- Calls `onSuccess` on successful verification

**`apps/client/src/layers/features/tunnel-gate/__tests__/PasscodeGateWrapper.test.tsx`:**

- Renders children immediately on localhost
- Calls `checkTunnelSession` on non-localhost hostname
- Shows PasscodeGate when session check returns `{ authenticated: false, passcodeRequired: true }`
- Renders children when session is authenticated
- Renders children when passcode is not required

**`apps/client/src/layers/features/settings/__tests__/TunnelDialog-passcode.test.tsx`:**

- Renders passcode section when token is configured and not connected
- Hides passcode section when connected
- Toggles passcode enabled state
- Calls set-passcode API with 6-digit input
- Shows toast on save success/failure
- Disables save button when input is incomplete

## Performance Considerations

- **Cold start:** `checkTunnelSession` is a single GET request (~5ms on local, ~50ms on tunnel). The brief blank screen during the check is imperceptible.
- **Scrypt hashing:** Each verification takes ~100ms (intentional — slows brute force). Only runs on `POST /verify-passcode`, not on every request.
- **Cookie overhead:** `cookie-session` adds ~200 bytes per request (signed cookie). Negligible.
- **Rate limiter memory:** In-memory store, per-IP counters. Resets on server restart. Suitable for single-user.

## Security Considerations

| Threat                      | Mitigation                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brute force                 | Progressive rate limiting: 10 attempts per 15-minute window per IP                                                                                                        |
| Timing attacks              | `crypto.timingSafeEqual` for all passcode comparisons                                                                                                                     |
| CSRF on verify endpoint     | `SameSite: strict` cookie + same-origin fetch (no CORS needed)                                                                                                            |
| PIN in transit              | POST body only, over TLS (ngrok terminates HTTPS)                                                                                                                         |
| PIN at rest                 | Hashed with scrypt + 32-byte random salt. Never stored in plaintext.                                                                                                      |
| Session hijacking           | `httpOnly` + `secure` + `sameSite: strict` cookies. Cannot be read by JS or sent cross-origin.                                                                            |
| Proxy spoofing              | `trust proxy: 1` (not `true`) — only trusts the immediate upstream proxy (ngrok)                                                                                          |
| Config file exposure        | Hash + salt stored, not plaintext. Even if `~/.dork/config.json` is read, the PIN cannot be recovered (1M possible combinations, but scrypt makes brute force expensive). |
| Localhost bypass            | By design. Local access implies machine access — gating it adds no security.                                                                                              |
| Passcode change from remote | `POST /set-passcode` is localhost-only (403 for tunnel requests).                                                                                                         |

## Documentation

- Update `contributing/configuration.md` with new tunnel config fields (`passcodeEnabled`, `passcodeHash`, `passcodeSalt`, `sessionSecret`)
- Add passcode section to the API reference in `contributing/api-reference.md` (3 new endpoints)

## Implementation Phases

### Phase 1: Server Foundation

1. Add `passcode-hash.ts` utility (hash + verify functions)
2. Update `config-schema.ts` with new fields (`passcodeHash`, `passcodeSalt`, `passcodeEnabled`, `sessionSecret`)
3. Update `schemas.ts` with `passcodeEnabled` on `TunnelStatusSchema` and new request/response schemas
4. Update `constants.ts` with passcode constants
5. Install `cookie-session` in server
6. Configure `cookie-session` + `trust proxy` in `app.ts`
7. Create `tunnel-auth.ts` middleware
8. Add `/verify-passcode`, `/session`, `/set-passcode` routes
9. Update `tunnel-manager.ts` status getter + `refreshStatus()`
10. Write server tests

### Phase 2: Client Gate

1. Install shadcn InputOTP component (`npx shadcn@latest add input-otp`)
2. Add `verifyTunnelPasscode` and `checkTunnelSession` to Transport interface and HttpTransport
3. Create `features/tunnel-gate/` module with `PasscodeGate` and `PasscodeGateWrapper`
4. Integrate `PasscodeGateWrapper` in `main.tsx`
5. Write client gate tests

### Phase 3: Settings UI

1. Add passcode section to `TunnelDialog.tsx` (toggle + InputOTP + save button)
2. Wire up `set-passcode` API calls
3. Sync state from server config
4. Write TunnelDialog passcode tests

## Open Questions

None — all decisions resolved during ideation.

## Related ADRs

- **ADR-0103:** Optional API Key Authentication for MCP — establishes the auth middleware pattern used as a model for `tunnel-auth.ts`
- **ADR-0057:** BroadcastChannel + SSE for Tunnel Sync — passcode config changes will propagate through the same SSE mechanism (`status_change` events)
- **ADR-0014:** Sliding Window Log for Rate Limiting — general rate limiting approach applied here with `express-rate-limit`

## References

- Ideation: `specs/remote-passcode/01-ideation.md`
- Research: `research/20260324_tunnel_passcode_auth_system.md`
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) (scrypt recommendation)
- [shadcn InputOTP docs](https://ui.shadcn.com/docs/components/radix/input-otp)
- [cookie-session npm](https://www.npmjs.com/package/cookie-session)
- [Express behind proxies](https://expressjs.com/en/guide/behind-proxies.html) (`trust proxy` configuration)
- [Node.js crypto.scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
