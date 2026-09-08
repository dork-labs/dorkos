# Connections runtime-turn lease renewal tasks

Canonical task data lives in [`03-tasks.json`](./03-tasks.json). This decomposition records the
implemented phases for
[DOR-1903](https://linear.app/dorkspace/issue/DOR-1903/design-uninterrupted-connections-credential-renewal-across-runtimes),
a follow-up to the approved [Connections specification](../white-label-connections/02-specification.md).
The lasting same-bearer decision is recorded in accepted ADR
[260908-153657](../../decisions/260908-153657-a-live-runtime-turn-renews-connections-authority-through-its-process-owner.md).

| Phase | Deliverable                                                                               | Depends on |
| ----- | ----------------------------------------------------------------------------------------- | ---------- |
| 1.1   | Opaque process-owned permit, canonical authority revalidation, and expiry compare-and-set | —          |
| 2.1   | Shared clock-driven supervisor attached to each runtime's real active-turn owner          | 1.1        |
| 3.1   | Multi-day cross-runtime, restart, execution, and public-seam proof                        | 1.1, 2.1   |

## Frozen policy

- The lease horizon stays four hours. The exact runtime-owned supervisor renews the same bearer one
  hour after each committed renewal point, scheduling from the returned expiry.
- There is no new absolute run cap or configuration. A legitimate productive turn may run for days.
- Bearer requests, session records, transcripts, thread IDs, sidecars, and MCP registrations never
  count as liveness and never renew authority.
- Cancellation, terminal/error teardown, restart, expiry, and changed canonical authority close the
  permit permanently. No durable state can reconstruct it.
- Renewal is server bookkeeping. It never retries a provider call, records billable usage, or emits
  hourly user activity.
- Codex keeps its fixed child environment, OpenCode keeps its directory-scoped registration, and
  Claude Code keeps its in-process path.
- A stolen bearer can remain usable while the legitimate days-long turn renews, but only for four
  hours after its last legitimate renewal. Bearer traffic cannot prolong it.

The work landed in order. Phase 1 established the authority primitive. Phase 2 attached one shared
supervisor without flattening the runtime adapters. Phase 3 proved the composed boundary through
each runtime's actual capability seam before publication.
