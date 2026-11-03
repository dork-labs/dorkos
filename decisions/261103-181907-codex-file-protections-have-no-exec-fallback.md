---
id: 261103-181907
title: Codex file protections have no exec fallback
status: accepted
created: 2026-11-03
spec: codex-app-server-transport
superseded-by: null
amends: 261005-113107
---

# 261103-181907. Codex file protections have no exec fallback

## Status

Accepted for DOR-3595. Amends ADR [261005-113107](261005-113107-codex-runs-on-app-server.md): retires “Exec stays as a fallback” and its two-transports consequence. The process pool, thread keys, credits relay, approval channel and remaining lifecycle decisions still govern. Config changes now reload the thread before its next turn rather than waiting for its process to become idle.

## Context

Every Codex turn must keep shared secret-read and person-only write refusals, including Full access. The pinned 0.163.0 exec CLI has no explicit permission-profile selector; a loaded legacy sandbox setting can override a default profile. App-server can explicitly select the profile on both thread load and turn start, and reports which profile it loaded. Ignoring the person's configuration for exec would also discard their provider and tool settings.

## Decision

We will run every saved transport setting, including `exec`, through protected app-server. We will remove the SDK exec launcher and refuse the session if app-server cannot start, with no bare-exec fallback. Each load carries a named profile derived from the shared table, requires the matching profile acknowledgement, and reloads changed tools or file policy before the next turn.

## Consequences

### Positive

- A saved exec setting cannot bypass file denials or managed-server holds.
- Own-sign-in configuration stays in the person's existing home; credits keep the existing separate home and relay.
- There is one production launch path to review and maintain.

### Negative

- An app-server failure cannot be worked around by selecting exec.
- Existing exec users gain app-server lifecycle and capabilities after restart.
- Wildcard write carve-outs are denied completely where the pinned binary cannot express read-only wildcard rules; Linux and Windows glob enforcement retains upstream process-start snapshot limits.
