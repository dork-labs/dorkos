# Plan: Integrate ngrok Tunnel as `@lifeos/tunnel`

## Summary

Create a new `packages/tunnel/` package that wraps the `@ngrok/ngrok` SDK, and integrate it into the server so that setting `TUNNEL_ENABLED=true` automatically starts an ngrok tunnel when the server boots. The tunnel URL is printed to the console and exposed via the existing health endpoint.

---

## New Files

### 1. `packages/tunnel/package.json`

```json
{
  "name": "@lifeos/tunnel",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@ngrok/ngrok": "^1.4.1"
  }
}
```

Follows the existing JIT `.ts` export pattern (no build step). The `@ngrok/ngrok` SDK bundles the ngrok agent binary — **no separate ngrok CLI installation needed**. This is what makes it easy for people to just `npm install` and go.

### 2. `packages/tunnel/src/index.ts`

The main module. Exports a `TunnelManager` class with a clean interface:

```typescript
export interface TunnelConfig {
  port: number;
  authtoken?: string;       // Falls back to NGROK_AUTHTOKEN env var
  basicAuth?: string;        // Format: "user:pass" — requires paid ngrok plan
  domain?: string;           // Static domain — requires paid ngrok plan
}

export interface TunnelInfo {
  url: string;
  port: number;
  basicAuth: boolean;
  domain?: string;
}

export class TunnelManager {
  start(config: TunnelConfig): Promise<TunnelInfo>;
  stop(): Promise<void>;
  getInfo(): TunnelInfo | null;          // null if not running
  isRunning(): boolean;
}
```

**Implementation details:**
- `start()` calls `ngrok.forward()` with the provided config, stores the listener reference, and returns the tunnel info.
- `stop()` calls `listener.close()` and clears state.
- `getInfo()` returns the current tunnel URL and config (used by health endpoint).
- If `authtoken` is not provided, the SDK auto-reads `NGROK_AUTHTOKEN` from the environment.
- If `basicAuth` is set but the user is on a free plan, the ngrok SDK will throw — we catch this and log a clear error message explaining the paid plan requirement, then continue without a tunnel.
- The server still starts normally even if the tunnel fails.

### 3. `packages/tunnel/src/__tests__/tunnel-manager.test.ts`

Unit tests that mock `@ngrok/ngrok`:
- Tunnel starts and returns URL
- Tunnel stop closes the listener
- Missing auth token produces helpful error
- Basic auth failure on free plan is handled gracefully
- `getInfo()` returns null when not running
- Double-start is handled (stops previous before starting new)

---

## Modified Files

### 4. `apps/server/package.json` — Add tunnel dependency

```diff
  "dependencies": {
+   "@lifeos/tunnel": "*",
    "@anthropic-ai/claude-agent-sdk": "latest",
```

### 5. `apps/server/src/index.ts` — Start tunnel after server boots

The key change. After `app.listen()` succeeds, conditionally start the tunnel:

```typescript
import { TunnelManager } from '@lifeos/tunnel';

const PORT = parseInt(process.env.GATEWAY_PORT || '6942', 10);
const tunnelManager = new TunnelManager();

async function start() {
  const app = createApp();

  // Make tunnelManager accessible to routes (for health endpoint)
  app.locals.tunnelManager = tunnelManager;

  app.listen(PORT, 'localhost', async () => {
    console.log(`Gateway server running on http://localhost:${PORT}`);

    // Optionally start ngrok tunnel
    if (process.env.TUNNEL_ENABLED === 'true') {
      try {
        const info = await tunnelManager.start({
          port: PORT,
          authtoken: process.env.NGROK_AUTHTOKEN,
          basicAuth: process.env.TUNNEL_BASIC_AUTH,  // "user:pass"
          domain: process.env.TUNNEL_DOMAIN,
        });
        console.log(`\n🌐 Tunnel active: ${info.url}`);
        if (info.basicAuth) {
          console.log(`🔒 Basic auth enabled`);
        }
      } catch (err) {
        console.error('⚠️  Tunnel failed to start:', err.message);
        console.log('   Server continues running locally.');
      }
    }
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    if (tunnelManager.isRunning()) {
      console.log('Closing tunnel...');
      await tunnelManager.stop();
    }
    process.exit(0);
  });

  // ... existing health check interval
}
```

**Important**: The server listens on `localhost` either way. The tunnel is additive — it never changes the local server behavior. If the tunnel fails, the server keeps running.

### 6. `apps/server/src/routes/health.ts` — Expose tunnel URL

```typescript
router.get('/', (req, res) => {
  const tunnelManager = req.app.locals.tunnelManager;
  const tunnelInfo = tunnelManager?.getInfo?.() ?? null;

  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    // Only included when tunnel is active
    ...(tunnelInfo && { tunnel: tunnelInfo }),
  });
});
```

Response when tunnel is active:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 123.456,
  "tunnel": {
    "url": "https://abc123.ngrok-free.app",
    "port": 6942,
    "basicAuth": true,
    "domain": null
  }
}
```

