---
id: 260708-185519
title: Local-HTML serving and localhost proxy render in an opaque-origin sandbox, not allow-same-origin
status: accepted
created: 2026-07-08
spec: right-panel-workbench
superseded-by: null
---

# 260708-185519. Local-HTML serving and localhost proxy render in an opaque-origin sandbox, not allow-same-origin

## Status

Accepted

## Context

Closing DOR-98, the workbench's embedded browser needs to render local HTML files and localhost dev servers inline. That content is untrusted by construction — it can be arbitrary project files or content an agent fetched from the internet — a different threat model from `mcp-apps`' server-fetched, trusted app HTML (`lib/sandbox.ts`). If served content shared the cockpit's own origin or credentials, a malicious local HTML file could call `/api/*` as the logged-in user.

## Decision

Serve local HTML from a boundary-confined static route (`GET /api/workbench/serve/:token/*`). The token is minted by an auth-gated `POST /api/workbench/sign` and carries the working directory to serve from; that directory is the client-supplied `cwd`, validated against the **global directory boundary** (`getBoundary()`) — the same confinement the existing authenticated `GET/PUT /api/files/*` routes already grant, not a verified _active-session_ cwd. The serve/proxy content routes are then authorized by the short-lived signed URL rather than the API's cookie/header auth (the opaque-origin frame carries no credentials), and every request is re-confined with `validateBoundary` so relative assets resolve without `..`/symlink escape. A companion reverse-proxy route (`ALL /api/workbench/proxy/:token/*` → `http://127.0.0.1:<port>`, loopback-only, no arbitrary-host SSRF) strips `X-Frame-Options`/`frame-ancestors` for dev-server preview. Both render in a `sandbox="allow-scripts"` iframe **without** `allow-same-origin` — an opaque origin — mirroring the `mcp-apps/lib/sandbox.ts` posture, applied to a different (untrusted-content) threat model (spec D6). Tokens are `no-referrer` and short-lived (30 min, re-minted on reload).

## Consequences

### Positive

- A malicious or compromised local HTML file or dev-server page can never ride the user's session into `/api/*`: the sandboxed iframe has no origin to steal credentials with, and the signed URL is boundary-confined and short-lived.
- The proxy is host-pinned to loopback, closing off SSRF to arbitrary hosts, and reuses the same `validateBoundary` confinement already proven for file routes.

### Negative

- Opaque origin means served pages can't rely on same-origin behavior (cookies, localStorage, some `postMessage` patterns) the way opening the URL directly in a browser tab would — some dev-server previews will behave differently than the operator expects.
- Signed-URL expiry adds an operational edge case (expired/forged token handling, path confinement) that must be explicitly tested, not just documented.
- The serve capability is confined to the global directory boundary, not a verified active-session cwd. This is not an escalation — it is the same boundary-confined, auth-gated reach the existing `/api/files/*` routes already grant an authenticated caller, and served content is opaque-origin so it cannot call `/api/*` — but it is a slightly broader capability than "session-cwd-scoped" would imply.
- The loopback proxy lets an authenticated caller reach any `127.0.0.1:<port>` service (other dev servers, DB admin UIs, even the DorkOS port itself), so when DorkOS is exposed via tunnel it is a residual remote→localhost bridge. Accepted under the single-operator trust model (the operator already has a shell in the same boundary); revisit if multi-user exposure is ever supported.
