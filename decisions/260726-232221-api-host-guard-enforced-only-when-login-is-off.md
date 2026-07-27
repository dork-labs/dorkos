---
id: 260726-232221
title: The /api Host guard is enforced only when login is off
status: accepted
created: 2026-07-26
spec: null
superseded-by: null
---

# 260726-232221. The `/api` Host guard is enforced only when login is off

## Status

Accepted (2026-07-26, DOR-532, PR #503).

## Context

DorkOS answers `/api` behind a per-request CORS delegate (`apps/server/src/app.ts:81`).
That delegate allows two things a DNS-rebinding attacker gets for free: any request
carrying no `Origin` at all (`app.ts:86`), and any request whose `Origin` equals
`${req.protocol}://${req.headers.host}` (`app.ts:93`) — a same-origin fallback added
so host-port remapping (`docker run -p 4300:4242`, an `ssh -L` forward, a reverse
proxy) does not blank the cockpit.

Under DNS rebinding both branches pass. A page served from `http://evil.com:4242`
that re-resolves `evil.com` to `127.0.0.1` is same-origin from the browser's point of
view: it sends no preflight, may post `application/json` freely, and satisfies the
no-`Origin` branch and the same-origin branch alike. Login is optional and off by
default (ADR-0320), so nothing else stood between that page and
`POST /api/sessions/:id/messages` (`routes/sessions.ts:368`), which creates the
session on first write and starts an agent turn in a working directory the caller
chose. That is remote code execution triggered by visiting a web page.

A sibling defence on a different header had existed for `/mcp` since 2026-03-09 —
`validateMcpOrigin` (`middleware/mcp-origin.ts:15`) rejects any browser `Origin`
outside the loopback-plus-tunnel allowlist — and was never generalized to the REST
API, the larger and more dangerous surface.

## Decision

`hostGuard` (`middleware/host-guard.ts:129`) is mounted at `/api` (`app.ts:127`),
ahead of `express.json` (`app.ts:148`) and ahead of the Better Auth handler, so a
rejected request is answered before its body is ever parsed and `/api/auth/*` is
covered too. A request passes when its `Host` names loopback, a name listed in the
new `DORKOS_TRUSTED_HOSTS`, or the live tunnel host (`isHostAllowed`,
`host-guard.ts:86`); anything else gets a 403 with the stable code
`HOST_NOT_ALLOWED`. `Host` is read raw (`req.headers.host`), never through
`req.hostname` — see ADR 260726-232222 for why that getter is attacker-controlled.

Matching is on the host **name** only, never the port. The Vite dev proxy, `ssh -L`
forwards, and `docker run -p 4300:4242` all legitimately carry a port this process
never listened on. A port is not a security boundary; the name is.

**The guard is enforced exactly where the vulnerability exists, and nowhere else.**
It skips entirely when `config.auth.enabled === true` (`host-guard.ts:133`) and when
`DORKOS_ALLOW_INSECURE_BIND` is set (`host-guard.ts:139`); both flags are read per
request, so turning login on takes effect without a restart. The login-off scoping is
the load-bearing choice: Better Auth cookies are scoped to the real origin, so a
rebound origin carries no cookie and `sessionGate` (`app.ts:156`) already turns it
away. A login-on instance gains nothing from a `Host` allowlist and would lose a
great deal — every reverse-proxy self-host binds loopback and forwards its own public
`Host`, so unconditional enforcement would 403 all of them on upgrade.

`DORKOS_TRUSTED_HOSTS` is the escape hatch for the one configuration that genuinely
changes: a login-off instance behind a proxy. The 403 body names the variable, and
never lists the allowlist back.

## Consequences

### Positive

- The rebinding path to agent execution is closed on the default configuration and
  costs nobody any setup: a normal local install arrives on `localhost` or
  `127.0.0.1`, which already pass. Login-on deployments and Docker are untouched.
- The CORS same-origin fallback can stay. Port remapping keeps working, and the
  `Host` check is what makes that fallback safe rather than a hole.
- Network trust moved into one module: `isLoopbackHost` left
  `services/core/auth/exposure-guard.ts` for `lib/trusted-origins.ts:31`, so the bind
  check and the `Host` allowlist share one definition of "names that mean this
  machine". One module, but still **two lists** — `getStaticLocalOrigins` (`:160`)
  hardcodes `localhost` and `127.0.0.1` without consulting `isLoopbackHost`, so
  `Host: [::1]` passes `hostGuard` while `Origin: http://[::1]:4242` is not a trusted
  origin. Reconciling them is filed separately; this ADR does not claim they agree.

### Negative

- **A real, documented behavior change for one configuration.** A login-off instance
  reached through a reverse proxy 403s every API call after upgrading until
  `DORKOS_TRUSTED_HOSTS` names its domain. Documented in
  `docs/self-hosting/reverse-proxy.mdx` and
  `docs/self-hosting/securing-your-instance.mdx`, but it still surfaces at runtime
  rather than at start-up.
- The defence is conditional, which quietly makes cookie scoping load-bearing: if
  `sessionGate` or the cookie's origin scoping ever changes, this guard will not
  catch the fall, because it is inert precisely where login is on.
- Coverage stops at `/api`, and the surfaces outside it are not defended alike.
  `/mcp` has an `Origin` check (`validateMcpOrigin`, mounted at `index.ts:1114` and
  `:1144`) and the terminal WebSocket has its own; `/a2a` has **no** origin check —
  it is gated by a bearer-token credential (`createMcpAuth({ surface: 'a2a' })`,
  `index.ts:1461`) plus `checkA2aExposure` at mount time. Different defences, so
  "is this surface rebinding-protected?" must be asked per surface, and a new
  top-level surface gets nothing until it opts in.
- `DORKOS_ALLOW_INSECURE_BIND` now carries **four** meanings, all of them
  relaxations: (1) a non-loopback bind without a login (`checkBindAllowed`,
  `exposure-guard.ts:153`); (2) mounting the A2A gateway unauthenticated on a
  non-loopback host (`checkA2aExposure`, `exposure-guard.ts:229`); (3) switching off
  this `/api` host guard; (4) switching off the request-level locality gate on the
  runtime routes (ADR 260726-232222). An operator sets it for one reason and receives
  the other three. `contributing/environment-variables.md` enumerates all four and
  must stay exhaustive — and a fifth meaning is a reason to split the flag, not to
  extend the list.

### Alternatives considered

- **Enforce the `Host` allowlist unconditionally.** Rejected: it breaks every
  reverse-proxy self-host on upgrade, because those instances bind loopback and
  forward a public `Host` that DorkOS has no way to learn. That would force new
  configuration on operators who are not vulnerable, since their login already
  defeats the attack.
- **Tighten CORS instead.** Rejected: a rebound request _is_ same-origin, so no CORS
  policy can see it. The no-`Origin` branch must also stay — non-browser clients
  (curl, the CLI, server-to-server callers) send none — and dropping the same-origin
  branch re-breaks port remapping (`app.ts:51`).
- **Require login always.** Rejected: it contradicts ADR-0320's zero-config local
  start, which is a core product value, to fix a browser-only attack that a
  cheaper check closes.
