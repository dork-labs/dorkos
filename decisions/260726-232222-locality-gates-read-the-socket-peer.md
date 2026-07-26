---
id: 260726-232222
title: A local-only gate reads the socket peer; Host answers a different question
status: accepted
created: 2026-07-26
spec: null
superseded-by: null
---

# 260726-232222. A local-only gate reads the socket peer; `Host` answers a different question

## Status

Accepted (2026-07-26, DOR-532, PR #503).

## Context

`/api/runtimes/*` provisions runtimes and holds credentials: it runs Homebrew and
winget installs, pulls Ollama models, accepts provider API keys, and drives the
OpenRouter OAuth exchange. All thirteen of its handlers gate on one question — is
this caller a person at this machine?

They originally answered it with `req.hostname`. `app.ts:106` sets
`trust proxy: 1`, which makes Express prefer `X-Forwarded-Host` from the first hop —
and on a direct connection the first hop **is** the caller. Reproduced against
Express 5 with a raw socket: `Host: dorkos.example.com` plus
`X-Forwarded-Host: localhost` yields `req.hostname === 'localhost'`.

The first fix swapped the read to `req.headers.host`, the unforwarded header.
**That was still wrong, and it shipped.** A raw socket from another machine on the
LAN, sending `Host: localhost`, got `200` and would have run a package install on the
operator's machine. Removing the forwarding bug did not make the header a locality
signal, because it never was one.

## Decision

A local-only gate requires **both** the TCP peer and the `Host` header.
`isLocalRequest` (`lib/trusted-origins.ts:150`) returns true only when
`isLoopbackPeer(req.socket.remoteAddress)` and
`isLoopbackHostHeader(req.headers.host)` both hold. Every handler in
`routes/runtimes.ts` goes through it — nine via `rejectNonLoopback`
(`runtimes.ts:104`), four checking `isLocalCaller` (`runtimes.ts:95`) inline because
they answer with SSE or HTML rather than JSON.

**The distinction, stated so it cannot be misread:**

- **`Host` says which name the caller asked for.** A browser writes it from the
  address bar and cannot lie about it, which makes it the right signal against DNS
  rebinding — that is the `/api` host guard's job (ADR 260726-232221). It is **not**
  a locality proof: a non-browser caller writes `Host` as freely as any other header.
- **The socket peer says where the other end of the connection is.** It comes from
  the TCP layer, not from the request, so no caller can write it. It is the only
  locality proof available. It is **not** a rebinding defence: under rebinding the
  peer genuinely _is_ `127.0.0.1`, because the request comes from the user's own
  browser.

Different threats, different signals, and neither substitutes for the other. `Host`
alone admits the remote caller. The peer alone admits the rebound browser. A live
ngrok tunnel is the clearest case for needing both: the tunnel agent runs on this
machine, so the peer really is loopback, and only the `Host` check — which sees the
public tunnel domain — turns that traffic away.

**Never derive locality from anything `trust proxy` touches.** `req.ip` is computed
from `X-Forwarded-For` and `req.hostname` from `X-Forwarded-Host`; on a direct
connection both are written by the attacker. Pass the raw `req.socket.remoteAddress`
and `req.headers.host`. `isLoopbackPeer` (`trusted-origins.ts:106`) handles the
shapes Node reports: the whole `127.0.0.0/8` block, `::1`, the `::ffff:127.0.0.1`
v4-mapped form a dual-stack listener reports, and a trailing `%zone` index.

## Consequences

### Positive

- The gate now holds against both callers it must exclude, and the reasoning lives at
  the definition (`trusted-origins.ts:56`–`116`) rather than at thirteen call sites.
- The two guards compose cleanly and neither duplicates the other: the `/api` host
  guard answers browser rebinding at the app edge, this gate answers the non-browser
  caller at the route.
- `isLocalRequest` is pure and takes resolved facts, so the flag branch is testable
  without mutating the shared `env` singleton for the length of a test.
- Every one of the nine `rejectNonLoopback` routes has a parametrized test using a
  non-loopback peer with a loopback `Host` — the shape that isolates this gate from
  the app-edge one. Mutation-tested: forcing `isLocalRequest` to `true` fails all
  nine, where the previous suite stayed green.

### Negative

- **A reverse proxy on the same host is inherently indistinguishable from a real
  local caller.** It connects from `127.0.0.1`, and at the socket layer there is
  nothing left to tell them apart. Pairing with `Host` narrows it — such a proxy
  normally forwards its own public name — but an operator who rewrites `Host` to
  `localhost` re-opens it. Exposed deployments must require a login, which gates
  these routes independently.
- `DORKOS_ALLOW_INSECURE_BIND` short-circuits both signals
  (`trusted-origins.ts:151`). Deliberate: inside a container the browser's request
  arrives from the bridge gateway, never from loopback, so requiring a loopback peer
  would refuse runtime provisioning for every Docker operator. Anyone who can reach a
  published DorkOS port can already run agent turns and open shells, so refusing here
  shrinks no blast radius. It is still a fourth meaning on an already overloaded flag
  (see ADR 260726-232221).
- The gate is per-handler, not middleware. A new route under `/api/runtimes/*` that
  forgets to call it is silently open, and nothing structural prevents that.

### Alternatives considered

- **`req.hostname`.** Rejected: `trust proxy: 1` lets a client-supplied
  `X-Forwarded-Host` control it. This is what shipped first and what the raw-socket
  reproduction broke.
- **`req.headers.host` alone.** Rejected: it fixes the forwarding bug and leaves the
  vulnerability. A non-browser caller from any host writes `Host: localhost` and
  passes. This is what the first fix shipped.
- **`req.ip`.** Rejected, and it is the trap worth naming: it looks like a socket-level
  fact and is not. `trust proxy` derives it from `X-Forwarded-For`, so the caller
  chooses it. Only `req.socket.remoteAddress` is the peer.
- **The socket peer alone.** Rejected: it admits a DNS-rebound browser, whose peer
  genuinely is `127.0.0.1`, and it admits tunnel traffic, whose peer is the local
  ngrok agent.
