# Extensions read DorkOS Connections (DOR-3547)

**Status:** design, for Security's read (Sun Nov 8, 12:00 CT). Nothing is built until Security passes it.
**Owner:** DorkOS Code. **Cloud contract:** DorkOS Cloud. **Acceptance:** DorkOS QA's four tests (§8.3).
**Read against:** `origin/main` at `86fd030ced`. Code was read, not run.

## The gist

A mini app (an extension) can read from an app a person connected, like Linear, without holding a token and without an agent in between.

1. The extension's manifest lists the services and the exact **read** operations it wants.
2. When a person enables it, **one card** asks: "Flow's code can read your Linear projects." They pick the account and say yes or no.
3. The extension's server half calls `ctx.connections.read(operation, params)`. DorkOS checks the grant, makes the call, and logs it under the extension's name.
4. Only extensions in the **subprocess runtime** can hold a grant. DorkOS knows who is calling from the process it started, never from anything in the call.
5. Revoke or uninstall, and the next call fails. Nothing is left behind.

Why this shape and not a hidden agent per app (PM call, Nov 7): the audit trail must say "Flow read Linear", and agent-turn rules (marks, levels, sessions) don't fit code. Why not an agent task at all (QA, Nov 7): an agent turn reads outside text that can steer a model, a task outlives the extension, and it costs a model turn per refresh.

## 1. Shape

### 1.1 Manifest

A new optional field on `serverCapabilities`, beside `runtime` and `allow` (`packages/extension-api/src/manifest-schema.ts`):

```jsonc
"serverCapabilities": {
  "serverEntry": "./server.js",
  "runtime": "subprocess",
  "allow": { "net": ["api.github.com"] },
  "connections": [
    {
      "service": "linear", // a toolkit id, as the connections catalog names it
      "access": "read", // the only value accepted in this version
      "operations": ["LINEAR_LIST_LINEAR_PROJECTS", "LINEAR_GET_LINEAR_PROJECT", "LINEAR_LIST_PROJECT_UPDATES"],
      "why": "Shows each project's health on the Owner view." // optional, ≤ 120 chars, shown on the card
    }
  ]
}
```

Schema rules (Zod, strict, checked in `checkIsolationDeclarations`):

- `connections` is refused unless `runtime` is `"subprocess"`. An in-process extension that declares it fails validation at load, with an error that says to move to the subprocess runtime.
- `access` is `z.literal("read")`. `"read-write"` and anything else is refused until a later version designs it.
- `operations` is 1 to 32 operation slugs per service, no duplicates. At most 8 services.
- `service` appears once per manifest.
- Slugs are names, not revisions. The grant binds to the reviewed revisions at approval time (§3.3).

The old reserved `permissions: string[]` slot stays unused. A typed field under `serverCapabilities` is clearer and sits with the rest of the server half's declared reach.

### 1.2 Server API

`DataProviderContext` (`packages/extension-api/src/server-extension-api.ts`) gains an optional member:

```ts
interface ExtensionConnectionsApi {
  /**
   * Run one declared, granted read operation through DorkOS. DorkOS picks the
   * granted account, makes the call and returns the provider's result. The
   * extension never sees a token.
   */
  read(operation: string, params?: Record<string, unknown>): Promise<ConnectionReadResult>;
  /** What this extension may call right now: per declared service, granted or not and on which account label. */
  status(): Promise<ExtensionConnectionStatus[]>;
}
```

- `read` takes no caller id, no connection id and no session id. There is nothing in the call that names who is calling (§2).
- If a person granted two accounts for one service (not allowed in v1, see §5), the call would be ambiguous; v1 grants exactly one account per service, so `read` needs no account argument.
- Errors are typed, with stable codes the extension can branch on: `EXTENSION_CONNECTION_NOT_DECLARED`, `EXTENSION_CONNECTION_NOT_GRANTED`, `EXTENSION_CONNECTION_NOT_READ`, `EXTENSION_CONNECTION_UNAVAILABLE` (account paused or signed out), plus the broker's existing provider errors.
- `ctx.connections` exists only in the subprocess runtime. The in-process ctx has no `connections` member (probe with `ctx.connections !== undefined`, like other newer members).
- **Page code never reaches it** (DOR-3293). The client-half `ExtensionAPI` gets no connections member and the data proxy exposes no route for it. A page that wants the data asks its own server half, which decides what to return.

