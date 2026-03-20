---
title: 'ngrok Integration Best Practices for Node.js/Express'
date: 2026-03-01
type: external-best-practices
status: active
tags: [ngrok, tunnel, security, authentication, nodejs, express, rate-limiting, dx]
feature_slug: ngrok-tunnel
searches_performed: 12
sources_count: 28
---

# ngrok Integration Best Practices for Node.js/Express

## Research Summary

This report covers the full breadth of production-quality ngrok integration for Node.js/Express applications: security architecture, all available authentication patterns (Basic Auth, OAuth, OIDC, JWT, mTLS), custom domain configuration, reconnection/resilience strategies, rate limiting via Traffic Policy, production vs. development use case differentiation, and DX patterns from tools like Expo and Vercel that use tunnel-based access. Existing research in `ngrok-research.md` (SDK API) and `20260217_tunnel_toggle_ux_research.md` (toggle UX) covers the surface-level SDK API and UI patterns — this report fills the remaining security, architecture, and ecosystem gaps.

---

## Key Findings

### 1. Security Architecture: Front Door vs. Direct Exposure

The most important security decision is **not how to configure the tunnel**, but **what topology to use**. ngrok recommends a "Front Door" model for teams:

- **Avoid**: Each developer runs a public ngrok endpoint with individual auth
- **Prefer**: A single centralized Cloud Endpoint managed by security/DevOps routes traffic to internal `.internal` endpoints that developers run locally

Individual developer endpoints should use `.internal` domain extensions (not publicly routable), protected behind a centralized Traffic Policy that applies auth, IP restrictions, rate limiting, and audit logging in one place. This prevents rogue tunnels from developers accidentally exposing sensitive data.

For solo developer tools like DorkOS (single user, no team), direct public endpoints with auth are acceptable, but the security layers described in findings 2–4 below still apply.

### 2. Authentication Patterns (Six Options, Ordered by Complexity)

ngrok's Traffic Policy engine exposes six authentication mechanisms — from trivial to enterprise-grade:

| Method                       | Use Case                           | Plan Required    | Complexity  |
| ---------------------------- | ---------------------------------- | ---------------- | ----------- |
| Basic Auth                   | Dev tools, demos, quick protection | Personal ($8/mo) | Low         |
| OAuth (Google, GitHub, etc.) | Internal tools, single sign-on     | Personal         | Medium      |
| OIDC (Okta, Azure AD)        | Enterprise corporate IdPs          | Pro              | Medium-High |
| JWT Validation               | API-to-API, mobile backends        | Personal         | Medium      |
| IP Restrictions              | Office-only access                 | Personal         | Low         |
| Mutual TLS (mTLS)            | Machine-to-machine, zero-trust     | Pro              | High        |

**Critical**: Basic Auth requires a paid plan. The free tier cannot add any auth to tunnel endpoints beyond the authtoken itself.

### 3. Custom Domain Options Are Tiered

Free tier users get a static "dev domain" (e.g., `abc123.ngrok-free.app`) that cannot be customized. Paid plans unlock:

- **Personal ($8/mo)**: Reserved subdomains on `ngrok.app`, `ngrok.dev`
- **Pay-as-you-go**: Bring-your-own domains via CNAME + wildcard subdomains

The static dev domain on free plans is significant: it means DorkOS can offer a stable public URL for free users (not a new random URL on each tunnel start), which dramatically improves UX for features like mobile access.

### 4. Reconnection Is Automatic; Status Callbacks Require the SessionBuilder API

The `@ngrok/ngrok` SDK handles reconnection automatically with exponential backoff — tunnels are re-established without application code. However, **monitoring requires opting into the SessionBuilder API** (lower-level than `ngrok.forward()`). The `ngrok.forward()` convenience function accepts `on_status_change` but the SessionBuilder exposes richer callbacks: `handleDisconnection`, `handleHeartbeat`, `handleStopCommand`.

### 5. Rate Limiting via Traffic Policy (Paid Feature)

ngrok's Traffic Policy engine provides a `rate-limit` action with sliding window algorithm, configurable capacity, rate period, and bucket key (per-IP, per-header, or global). On the free tier, application-level rate limiting in Express must handle this instead.

### 6. Production vs. Development: Different Endpoints, Different Lifecycles

