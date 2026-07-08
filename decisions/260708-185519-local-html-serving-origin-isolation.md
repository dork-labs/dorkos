---
id: 260708-185519
title: Local-HTML serving and localhost proxy render in an opaque-origin sandbox, not allow-same-origin
status: draft
created: 2026-07-08
spec: right-panel-workbench
superseded-by: null
---

# 260708-185519. Local-HTML serving and localhost proxy render in an opaque-origin sandbox, not allow-same-origin

## Status

Draft (auto-extracted from spec: right-panel-workbench)

## Context

Closing DOR-98, the workbench's embedded browser needs to render local HTML files and localhost dev servers inline. That content is untrusted by construction — it can be arbitrary project files or content an agent fetched from the internet — a different threat model from `mcp-apps`' server-fetched, trusted app HTML (`lib/sandbox.ts`). If served content shared the cockpit's own origin or credentials, a malicious local HTML file could call `/api/*` as the logged-in user.

## Decision

Serve local HTML from a session-cwd-scoped static route (`GET /api/workbench/serve/:token/*`), authenticated by short-lived signed URLs rather than the API's own cookie/header auth, so relative assets resolve from the confined cwd. A companion reverse-proxy route (`/api/workbench/proxy/:port/*` → `http://localhost:<port>`, `localhost`-only, no arbitrary-host SSRF) strips `X-Frame-Options`/`frame-ancestors` for dev-server preview. Both render in a `sandbox="allow-scripts"` iframe **without** `allow-same-origin` — an opaque origin — mirroring the `mcp-apps/lib/sandbox.ts` posture, applied to a different (untrusted-content) threat model (spec D6).

## Consequences

### Positive

- A malicious or compromised local HTML file or dev-server page can never ride the user's session into `/api/*`: the sandboxed iframe has no origin to steal credentials with, and the signed URL is scoped to the session cwd and short-lived.
- The proxy is host-pinned to `localhost`, closing off SSRF to arbitrary hosts, and reuses the same `validateBoundary` confinement already proven for file routes.

### Negative

- Opaque origin means served pages can't rely on same-origin behavior (cookies, localStorage, some `postMessage` patterns) the way opening the URL directly in a browser tab would — some dev-server previews will behave differently than the operator expects.
- Signed-URL expiry adds an operational edge case (expired/forged token handling, path confinement) that must be explicitly tested, not just documented.
