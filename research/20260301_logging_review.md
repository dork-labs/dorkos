---
title: 'DorkOS Logging System Code Review'
date: 2026-03-01
type: internal-architecture
status: active
tags: [logging, code-review, analysis, logger, structured-logs]
feature_slug: logging-infrastructure
---

# DorkOS Logging System Code Review

**Date:** 2026-03-01
**Scope:** All packages — server, client, CLI, relay, mesh, shared
**Verdict:** Solid foundation in server; significant gaps in packages and client

---

## Executive Summary

The server has a well-designed centralized logger (`consola` + NDJSON file reporter at `~/.dork/logs/dorkos.log`) with rotation, level control, and good test coverage. However, the **relay**, **mesh**, and **CLI** packages bypass it entirely with raw `console.*` calls, creating a split logging world where runtime diagnostics from packages never reach the log file. The client has virtually no logging infrastructure and a `verboseLogging` setting that does nothing.

---

## 1. What Works Well

### Server Logger (`apps/server/src/lib/logger.ts`)

- **Centralized module** — single `createConsola()` instance, imported by 19 source files
- **NDJSON file persistence** — structured, machine-parseable log entries to `~/.dork/logs/dorkos.log`
- **Automatic rotation** — 10MB threshold, retain 7 rotated files, silent failure on IO errors
- **Level configuration** — `DORKOS_LOG_LEVEL` env var (0-5), CLI `--log-level` flag, config file fallback
- **Privacy-conscious** — `request-logger.ts` explicitly never logs `req.body` or headers
- **Good test coverage** — 266 lines covering init, NDJSON format, rotation, error resilience, mock patterns
- **Consistent tag pattern** — `logger.info('[Feature] message')` used across index.ts, routes, and services

### Structured Error Context

- Error handler middleware logs `err.message` + `err.stack` — full context for debugging
- Scheduler service logs operation names alongside errors for traceability
- Agent routes log structured `{ err }` objects

---

## 2. Critical Issues

### I1. Packages Use Raw `console.*` — Logs Never Reach Disk

**Severity: HIGH** — These are runtime services whose diagnostics are lost.

| Package         | Files   | `console.*` Calls                          | Impact                                                     |
| --------------- | ------- | ------------------------------------------ | ---------------------------------------------------------- |
| `@dorkos/relay` | 4 files | 7 `console.warn` calls                     | Adapter failures, plugin load errors invisible in log file |
| `@dorkos/mesh`  | 2 files | 2 calls (`console.warn` + `console.error`) | Discovery errors, reconciliation failures invisible        |
| `packages/cli`  | 4 files | ~40 calls                                  | CLI output (acceptable — user-facing)                      |

**Specific locations:**

- `relay/src/adapter-registry.ts:72,159` — adapter shutdown failures
- `relay/src/adapter-plugin-loader.ts:95,148,153` — plugin load errors
- `relay/src/adapters/claude-code-adapter.ts:311` — missing replyTo warning
- `mesh/src/discovery-engine.ts:168` — directory read errors during discovery
- `mesh/src/mesh-core.ts:582` — periodic reconciliation failures

**Root cause:** Relay and Mesh are standalone packages (`packages/relay`, `packages/mesh`) that can't import the server's `lib/logger.ts`. They default to `console` because no logger injection mechanism exists.

**Note:** `adapter-delivery.ts` already has the right pattern — it accepts a `Logger` interface via constructor injection. But only 1 of ~6 classes in the relay package uses this pattern.

### I2. Client `verboseLogging` Setting Is a No-Op

**Severity: MEDIUM** — Users toggle it expecting behavior; nothing happens.

- Defined in `app-store.ts` (persisted to localStorage as `'dorkos-verbose-logging'`)
- Exposed in Settings Dialog > Preferences
- **Zero call sites** read `verboseLogging` to conditionally log anything
- Only 4 `console.*` calls exist in the entire client, none gated by this flag

### I3. No Error Boundary in Client

**Severity: MEDIUM** — Unhandled React errors crash the app with a blank screen.

