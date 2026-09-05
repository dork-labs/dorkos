# DorkOS Connections implementation record

**Spec:** `specs/white-label-connections/02-specification.md`  
**Umbrella:** DOR-1792  
**Project:** DorkOS Connections  
**Branch:** `codex/connections-program`  
**Status:** In progress — 0/7 workstreams complete  
**Updated:** 2026-09-05

## Prerequisites and related work

| Item    | Role                                                                              | State                                                                   |
| ------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| DOR-738 | Independent prerequisite: raw MCP must verify authenticated initialization        | In progress in `codex-connections-mcp-verification`; not counted in 0/7 |
| DOR-740 | Existing issue reused and respecified for workstream 6 agent request/grant/resume | Planned                                                                 |

## Initial worker roster

| Role                                                 | Owner                                | Scope                                                                    |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Programme orchestration and architecture audit       | Root Codex agent                     | Integration boundaries, tracker projection, worker dispatch, final gates |
| Ideation, specification, decomposition, proposed ADR | `spec_author`                        | Frozen artifacts through independent review                              |
| Workstreams 1–7                                      | Unassigned; tracker issues projected | One isolated worktree/writer per implementation branch                   |
| Adversarial review                                   | Separate reviewer per branch         | Independent review before PR creation                                    |

## Workstream status

| ID  | Workstream                          | Tracker                                                                                                                        | State   | Evidence |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | -------- |
| 1.1 | Contracts and migration             | [DOR-1793](https://linear.app/dorkspace/issue/DOR-1793/white-label-connections-p1-stable-provider-instance-connection-grant)   | Pending | —        |
| 2.1 | Authorization, execution, and usage | [DOR-1794](https://linear.app/dorkspace/issue/DOR-1794/white-label-connections-p2-enforced-connector-execution-across-dorkos)  | Pending | —        |
| 3.1 | Complete local experience           | [DOR-1795](https://linear.app/dorkspace/issue/DOR-1795/white-label-connections-p3-complete-connections-management-access)      | Pending | —        |
| 4.1 | Managed tenant service              | [DOR-1796](https://linear.app/dorkspace/issue/DOR-1796/white-label-connections-p4-tenant-scoped-managed-connector-service-in)  | Pending | —        |
| 5.1 | Managed and BYO events              | [DOR-1797](https://linear.app/dorkspace/issue/DOR-1797/white-label-connections-p5-signed-managed-and-byo-event-ingress-with)   | Pending | —        |
| 6.1 | Agent request, grant, and resume    | [DOR-740](https://linear.app/dorkspace/issue/DOR-740/white-label-connections-p6-respec-dor-740-for-private-agent-requests)     | Pending | —        |
| 7.1 | Rollout and production evidence     | [DOR-1798](https://linear.app/dorkspace/issue/DOR-1798/white-label-connections-p7-remove-legacy-paths-verify-all-surfaces-and) | Pending | —        |

Root takes ownership of this record after the specification and task decomposition freeze. Implementation PRs must add verification evidence here without marking managed production capabilities available before the separate real provisioning smoke passes.

The first independent specification review corrections are incorporated in the tracked artifacts; changed findings await re-review before implementation dispatch.