| Dimension      | Development Tunnel                        | Production Cloud Endpoint         |
| -------------- | ----------------------------------------- | --------------------------------- |
| Lifecycle      | Ephemeral (process lifetime)              | Persistent (exists until deleted) |
| URL stability  | Static dev domain (free) or custom (paid) | Always stable                     |
| Auth           | Basic auth or OAuth                       | IP restrictions + JWT + mTLS      |
| Traffic policy | Optional                                  | Required                          |
| Management     | Programmatic via SDK                      | Dashboard/API                     |

### 7. DX Patterns from Expo and Vercel

- **Expo**: QR code printed in terminal, entropy-prefixed URL, explicit `--tunnel` flag opt-in, performance warnings shown on activation, LAN-first fallback recommended
- **Vercel**: No native tunnel — ecosystem uses DevTunnel-CLI which auto-cascades Cloudflare → ngrok → LocalTunnel for reliability
- **Common pattern**: tunnel as explicit opt-in, not default; clear visual distinction between local and public access modes; URL shown prominently with copy affordance

---

## Detailed Analysis

### Security Best Practices for Exposing Local Servers

#### 1. Principle of Least Exposure

Always start the local server **before** the tunnel. Never expose the tunnel port while the server is still initializing. In production-adjacent scenarios, only expose the port that your app binds to — never a database port (5432, 27017) or admin panel over a raw TCP tunnel without application-level auth.

```typescript
// Correct order: server first, tunnel second
const server = await new Promise<http.Server>((resolve) => {
  const s = app.listen(PORT, () => resolve(s));
});

// Now safe to expose
const listener = await ngrok.forward({ addr: PORT, authtoken: process.env.NGROK_AUTHTOKEN });
```

#### 2. Terminate Tunnels When Not In Use

An idle ngrok tunnel is still a live public endpoint. Always close tunnels on process exit:

```typescript
process.on('SIGINT', async () => {
  await listener.close();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', async () => {
  await listener.close();
  server.close(() => process.exit(0));
});
```

#### 3. Unique Authtokens Per Context

ngrok allows generating multiple authtokens per account. The best practice is:

- One authtoken per developer (for team setups)
- One authtoken per application (for production use)
- Revoke individual tokens without affecting others

For DorkOS, store `NGROK_AUTHTOKEN` in the user's `~/.dork/config.json` (already implemented) and never commit it.

#### 4. Use `circuit_breaker` to Prevent Cascade Failures

The `circuit_breaker` option (free tier, no extra cost) automatically rejects requests when 5XX error rates exceed a configurable threshold. This prevents runaway upstream errors from overwhelming the tunnel:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  circuit_breaker: 0.5, // Reject new requests when >50% return 5XX
});
```

#### 5. Security Verification: Verifying Webhooks

If using ngrok to receive webhooks from third parties, use the `verify_webhook` option (paid) to cryptographically verify the source:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  verify_webhook: {
    provider: 'github',
    secret: process.env.GITHUB_WEBHOOK_SECRET,
  },
});
```

---

### Authentication Patterns

#### Basic Auth (Personal Plan Required)

Simplest protection. Up to 10 username/password pairs. Prompts browser users. Not suitable for API clients that can't handle HTTP 401 challenges.

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  basic_auth: [`${process.env.TUNNEL_USERNAME}:${process.env.TUNNEL_PASSWORD}`],
});
```

Traffic Policy equivalent (for multiple credentials):

```yaml
actions:
  - type: basic-auth
    config:
      credentials:
        - 'user1:password1'
        - 'user2:password2'
      realm: 'DorkOS'
```

#### OAuth via Traffic Policy

Redirect all visitors through Google/GitHub/etc. before they can reach the upstream server. The `oauth` option in `ngrok.forward()` accepts a provider string:

```typescript
// Via ngrok.forward() shorthand
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  oauth: {
    provider: 'google',
    allow_emails: ['user@example.com'], // Allowlist by email
    allow_domains: ['yourcompany.com'], // Allowlist by domain
  },
});

// Via Traffic Policy JSON (more control)
// policy action type: "oauth"
```

Supported providers: Google, GitHub, GitLab, LinkedIn, Microsoft, Twitch.

ngrok handles the OAuth callback URL automatically — set `https://idp.ngrok.com/oauth2/callback` as the redirect URI in your OAuth app registration.

#### OIDC (Corporate IdPs: Okta, Azure AD)

