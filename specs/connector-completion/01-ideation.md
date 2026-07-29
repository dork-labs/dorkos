---
slug: connector-completion
id: 260729-084214
created: 2026-07-29
status: ideation
linearIssue: DOR-415
---

# Connector completion — give the shipped gateway a face

**Author:** spec-connector (connector-completion program)
**Date:** 2026-07-29
**Parent work:** `specs/connector-gateway/` (DOR-371, shipped), ADR `260718-045630`, DOR-415 (Nango Proxy→MCP wrapper + review nits).

## The problem, in one sentence

The connector gateway shipped a complete, conformance-tested backend — port, registry, routing, custody disclosure, session exposure, 9 REST routes, three providers, `connected_accounts` table, session→MCP tool injection — and **zero user-facing surface**, so no user and no agent can actually connect anything.

## Verified gaps (read from source, 2026-07-29)

1. **The Composio provider can never activate.** `maybeCreateComposioProvider` (`apps/server/src/services/connectors/providers/composio.ts`) registers only when the credential `file:composio-api-key` resolves — and **no code path writes that credential**. The provider's own TSDoc says "a settings write path (later phase) stores the key under this name"; that phase never happened. Same for Nango's `file:nango-secret-key`.
2. **Providers are constructed once at boot** (`apps/server/src/index.ts:1051-1090`). Even if a key were written, the operator would have to restart the server. Saving a key must (re)construct and register the provider live; deleting must unregister.
3. **`RawMcpConnectorProvider` is never registered.** Exported from `services/connectors/index.ts:67`, used only in tests. There is also no config surface naming which remote MCP servers it should offer.
4. **No agent-facing tools.** The DorkOS MCP server (`services/core/mcp-server.ts` + the capability registry) exposes zero connector tools. "Connect my Gmail" in chat does nothing — the exact demo the docs promise.
5. **Nango exposes no tools** (`exposesOverMcp: false`, `toolServerForAccount` always null) because the Proxy→MCP wrapper was deferred. DOR-415 tracks building it, plus three review nits in `nango-client.ts`/`env.ts` (unknown statuses default to PENDING not ERROR; `end_user.id` reuses the label and collides; `NANGO_BASE_URL` has no url refinement).
6. **No client UI at all.** No `/connections` route, no key entry, no service grid, no accounts list, no session attach affordance — the 9 REST endpoints have no caller.
7. **No discovery.** Marketplace UI renders `adapterType: 'connector'` packages as generic "Adapters" (no badge/filter); the site's features catalog has no connectors entry and the Marketplace bullet "Browse agents, plugins, skills, and connectors" is currently false.
8. **Docs describe fiction.** `docs/connectors/*.mdx` say "Save the key in DorkOS settings" and "say Connect to my Gmail" — neither exists.
9. **No e2e proof.** Nothing exercises save-key → connect → attach → tools-in-session end to end, even against fakes.

## What "done" looks like (jobs to be done)

- **Ikechi (non-developer founder):** opens Connections, pastes a Composio key once, clicks Connect on Gmail, signs in with Google, sees "Gmail (personal)" with a plain-language custody line, attaches it to a session, and the agent can read email. No restart, no config file.
- **Kai (senior dev):** says "connect my Linear" in chat; the agent answers with an auth link and the custody sentence; after sign-in Kai attaches the account and keeps working. Also connects a second Gmail as "work".
- **Priya (reads source):** sees that keys go through the encrypted `CredentialStore`, custody is disclosed verbatim from the ADR, and the Nango self-host path exposes tools without touching Nango's Enterprise MCP.

## Options considered

- **Provider live-reload seam.** (a) Restart-required (rejected: hostile, and the gateway spec promised runtime connect); (b) construct providers lazily per request (rejected: loses boot-time refusal semantics like `NangoEncryptionKeyError`, complicates registry identity); **(c) a `ConnectorProviderBootstrapper` that owns construct+register/unregister and is called at boot and by the credential routes — chosen.** Precedent: `openCodeServerManager.recycle()` on credential persist.
- **Where agent tools live.** (a) Hand-registered MCP tools (legacy); **(b) a capability-domain module like `marketplace-capabilities.ts`, projected onto both the in-session tool server and the external `/mcp` server by the capability registry — chosen** (one definition, two surfaces, tier-gate/approval semantics for free).
- **In-chat connect UX v1.** (a) Custom connect card in the chat stream (deferred — real design work, not launch-critical); **(b) the tool result carries the auth URL + custody sentence as plain markdown the chat already renders — chosen for v1.**
- **Nango Proxy→MCP shape.** (a) stdio subprocess per account (rejected: process sprawl); **(b) a DorkOS-hosted Streamable-HTTP MCP endpoint that wraps Nango's credentialed proxy, one generic `proxy_request` tool per account, per-account bearer token — chosen** (reuses the `@modelcontextprotocol/sdk` server the repo already runs at `/mcp`).
- **Raw-MCP server source of truth.** (a) hardcode none and register anyway (inert but honest); (b) a new config block `connectors.rawMcpServers` in user config — **chosen**, following the `adding-config-fields` lifecycle, so the baseline provider is actually usable.

## Scope shape

Four execution slices (the orchestrator's decomposition): **A** server truth (credential write path + bootstrapper, raw-MCP registration, agent tools, DOR-415, docs truthing), **B** client surfaces (`/connections` route + session attach), **C** discovery (marketplace badge/filter + site catalog), **E** e2e (fake provider + Playwright).

## Non-goals (carried or new)

- No custom chat connect-card (explicit deferred enhancement).
- No real-provider CI; mocks in CI, live checks out of band (gateway spec D5).
- No multi-user `user_id` scoping (gateway OQ1 stands).
- No claim in user-facing copy that any provider "works" until verified end-to-end (demo-claim gate) — docs and site copy stay alpha-labeled.

## Open questions carried into SPECIFY

Resolved there; see `02-specification.md` §Decisions and §Open Questions.
