---
number: 1
title: Use Hexagonal Architecture with Transport Interface
status: accepted
created: 2026-02-06
spec: claude-code-webui-api
superseded-by: null
---

# 0001. Use Hexagonal Architecture with Transport Interface

## Status

Accepted

(2026-08-06 audit) Still governing; the Transport interface has grown far past the 9 methods described here — see ADR-0258's capability-gated sub-interfaces.

## Context

DorkOS needs to run as both a standalone web app (React SPA + Express server) and an embedded Obsidian plugin. The Obsidian plugin runs inside Electron and cannot make HTTP requests to localhost, so the client needs a communication layer that works in both environments without duplicating the React UI or business logic.

## Decision

We will use a hexagonal (ports & adapters) architecture with a `Transport` interface as the central abstraction. The interface defines 9 methods covering all client-server communication. Two adapters implement it: `HttpTransport` for standalone mode (REST/SSE over Express) and `DirectTransport` for Obsidian mode (in-process function calls). Transport is injected via React Context (`TransportProvider`), making the adapter pluggable at the app root.

## Consequences

### Positive

- Same React codebase runs standalone and embedded without modification
- Mock Transport objects enable isolated component testing without a server
- Future clients (mobile app, Slack bot) only need a new Transport adapter
- Clean separation between UI and infrastructure concerns

### Negative

- Every new API endpoint requires updating the Transport interface and both adapters
- Callback-based streaming (`onEvent`) is less intuitive than async generators
- Obsidian's Electron runtime required 4 custom Vite build plugins to patch compatibility issues
