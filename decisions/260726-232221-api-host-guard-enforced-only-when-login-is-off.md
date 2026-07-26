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

The same defence had existed for `/mcp` since 2026-03-09 — `validateMcpOrigin`
(`middleware/mcp-origin.ts:15`) rejects any browser `Origin` outside the
loopback-plus-tunnel allowlist — and was never generalized to the REST API, which is
the larger and more dangerous surface.

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
changes: a login-off instance behind a proxy. The 403 body names the variable so the
operator reads the fix once and is done, and never lists the allowlist back.

## Consequences

### Positive

- The rebinding path to agent execution is closed on the default configuration,
  with no configuration required: a normal local install reaches DorkOS on
  `localhost` or `127.0.0.1`, which already pass.
- Login-on deployments are untouched — any host name, no new variable, no upgrade
  note. The same is true of Docker, which sets `DORKOS_ALLOW_INSECURE_BIND`.
- The CORS same-origin fallback can stay. Port remapping keeps working, and the
  `Host` check is what makes that fallback safe rather than a hole.
- One origin policy. `isLoopbackHost` moved out of
  `services/core/auth/exposure-guard.ts` into `lib/trusted-origins.ts:31`, so the
  bind check, the CORS allowlist, the `Host` allowlist, and Better Auth's
  `trustedOrigins` all read a single definition of "names that mean this machine".

### Negative

- **A real, documented behavior change for one configuration.** A login-off instance
  reached through a reverse proxy 403s every API call after upgrading until
  `DORKOS_TRUSTED_HOSTS` names its domain. Documented in
  `docs/self-hosting/reverse-proxy.mdx` and
  `docs/self-hosting/securing-your-instance.mdx`, but it still surfaces at runtime
  rather than at start-up.
- The defence is conditional, which quietly makes cookie scoping load-bearing. If
  `sessionGate` or the cookie's origin scoping ever changes, this guard will not
  catch the fall, because it is inert precisely where login is on. Anyone touching
  either must re-read this ADR.
- Coverage stops at `/api`. `/mcp`, `/a2a`, and the terminal WebSocket keep their own
  origin checks; a new top-level surface is unprotected until it opts in.
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
