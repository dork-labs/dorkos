---
slug: dorkos-config-file-system
number: 32
created: 2026-02-16
status: implemented
---

# DorkOS Configuration File System

**Slug:** dorkos-config-file-system
**Author:** Claude Code
**Date:** 2026-02-16
**Branch:** preflight/dorkos-config-file-system
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Add a persistent configuration file at `~/.dork/config.json` that integrates with the existing CLI, server, and client. Define the relationship between `.env`, CLI flags, and the config file. Add CLI commands for managing config. Provide validation, defaults, and a standard developer/user experience.

- **Assumptions:**
  - Config file will be JSON (consistent with existing Zod/JSON patterns and the `ServerConfig` endpoint)
  - Located at a fixed path (`~/.dork/config.json`), not discovery-based
  - `.env` continues to exist for local development; config file is for installed users
  - Sensitive values (API tokens like `NGROK_AUTHTOKEN`) stay in env vars, not config file
  - Obsidian plugin has its own config system (Obsidian settings API) and doesn't read `~/.dork/config.json`

- **Out of scope:**
  - Per-project config files (`.dorkos.json` in project dirs) — future enhancement
  - Config encryption/secrets management
  - Config sync across machines
  - XDG-compliant paths (consider for v2.0)
  - UI for editing config in the client settings panel (future enhancement)

## 2) Pre-reading Log

- `packages/cli/src/cli.ts`: CLI entry point. Creates `~/.dork/` dir, sets `DORK_HOME` env var, parses `--port`, `--tunnel`, `--dir`, `--help`, `--version` flags, loads project-local `.env`, starts server. **Currently no config file reading.**
- `apps/server/src/index.ts`: Server startup. Reads `DORKOS_PORT`, `TUNNEL_ENABLED`, `TUNNEL_PORT`, `NGROK_AUTHTOKEN`, `TUNNEL_AUTH`, `TUNNEL_DOMAIN` from process.env.
- `apps/server/src/routes/config.ts`: GET `/api/config` endpoint returning `ServerConfig` (version, port, uptime, workingDirectory, nodeVersion, claudeCliPath, tunnel status). Read-only, no write endpoint.
- `apps/server/src/app.ts`: Express app factory. Reads `NODE_ENV`, `CLIENT_DIST_PATH` for production static serving.
- `apps/server/src/services/agent-manager.ts`: Uses `DORKOS_DEFAULT_CWD` with fallback chain: constructor param → env var → repo root.
- `apps/server/src/services/tunnel-manager.ts`: Singleton with `TunnelConfig` interface (port, authtoken, basicAuth, domain). All from env vars.
- `apps/server/src/routes/commands.ts`: Uses `DORKOS_DEFAULT_CWD` for `.claude/commands/` scanning root.
- `packages/shared/src/schemas.ts`: `ServerConfigSchema` Zod schema (lines 457-475). Pattern to follow for UserConfigSchema.
- `packages/shared/src/constants.ts`: `DEFAULT_PORT = 4242`. Hardcoded fallback.
- `packages/shared/src/transport.ts`: Transport interface includes `getConfig(): Promise<ServerConfig>`.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: Settings modal fetches config via `transport.getConfig()` with TanStack Query (`staleTime: 30_000`).
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`: Displays server config (version, port, uptime, working dir, Node version, Claude CLI path, tunnel status).
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store for client-side preferences (appearance, statusbar). Persisted to localStorage.
- `.env`: Root env file loaded by `dotenv-cli` for development. Contains `DORKOS_PORT`, tunnel vars, etc.

## 3) Codebase Map

**Primary Components/Modules:**

| File | Role | Config Values |
|------|------|---------------|
| `packages/cli/src/cli.ts` | CLI entry point, env var setup | Sets: DORKOS_PORT, DORKOS_DEFAULT_CWD, TUNNEL_ENABLED, NODE_ENV, CLIENT_DIST_PATH, DORK_HOME |
| `apps/server/src/index.ts` | Server startup | Reads: DORKOS_PORT, TUNNEL_ENABLED, TUNNEL_PORT, NGROK_AUTHTOKEN, TUNNEL_AUTH, TUNNEL_DOMAIN |
| `apps/server/src/routes/config.ts` | Config API endpoint | Reads: DORKOS_PORT, TUNNEL_AUTH, NGROK_AUTHTOKEN |
| `apps/server/src/services/tunnel-manager.ts` | Tunnel lifecycle | Reads: NGROK_AUTHTOKEN, TUNNEL_AUTH, TUNNEL_DOMAIN (via connect() params) |
| `apps/server/src/services/agent-manager.ts` | SDK session manager | Reads: DORKOS_DEFAULT_CWD |
| `apps/server/src/routes/commands.ts` | Command registry | Reads: DORKOS_DEFAULT_CWD |
| `packages/shared/src/schemas.ts` | Zod schemas | Defines: ServerConfigSchema |
| `packages/shared/src/constants.ts` | Shared defaults | Defines: DEFAULT_PORT (4242) |

**Shared Dependencies:**
- `@dorkos/shared` — Zod schemas, types, constants, transport interface
- `dotenv-cli` — Loads `.env` at monorepo root for dev scripts

**Data Flow:**
```
CLI flags → cli.ts → process.env → server/index.ts → routes + services
                                                    → /api/config → client SettingsDialog