- Zero `<ErrorBoundary>` components in the codebase
- No error reporting service (Sentry, etc.)
- All error handling is per-component/per-hook — nothing catches the unexpected

---

## 3. Inconsistencies

### I4. Mixed Tag Formats

The server logger uses `[Feature]` prefixes, but the format varies:

| Pattern                | Example                                 | Files                   |
| ---------------------- | --------------------------------------- | ----------------------- |
| `[Feature]` (brackets) | `logger.info('[Pulse] Routes mounted')` | index.ts, most services |
| `Feature:` (colon)     | `logger.info('Pulse: started with...')` | scheduler-service.ts    |
| `[Feature] operation`  | `logger.error('[DorkOS Error]', ...)`   | error-handler.ts        |
| `Class:`               | `logger.warn('BindingRouter: ...')`     | binding-router.ts       |
| No prefix              | `logger.info('Shutting down...')`       | index.ts                |

**Not severe** — but makes grep/filtering harder.

### I5. Inconsistent Error Object Passing

| Pattern          | Example                                                  | Problem                                                |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `{ err }`        | `logger.error('[agents] GET /current failed', { err })`  | `err` is full Error object — serializes poorly to JSON |
| `{ error: msg }` | `logger.error('[Pulse] Failed to init', { error: msg })` | Only message string — loses stack trace                |
| Positional args  | `logger.error('[DorkOS Error]', err.message, err.stack)` | Stack as separate arg — OK but inconsistent            |
| Direct error     | `logger.warn('...:', err)`                               | Whole Error object as string arg                       |

The NDJSON file reporter flattens the first object arg into the JSON entry, so `{ err }` puts a serialized Error (with all its properties) into the log. This works but the shape varies across call sites.

### I6. File Reporter Only Captures First Object Arg

In `createFileReporter()`, the loop assigns `context` to the **last** object argument found. If a log call passes multiple objects, only the last one is captured. This is fine in practice (most calls pass 0-1 objects) but is a subtle data loss risk.

---

## 4. Missing Capabilities

### I7. No Request Correlation / Trace IDs

- No `requestId` or `traceId` attached to log entries
- When debugging "why did this request fail?", you have to match timestamps manually
- The Relay system has `traceStore` for message tracing, but HTTP request logging doesn't participate

### I8. No Log Tail / View in UI

- Logs go to `~/.dork/logs/dorkos.log` but there's no way to view them from the DorkOS UI
- Users must SSH or `tail -f` the log file manually
- For a tool designed for AI agent operators, log observability would be valuable

### I9. No Startup Summary Log

- Individual `[Feature] initialized` messages are logged, but there's no single structured entry summarizing the full server configuration (port, enabled features, boundary, log level, version)
- Makes it harder to correlate "what was running" when reviewing historical logs

### I10. Mesh Package Has No Logger Injection

- `mesh-core.ts:582` uses `console.error` for periodic reconciliation failures
- `discovery-engine.ts:168` uses `console.warn` for directory read errors
- Unlike relay's `adapter-delivery.ts`, mesh has no `Logger` interface pattern at all

---

## 5. Code Organization Assessment

### Strengths

- Logger is a clean, focused 99-line module — well under the 300-line limit
- Single responsibility: init, file reporter, rotation
- Proper TSDoc on the module and `initLogger()`
- Test file is comprehensive and well-structured
- `request-logger.ts` middleware is minimal and privacy-aware

### DRY Assessment

- **Logger import is consistent** — all 19 server files use `import { logger } from '../lib/logger.js'`
- **No duplicated logging utilities** — single module, no parallel implementations
- **CLI console calls are appropriate** — CLI is user-facing terminal output, not structured logging

### File Organization

- `lib/logger.ts` — appropriate location for cross-cutting infrastructure
- `middleware/request-logger.ts` — appropriate separation of HTTP logging concern
- `middleware/error-handler.ts` — appropriate separation of error logging concern

---

## 6. Security Review