### 7. `turbo.json` — Add tunnel env vars to cache key

```diff
  "build": {
    "dependsOn": ["^build"],
    "outputs": ["dist/**", "dist-server/**", "dist-obsidian/**"],
-   "env": ["NODE_ENV", "VITE_*", "GATEWAY_PORT"]
+   "env": ["NODE_ENV", "VITE_*", "GATEWAY_PORT", "TUNNEL_*", "NGROK_AUTHTOKEN"]
  },
```

### 8. `.env` — Add tunnel config (commented out by default)

```diff
  GATEWAY_PORT=6942
+
+ # Tunnel (ngrok) — uncomment to expose server externally
+ # TUNNEL_ENABLED=true
+ # NGROK_AUTHTOKEN=your_token_here        # Get from https://dashboard.ngrok.com
+ # TUNNEL_BASIC_AUTH=user:password         # Requires ngrok paid plan
+ # TUNNEL_DOMAIN=my-app.ngrok-free.app    # Requires ngrok paid plan
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TUNNEL_ENABLED` | No | `false` | Set to `"true"` to start ngrok tunnel on server boot |
| `NGROK_AUTHTOKEN` | When tunnel enabled | — | Your ngrok auth token (free at ngrok.com) |
| `TUNNEL_BASIC_AUTH` | No | — | Basic auth credentials as `"user:pass"` (paid plan) |
| `TUNNEL_DOMAIN` | No | — | Static ngrok domain (paid plan) |

---

## What Does NOT Change

- **Client code** — No changes. The client already connects to whatever URL it's served from. When accessed via the ngrok URL, all relative `/api/*` requests go through the tunnel automatically.
- **Obsidian plugin** — No changes. It uses DirectTransport (in-process), not HTTP.
- **`packages/shared`** — No schema changes needed. The health response just gets an optional extra field.
- **Vite config** — Already has `allowedHosts: ['.ngrok-free.app']`. No change needed.

---

## User Experience

### Quick start (free tier)
```bash
# 1. Sign up at https://ngrok.com and get your auth token
# 2. Set environment variables
echo "TUNNEL_ENABLED=true" >> .env
echo "NGROK_AUTHTOKEN=your_token" >> .env

# 3. Start the server — tunnel starts automatically
turbo dev
```

Console output:
```
Gateway server running on http://localhost:6942
🌐 Tunnel active: https://abc123.ngrok-free.app
```

### With basic auth (paid tier)
```bash
echo "TUNNEL_BASIC_AUTH=myuser:mypassword" >> .env
turbo dev
```

Console output:
```
Gateway server running on http://localhost:6942
🌐 Tunnel active: https://abc123.ngrok-free.app
🔒 Basic auth enabled
```

### Checking the tunnel URL programmatically
```bash
curl http://localhost:6942/api/health
# → { "status": "ok", "tunnel": { "url": "https://abc123.ngrok-free.app", ... } }
```

---

## Why `@ngrok/ngrok` SDK (not CLI wrapper)

The `@ngrok/ngrok` npm package **bundles the ngrok agent binary** inside the package itself. This means:

1. **No separate installation** — Users don't need to install ngrok globally or download it manually. `npm install` handles everything.
2. **Cross-platform** — The SDK includes binaries for macOS, Linux, and Windows.
3. **Programmatic control** — Start/stop/inspect tunnels from code, not subprocess management.
4. **No PATH issues** — No need to find the ngrok binary or worry about shell environments.

This is exactly what makes it easy for people to install — it's just an npm dependency.

---

## Implementation Order

1. Create `packages/tunnel/` with `package.json` and `src/index.ts`
2. Write tests in `packages/tunnel/src/__tests__/tunnel-manager.test.ts`
3. Add `@lifeos/tunnel` dependency to `apps/server/package.json`
4. Modify `apps/server/src/index.ts` to conditionally start tunnel
5. Modify `apps/server/src/routes/health.ts` to expose tunnel info
6. Update `turbo.json` env vars
7. Update `.env` with commented-out tunnel config
8. Run `npm install` to link the new workspace package
9. Run `turbo typecheck` and `turbo test` to verify
