---
id: 261116-065134
title: Runtime tool context rides the existing process-owned turn
status: proposed
created: 2026-11-16
spec: shared-native-runtime-tools
superseded-by: null
---

# 261116-065134. Runtime tool context rides the existing process-owned turn

## Status

Proposed, unaccepted design extracted from [shared-native-runtime-tools](../specs/shared-native-runtime-tools/02-specification.md), DOR-4481. This is the requested draft design; the repository's ADR lifecycle uses `proposed`, not the generic Flow scaffold's unsupported `draft` status. No implementation or policy acceptance is implied.

## Context

Native DorkOS MCP tools already authenticate through an exact process-owned runtime-turn binding, but that binding does not expose all live execution-mode and event-channel facts used by Claude's hand tools. Stored chat settings and latest-turn caches can disagree with a running or replaced turn, especially around permission updates, Auto fallback and pending next-turn changes. Shared turn-power and approval services already own marks, semantic policy and delivery machinery; duplicating them would create a second authority model.

## Decision

We will attach a read-through tool-context closure to the existing `ConnectorTurnOwnership` entry and resolve it through the current verified principal with exact active-object checks. It will supply only current applied/chosen mode, Never ask distinction, the existing neutral card-event facade and turn cancellation; identity/home/desk remain principal facts and existing shared services retain their policy. We will recheck ownership and current domain permission before sensitive effects after waits, while reusing the existing input parse, approval hash, hold and durable verdict machinery. Revocation, replacement, terminal cleanup and boot reset will remove the closure with its existing binding; no new permission store, wire-controlled grant or runtime SDK type crosses the boundary.

## Consequences

### Positive

- All runtimes can invoke neutral domain tools with the same current-turn facts and approval events.
- Existing ownership and renewal guards remain the single lifecycle authority; stale settings cannot manufacture an active grant.
- SDK confinement and the registry's original validation/gating path remain intact.

### Negative

- Every adapter must map actual applied versus chosen mode and durable event delivery correctly, including warm background work and rekey.
- Stateful tools refuse when verified live context is unavailable; adapters need lifecycle and cancellation conformance beyond listability.
- The principal service's existing process-local owner entry gains a narrow server-only dependency on neutral tool facts.
