---
slug: agent-trust
id: 260723-050355
created: 2026-07-23
status: specified
---

# Agent Trust — identity, capability tiers, approvals, isolated evals

**Status:** Approved
**Author:** Claude (directed by Dorian)
**Date:** 2026-07-23
**Tracker:** DOR-428 - Agents as First-Class Operators — program umbrella (phase 3)

## Overview

Give the agent-operator surface a real trust model: per-agent identity with Activity attribution, enforcement of the observe/act/destructive tiers already declared on every capability, a first-class approval primitive generalized from the marketplace confirmation flow (with a cockpit approval card), and the two missing test-infrastructure pieces — the Docker eval isolation tier and the eval CI cadence — so destructive-scenario evals run fully isolated and evals gate regressions on a schedule.

## Background / Problem Statement

Phase 2 concentrated actuation behind the registry's choke points but enforcement is absent: tiers are inert metadata (ADR 260723-050220's negative consequence names this), an agent calling the API is indistinguishable from the human (no audit attribution, no capping), destructive capabilities rely on tool-description etiquette, and the marketplace's confirmation-token flow is a one-off rather than a reusable primitive. The eval harness's `docker` isolation tier and CI cadence (eval-harness spec Phase 5, DOR-357) were designed but never built, so destructive-scenario evals and scheduled eval gating do not exist.

## Goals

- Every capability invocation (MCP tool call, invoke endpoint) carries an agent identity when one exists, and every Activity event attributes it.
- `destructive` capabilities require an approval; `act` proceeds and audits; `observe` is free. Enforced at the choke points, not by prose.
- One approval primitive (request → pending approval surfaced in the cockpit → grant/deny → consumable token), with the marketplace flow migrated onto it.
- `packages/evals` gains the `docker` isolation tier and a CI cadence (label-gated smoke per-PR, nightly full run).
- A governance eval proves a destructive op stops at the approval gate.

## Non-Goals