For teams using enterprise identity:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  oidc: {
    issuer_url: 'https://your-company.okta.com',
    client_id: process.env.OIDC_CLIENT_ID,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    scopes: ['openid', 'profile', 'email'],
  },
});
```

Identity tokens can be forwarded to the upstream Express app as HTTP headers, enabling the server to read user identity without implementing its own auth flow.

#### JWT Validation (API Clients)

For machine-to-machine or mobile app backends where the client sends a Bearer token:

```yaml
# Traffic Policy action
- type: validate-jwt
  config:
    issuer:
      allow_list:
        - value: 'https://auth.example.com'
    audience:
      allow_list:
        - value: 'my-api'
    http:
      tokens:
        - type: bearer
          method: header
          name: Authorization
```

The token is validated at the ngrok edge before reaching the Express server — no Express middleware needed.

#### IP Restrictions

Simplest enterprise pattern — allowlist a CIDR range:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  ip_restriction_allow_cidrs: ['203.0.113.0/24', '10.0.0.0/8'],
});
```

#### Mutual TLS (mTLS)

For zero-trust machine-to-machine scenarios where both client and server must present certificates:

```typescript
import { readFileSync } from 'fs';

const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  mutual_tls_cas: [readFileSync('/path/to/ca.pem')],
});
```

---

### Custom Domain Configuration

#### Free Tier: Static Dev Domain

Every ngrok account gets a static dev domain automatically — it is always the same URL for that account. This is the most important free-tier feature for developer tooling:

```typescript
// The dev domain is automatically used — no configuration needed
// URL will always be the same for this account (e.g., abc123.ngrok-free.app)
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  // No domain: specified — will use dev domain automatically
});
console.log(listener.url()); // Always "https://abc123.ngrok-free.app" for this account
```

To explicitly request the static dev domain:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  domain: process.env.NGROK_STATIC_DOMAIN, // Your assigned dev domain
});
```

#### Paid: Reserved Custom Subdomain

Personal plan allows choosing a subdomain on `ngrok.app`:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  domain: 'my-dorkos.ngrok.app', // Reserved in ngrok dashboard
});
```

#### Paid: Bring-Your-Own Domain (Pay-as-you-go)

1. Reserve the domain in the ngrok dashboard
2. Create a CNAME record at your DNS provider pointing to `tunnel.ngrok.com`
3. Use in code:

```typescript
const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  domain: 'agent.yourcompany.com',
});
```

Wildcard domains (`*.yourcompany.com`) are supported on pay-as-you-go plans for multi-tenant routing.

---

### Error Handling and Reconnection Strategies

#### Two-Level API: `ngrok.forward()` vs. SessionBuilder

`ngrok.forward()` is a convenience wrapper that creates a Session and an HTTP endpoint in one call. For production resilience, use the **SessionBuilder API** directly:

```typescript
import * as ngrok from '@ngrok/ngrok';

async function createResilientTunnel(port: number): Promise<ngrok.Listener> {
  const session = await new ngrok.SessionBuilder()
    .authtokenFromEnv()
    .metadata('dorkos-server')
    // Heartbeat monitoring (every 10s, 30s tolerance by default)
    .handleHeartbeat((latencyMs: number) => {
      if (latencyMs > 500) {
        console.warn(`[ngrok] High tunnel latency: ${latencyMs}ms`);
      }
    })
    // Disconnect notification (SDK auto-reconnects, this is for logging only)
    .handleDisconnection((addr: string, error: Error) => {
      console.error(`[ngrok] Tunnel disconnected from ${addr}:`, error?.message ?? 'clean close');
    })
    // Handle remote stop command from ngrok dashboard
    .handleStopCommand(() => {
      console.log('[ngrok] Stop command received from dashboard');
      process.exit(0);
    })
    .connect();

  const listener = await session
    .httpEndpoint()
    .domain(process.env.NGROK_DOMAIN ?? '') // empty string = use dev domain
    .circuitBreaker(0.5)
    .listen();

  console.log(`[ngrok] Tunnel active: ${listener.url()}`);

  return listener;
}
```

#### Automatic Reconnection

The SDK's built-in reconnection behavior:

- Detects failure via missed heartbeats (30s tolerance by default)
- Exponential backoff between reconnection attempts
- Automatically re-establishes all tunnels after reconnection
- **No application code required** for reconnection — it is transparent

The `handleDisconnection` callback fires during transient disconnects, but the tunnel URL does **not** change after reconnection. This means the client doesn't need to update stored URLs.

#### Error Classification for Application Code