Flow's use: `ctx.schedule(3600, async () => { const r = await ctx.connections.read("LINEAR_LIST_LINEAR_PROJECTS", {...}); /* write snapshot to filesDir */ })`.

## 2. Identity

**Rule:** a connection grant goes only to an extension that runs in the subprocess runtime. The broker learns the extension's id from the child process DorkOS spawned, never from the call.

How that holds in today's code (`apps/server/src/services/extensions/isolation/`):

- There is one `IsolatedExtensionHost` and one `CtxDispatcher` per child process, each built for one extension id. IPC messages carry no extension id; the dispatcher answers with the real ctx it was built with. So identity is by construction.
- `connections.read` is added to `CTX_PROTOCOL` (`ctx-protocol.ts`) as a `call` member with a new gate, `gate: 'connections'`. The host-side gate check refuses it unless the extension's validated manifest declares `connections` and the process is the subprocess runtime. The table `satisfies ProtocolFor<DataProviderContext>`, so the new member cannot be forgotten.
- The host side, not the child, builds the principal: a new `extension` kind in `ServerPrincipalClaims` (`connectors/principal/server-principal.ts`), `{ kind: 'extension', owner, extensionId }`, minted by `createServerPrincipal` inside the dispatcher's handler. Principals are authentic only through that module's private WeakSet, so the child cannot forge one.
- **In-process extensions are refused** at three points: manifest validation (§1.1), no `connections` member on their ctx, and the authorization service refuses an `extension` principal whose extension is not running isolated right now (checked against the live host registry, not the manifest).

Why in-process can't work: an in-process server half shares the DorkOS server's memory with no boundary. It could import the broker or forge any agent, so "extension:flow" would mean nothing there.

**Flow today runs in-process** (flow-owner 0.1.0 sets no `runtime`). Moving it to `runtime: "subprocess"` is the first step of Flow's side (§8.2, phase 7).

## 3. Grant model

### 3.1 A typed `extension` subject

`connection_operation_grants.subject_type` gains `'extension'` (`packages/db/src/schema/connectors/connections.ts`):

| subject_type  | subject_id    | agent_id | extension_id (new column) |
| ------------- | ------------- | -------- | ------------------------- |
| `agent`       | agent id      | agent id | null                      |
| `session`     | session id    | agent id | null                      |
| `every_agent` | `every_agent` | null     | null                      |
| `extension`   | extension id  | null     | extension id              |

- A typed column, never a prefixed string like `extension:flow` in `agent_id`. A check constraint (or the store's insert guard, if the migration tool can't add one) pins: `subject_type = 'extension'` ⇔ `extension_id IS NOT NULL AND agent_id IS NULL`. So an agent can't be named into an extension's grant, or the reverse.
- Extension ids and agent ids live in different namespaces (`EXTENSION_ID_REGEX` vs ULIDs), but the design doesn't lean on that: the subject type is always matched first.
- `connection_access_levels` is **not** extended. Extensions don't get a Read or Read-write level; they get exactly the operations they declared, nothing more. This keeps "follow new operations at my level" from ever reaching an extension.
- One migration in `packages/db/drizzle/`, named like `<timestamp>_dor3547_extension_grant_subject.sql`: widen the enum, add `extension_id`, add an index on `(extension_id)`, add a new table `extension_connection_approvals` (§4.1).

### 3.2 `every_agent` never covers an extension