```

**Feature Flags/Config:**
- No feature flag system exists
- All config is runtime env vars

**Potential Blast Radius:**

| Category | Files |
|----------|-------|
| Must modify | `packages/cli/src/cli.ts`, `apps/server/src/routes/config.ts`, `packages/shared/src/schemas.ts`, `packages/shared/src/constants.ts` |
| May enhance | `apps/server/src/index.ts`, `apps/server/src/services/agent-manager.ts`, `apps/server/src/services/tunnel-manager.ts` |
| New files | Config service, config CLI commands, config schema |
| Tests | New test files for config service + CLI commands; existing config route tests updated |
| Docs | `CLAUDE.md`, `guides/architecture.md`, `guides/api-reference.md`, new `guides/configuration.md` |

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

## 5) Research

### 5a) .env vs config.json Relationship

**Recommended precedence (highest to lowest):**

1. **CLI flags** (`dorkos --port 8080`) — Explicit intent, always wins
2. **Environment variables** (`.env` or shell exports) — Dev/CI overrides
3. **Config file** (`~/.dork/config.json`) — Persistent user preferences
4. **Built-in defaults** (`constants.ts`) — Hardcoded fallbacks

**Key insight:** `.env` should NOT migrate to config.json. They serve different purposes:
- `.env` = development-time overrides, CI/CD config, secrets (tokens)
- `config.json` = persistent user preferences for installed CLI users (port, theme, default cwd)
- They coexist. Config file provides a user-friendly layer; env vars remain the escape hatch.

**What goes where:**

| Setting | config.json | .env / env var | Why |
|---------|------------|----------------|-----|
| Port | `server.port` | `DORKOS_PORT` | User preference, overridable |
| Default CWD | `server.cwd` | `DORKOS_DEFAULT_CWD` | User preference, overridable |
| Tunnel enabled | `tunnel.enabled` | `TUNNEL_ENABLED` | User preference, overridable |
| Tunnel domain | `tunnel.domain` | `TUNNEL_DOMAIN` | User preference, overridable |
| ngrok auth token | **NO** | `NGROK_AUTHTOKEN` | Secret — env vars only |
| Tunnel auth | **NO** | `TUNNEL_AUTH` | Secret — env vars only |
| Theme | `ui.theme` | N/A | Pure user preference |
| NODE_ENV | **NO** | `NODE_ENV` | Runtime concern, not user config |
| CLIENT_DIST_PATH | **NO** | `CLIENT_DIST_PATH` | Build/CLI internal |

### 5b) Library Recommendations

**Recommended: `conf` library + Zod validation**

| Option | Verdict | Reason |
|--------|---------|--------|
| **Hand-rolled (fs + Zod)** | Viable but risky | No atomic writes, manual migration logic, file corruption risk |
| **`conf` (sindresorhus)** | **Recommended** | Atomic writes, built-in migrations, dot-path access, 2.5M+ weekly downloads |
| **`cosmiconfig`** | Wrong tool | Designed for discovery-based config (upward search). No write API. DorkOS has a fixed path. |
| **`rc`** | Outdated | Legacy pattern, no TypeScript, no write API |

**Why `conf`:**
- Atomic writes (prevents corruption from crashes/signals)
- Built-in migration system for schema evolution
- Dot-path access (`config.get('tunnel.enabled')`)
- Platform-aware defaults (though we'll override with `~/.dork/`)
- 12KB, zero-config
- TypeScript support

**Hybrid approach:** Use `conf` for I/O + atomic writes, convert Zod schema to JSON Schema via `zod-to-json-schema` for `conf`'s validation, keep Zod for runtime type inference consistency.

**New dependencies:**
- `conf` — Config I/O and persistence
- `zod-to-json-schema` — Bridge Zod → JSON Schema for `conf`
- `@inquirer/prompts` — Interactive setup wizard (Phase 2)

### 5c) Config Warnings & Validation

**Strategy: Warn + fallback (never block startup)**

| Scenario | Behavior |
|----------|----------|
| Config file missing | Create with defaults, log `Created config at ~/.dork/config.json` |
| Config file has invalid values | Warn with specific errors, use defaults for invalid fields |
| Config file is corrupt JSON | Warn, back up corrupt file, create fresh defaults |
| Unknown keys in config | Ignore silently (forward compatibility) |
| Schema version mismatch | Run migrations automatically |

**Example warning output:**
```
⚠️  Config validation warning:
  • port: Expected number, received "not-a-number"
  • theme: Invalid value. Expected 'light' | 'dark' | 'system', received 'blue'

