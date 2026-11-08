# Security conditions on the DOR-3547 design

Security passed the design (`02-specification.md`, PR #3527) **with conditions** at `9976ef4fb3` on Nov 7, 2026. This file is the binding list. Where it and the design disagree, this file wins. The design file stays as Security read it, so that review still covers it.

**Gates:** phases 1 and 2 may start now. **N1, N2 and N3 block phase 4** (the broker and `ctx.connections`). Every phase PR opens with `hold` and waits for Security's own OK.

## Musts

| Id         | Rule                                                                                                                                                                                                                              | Where it lands                        | Proof                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1, M7, M8 | Subprocess only; audit under the extension id; revoke and uninstall stop the next call.                                                                                                                                           | Phases 4 and 5                        | The tests in design §8.3                                                                                                                                                  |
| M2         | Identity from the spawned child, never the call.                                                                                                                                                                                  | Phase 4                               | The crafted-IPC test (§8.3). S1 and S2 below finish it.                                                                                                                   |
| M3         | `node:sqlite` can't load in the child.                                                                                                                                                                                            | Phase 2                               | The fixture also tries `process.binding('sqlite')`, beside `require`, `import()` and `process.getBuiltinModule`. Plus S2.                                                 |
| **M4**     | The typed subject rule (`subject_type = 'extension'` ⇔ `extension_id` set and `agent_id` null) is enforced **by the database**. "Check constraint or insert guard" is not enough, and SQLite's `ALTER TABLE` can't add a `CHECK`. | Phase 3 (its own PR, migration alone) | A table rebuild with a `CHECK`, or `BEFORE INSERT` and `BEFORE UPDATE` triggers that `RAISE(ABORT)`. A test does a **raw SQL insert** that breaks the rule and must fail. |
| M5         | Read only.                                                                                                                                                                                                                        | Phases 1 and 4                        | See S4 and S7.                                                                                                                                                            |
| M6         | Bound to the extension and its declared operations.                                                                                                                                                                               | Phase 4                               | Needs N1 and N2.                                                                                                                                                          |

## New Musts (block phase 4)

- **N1. No grant for code that can change without a person.** A path-trust copy (agent-written, local, subprocess) can rewrite `server.js` with nobody clicking anything, so no "update" ever fires and the Q1 notice never shows.
  - Add `connections` to `grantsDigestOf` (`extension-path-trust.ts`).
  - Honour extension grants only on a trusted-origin or digest-pinned copy whose **live** digest equals `approved_files_digest`.
  - **Test:** edit `server.js`, and the next read is refused.
- **N2. Grants key on the approved install, not the bare id.** Once the global copy's run approval is gone without an uninstall, a project copy with the same id could take over its grant (`extension-discovery.ts`), and `create_extension` copies are approved automatically.
  - Key `extension_connection_approvals` on **scope, real path, origin and digest**, and check the match on every call.
  - **Test:** a same-id project copy gets nothing (with Q2).
- **N3. A change of runtime, install or approval revokes the grants**, rather than only refusing them.

## Open questions, decided

- **Q1. Code-only update:** no separate pause, and nothing carries over silently. Grants follow the digest a person last approved. New files mean a re-approval card that says "still reads your Linear". Path-trust and dev-link copies hold no grants.
- **Q2. Reinstall from another source:** a new install that asks again. The same-id project copy joins the test.
- **Q3. Disable keeps grants:** yes, but only for the same install (N2, N3).
- **Q4. `--no-experimental-sqlite`:** Security ran it on Node 24.14.1 and 22.23.3. It blocks `require`, `import()` and `getBuiltinModule`. `NODE_OPTIONS` can't turn it back on, and `process.binding` is already denied under `--permission`, so no loader hook is needed. **Phase 2 still owes the proof on 24.19, in CI.**
- **Q5. Result size:** cap reads at 8 MB and refuse anything bigger with a typed error. Never truncate.
- **Q6. Network:** no `allow.net` ban, but the card names **every** place the data can go: `allow.net`, the extension's agent tools, `allow.agents`, the data proxy and its routes.
- **Q7. Whose extensions:** v1 grants only to core or trusted-source copies, or digest-pinned copies a person approved. Never to path-trust, dev-link or `create_extension` copies. Only a person can set the flag that widens this, never `config_patch`.

## Shoulds

- **S1.** Design §1.2 adds: until DOR-3293 ships, any extension's page code can call Flow's `/api/ext` routes.
- **S2.** The broker refuses an extension principal unless that child's `hello` said sqlite can't load. Then the order of phases 2 and 4 can't slip at merge time.
- **S3.** Linear text reaches agents through Flow's tools, `ctx.agent`, posts and files with no outsider mark, and lets an agent with no Linear grant read Linear. The card says so, and it gets a ticket.
- **S4.** "It can't change anything" relies on the provider's `read` label. v1 either keeps to slugs we've audited or softens the copy.
- **S5.** Extension cards are decided only on the owner route, with a test.
- **S6.** Audit rows carry the connection id, the operation revision and a hash of the arguments.
- **S7.** Contract tests refuse `extension` with `every_agent`, and `extension` with a write. **Landed in phase 1** (`packages/cloud-api/src/__tests__/contract.test.ts`, "extension grants").

## Phase map after the conditions

1. **Contract** (`cloud-api`): the `extension` subject, a typed subject reference, the read-only rule, S7's tests. An agent's hosted call can't name `extension`.
2. **Sandbox guard:** `--no-experimental-sqlite`, the require guard, the self-check, the M3 fixture, Q4's proof on 24.19 in CI.
3. **Local grant subject + migration**, alone in its PR, with M4's trigger or rebuild and the raw-insert test.
4. **Broker + ctx**, after N1 to N3, with S2, S5, S6 and Q5.
5. **Card and UX**, with Q6, S3 and S4.
6. **Cloud deploy.**
7. **Flow switches.**