- `agentGrantScope` (`connectors/execution/agent-grant-scope.ts`) stays agent-only and never matches `extension` rows.
- A new `extensionGrantScope(extensionId)` returns exactly `subject_type = 'extension' AND extension_id = ?`. It has no `every_agent` branch and no session-override branch.
- An extension can't hold an `every_agent` grant, and the every-agent card and "Trusted" sharing (PR5) never create `extension` rows.

### 3.3 Read-only, bound to reviewed revisions

- The authorization service gets an `extension` branch in `resolveActor`. It resolves to `{ kind: 'extension', extensionId }`, not an agent.
- The checks in `prepareResolved` stay in the same order (owner, readiness, classification, toolkit, grants), plus two extension rules:
  - the capability must be `connectors.execute_read` and the revision's `capability_classification` must be `read`; write and destructive are refused with `EXTENSION_CONNECTION_NOT_READ` before any grant lookup;
  - the operation slug must be in the manifest that is running now (the host passes its validated declaration, not the child).
- A grant row names an exact operation **revision**. When the provider ships a new revision of a declared slug, it stays off until a person reviews it, the same rule agents and Cloud already follow ("a new or changed revision stays off until the owner reviews it"). The extension sees `EXTENSION_CONNECTION_NOT_GRANTED` with a hint, and the Connections row shows "Flow needs a fresh OK for Linear".
- The authority digest and the synchronous recheck before dispatch (`recheckPreparedSynchronously`) cover extension grants the same way, so a revoke between prepare and dispatch still stops the call.

## 4. Security's five lines

### 4.1 Bound to the extension's id and its declared operations

- Grants are rows per `(extension_id, connection_id, operation_revision_id)`.
- New table `extension_connection_approvals`, one row per `(extension_id, service)`: `connection_id`, `approved_operations_digest` (sorted slugs), `approved_version`, `approved_files_digest` (the run-approval digest the extension manager already pins, `pinnedDigest`), `approved_by`, `approved_at`.
- **On update**, the extension manager compares the new manifest against the approval:
  - **Operations added:** the added ones are not granted. A new card asks for just those ("Flow 0.2.0 also wants to read Linear issues"). The ones already granted keep working.
  - **Operations removed:** their grants are revoked at load.
  - **Code changed, same operations:** grants stay. The Connections row and the extension's entry show "Flow updated to 0.1.4. It still reads your Linear projects." with a one-tap Revoke. This mirrors the existing agent-tools declaration digest (`extensionDeclarationDigest`), which re-asks on a declaration change.
  - **Service added:** a new card for that service.
- Someone else's extension with the same id (reinstall from another source) is a different install record and run approval; approvals key on the install, so its grants are dropped and it asks again. (Open question Q2.)

### 4.2 Refused at the broker, not in the extension

- Every check in §3.3 runs host-side in the authorization service. The child holds no list it could edit and no flag it could flip.
- The child's `ctx.connections.read` is a thin IPC call; its only job is to send `(operation, params)`.
- An undeclared slug, a write slug, or a slug declared but not granted are all refused by the broker with a typed error and an audit row with `outcome = refused` (QA test 1 and 2).

### 4.3 Plain card copy

- Title: **"Flow's code can read your Linear projects"**. "Code" on purpose: the trust is in the extension's code, since its server can send data anywhere its `allow.net` permits.
- Body (≤ 15 words per block, `writing-app-copy`): the account picker, the extension's `why` line, and "It can't change anything in Linear."
- A "See what it reads" disclosure lists the operations in plain words, from the catalog's display names.
- If the extension's `allow.net` names hosts, the card says so: "It can also reach api.github.com." That's the honest picture of where the data could go.
- Buttons: **Allow** and **Not now**. No "Always". No Read-write option.

### 4.4 Audited under the extension's id

- `connector_usage` gains `actor_kind = 'extension'` and `surface = 'extension'`; `actor_id` is the extension id and `agent_id` and `session_id` stay null.
- Activity and the Connections account panel read "Flow read Linear: list projects", with the extension's name and icon.
- Refusals are logged too, so a misbehaving extension shows up.
- Approvals and revokes go to the audit log with the person who made them.