- **No sensitive data in logs** — request logger explicitly skips body and headers
- **No PII logging** — no user messages, auth tokens, or session content logged
- **Log file permissions** — uses default filesystem permissions (could be tightened)
- **Error handler** — hides error details in production responses but logs full stack server-side

---

## 7. Improvement Plan

### Priority 1: Package Logger Injection (HIGH)

**Goal:** Route relay/mesh `console.*` calls through a shared logger interface so they appear in `~/.dork/logs/dorkos.log`.

1. Extract a `Logger` interface to `@dorkos/shared` (extending the pattern from `adapter-delivery.ts`):
   ```typescript
   export interface Logger {
     info: (...args: unknown[]) => void;
     warn: (...args: unknown[]) => void;
     error: (...args: unknown[]) => void;
     debug: (...args: unknown[]) => void;
   }
   ```
2. Add `logger` as a constructor/factory parameter to `RelayCore`, `AdapterRegistry`, `AdapterPluginLoader`, `MeshCore`, `DiscoveryEngine`
3. Default to `console` (preserving standalone usage) but inject the server's consola logger when instantiated from `index.ts`
4. Remove direct `console.warn/error` calls from package source files

**Estimated scope:** ~6 files modified in relay, ~2 in mesh, 1 in shared, 1 in server index.ts

### Priority 2: Standardize Log Format (MEDIUM)

1. Adopt a single tag format: `[Module]` with brackets everywhere
2. Standardize error context to `{ error: err instanceof Error ? err.message : String(err), stack: err?.stack }`
3. Create a small helper: `function logError(err: unknown): { error: string; stack?: string }` in logger.ts
4. Update ~15 call sites to use consistent format

### Priority 3: Fix Client `verboseLogging` (MEDIUM)

Two options:

- **Option A:** Implement it — gate debug-level `console.debug()` calls behind the flag in key hooks (`useChatSession`, `useRelayEventStream`, transport layer)
- **Option B:** Remove it — delete the setting, the localStorage key, and the Settings UI toggle

Recommendation: **Option A** — it's useful for debugging SSE/Relay issues.

### Priority 4: Add React Error Boundary (MEDIUM)

1. Add a top-level `<ErrorBoundary>` component in `App.tsx`
2. Show a friendly "Something went wrong" UI with a reload button
3. Log the error to `console.error` (and optionally POST to server for aggregation)

### Priority 5: Add Request Correlation IDs (LOW)

1. Generate a `requestId` (nanoid) in request-logger middleware
2. Attach to `req` object and include in all log entries for that request
3. Return as `X-Request-Id` header for client-side correlation

### Priority 6: Startup Summary Log (LOW)

Add a single structured log entry after all initialization:

```typescript
logger.info('[Startup] Server ready', {
  port: PORT,
  version: env.DORKOS_VERSION,
  logLevel,
  features: { pulse: pulseEnabled, relay: relayEnabled, mesh: meshEnabled },
  boundary: resolvedBoundary,
  dorkHome,
});
```

### Priority 7: Log Viewer (FUTURE)

- Add a `/api/logs` endpoint that streams/paginates from `dorkos.log`
- Add a Logs panel in the client UI (similar to how Pulse/Relay panels exist)
- Support filtering by level, tag, and time range

---

## 8. Summary Matrix

| Area                 | Grade  | Notes                                                           |
| -------------------- | ------ | --------------------------------------------------------------- |
| Server logger module | **A**  | Clean, tested, NDJSON + rotation                                |
| Server log usage     | **B+** | Consistent imports, good coverage, minor format inconsistencies |
| Package logging      | **D**  | Raw `console.*`, no file persistence, no injection              |
| Client logging       | **D**  | Virtually none, broken `verboseLogging` flag, no error boundary |
| CLI logging          | **B**  | Appropriate for terminal tool — `console.*` is correct here     |
| Security             | **A**  | No PII, no body/header logging, prod error hiding               |
| DRYness              | **A-** | Single logger module, no duplication                            |
| Test coverage        | **A**  | Logger tests + middleware tests comprehensive                   |
| Observability        | **C**  | No request IDs, no UI log viewer, no startup summary            |
