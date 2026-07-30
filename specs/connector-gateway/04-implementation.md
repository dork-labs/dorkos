# Implementation Record: ConnectorProvider Gateway

**Created:** 2026-07-29 (record backfilled; the work shipped 2026-07)
**Spec:** specs/connector-gateway/02-specification.md (id 260718-050609, DOR-371)

## Status

Complete. All 13 tasks in `03-tasks.json` shipped in July 2026 under DOR-371, across six PRs (#392–#410). This record was written at program close-out; the tasks file's statuses were backfilled to `completed` at the same time.

## PRs per phase

| Phase | PR   | What shipped                                                                                                                                                                                                                                                                                        |
| ----- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | #392 | The Zod-first `ConnectorProvider` port (`@dorkos/shared/connector-provider`), the `connectorConformance` suite + `FakeConnectorProvider` in `@dorkos/test-utils`, and the raw-MCP baseline adapter (single-account, custody `external`).                                                            |
| P2–P3 | #400 | The custody-disclosure module (ADR `260718-045630` canonical sentence pinned byte-verbatim by test), the `connected_accounts` derived-cache table, `ConnectorRegistry` with id → provider routing, `recommendConnector` (relay adapter > gateway > raw-MCP), and the `/api/connectors` REST routes. |
| P4    | #404 | Per-account session tool servers through the `setMcpServerFactory` seam — two Gmail accounts are two distinct tool servers; the null branch (expired/revoked) surfaces as a per-account warning, never a throw.                                                                                     |
| P5    | #406 | The Composio managed-custody adapter (API key via the encrypted `CredentialStore`, reference-only beyond it).                                                                                                                                                                                       |
| P6    | #408 | The `adapterType: 'connector'` packaging convention, connector setup guides, and the two W4 connector evals.                                                                                                                                                                                        |
| P7    | #410 | The build-time self-host re-check and the Nango self-host adapter (encryption-key refusal semantics: configured-but-unsafe refuses loudly).                                                                                                                                                         |

## How the gateway became user-facing

This spec deliberately shipped the seam, not the cockpit: at its close the backend was complete and conformance-tested, but no code path wrote the vendor keys its providers gate on, providers were built once at boot, agents had no connector tools, and there was no UI. That user-facing half was specced and shipped separately as **`specs/connector-completion`** (2026-07-29, PRs #606/#611/#614/#615 plus the sibling `specs/user-profile-onboarding` PR #608) — credential write path with live provider reload, the `/connections` page, the seven agent-facing MCP capabilities, the Nango Proxy→MCP wrapper (DOR-415), discovery, truthful docs, and Playwright proof. See `specs/connector-completion/04-implementation.md`.
