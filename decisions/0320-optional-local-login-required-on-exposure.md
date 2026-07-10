---
number: 320
title: Optional-by-default local login, auto-required on exposure; subsumes tunnel passcode and global MCP key
status: accepted
created: 2026-07-02
spec: accounts-and-auth
superseded-by: null
---

# 0320. Optional-by-default local login, auto-required on exposure; subsumes tunnel passcode and global MCP key

## Status

Accepted

## Context

Zero-config local startup is a core DorkOS value, but the current protection for exposed instances is a 6-digit tunnel passcode (strictly weaker than real credentials) plus a single global MCP Bearer key, and n8n-style mandatory first-run logins add a signup wall a local single-user dev tool does not need. Verified industry norm (n8n, Metabase, Grafana, PostHog): login and multi-user stay free; the open-core gates are features (SSO/SCIM/RBAC), not headcount. A DorkOS-specific constraint: anyone who can drive agents effectively holds the server process's filesystem access and spends the owner's Claude quota, so multi-user access is a trust-domain decision, not a UI toggle.

## Decision

Local login is optional and off by default; enabling exposure (tunnel or non-loopback bind) hard-requires creating the owner account first. Better Auth subsumes the tunnel passcode and cookie-session middleware (passcode config deprecated via migration), and per-user scoped API keys (Better Auth `apiKey` plugin) replace the global `dork_mcp_*` key (env `MCP_API_KEY` retained for headless use). The schema is multi-user-capable from day one, but registration auto-closes after the first user; invites wait for a viewer/operator role model in a fast-follow spec. No first-run account prompt until there are nameable benefits; prompts are contextual at the moment of value.

## Consequences

### Positive

- Zero-config local UX preserved; exposed instances get real credentials instead of a 6-digit PIN; one auth path instead of three (passcode, cookie-session, global key).
- Honest posture: no login wall without a benefit to name; no invite button implying isolation that does not exist.

### Negative

- Breaking change for existing passcode users (credentials must be re-established; migration + changelog required).
- Two operating modes (auth on/off) double the middleware test matrix.
- OSS multi-user invites are deferred, which slightly lags the n8n Community feature set until the fast-follow ships.
