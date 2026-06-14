---
number: 196
title: Use cookie-session for Tunnel Passcode Sessions
status: draft
created: 2026-03-24
spec: remote-passcode
superseded-by: null
---

# 196. Use cookie-session for Tunnel Passcode Sessions

## Status

Draft (auto-extracted from spec: remote-passcode)

## Context

The Remote Access Passcode feature needs session management to remember authenticated tunnel users for 24 hours. DorkOS has no database-backed session store, no `express-session` middleware, and no `cookie-parser`. The server is single-user and must survive restarts without losing session state. Three approaches were evaluated: `express-session` with MemoryStore, `cookie-session` (client-side signed cookies), and raw `Set-Cookie` headers.

## Decision

Use `cookie-session` with a 24-hour rolling `maxAge`, signed with an auto-generated secret persisted to `~/.dork/config.json`. Cookie flags: `httpOnly`, `secure`, `sameSite: strict`.

## Consequences

### Positive

- No server-side session store needed — state lives entirely in the signed cookie
- Survives server restarts (cookie is client-held, secret is persisted to config)
- Lightweight dependency (~3KB, no native code)
- `secure: true` is safe because ngrok always terminates TLS
- `sameSite: strict` provides CSRF protection without additional middleware

### Negative

- Session payload is visible to the client (though signed, not secret — only contains `tunnelAuthenticated: true`)
- Cannot invalidate individual sessions server-side (changing the secret invalidates all sessions)
- Rolling `maxAge` resets on every request, so truly inactive sessions must expire naturally