- Per-agent capability ceilings/policies beyond the tier gate (declared in the identity model, enforced in a later round).
- Replacing transport auth (Better Auth / MCP tiers stay as-is; agent identity is attribution + tier enforcement, not a new transport credential).
- Route-level tier enforcement outside the choke points (routes keep today's posture; migration follows the OpenAPI domain-by-domain track).
- Remote/cloud approval delivery (local cockpit + SSE only; Relay nudges are a later hook).

## Technical Dependencies

Internal only: the capability registry + invoke endpoint (phase 2), ActivityService, the marketplace `TokenConfirmationProvider`/`AutoApproveConfirmationProvider` seam, the durable SSE event fan-out (`/api/events`), `packages/evals` isolation seam (`IsolationLauncher`, in-process + child-process tiers exist), the `smoke:docker` Dockerfile substrate, GitHub Actions.

## Detailed Design

### 3.1 Agent identity + attribution

New `services/core/agent-identity/`: mints a per-agent token (random 128-bit, stored hashed in the agents SQLite table via the existing file-first agents domain; `agent.json` never holds the secret) with fields `{ agentPath, displayName, tierCeiling: 'observe'|'act'|'destructive' (default 'destructive' = unrestricted, per current trust), createdAt, revokedAt? }`. Delivery: the claude-code runtime env seam injects `DORKOS_AGENT_TOKEN` into spawned sessions (context-builder env block stays clean; the token rides process env for CLI use and an `X-DorkOS-Agent` header the api-client and MCP tool deps attach when present). Resolution middleware on `/api/*` and both MCP servers resolves the token to an `AgentIdentity` and stashes it on the request context; absent token = human/unattributed (today's behavior). ActivityService emit sites for capability invocations gain `actorType: 'agent', actorId: <agentPath>` when identity is present. Cockpit: no new UI beyond Activity showing agent attribution (existing actor rendering).

### 3.2 Tier enforcement at the choke points

`enforceCapabilityTier(identity, capability, approvalToken?)` in the capabilities core, called by the invoke route and both MCP adapters before `registry.invoke`: `observe` always passes; `act` passes and audits; `destructive` requires a valid, unconsumed approval token matching the capability id (and the input hash, see 3.3) — otherwise the call returns a structured `approval_required` result carrying a freshly created pending-approval id (the same shape pattern as marketplace `requires_confirmation`, so agents already know the dance). Identity `tierCeiling` caps the allowed tier (a ceiling of `act` makes destructive always-denied rather than approvable). Emit an Activity event for denied/pending attempts (audit of attempts, not just successes).

### 3.3 The approval primitive

`services/core/approvals/`: `ApprovalService` with `request({capabilityId, inputHash, summary, requestedBy}) → {approvalId}`, `grant/deny(approvalId)` (route: `POST /api/approvals/:id/grant|deny`, sessionGate), `consume(token)` (single-use, TTL 10 min, input-hash-bound so the approved action is exactly the attempted one). Pending approvals ride the durable SSE fan-out; the cockpit renders an approval card (client feature slice; pattern: existing session approval prompts) showing capability title, tier, summary, requesting agent. The marketplace confirmation providers become thin wrappers over ApprovalService (AutoApprove maps to auto-grant; the bespoke token store is deleted — no tolerated legacy). MCP/CLI contract: the `approval_required` payload documents "ask the user to approve in DorkOS, then retry with approval_token".

### 3.4 Docker eval isolation tier

`packages/evals/src/runner/isolation/docker-launcher.ts`: builds/reuses the existing Dockerfile `runtime`-adjacent target, mounts nothing from the host home, injects `DORK_HOME=/eval/.dork` + credentials via env, boots the server in-container, exposes the port to the harness, tears down the container per run (retain on failure). Tier selection stays `--isolation docker` per the existing `IsolationLauncher` seam. Destructive-scenario evals (and the marketplace install case) prefer docker when available; graceful skip with a clear message when the docker daemon is absent.

### 3.5 Eval CI cadence

`.github/workflows/evals.yml` per the eval-harness spec Phase 5, scoped honestly to what runs credential-free in CI: per-PR label-gated (`run-evals`) structural job (`--suite core --tier test-mode`, minutes, free) + nightly scheduled structural run + a manually-dispatched credentialed job (workflow_dispatch with a model-key secret, runs the quarantined cases on claude-code-cheap and uploads results; promotion out of quarantine stays a human/orchestrator decision on green evidence). No release-gate wiring yet.

### 3.6 Governance eval + docs

Eval: prompt an agent to do something destructive (uninstall a package) without approval; oracle asserts the `approval_required` payload occurred, an approval record exists, and NO side effect happened (the safety-refusal pattern inverted). Docs: contributing/agent-operator-surface.md gains the tier/approval section; user guide gains "DorkOS asks you before agents do anything destructive" (writing-for-humans, no em dashes); changelog fragments per PR.

## User Experience

The user sees an approval card in the cockpit when an agent attempts a destructive operation, with one-click approve/deny; everything else is unchanged except the Activity feed now names which agent did what. Agents receive a structured, self-explanatory `approval_required` payload and retry after approval.

## Testing Strategy

Unit: identity mint/resolve/revoke (hashing, no plaintext at rest), tier enforcement matrix (3 tiers × {no token, valid, consumed, wrong-input-hash, expired, ceiling-capped}), approval lifecycle, marketplace-provider migration (existing confirmation tests pass on the new primitive). Integration: invoke endpoint + both MCP paths return `approval_required` for destructive without token; grant→retry succeeds; Activity attribution asserted. Conformance: extend `capabilityConformance` — every `destructive` capability's adapter path must call the enforcement seam (seeded-drift test proves it can fail). Evals: 3.6 case (docker tier when available, child-process otherwise). CI: the new workflow's structural job green on this PR itself.

## Performance Considerations

Token resolution is one indexed lookup per request with identity present, none otherwise; approval store is SQLite with TTL cleanup piggybacking existing maintenance cadence.

## Security Considerations

Tokens stored hashed; never in `agent.json`, never in tool results (extend the redaction test to cover `DORKOS_AGENT_TOKEN` if config-adjacent); approval tokens single-use + input-hash-bound (no confused-deputy replay with different arguments); enforcement lives server-side at the choke points so a modified client/skill cannot bypass; denied attempts are audited. The invoke endpoint remains sessionGate-guarded; identity never substitutes for transport auth.

## Documentation

Per 3.6.

## Implementation Phases

Single phase; decomposition in `03-tasks.json`.

## Open Questions

- ~~Should identity be enforced (agent must present a token)?~~ **(RESOLVED)** No: absent identity = today's behavior. Rationale: mandatory identity breaks external MCP clients and human CLI use; attribution + tier gating deliver the value without a breaking change.
- ~~Approval persistence?~~ **(RESOLVED)** SQLite table (derived data, not user-owned files). Rationale: approvals are operational state like tasks runs, not identity like `agent.json`.
- ~~Docker tier in per-PR CI?~~ **(RESOLVED)** No: docker-in-CI cost and flake risk; per-PR stays test-mode structural; docker is local + nightly/dispatch. Rationale: eval-harness spec's cadence intent, honest about CI budget.

## Related ADRs

260723-050220 (invoke endpoint is the enforcement choke point — this spec discharges its "tier enforcement must target this endpoint first" consequence), 260723-013236 (redaction invariant extends to agent tokens), ADR-0304 (marketplace transaction; its confirmation seam migrates), eval-harness spec (DOR-357) Phase 5.

## References

- `research/20260722_agents-as-first-class-operators.md` §Pillar 4, §4
- `specs/capability-registry/04-implementation.md` (the choke points)
- `specs/eval-harness/02-specification.md` (isolation seam + cadence design)
- `apps/server/src/services/marketplace-mcp/` confirmation providers (the seam being generalized)