```typescript
async function startTunnelSafely(port: number) {
  try {
    const listener = await ngrok.forward({
      addr: port,
      authtoken: process.env.NGROK_AUTHTOKEN,
      on_status_change: (addr: string, error: string) => {
        // This fires on transient disconnects; SDK auto-reconnects
        console.warn(`[ngrok] Status change on ${addr}: ${error}`);
      },
    });
    return { ok: true, url: listener.url(), listener };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);

    // Classify error for appropriate user-facing messaging
    if (msg.includes('authtoken') || msg.includes('ERR_NGROK_105')) {
      return { ok: false, error: 'AUTH_MISSING', detail: 'NGROK_AUTHTOKEN is not set or invalid' };
    }
    if (msg.includes('account limit') || msg.includes('ERR_NGROK_402')) {
      return { ok: false, error: 'PLAN_LIMIT', detail: 'Feature requires a paid ngrok plan' };
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ERR_NGROK_3004')) {
      return {
        ok: false,
        error: 'NETWORK_ERROR',
        detail: 'Cannot reach ngrok servers — check internet connection',
      };
    }
    if (msg.includes('tunnel not found') || msg.includes('ERR_NGROK_8012')) {
      return {
        ok: false,
        error: 'DOMAIN_INVALID',
        detail: 'The specified domain is not reserved on this account',
      };
    }
    return { ok: false, error: 'UNKNOWN', detail: msg };
  }
}
```

#### Startup Timeout

ngrok normally connects in under 5 seconds. A 15-second timeout is a generous upper bound:

```typescript
async function startTunnelWithTimeout(port: number, timeoutMs = 15_000) {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('ngrok connect timeout')), timeoutMs)
  );
  return Promise.race([createResilientTunnel(port), timeout]);
}
```

---

### Rate Limiting and Abuse Prevention

#### ngrok-Level Rate Limiting (Traffic Policy — Paid)

The `rate-limit` Traffic Policy action uses a sliding window algorithm:

```typescript
// Via ngrok.forward() policy option
const policy = JSON.stringify({
  inbound: [
    {
      actions: [
        {
          type: 'rate-limit',
          config: {
            name: 'per-ip-limit',
            algorithm: 'sliding_window',
            capacity: 100, // 100 requests
            rate: '1m', // per minute
            bucket_key: ['conn.ClientIP'], // per IP address
          },
        },
      ],
    },
  ],
});

const listener = await ngrok.forward({
  addr: PORT,
  authtoken: process.env.NGROK_AUTHTOKEN,
  policy,
});
```

Rate-limited requests receive HTTP 429 with a `Retry-After` header. Bucket key options:

- `conn.ClientIP` — per source IP (recommended for abuse prevention)
- `req.Headers['Authorization']` — per API key/token
- No bucket key — global limit across all traffic

#### Application-Level Rate Limiting (Free Tier Fallback)

For users on the free tier, implement rate limiting in Express using `express-rate-limit`:

```typescript
import rateLimit from 'express-rate-limit';

// Apply when running behind ngrok — trust the forwarded IP
app.set('trust proxy', 1); // Trust first proxy (ngrok forwards real IP in X-Forwarded-For)

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per IP per minute
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retryAfter: res.getHeader('RateLimit-Reset'),
    });
  },
});

app.use('/api', limiter);
```

**Important**: Set `trust proxy: 1` when behind ngrok. Without this, `req.ip` will always be `127.0.0.1` (the ngrok agent), defeating per-IP rate limiting.

#### JA4 Fingerprinting for DDoS Mitigation (Paid)

ngrok's Traffic Policy supports JA4 TLS fingerprint matching to identify and block bot traffic at the edge:

```yaml
# Block known bad TLS fingerprints before they reach your server
- type: deny
  config:
    status_code: 403
  when: "conn.tls.client.ja4 in ['t13d190900_', 'botFingerprint...']"
```

---

### Production vs. Development Tunnel Usage

#### Development Use Cases (Where Tunnels Excel)

- **Webhook development**: Receive Stripe, GitHub, Slack webhooks locally without a deployed server
- **Mobile device testing**: Access a local backend from a physical phone on any network
- **Cross-team demos**: Share work-in-progress without deploying
- **Firewall bypass**: Work behind corporate NATs or VPNs that block inbound traffic

#### Production Use Cases (Cloud Endpoints)

ngrok Cloud Endpoints are **persistent** — they exist independently of any running process and can be pointed at different upstreams. This enables:

- Zero-downtime deploys (update routing while endpoint remains live)
- Centralized traffic policy managed by ops teams
- Always-on public URL that survives server restarts

