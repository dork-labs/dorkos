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
  - **A path-trust copy that declares `connections` never gets a card.**
  - **Test:** edit `server.js`, and the next read is refused.
- **N2. Grants key on the approved install, not the bare id.** Once the global copy's run approval is gone without an uninstall, a project copy with the same id could take over its grant (`extension-discovery.ts`), and `create_extension` copies are approved automatically.
  - Key `extension_connection_approvals` on **scope, real path, origin and digest**, and check the match on every call.
  - **Test:** a same-id project copy gets nothing (with Q2).
- **N3. A change of runtime, install or approval revokes the grants**, rather than only refusing them.
  - **Test:** a grant-holding subprocess copy is replaced by an in-process one, and **both** its grant rows **and** its approval rows get `revoked_at`.

## Open questions, decided

- **Q1. Code-only update:** no separate pause, and nothing carries over silently. Grants follow the digest a person last approved. New files mean a re-approval card that says "still reads your Linear". Path-trust and dev-link copies hold no grants.
- **Q2. Reinstall from another source:** a new install that asks again. The same-id project copy joins the test.
- **Q3. Disable keeps grants:** yes, but only for the same install (N2, N3).
- **Q4. `--no-experimental-sqlite`:** Security ran it on Node 24.14.1 and 22.23.3. It blocks `require`, `import()` and `getBuiltinModule`. `NODE_OPTIONS` can't turn it back on, and `process.binding` is already denied under `--permission`, so no loader hook is needed. **Phase 2 still owes the proof on 24.19, in CI.**
- **Q5. Result size:** cap reads at 8 MB and refuse anything bigger with a typed error. Never truncate.
- **Q6. Network:** no `allow.net` ban, but the card names **every** place the data can go: `allow.net`, the extension's agent tools, `allow.agents`, its data proxy, and its HTTP routes.
- **Q7. Whose extensions:** v1 grants only to core or trusted-source copies, or digest-pinned copies a person approved. Never to path-trust, dev-link or `create_extension` copies. Only a person can set the flag that widens this, never `config_patch` or any agent capability.

## Shoulds

- **S1.** Design §1.2 adds: until DOR-3293 ships, any extension's page code can call Flow's `/api/ext` routes.
- **S2.** The broker refuses an extension principal unless that child's `hello` said sqlite can't load. Then the order of phases 2 and 4 can't slip at merge time.
- **S3.** Linear text reaches agents through Flow's tools, `ctx.agent`, posts and files with no outsider mark, and lets an agent with no Linear grant read Linear. The card says so, and it gets a ticket.
- **S4.** "It can't change anything" relies on the provider's `read` label. v1 either keeps to slugs we've audited or softens the copy.
- **S5.** A mini app's read is decided only on one page outside the app (Security, Nov 8, replacing the earlier "on Settings" wording). Every page inside the app runs mini app code in the same window and shares its `fetch`, so the server can't tell a mini app's call from the person's there.
  - **The page:** `GET /api/connectors/mini-app-access/page` (`routes/mini-app-access-page.ts`), rendered by DorkOS with its own static script and styles only. It answers only a real page load (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode: navigate`), never a `fetch` or a frame, and only for the owner (`resolveConnectorOperator`). Its headers: a CSP that loads nothing else (`form-action 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`), COOP `same-origin`, `no-store`, `nosniff`, `Referrer-Policy: no-referrer`.
  - **Cards elsewhere only link** to it, with no button and no decision in the link. The page re-reads the request from the server.
  - **The token:** one per rendered page, single use, five minutes, stored hashed, carried in the body. It is bound to the read, the person's session, an `HttpOnly`, `SameSite=Strict` cookie only that page's response set, and the mini app's files when the page rendered: a change refuses the decision.
  - **The decision POST** also needs `Sec-Fetch-Site: same-origin` and DorkOS's own `Origin`, and passes `resolveConnectorOperator`, which refuses any agent, program or approval token.
  - **M-A, service workers:** the server refuses every `Service-Worker: script` fetch except DorkOS's own `/sw.js` (`middleware/service-worker-guard.ts`), and never sends `Service-Worker-Allowed`. DorkOS's worker intercepts no request; a guard test fails the day it does without passing this page to the network.
  - **M-B, click timing:** Allow and Not now start off and turn on only after the page has been visible and focused for a second, starting over whenever it isn't. They take only a press that began after that, so a steered click or a held key does nothing.
  - **Should, not done:** `Sec-Fetch-User: ?1` on the page load. The card opens the page with `location.assign` from a click; whether that counts as a user navigation differs by browser, so it isn't required.
  - **The card names the author:** who made the extension, and the source its trusted copy came from, so the person sees whose code they are trusting.
- **S6.** Audit rows carry the connection id, the operation revision and a hash of the arguments.
- **S7.** Contract tests refuse `extension` with `every_agent`, and `extension` with a write. **Only the schema half landed in phase 1** (`packages/cloud-api/src/__tests__/contract.test.ts`, "extension grants"). Nothing on the Cloud side uses `ConnectionGrantCoverageSchema` yet, so **the Cloud-side refusal test is still owed in phase 6.**

## From the #3537 review (phase 4)

- **C1. Only a person's yes is a digest origin** (round 2: a positive marker that fails closed). `approveToRun` writes `personApprovedDigest`, and a copy is `digest_pinned` only while that equals the digest it is pinned to. Every pin DorkOS writes on its own has none or a stale one: a `create_extension` approval (also stamped `autoApprovedBy`), one written before the marker existed, a path-trust re-pin (`{ ...source, digest }`), and an upgrade pin (`pinnedOnFirstUse`). A person approves again to lift it.
- **C2. A change while the app answers.** The checks run again when the answer comes back. If access changed meanwhile (a revoke, a stopped child, other files) or the extension was stopped, the answer is kept from the extension and the usage row says `AUTHORITY_CHANGED_AFTER_DISPATCH`. That one request already reached the app; it only reads, so nothing changed there. Stopping the extension also aborts a read in flight.

## Phase map after the conditions

1. **Contract** (`cloud-api`): the `extension` subject, a typed subject reference, the read-only rule, S7's schema tests. An agent's hosted call can't name `extension`.
2. **Sandbox guard:** `--no-experimental-sqlite`, the require guard, the self-check, the M3 fixture, Q4's proof on 24.19 in CI.
3. **Local grant subject + migration**, alone in its PR, with M4's trigger or rebuild and the raw-insert test.
4. **Broker + ctx**, after N1 to N3 (with their tests, the N3 replace-in-process one included), with S2, S5, S6, Q5 and **Q7** (who can hold a grant, and only a person sets the flag).
5. **Card and UX**, with Q6, S3 and S4.
6. **Cloud deploy**, with **S7's Cloud-side refusal test**.
7. **Flow switches.**
