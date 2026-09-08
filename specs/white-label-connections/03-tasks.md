# DorkOS Connections implementation tasks

Canonical task data lives in [`03-tasks.json`](./03-tasks.json). The programme is seven independently reviewable, complete workstreams under [DOR-1792](https://linear.app/dorkspace/issue/DOR-1792/deliver-dorkos-connections-managed-and-byo-accounts-agent-access-usage).

| Workstream | Status      | Tracker                                                                                                                        | Deliverable                                                                                                    | Depends on          | Can overlap with |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------- |
| 1.1        | Merged      | [DOR-1793](https://linear.app/dorkspace/issue/DOR-1793/white-label-connections-p1-stable-provider-instance-connection-grant)   | Stable identities, immutable operation revisions, typed reviews, durable event inbox, and ledgered migration   | —                   | —                |
| 2.1        | Merged      | [DOR-1794](https://linear.app/dorkspace/issue/DOR-1794/white-label-connections-p2-enforced-connector-execution-across-dorkos)  | One enforced execution and usage path for DorkOS MCP, REST, and scoped CLI                                     | 1.1                 | —                |
| 3.1        | Merged      | [DOR-1795](https://linear.app/dorkspace/issue/DOR-1795/white-label-connections-p3-complete-connections-management-access)      | Complete local management, Transport, CLI review handoff, access presets, usage, and responsive Connections UX | 1.1, 2.1            | 4.1              |
| 4.1        | Merged      | [DOR-1796](https://linear.app/dorkspace/issue/DOR-1796/white-label-connections-p4-tenant-scoped-managed-connector-service-in)  | Tenant-scoped managed connector routes and data in `apps/site`, including verified single-use account linking  | 2.1                 | 3.1              |
| 5.1        | Merged      | [DOR-1797](https://linear.app/dorkspace/issue/DOR-1797/white-label-connections-p5-signed-managed-and-byo-event-ingress-with)   | Signed hosted/local ingress, protected restart-safe inboxes, receipts, and one durable routing worker          | 2.1, 4.1            | 6.1              |
| 6.1        | Merged      | [DOR-740](https://linear.app/dorkspace/issue/DOR-740/white-label-connections-p6-respec-dor-740-for-private-agent-requests)     | DOR-740 respec: private agent request, operator auth/grant, live hold, and restart-safe resume                 | 2.1, 3.1, 4.1       | 5.1              |
| 7.1        | In progress | [DOR-1798](https://linear.app/dorkspace/issue/DOR-1798/white-label-connections-p7-remove-legacy-paths-verify-all-surfaces-and) | Legacy removal, full integration evidence, docs, and per-capability production provisioning gate               | 1.1–6.1 and DOR-738 | —                |

## Frozen acceptance boundaries

- Stable public IDs never expose provider account IDs, users, sessions, auth configs, credentials, or execution URLs.
- Provider execution always names one connection and one immutable operation revision containing the reviewed provider version, schema hash/input schema, and classification; usage references that revision. Agents never receive a provider MCP endpoint.
- The API-key CLI executes only through `--agent`. Operator mutations become versioned, discriminated, validated review actions and wait for browser authority; omission never grants operator status.
- Read presets resolve to reviewed operation-revision IDs. Advanced mode is available, and new or reclassified revisions default off.
- Managed and BYO provider instances coexist. Managed identity derives from Better Auth plus a verified linked-instance key; all hosted rows and callbacks are tenant scoped.
- Managed events retain normalized protected payload and restart-safe retry/lease state in the hosted inbox. BYO events persist the same local inbox before ACK and work without cloud linking; receipts audit delivery transitions without owning payload/retry state.
- Removing an agent revokes agent and session-specific operation grants and receive subscriptions by default. Removing an operation-only grant does not stop a separately authorized event; subscription/receive revocation does.
- Production readiness requires real project, OAuth/auth-config, callback, webhook, deployment, execution, usage, and revocation evidence. Hermetic tests cannot satisfy that external gate.

The critical implementation paths are `1.1 → 2.1 → 3.1 → 6.1 → 7.1` for the operator/agent experience and `1.1 → 2.1 → 4.1 → 5.1 → 7.1` for managed hosting and events. Workstreams 3.1 and 4.1 can start together after execution. Workstreams 5.1 and 6.1 can start together after their prerequisites.

## Related work

- **DOR-738** merged as the prerequisite that replaced raw-MCP false authentication success with a real protocol check. Workstream 7 adds restart durability without widening raw MCP into execution.
- **DOR-740** merged as workstream 6. Its Connections naming, tool guidance, session group, “Ask your agent,” and entry points remain, while its raw agent start-connect instruction is replaced by operator-owned authentication and grant resolution.

Each workstream is complete only when its behavioral acceptance tests pass. Schemas, empty routes, unavailable test seams, or UI shells alone do not complete a workstream.