Using default values for invalid fields.
To fix: dorkos config reset
```

**CLI validation commands:**
- `dorkos config validate` — Check config without starting server
- `dorkos config reset [key]` — Restore defaults (all or specific key)

### 5d) Standard Setup Requirements

**Schema versioning:** Include `"version": 1` in the config file. Increment when schema changes. Use `conf`'s migration system to auto-upgrade.

**Initial config file (created on first run):**
```json
{
  "version": 1
}
```

Minimal by design. `conf` provides defaults for all unset fields, so the file only needs the version marker. As users customize via `dorkos config set`, their overrides are written.

**Why minimal initial file:**
- Avoids confusion ("did I change this or is it a default?")
- Forward-compatible (new defaults apply automatically)
- Follows `conf` conventions
- Users can run `dorkos config list` to see effective values (defaults + overrides)

### 5e) Interactive Setup & CLI Commands

**First-run strategy: Silent creation + optional wizard**

```bash
# First run (silent — just works)
$ dorkos
✓ Created config at ~/.dork/config.json
Starting DorkOS on port 4242...

# Optional interactive setup
$ dorkos init
? Default port: (4242)
? UI theme: › system
? Enable tunnel by default? (y/N)
✓ Config saved to ~/.dork/config.json
```

**Why silent first-run:**
- Doesn't break automation (CI/CD scripts)
- "Just works" philosophy (like Jest, Parcel)
- Experienced users aren't forced through a wizard
- `dorkos init` is opt-in for those who want it

**CLI config commands (standard pattern, matches npm/git/pnpm):**

```bash
dorkos config                    # Show all effective settings
dorkos config get <key>          # Get single value
dorkos config set <key> <value>  # Set single value
dorkos config list               # Full JSON output
dorkos config reset [key]        # Reset to defaults
dorkos config edit               # Open in $EDITOR
dorkos config path               # Print config file location
dorkos config validate           # Check validity
```

**`dorkos init` flags:**
- `dorkos init --yes` — Accept all defaults (CI-friendly)
- `dorkos init --quiet` — Silent mode

**Interactive prompt library:** `@inquirer/prompts` (19k stars, modular, TypeScript-first, modern API)

### 5f) Documentation Updates

| Document | Update |
|----------|--------|
| `CLAUDE.md` | Add config file section, precedence rules, new CLI commands |
| `guides/architecture.md` | Config loading sequence, new service |
| `guides/api-reference.md` | Config write endpoint (if added) |
| **New: `guides/configuration.md`** | Comprehensive config guide: all settings, types, defaults, precedence, CLI commands, migration |
| `packages/cli/README.md` | Config section, `dorkos config` commands |
| CLI `--help` output | Show config file location, link to docs |

## 6) Clarification (Resolved)

| # | Question | Decision |
|---|----------|----------|
| 1 | Config file location | **`~/.dork/config.json`** — Simple, discoverable, matches Claude Code's `~/.claude/` pattern. Already created on startup. |
| 2 | UI settings in config file | **Only `ui.theme`** — Theme is the one preference users want consistent. Sidebar state, panel positions stay in localStorage. |
| 3 | Config write endpoint | **Yes, `PATCH /api/config`** — Partial updates with Zod validation. Enables remote config changes via tunnel. Excludes sensitive fields. |
| 4 | Tunnel secrets handling | **Warn but allow** — Print warning suggesting env vars when users set sensitive fields (authtoken, auth). Don't block the operation. |
| 5 | `conf` directory override | **Yes, use `~/.dork/`** — Pass `cwd: process.env.DORK_HOME` to `conf`. Config lives alongside future DorkOS data. |
| 6 | Phasing | **All phases at once** — Config service, CLI commands, interactive wizard, validation, and full documentation in one implementation. |
| 7 | .env relationship | **Completely independent** — config.json and .env serve different audiences (installed users vs. developers). Precedence handles conflicts. |