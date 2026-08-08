# Verified Message Origin for Relay and Mesh

## Problem Statement

Inter-agent messages in Relay/Mesh currently trust the sender's self-declared
identity — nothing is verifiable. The Claude Agent SDK now attaches
`SDKMessageOrigin` with `verifiedPeerPid`, `body`, and `fromSession`
(0.3.205/0.3.224): the first non-forgeable sender identity available to us at
the runtime level. This is foundational for multi-agent coordination — the
core DorkOS thesis — and for agent-etiquette enforcement in shared rooms.

## Design Principle: Runtime-Interface First

Per operator direction (2026-08-07): origin verification becomes a generic
concept in the coordination layer, not a claude-code detail:

- Define a runtime-agnostic `MessageOrigin` shape in `@dorkos/shared` (Zod),
  with an explicit verification level: `verified` (runtime-attested, e.g. peer
  PID) vs `declared` (self-reported) vs `unknown`
- **claude-code** populates `verified` from `SDKMessageOrigin.verifiedPeerPid`/`fromSession`
- **codex / opencode** emit `declared`/`unknown` until their SDKs offer
  attestation — the shape makes trust level explicit rather than pretending
- Relay (`@dorkos/relay`) and Mesh (`@dorkos/mesh`) consume the origin through
  the `AgentRuntime` boundary (Hard Rule 2: SDK types never leak outside the
  adapter — the shared shape is the carrier)

## Research

- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/changelog.md` (0.3.205, 0.3.224)
- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/impact-assessment.md` (origin section)
- Note: Mesh+Relay coordination is shipped but unverified end-to-end (demo-claim gate) — this spec must not claim user-facing security guarantees until that verification exists.

## Dependencies

- **Blocked by**: `claude-agent-sdk-upgrade-0.3.224`

## Suggested Approach

1. `MessageOrigin` schema + verification-level enum in shared
2. claude-code adapter maps SDK origin → shared shape
3. Relay/Mesh plumb origin through message envelopes; surface trust level where messages render
4. Conformance: every runtime must emit _an_ origin, at whatever level it can attest

Effort: significant (crosses runtime, relay, mesh; needs its own threat-model pass at SPECIFY).
