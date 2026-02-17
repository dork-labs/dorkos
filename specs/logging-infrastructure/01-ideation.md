---
slug: logging-infrastructure
number: 36
created: 2026-02-16
status: ideation
---

# Logging Infrastructure

**Slug:** logging-infrastructure
**Author:** Claude Code
**Date:** 2026-02-16
**Branch:** preflight/logging-infrastructure
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Implement proper logging for DorkOS — replace ad-hoc `console.log/warn/error` calls with a structured logging system that supports log levels, file persistence to `~/.dork/logs/`, and integrates cleanly with the CLI + server architecture.
- **Assumptions:**
  - Logging is server-side primary; client-side logging is limited to error boundaries
  - Logs should persist to `~/.dork/logs/` (co-located with existing `~/.dork/config.json`)
  - The solution must bundle cleanly with esbuild (CLI build pipeline constraint)
  - Performance is not a differentiator — DorkOS is a single-user local tool
  - User-facing CLI output (startup banner, URLs) stays as `console.log`
- **Out of scope:**
  - Cloud log aggregation (Datadog, CloudWatch, etc.)
  - Client-side log shipping to server
  - Distributed tracing / correlation IDs
  - Monitoring dashboards

## 2) Pre-reading Log

- `apps/server/src/index.ts`: Server entry point — 17 console calls, most are startup banner formatting. Startup flow creates Express app, binds port, optionally starts ngrok tunnel.
- `apps/server/src/app.ts`: Express app factory — no logging middleware, registers 7 route groups + error handler.
- `apps/server/src/services/agent-manager.ts`: Heaviest logging (9 calls) — `[sendMessage]`, `[canUseTool]`, `[updateSession]` prefixed debug messages with inline key=value format.
- `apps/server/src/services/session-broadcaster.ts`: 3 console calls — watcher events for JSONL file changes.
- `apps/server/src/services/config-manager.ts`: 2 console.warn calls — corrupt config backup + fresh config creation.
- `apps/server/src/services/command-registry.ts`: 2 calls — command directory scan errors.
- `apps/server/src/middleware/error-handler.ts`: 1 console.error — global Express error handler.
- `packages/cli/src/cli.ts`: 16 calls — startup banner, port display, version output, error messages.
- `packages/cli/src/config-commands.ts`: 20 calls — config subcommand output (intentional user-facing).
- `packages/cli/src/init-wizard.ts`: 4 calls — wizard output.
- `packages/cli/src/check-claude.ts`: 6 calls — Claude CLI detection output.
- `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`: 2 console calls — only client file with logging.
- `packages/shared/src/config-schema.ts`: Config schema — no logging config fields exist yet.

## 3) Codebase Map

**Primary components/modules:**
- `apps/server/src/index.ts` — Server startup, port binding, tunnel init (17 console calls)
- `apps/server/src/app.ts` — Express app factory, route registration, error handler middleware
- `apps/server/src/services/agent-manager.ts` — SDK session management (9 console calls, heaviest logging)
- `apps/server/src/services/session-broadcaster.ts` — SSE file watcher (3 console calls)
- `apps/server/src/services/config-manager.ts` — Config file I/O (2 console.warn calls)
- `apps/server/src/middleware/error-handler.ts` — Global error handler (1 console.error)
- `packages/cli/src/cli.ts` — CLI entry point, startup banner (16 console calls)

**Shared dependencies:**
- `packages/shared/src/config-schema.ts` — Would need `logLevel` field added to UserConfigSchema
- `apps/server/src/lib/boundary.ts` — Existing lib/ directory pattern for shared server utilities
- `packages/cli/src/cli.ts` — Sets env vars and creates `~/.dork/` directory at startup

**Data flow:**
CLI startup → sets env vars → creates `~/.dork/` → imports server → Express binds → services start logging

**Feature flags/config:**
- `LOG_LEVEL` env var (proposed, not yet implemented)
- `~/.dork/config.json` — would add `logLevel` field
- No existing logging config

