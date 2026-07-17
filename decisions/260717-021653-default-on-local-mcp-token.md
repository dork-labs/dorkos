---
id: 260717-021653
title: Default-on local MCP token with a readOnlyHint capability carve-out
status: proposed
created: 2026-07-17
spec: mcp-local-auth-posture
superseded-by: null
---

# 260717-021653. Default-on local MCP token with a readOnlyHint capability carve-out

## Status

Proposed

## Context

The external MCP endpoint (`/mcp`) and the A2A gateway (`/a2a`) shared one auth middleware whose last branch was an unconditional passthrough: with no `MCP_API_KEY`, no legacy config key, and login off (the default), every request was allowed. On loopback that let any local process — a sandboxed dependency, a malicious `postinstall`, a compromised package in another project — call every DorkOS MCP tool tokenlessly, including the in-process code-execution trio (`create_extension`, `test_extension`, `reload_extensions`) and the human-impersonating `relay_send` family, and drive any agent via A2A prompt execution. The constant-time compare was already fixed by an earlier audit; the passthrough was the remaining posture hole (DOR-278, under the DOR-272 umbrella). DorkOS already had the precedent for a per-instance secret file in `secret.ts` (the Better Auth signing secret, DOR-242): env override → read persisted `0600` file → generate + persist, with a lax-permission repair pass.

## Decision

We will delete the passthrough and default-on a **per-instance local MCP token** (the Jupyter pattern): `dork_mcp_local_<hex>`, generated once at boot in login-off mode, stored `0600` at `<dorkHome>/mcp-local-token`, and required as `Authorization: Bearer` on every mutating call. It is a generated secret, so it lives in a file, not a `UserConfigSchema` field — no `conf` migration (ADR-0315, `CREDENTIAL_REF_PATTERN`).

The one carve-out keys off `readOnlyHint: true`, the **only** tool annotation that fails safe — an unannotated or mis-annotated tool is not read-only, so it lands on the guarded side by construction. `READ_ONLY_MCP_TOOL_NAMES` is the single source of truth for the carve-out, locked to the live `tools/list` annotations by a drift-guard test in both directions. On `/mcp` in login-off mode: discovery/handshake methods and read-only `tools/call`s pass tokenless; every other tool, `resources/read`, unknown methods, and any batch with a guarded element fail closed. On `/a2a` there is no read/write annotation to carve on, so JSON-RPC execution (POST) is **always** token-gated in login-off mode; agent-card discovery (GET) stays open. The token is inactive when login is on — it yields to per-user keys (ADR-0320) and is never emitted then. The rollout is a **hard 401 cut** with no warn-then-enforce grace period: pre-launch alpha carries near-zero migration debt, and the only HTTP `/mcp` callers are deliberately-configured third-party clients already at a config step. The token surfaces as a ready-to-paste client config in the settings tab, with a rotate action.

## Consequences

### Positive

- A local non-operator process can no longer reach the mutating/RCE MCP tools or drive agents over A2A on loopback without the `0600` token it cannot read
- Fail-closed by construction: unknown tools, unknown methods, unparseable bodies, and mixed batches all require the token; a newly added tool defaults to guarded until it is both annotated read-only and added to the SSOT
- Zero code impact on the cockpit SPA, DorkOS-driven agents, and the Obsidian embedded path — none call HTTP `/mcp`
- `resources/read` (session/agent/skill data) is gated, a deliberate tightening beyond the tool decision, since transcripts can hold sensitive content

### Negative

- A breaking change with no grace period: existing external MCP and A2A clients must add the token to keep using the tools that change things
- Read-only tools and MCP discovery stay tokenless (accepted per the operator decision), so a local process can still probe health and list tools
- The token is emitted through a purpose-built login-off DTO field over loopback (the same trust boundary as the cockpit); it is never emitted in login-on mode, never logged, and stored `0600` with a lax-permission repair pass

## Related

- Supersedes the zero-config passthrough branch of **ADR-0103** (optional `MCP_API_KEY`); `MCP_API_KEY` stays as the headless override.
- Extends the login-off path of **ADR-0320** (optional-by-default login, per-user keys); the token is inactive once login is on and does not reintroduce a global key on exposure.
- **ADR-0227** (middleware-gated MCP toggle) is unchanged — the auth middleware sits beside `requireMcpEnabled`.
- **ADR-0315** (CredentialProvider port, "never persist plaintext") is why the token is a `0600` file, not a config field.
- **ADR-0311** (Better Auth as the single identity core) is the login-on identity path the local token yields to.
