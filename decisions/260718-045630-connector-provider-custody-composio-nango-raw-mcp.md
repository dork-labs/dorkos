---
id: 260718-045630
title: 'Connector custody stance: a ConnectorProvider abstraction — Composio (managed), Nango (self-host), raw MCP (baseline)'
status: accepted
created: 2026-07-17
spec: null
superseded-by: null
---

# 260718-045630. Connector custody stance: a ConnectorProvider abstraction — Composio (managed), Nango (self-host), raw MCP (baseline)

## Status

Accepted

## Context

Shapes need agents to act on a user's real accounts (Gmail, Slack, Linear), but raw MCP has no multi-account model: the authorization draft scopes one OAuth connection to one account, GitHub discussion #234 proposed a per-call multi-user mechanism and was closed unadopted by its own author, and #193/#483 remain open and stalled (`research/20260718_connector-gateway-spike.md` §1.1). Real-world workarounds — an Atlassian user told two accounts require two separate MCP connections, Google Workspace MCP's `login_hint` patch — confirm this is a genuine protocol gap, not a theoretical one. D4 in `plans/shapes-program.md` set direction on 2026-07-17 (founder: "MCP gateway adapter") — build a `ConnectorProvider` abstraction rather than depend on any single vendor — but deferred the concrete provider picks and the custody disclosure to the W5 research spike (DOR-365). That spike verified the provider landscape, licenses, and custody models against primary sources (docs, repo `LICENSE` files, npm metadata, funding announcements), including a same-day AGPL-vs-Apache-2.0 name collision worth flagging (`research/20260718_connector-gateway-spike.md` §1.2, §5).

## Decision

We will build a `ConnectorProvider` port — the third swappable backend seam alongside `AgentRuntime` (`packages/shared/src/agent-runtime.ts`) and `Transport` (`packages/shared/src/transport.ts`) — with concrete providers distributed as marketplace `adapter`-type packages (`packages/marketplace/src/package-types.ts`). Every DorkOS install gets **raw MCP over OAuth 2.1** as the zero-dependency single-account baseline; no vendor account is required to connect a remote MCP server. **Composio** is the flagship managed provider: multi-account addressing via `connected_account_id` + `alias`, tokens held in Composio's SOC 2 Type II vault and never touching DorkOS or the model. **Nango** is the first self-hostable provider: Elastic License 2.0 across the whole monorepo (source-available, non-copyleft — acceptable because DorkOS points at a self-hosted instance rather than reselling Nango as a service), tokens in the user's own Postgres. The self-host guide must make setting `NANGO_ENCRYPTION_KEY` mandatory, because Nango stores tokens unencrypted by default; DorkOS wraps only Nango's free Auth+Proxy tier and must never depend on its Enterprise-gated MCP server. **Before W5 implementation locks the self-host slot, we will re-check `oomol-lab/open-connector`** (Apache-2.0, `v1.3.0` released 2026-07-17) — a self-hostable MCP-gateway-with-vault that is architecturally the shape we want and more permissively licensed than Nango's ELv2, but one day old at spike time and too young to adopt at decision time.

### Custody disclosure

Custody is a first-class, disclosable field (`ConnectorCustody: 'managed' | 'self-host' | 'external'`) surfaced per account, not a buried setting — because a user can hold a managed Gmail and a self-hosted Slack at once. For the Composio path, product copy reuses this sentence, written to the `writing-for-humans` plain-language standard:

> **"Composio stores your connected accounts' login access in its own secure vault, not on your computer."**

This must appear before the user connects anything, not just in docs — the honesty gate made structural, not a copy-review afterthought.

## Consequences

### Positive

- Reuses proven in-repo seams instead of inventing new machinery: `CredentialProvider`'s reference-not-secret discipline, `AdapterManager`'s per-service lifecycle and `multiInstance` precedent, and the runtime's existing MCP tool-server injection (`getMcpServerConfig`, `supportsMcp`) all extend directly — the gateway is additive, not invasive (`research/20260718_connector-gateway-spike.md` §3).
- Closes a real, verified gap (raw MCP's single-account limit) with Composio's `connected_account_id` primitive, while the baseline still works with zero vendor dependency for anyone who never needs multi-account.
- Gives the privacy-conscious cohort a genuine self-host answer — tokens in their own Postgres, not vendor-only — instead of forcing every user through a managed vault.
- Custody is structural, not aspirational: the `ConnectorCustody` field means no provider can ship without declaring where tokens live, and the UI can't silently default into an undisclosed stance.

### Negative

- Composio's managed vault means tokens leave the user's machine by default — a real departure from DorkOS's local-first framing that must be labeled at every connect flow, not just recorded here.
- Nango's free self-host tier is Auth+Proxy only; DorkOS must actively wrap those two primitives into its own MCP tools rather than reach for Nango's Enterprise-gated MCP server, and must re-verify this boundary holds on every Nango pricing or tier change.
- The self-host custody promise ("tokens stay in your infrastructure") is only true if `NANGO_ENCRYPTION_KEY` is set; a missed setup step silently downgrades it to plaintext tokens at rest, so the setup flow must enforce the key, not just recommend it.
- The `oomol-lab/open-connector` re-check is a deliberate open loop: if it doesn't clear evaluation by W5 spec kickoff, Nango stays the default indefinitely with no formal close-out; if it does clear, this ADR needs a follow-up amendment or supersession.

## Alternatives Considered

- **Raw-MCP-only (no gateway)** — rejected: the multi-account gap is real, not theoretical. MCP discussion #234 proposed exactly this fix and was closed unadopted by its own author; #193 and #483 remain open and stalled with no merged multi-account primitive. N accounts of one service would require N raw MCP connections with no addressing layer between them.
- **Klavis or Arcade as the flagship managed provider** — rejected per the spike's provider matrix: Klavis's per-toolkit multi-account support and vaulting mechanics are undocumented and unverified; Arcade's Engine (the actual credential vault) is proprietary and Enterprise-only to self-host. Neither has Composio's verified `connected_account_id` + `alias` primitive or a hosted MCP gateway (Rube) already aligned with DorkOS's MCP host.
- **AGPL "Open Connector" (`openconnector.dev`)** — rejected: declares AGPL-3.0 but ships no published code, a "coming soon" repo with one star — vaporware, not adoptable regardless of license. Separately, AGPL-3.0's network-copyleft clause (§13) means any AGPL connector backend would need legal sign-off before being bundled as a default; the mature, differently-named `oomol-lab/open-connector` (Apache-2.0) carries no such exposure, which is why it's the re-check candidate instead.