```typescript
// Cloud Endpoint is created once via dashboard or API
// Your server just connects to it on startup:
const session = await new ngrok.SessionBuilder().authtokenFromEnv().connect();

// Bind to an existing Cloud Endpoint
const listener = await session
  .httpEndpoint()
  .domain('api.yourcompany.com') // Pre-provisioned Cloud Endpoint
  .listen();
listener.forward(`localhost:${PORT}`);
```

#### When NOT to Use Tunnels

- Serving static files at high volume (use a CDN)
- Long-running production APIs with SLA requirements (use cloud hosting)
- Services requiring WebSocket connections at scale (tunnel adds latency)
- Any service where the tunnel auth token being compromised would cause data loss

#### DorkOS-Specific Guidance

DorkOS's tunnel is a development convenience feature — the right design:

1. **Off by default** (existing implementation is correct)
2. **Non-blocking on failure** (tunnel failure must not prevent local server from starting — existing implementation is correct)
3. **Explicit opt-in** — users who enable tunnel understand they are exposing Claude Code capabilities publicly
4. **Auth strongly recommended** — the settings UI should warn loudly when tunnel is enabled without auth configured
5. **Ephemeral by design** — DorkOS tunnel URLs change per session unless users configure a reserved domain (fine for dev use)

---

### DX Patterns from Popular Tools

#### Expo: `--tunnel` Flag Pattern

Expo's approach to tunnel UX sets the standard for developer tooling:

1. **Explicit opt-in**: Tunnel is not active by default. Users must pass `--tunnel` flag.
2. **Performance warning**: Terminal shows "Using Tunnel connection type will make app reloads considerably slower."
3. **QR code in terminal**: ASCII QR code printed directly in terminal output with the tunnel URL.
4. **URL entropy**: `https://xxxxxxx.bacon.19000.exp.direct` — entropy prefix prevents URL enumeration.
5. **Fallback hierarchy**: LAN → Tunnel (not Tunnel → LAN). Tunnel is the fallback, not the default.
6. **Connection type UI**: The Expo Go app shows the current connection type (LAN/Tunnel/Local) with a visual indicator.

#### Vercel: Delegated to Ecosystem

Vercel's own `vercel dev` command does **not** bundle a tunnel. Instead, the community uses DevTunnel-CLI which implements an automatic fallback cascade:

```
Cloudflare → ngrok → LocalTunnel
```

This resilience pattern — trying multiple providers until one works — is worth considering for DorkOS if ngrok reliability becomes an issue.

#### Microsoft Dev Tunnels

The `devtunnel` CLI (Visual Studio / VS Code integration) embeds tunnel UX directly in the IDE:

- Status shown in the status bar (bottom of VS Code)
- Tunnel URL copyable from a dedicated panel
- Auth integrated with the user's Microsoft account (no separate token needed)
- Port forwarding list shows which ports are tunneled

Key UX lesson: tunnel status belongs in **persistent** UI (status bar or dedicated sidebar section), not a modal. The DorkOS `StatusLine` component is the right place for tunnel status, in addition to the Settings dialog toggle.

#### ngrok's Own Dashboard UX

The ngrok web dashboard uses:

- Live traffic inspector (request/response replay)
- Real-time connection count per tunnel
- Endpoint health status badges (green/amber/red)
- "Copy URL" with one click
- QR code button next to every active tunnel URL

This confirms that QR code + copy-to-clipboard is the canonical ngrok-adjacent URL sharing UX, matching what's already designed in `20260217_tunnel_toggle_ux_research.md`.

---

## Sources & Evidence

