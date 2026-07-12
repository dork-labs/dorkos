---
id: 260712-005315
title: Packaged desktop renderer is served by the bundled server over localhost
status: accepted
created: 2026-07-12
spec: null
superseded-by: null
---

# 260712-005315. Packaged desktop renderer is served by the bundled server over localhost

## Status

Accepted

## Context

The packaged Electron app originally loaded its UI with `loadFile` (`file://`).
A `file://` page sends the literal header `Origin: null` on every API request,
and the server's CORS allowlist rejects it — so even a correctly packaged app
had a UI that could not reach its own server. Working around that would mean
carving a `null`-origin exception into CORS (unsafe: every `file://` page on
the machine shares that origin) or registering a custom privileged `app://`
scheme (a second serving path to maintain). Meanwhile the server already
serves the built client SPA in production via `express.static`, with a
`CLIENT_DIST_PATH` override, and the desktop's crash-restart handler already
reloaded windows from `http://localhost:<port>`.

## Decision

In packaged builds, the main window loads `http://localhost:<serverPort>` —
the bundled server's own origin — instead of a `file://` renderer. The server
child receives `CLIENT_DIST_PATH` pointing at the asar-unpacked renderer
assets, so one origin serves both the SPA and the API. Dev mode is unchanged
(`ELECTRON_RENDERER_URL` from electron-vite, with `DORKOS_CORS_ORIGIN`
whitelisting it). The `will-navigate` guard treats the server origin as the
app's own origin; all other origins open externally.

## Consequences

### Positive

- API calls are same-origin: no CORS carve-outs, no `Origin: null` handling,
  and cookie-based auth (Better Auth) works exactly as it does in the web
  cockpit served by the npm CLI.
- One serving path for prod: the desktop app exercises the same
  `express.static` code the CLI cockpit uses, instead of a desktop-only
  `file://` variant.
- The `will-navigate` security guard reduces to an origin comparison instead
  of filesystem-path prefix checks against the renderer directory.

### Negative

- The window cannot render before the server child is up; server-start
  failures must be surfaced loudly (error dialog + quit) since there is no
  UI to fall back to.
- Renderer assets must live outside the asar (`asarUnpack: dist/renderer`)
  because `express.static` cannot reliably stream from inside an archive —
  a slightly larger unpacked footprint.
- Anything on the machine can fetch `http://localhost:<port>` while the app
  runs — unchanged from the npm CLI cockpit's posture, but the desktop app
  no longer has the (illusory) isolation of `file://`.