### 4.5 Revoke and uninstall stop the next call; no token in the extension

- **Revoke** (Connections page, or the extension's entry): sets `revoked_at` on all of that extension's grants for that account and deletes the approval row. The next `read` is refused; one already past the recheck finishes, as for agents.
- **Disable:** the host stops, so `ctx.schedule` timers stop with it. Grants stay, so re-enabling needs no new card. (Open question Q3.)
- **Uninstall:** the uninstall hook beside `forgetToolPermissions` revokes every grant and approval the extension holds, and (for DorkOS-account connections) sends Cloud a revoke for each (§6). Timers died with the process, and an extension owns no tasks, so nothing is left scheduled (QA test 4).
- **Removing the account** already revokes every grant on it (`connection-store.ts`), extension rows included.
- **No token** ever crosses into the child. The broker makes the provider call in the server process and returns only the result. The child's env stays scrubbed (`buildChildEnv`).

## 5. Approval UX

- **One card, on enable.** Enabling an extension whose manifest declares connections raises one card per service, in the same flow as its other enable approvals (Extensions settings, or the Marketplace install). If the person dismisses it, the extension runs without connections, and `ctx.connections.status()` says "not granted".
- **No chat needed.** The card is a `connector_review_requests` row with a new `requester_kind = 'extension'`, `extension_id` set and `session_id` null. It is not a `connector_agent_requests` row (that table's `session_id` is NOT NULL and its whole flow is built from runtime claims). There is no session to resume: approving writes the grants, and the extension's next `read` just works.
- **Where it shows:** the enable flow, Needs you on the Connections page, and the extension's own settings entry. It never appears in a room.
- **Revocable:** each connected app's panel on Connections lists "Mini apps that can read this" beside its agents, with Revoke.
- **One account per service** in v1. The picker shows only accounts of that service the person owns. Changing the account is revoke plus a new card.
- **Rate:** the extension can't raise a card itself. Cards come only from enable and update, so there is no spam path.

## 6. Cloud contract

Accounts connected through DorkOS (custody `managed`) are checked again on Cloud. Flow's Linear is one of these, so Flow's switch waits on a Cloud deploy.

What Cloud told us, in contract terms (DorkOS Cloud's section, Nov 7):

- Cloud trusts the machine to say who is calling. So **the local broker is the first lock** and the one that enforces "only declared read operations" and "audited under the extension's id". **Cloud's check is the second lock.**
- A read grant on a DorkOS-account connection needs no Cloud owner page. The person's card for an extension's read is DorkOS's local card.

Contract changes in `packages/cloud-api`, landed contract-first (a DOR issue for the contract, then a CLD issue for Cloud):

1. `ConnectionGrantSubjectSchema` gains `extension`, with the extension id in its own typed field. Never a prefixed string in the agent-id field.
2. `every_agent` never covers an extension, and an extension can't hold an `every_agent` grant.
3. Extensions are read-only at first: a write or destructive operation for the `extension` subject is refused until its owner page is designed.
4. Uninstall sends revokes for every grant the extension holds; machine teardown already sweeps them. No token is kept in the extension.
5. Usage and log records name the subject kind and id ("extension flow"), not an agent.

Wire rules: a new enum member and a new optional field are a minor release under `/v1` (`packages/cloud-api/README.md`), and consumers must tolerate unknown members. Cloud must accept the new subject before any machine sends it, so the order is contract PR, Cloud deploy, then the app sends extension grants. Until the Cloud side is live, the app refuses extension grants on `managed` connections with a clear "not yet" rather than sending them.

The server's managed provider types its own literal `grantSubject?: 'agent' | 'every_agent'` (`connectors/providers/managed/managed-cloud.ts`); it switches to the contract's type so the two can't drift.

## 7. Blocker: `node:sqlite` in the subprocess runtime

**The hole (Security, proved Nov 6 on Node 24.19):** `node:sqlite` ignores `--permission`. A subprocess extension can open, read and write any SQLite file, `ATTACH` and `VACUUM INTO` included. Grants live in `dork.db`, so an extension could write itself a grant row and skip the broker. It is also a problem for everything else in `dork.db`, not only grants.

Today the child's `--allow-fs-*` grants and the `hello` self-check keep the extension away from `dorkHome` for ordinary fs calls, and `better-sqlite3` is unreachable (not a builtin, and addons are off). But `child/load-bundle.ts` passes every Node builtin through (`isBuiltin(name) → nodeRequire(name)`), so `node:sqlite` loads.

**The fix (pick (a), per the ticket):** close the hole for every extension, in layers:

1. **Node flag:** add `--no-experimental-sqlite` to the child's `execArgv` (`isolated-host.ts`), so the module doesn't exist in the child at all. This also stops `import()` and `process.getBuiltinModule()`, which a require shim can't. Verify the flag is honoured on the Node versions we ship (24.19 today); if it isn't, use (2) plus a startup probe that fails closed.
2. **Require guard:** `createInjectedRequire` refuses `node:sqlite` and `sqlite` by name with `ERR_EXTENSION_BUILTIN_REFUSED`. Belt and braces, and a clear error for authors.
3. **Self-check:** the child's `hello` reports whether `node:sqlite` is loadable; `selfCheckPassed` (`grants.ts`) kills the child if it is, the same fail-closed rule as `readsDorkHome`.

**Test:** an isolated extension fixture tries `require('node:sqlite')`, `await import('node:sqlite')` and `process.getBuiltinModule('node:sqlite')`, then opens the test `dork.db`. Every path must fail, and the test also proves the fixture really ran (a positive marker), so it can't pass by not running.

**Scope:** the general feature doesn't ship until the guard is in. Flow's read-only Linear doesn't wait for it (Security's note): until then a grant gives an extension nothing a hand-written row couldn't, which is acceptable for one first-party read but not for strangers' extensions.

**Later second lock:** unforgeable grants, rows the broker checks with a key only the server process holds, so a written row is ignored. Not in this work; filed as a follow-up.

**Also noted, not in scope:** in-process extensions can open `dork.db` with no limits at all. That's the existing in-process trust model; this design only makes sure they can't hold connection grants.

## 8. Files, phases and tests

### 8.1 Files likely touched

| Area                | Files                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract            | `packages/cloud-api/src/connections.ts` (+ `__tests__/contract.test.ts`)                                                                                                                                                                  |
| Manifest + API      | `packages/extension-api/src/manifest-schema.ts`, `server-extension-api.ts`, docs in `docs/` for extension authors                                                                                                                         |
| DB                  | `packages/db/src/schema/connectors/connections.ts`, `connector-usage.ts`, `connector-review-requests.ts`, new migration in `packages/db/drizzle/`, `drizzle.config.ts` if a new schema file                                               |
| Principal + authz   | `apps/server/src/services/connectors/principal/server-principal.ts`, `execution/authorization-service.ts`, new `execution/extension-grant-scope.ts`, `execution/execution-broker.ts` (usage record), `providers/managed/managed-cloud.ts` |
| Grants + requests   | new `extension-connection-grants` store/service under `services/connectors/`, the review-request service for `requester_kind = 'extension'`, revoke paths                                                                                 |
| Isolation           | `services/extensions/isolation/ctx-protocol.ts`, `ctx-dispatcher.ts`, `child/proxy-ctx.ts`, `isolated-host.ts`, `grants.ts`, `child/load-bundle.ts`                                                                                       |
| Extension lifecycle | `services/extensions/extension-server-api-factory.ts`, `extension-manager.ts` (enable, update diff, uninstall hook)                                                                                                                       |
| Client              | `features/connections/ui/` (card, account panel "Mini apps that can read this", Needs you), the extension settings entry, Activity row label                                                                                              |

### 8.2 Phases, one PR each

Every PR touches connectors, extensions or Cloud auth, so each opens with `hold` until Security OKs it.

1. **Contract PR** (DOR): `extension` subject + typed id field in `cloud-api`, with tests. Then the CLD issue.
2. **Sandbox guard** (§7): flag, require guard, self-check, `dork.db` test. Can run in parallel with 1.
3. **Local grant subject + migration:** schema, migration, `extensionGrantScope`, store, usage enums. No caller yet.
4. **Broker + ctx:** extension principal, authorization branch, `CTX_PROTOCOL` member and gate, `ctx.connections`, manifest field, typed errors, audit rows, uninstall and update handling.
5. **Card and UX:** enable-time card, Needs you, Connections panel list, revoke, update notice, Activity label.
6. **Cloud deploy:** Cloud accepts the `extension` subject (pre-approved by the PM once Security passes this design and the CLD PR is labelled). The app's "not yet on DorkOS-account connections" refusal comes off.
7. **Flow switches:** Flow moves to `runtime: "subprocess"`, declares its Linear reads, reads from `ctx.schedule`. Then `flow-snapshot`, its task, its pinned folder and its Linear grant are deleted.

### 8.3 Test plan

QA's four, as the acceptance bar, each against a real isolated fixture extension and a fake provider:

1. **An undeclared operation is refused** at the broker, with `EXTENSION_CONNECTION_NOT_DECLARED` and a refused audit row. The provider is never called.
2. **A write is refused on a read grant:** a write slug, even if declared by a hand-edited manifest, is refused at validation; and a read-declared slug whose revision is classified write is refused by the broker.
3. **Revoke stops the next run:** grant, run once (succeeds), revoke, run the next `ctx.schedule` tick (refused). Also a revoke between prepare and dispatch.
4. **Uninstall leaves nothing scheduled:** after uninstall, no timer fires, no grant or approval row is live, and (managed) a revoke was sent per grant.

Plus:

- An in-process extension that declares `connections` fails validation; one that doesn't has no `ctx.connections`.
- The child can't name another extension: a crafted IPC message with an `extensionId` field is ignored, and the audit row names the real extension.
- `every_agent` and agent grants never satisfy an extension call; extension grants never satisfy an agent call.
- An update that adds an operation leaves it refused until a new card is approved; the old operations keep working.
- A new operation revision stays off until reviewed.
- The `node:sqlite` test in §7.
- Page code: the client `ExtensionAPI` and the data proxy have no connections path (a type test and a route test).

## 9. Open questions

- **Q1. Should a code-only update pause grants until the person looks?** My pick: no. Show the "Flow updated, still reads Linear" notice with Revoke. Pausing would break every refresh on every patch, and the person already trusted this extension's code for this data. Security's call.
- **Q2. Reinstall from a different source with the same id.** My pick: treat it as a new install, drop grants, ask again. Needs a check that the install record really changes in that case.
- **Q3. Disable keeps grants?** My pick: yes, so re-enabling isn't a new card. Uninstall drops them.
- **Q4. `--no-experimental-sqlite` on Node 24.19.** Needs a proof run in phase 2. If it isn't honoured, the require guard plus fail-closed self-check carry it, and `import()` needs its own answer (a loader hook in the child).
- **Q5. Result size and shape.** Should the broker cap the result size it returns over IPC (for example 8 MB, like Flow's writer), and strip nothing else? My pick: cap, and return the provider's result as is.
- **Q6. Should `allow.net` be required to be empty for an extension holding a grant?** My pick: no, but the card names the hosts (§4.3). Requiring no network would block Flow's GitHub fetch, and the person sees exactly where the data could go before saying yes.
- **Q7. Strangers' extensions.** Marketplace code from strangers stays gated (AGENTS.md). Should v1 allow connection grants only for first-party or locally built extensions until the second lock lands? My pick: yes, behind a flag for others.

<!-- agent:provenance {"v":1,"harness":"claude-code","account":"claude4","surface":"dorkos"} -->
