---
id: 260803-233420
title: Managed MCP server trust model — gated writes, marketplace rejection, absence withholds
status: accepted
created: 2026-08-03
spec: mcp-server-management
superseded-by: null
---

# 260803-233420. Managed MCP server trust model — gated writes, marketplace rejection, absence withholds

## Status

Accepted

## Context

A managed MCP server can carry an arbitrary stdio command that executes in the
agent's environment, so introducing one is a capability grant and a potential
data-egress path. The `safe-defaults` rule requires that absence never means
consent. The originating request specifically asks for an explicit approval gate
that shows the command a server would run, and for protection against a
cloned/installed agent auto-connecting arbitrary commands. The standing-approvals
module is security-critical and recently hardened, so we prefer not to extend its
internals for this.

## Decision

We will govern managed MCP servers with four guarantees rather than a new approval
ledger:

1. **Absence withholds.** `mcpServers` defaults to `[]`; an entry's `enabled`
   defaults to `false`; injection fires only for `enabled === true` entries.
2. **Gated writes only.** `mcp.add` and any change to a server's `connection` are
   `destructive`-tier capabilities that raise a human approval card showing the
   exact `command`/`args`/`url` (`approvalDisplayFields`). `mcpServers` is excluded
   from the general agent PATCH, so there is no un-gated write path.
3. **Marketplace packages may not declare `mcpServers`.** The marketplace
   agent-manifest validator rejects it, closing the "packaged/remote agent smuggles
   an auto-injected command" vector.
4. **The operator's own filesystem stays trusted.** A hand-edited `agent.json` is
   in the same trust position as a hand-written `.mcp.json` the SDK already
   auto-loads; we defend against packaged/remote content, not the operator's own
   disk.

## Consequences

### Positive

- Satisfies the explicit approval-gate requirement (command diff) and
  `safe-defaults` without touching the hardened standing-approvals module.
- The single legitimate writer (the gated capability) gives one audit surface and a
  clear re-approval trigger on command change.
- Marketplace rejection is a one-rule guard, cheap and testable.

### Negative

- Trust is anchored in "only the gated capability writes `mcpServers`" plus the
  marketplace guard, not in a per-entry cryptographic approval token; a determined
  operator editing their own manifest bypasses the card (accepted, matches the
  existing `.mcp.json` boundary).
- A follow-up that imports discovered `.mcp.json` servers must route through the
  same gate rather than trusting the file.
