---
id: 261005-105212
title: An isolated extension's router is reached by real HTTP carried over the IPC channel, with the person's credentials stripped
status: accepted
created: 2026-10-05
spec: isolated-extension-backends
superseded-by: null
amends: null
---

# 261005-105212. An isolated extension's router is reached by real HTTP carried over the IPC channel, with the person's credentials stripped

## Status

Accepted

## Context

The extension's Express router must stay at `/api/ext/<id>/*` with streaming intact. A Unix socket or named pipe needs a listen permission and a filesystem path and differs on Windows; serializing requests by hand reimplements HTTP badly. A request forwarded as-is would hand the person's session cookie to extension code, and through the tunnel a leaked cookie works from anywhere.

## Decision

The child runs an `http.Server` that never listens; the host proxies each request with `http.request({ createConnection })` over a virtual duplex whose bytes travel as IPC frames, with flow control both ways. Inbound, the host strips cookies, authorization, the MCP token and every `x-dorkos-*` header, and adds a person verdict it computed itself (`ctx.requirePerson` reads it). Outbound, only an allowlist of content and caching headers survives, plus a sandboxing content-security-policy.

## Consequences

### Positive

- Real HTTP/1.1 semantics, server-sent events included; nothing listens; identical on every platform.
- The person's session never reaches extension code.

### Negative

- An extension that read cookies or `Authorization` in-process must use `ctx.requirePerson` when isolated.
- The host re-encodes JSON bodies `express.json` already consumed.