- [Best security practices for developer productivity — ngrok docs](https://ngrok.com/docs/guides/security-dev-productivity)
- [Add Authentication examples — ngrok Traffic Policy docs](https://ngrok.com/docs/traffic-policy/examples/add-authentication)
- [Authentication with ngrok — ngrok blog](https://ngrok.com/blog/authentication-with-ngrok)
- [Add OAuth 2.0 to a Node.js CRUD app — ngrok blog](https://ngrok.com/blog-post/nodejs-crud-app-oauth-tutorial)
- [ngrok Domains documentation](https://ngrok.com/docs/universal-gateway/domains)
- [Static dev domains for all ngrok users — ngrok blog](https://ngrok.com/blog/free-static-domains-ngrok-users/)
- [ngrok JavaScript SDK API reference](https://ngrok.github.io/ngrok-javascript/)
- [ngrok-javascript GitHub repository](https://github.com/ngrok/ngrok-javascript)
- [ngrok TypeScript example — ngrok-typescript.ts](https://github.com/ngrok/ngrok-javascript/blob/main/examples/ngrok-typescript.ts)
- [Reconnection and Resilience — ngrok-go DeepWiki](https://deepwiki.com/ngrok/ngrok-go/4.3-reconnection-and-resilience)
- [Drive application performance with global rate limiting — ngrok blog](https://ngrok.com/blog-post/new-feature-rate-limiting)
- [Protecting Services with Rate Limiting — ngrok Kubernetes docs](https://ngrok.com/docs/k8s/guides/how-to/rate-limiting)
- [Block bad actors with JA4 fingerprints — ngrok blog](https://ngrok.com/blog/block-ddos-ja4-fingerprints)
- [ngrok Traffic Policy engine blog post](https://ngrok.com/blog/traffic-policy-engine)
- [ngrok use cases](https://ngrok.com/use-cases)
- [ngrok Security & Compliance](https://ngrok.com/security)
- [Expo CLI — Start developing docs](https://docs.expo.dev/get-started/start-developing/)
- [Expo CLI reference](https://docs.expo.dev/more/expo-cli/)
- [Expo QR Code guide — catdoes.com](https://catdoes.com/blog/expo-qr-code)
- [Local Development Tunnel — Vercel Academy](https://vercel.com/academy/slack-agents/tunnel-orchestration)
- [DevTunnel-CLI documentation](https://devtunnel-cli.vercel.app/)
- [Is ngrok Safe to Use? — w3tutorials.net](https://www.w3tutorials.net/blog/is-ngrok-safe-to-use-or-can-it-be-compromised/)
- [ngrok and OAuth for private tunnels — release.com](https://docs.release.com/guides-and-examples/common-setup-examples/using-ngrok-+-oauth-for-private-tunnels)
- [Ngrok Secrets: Securely Share Localhost — OutrightCRM](https://www.outrightcrm.com/blog/ngrok-securely-share-localhost/)
- [ngrok pricing page](https://ngrok.com/pricing)

---

## Research Gaps & Limitations

- **Heartbeat configuration in JavaScript SDK**: The `@ngrok/ngrok` SDK documentation does not explicitly expose `heartbeat_interval` or `heartbeat_tolerance` options in `ngrok.forward()`. These are available via the `SessionBuilder` Go SDK but their JavaScript equivalents could not be confirmed from docs alone — check `@ngrok/ngrok` TypeScript types directly.
- **Traffic Policy cost**: It's unclear whether all Traffic Policy actions (rate-limit, jwt-validate) require the paid `traffic-policy` add-on or if some are included in paid base plans. Verify at ngrok.com/features/traffic-policy before committing to rate limiting as a feature.
- **Free tier static domain stability**: The free static dev domain docs say it "cannot be customized" but do not explicitly state whether it changes when the account is recreated. Assumed stable for the account lifetime.
- **Multi-leg connections in JavaScript SDK**: The `WithMultiLeg()` resilience feature is documented in the Go SDK but not confirmed available in `@ngrok/ngrok`.

---

## Contradictions & Disputes

- **Basic auth free vs. paid**: The original `ngrok-research.md` correctly notes basic auth is paid-only. Some community blog posts (pre-2024) suggest basic auth was free on older versions — this is outdated.
- **Rate limiting approach**: For the free tier, application-level rate limiting (express-rate-limit) is the only option. Setting `trust proxy: 1` is essential and easy to miss — many community examples omit it.
- **Tunnel URL stability after reconnect**: Community reports conflict on whether a reconnected tunnel preserves the URL. The official SDK docs confirm the URL is preserved when using a static/reserved domain. Random URLs change on each tunnel start (not on reconnect).

---

## Prior Research to Cross-Reference

- `research/ngrok-research.md` — SDK API basics (archived, superseded by this report for security/auth)
- `research/20260217_tunnel_toggle_ux_research.md` — Toggle UX, QR code, state machine patterns (still active and complementary)

---

## Search Methodology

- Searches performed: 12
- Most productive terms: `ngrok security best practices expose local server 2025`, `ngrok OAuth OIDC authentication Node.js Express integration`, `ngrok custom domain configuration reserved domain paid plan`, `ngrok reconnection strategy Node.js SDK disconnect event handler`, `ngrok rate limiting abuse prevention traffic policy 2025`, `Expo Vercel tunnel development URL sharing UX patterns developer tools`
- Primary information sources: ngrok.com official docs, ngrok blog, ngrok GitHub (ngrok-javascript), deepwiki.com (ngrok-go SDK analysis), expo.dev docs, vercel.com academy