**Potential blast radius:**
- Direct: 7 server files (replace console.* with logger.*)
- Indirect: 4 CLI files (keep console.log for user output, but route errors through logger)
- New files: 1 (`apps/server/src/lib/logger.ts`)
- Config: 1 schema change (`packages/shared/src/config-schema.ts`)
- Tests: Error handler test mocks console.error — would need updating

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Full research document: `research/20260216_logging_strategy.md`

**Potential solutions:**

**1. Consola + Custom File Reporter (Recommended)**
- Description: Use consola (UnJS ecosystem) for structured logging with pretty dev output, add a ~20-line custom file reporter for NDJSON persistence to `~/.dork/logs/`
- Pros:
  - Bundles cleanly with esbuild (no worker thread complexity like pino)
  - Beautiful built-in fancy reporter for development
  - Auto-switches to plain output in CI/tests
  - ~15KB core bundle via `consola/core` subpath
  - ~5M weekly downloads, active UnJS maintenance
  - Custom reporter pattern is simple and well-documented
- Cons:
  - No built-in file rotation (requires ~20 lines of custom code or a separate package)
  - Less battle-tested in Express contexts than winston
  - Smaller ecosystem than pino/winston
- Complexity: Low
- Maintenance: Low

**2. Winston**
- Description: Use winston with built-in Console + DailyRotateFile transports for a batteries-included solution
- Pros:
  - Built-in file transport with `winston-daily-rotate-file`
  - Most widely known Node.js logger
  - Colorized console + JSON file output in single config
  - TypeScript types bundled since v3
- Cons:
  - ~200KB install size (vs ~15KB for consola)
  - Verbose configuration boilerplate
  - Poor defaults — requires significant setup
  - Slower than pino (irrelevant for our use case)
- Complexity: Medium
- Maintenance: Low

**3. Pino**
- Description: Use pino for high-performance structured JSON logging
- Pros:
  - Industry-standard, 20M+ weekly downloads
  - Fastest Node.js logger (5-10x faster than winston)
  - Excellent `pino-http` Express middleware
  - First-class TypeScript support
- Cons:
  - **esbuild bundling requires worker thread file generation** — needs `esbuild-plugin-pino`, produces 3-4 extra files in `dist/`, requires `globalThis.__bundlerPathsOverrides` injection
  - Pretty-printing requires separate `pino-pretty` dependency
  - Overkill performance for a single-user local tool
- Complexity: High (bundling)
- Maintenance: Medium (extra build pipeline maintenance)

**Recommendation:** Consola + Custom File Reporter

Consola is purpose-built for developer tools: clean esbuild bundling, beautiful dev output out of the box, and the custom file reporter pattern is trivial (~20 lines). The only gap (no built-in log rotation) is easily solved with a startup check that rotates files >10MB and retains the last 7 days.

**Key architectural decisions:**
- **Storage**: `~/.dork/logs/dorkos.log` (co-located with config)
- **Rotation**: Daily, 10MB max, 7-day retention
- **Log levels**: `fatal/error/warn/info/debug/trace` — default `info` in prod, `debug` in dev
- **HTTP request logging**: Custom Express middleware (~5 lines), not morgan/pino-http
- **Client logging**: Error boundaries only, no structured client logger
- **CLI output**: Keep `console.log` for user-facing banners; route server operational logs through logger
- **Sensitive data**: Never log `req.body`, user messages, or auth tokens

## 6) Clarification (Resolved)

1. **Library choice**: **Consola** — clean esbuild bundling, pretty dev output built-in, ~15KB core. File logging via ~20-line custom reporter.

2. **Log level config**: **Yes, add to config** — `logLevel` field in `~/.dork/config.json` + `LOG_LEVEL` env var. Follows existing config precedence (CLI flags > env > config > defaults).

3. **HTTP request logging**: **All requests at debug level** — method, path, status, duration. Invisible at default info level. Full visibility when debugging.

4. **Client error boundaries**: **Separate spec** — this spec stays focused on server-side logging. Error boundary gets its own future spec with proper fallback UI design.

5. **Console output in dev mode**: **Both console + file** — pretty-printed logs in terminal via consola fancy reporter + NDJSON to `~/.dork/logs/`. Real-time visibility during development.
