# DorkOS Connections: UX and DX audit

**Snapshot:** `origin/main` at 6fd5cd3f9 (2026-09-28), plus open PR #2299. The audit was read-only.

**How it was done:** four parallel reads (server state model, client UI, the agent's side, and docs/design/Linear), then my own synthesis. I re-checked the claims that carry the most weight against the code; they are marked **[verified]**.

**Path shorthand:**

- `S/` = `apps/server/src/services/connectors/`
- `C/` = `apps/client/src/layers/`
- `sh/` = `packages/shared/src/`

---

## 0. The root cause, in one paragraph

The server never works out the one fact every surface needs: **"can agents use this account right now, and if not, what is the single fix and who can make it?"**

Instead it ships 5–6 raw fields (`lifecycle`, `authenticationStatus`, `reconciliationStatus`, `authoritySync`, `externalCleanup`, `mode`/`payer`), and each consumer rebuilds usability its own way. We found **at least 7 server predicates and 5 client predicates** (§4.1).

Worse, the three facts that most often decide the answer are **not in the owner view model at all**:

1. **Is the way behind the account still up?** DorkOS account link, own key, provider probe. `warnings: []` is hard-coded at `S/resources/operator-query-service.ts:1059`.
2. **Can this route run actions at all?** Nango and Composio `uak_` keys never can.
3. **Is the sign-in status still true?** `connections.status` is written only when a sign-in completes. **[verified]** `registry.listAccounts` has no production caller, so a sign-in revoked or expired at the service never reaches DorkOS.

So the most common real failures show up as a **green row**.

On the agent side, the same missing fact means a granted-but-broken account is silently dropped from its list. The prompt then tells the agent to request access, and the agent tells the person "I asked for access" when the real fix is "sign in to Gmail again".

**The S-tier fix is one server function.** It returns `{usable, reason, fix, fixableBy}`. It is emitted on the connection summary, on the agent's granted list (as `unavailable[]` with notes), in every execution refusal, and in the chat card. The client renders it and derives nothing.

---

## 1. Findings ranked by user impact

Tags: **LIE** (the copy is false), **DEAD END** (no action resolves it), **JARGON**, **CONFUSING** (the same thing shown twice with different words or actions), **INTERNALS** (the person must understand how it works inside).

### P0: the person or agent is told something false, or cannot get out

**1. A sign-in expired or revoked at the service never reaches DorkOS.** LIE, DEAD END. **[verified]**

- The only writer of `connections.status` is `ConnectionStore.reconcile`, reached in production only through `registry.recordConnect` after a sign-in completes (`S/connection-store.ts:414,429`; `S/resources/authentication-flow-service.ts:278`).
- `ConnectorRegistry.listAccounts`, which would reconcile status (`S/registry.ts:422-448`), is called only by tests. `registry.test.ts` exercises reconciliation that production never runs.
- Effect: the row stays green forever and the "Sign in again" state never appears. Agents' calls fail inside the provider.

**2. The page stays green when the way behind an account is down.** LIE. (DOR-2498; partly addressed by PR #2299)

- Causes: the DorkOS account is unlinked, the own key is removed or refused, the provider probe failed, or the service is out.
- `accountRow` (`C/features/connections/lib/app-list.ts:155-226`) and the panel's `usable` check (`C/features/connections/ui/panel/AccountPanel.tsx:119-122`) never read way health.
- The summary schema has no field for it (`sh/connector-resource-schemas.ts:300-324`).
- The row shows `work · 2 agents` with a green dot, and the panel still offers **Try it**, which opens a chat whose agent then fails.
- Only Settings tells the truth:
  - "These apps stopped working when the account was unlinked…" (`ConnectionWays.tsx:222-227`)
  - "These apps stopped working when the key was removed…" (`KeyWayRow.tsx:126-131`)
- The persisted provider status can also be stale. `registry.unregisterProviderInstance` returns early when the instance isn't live (`S/registry.ts:245-246`), so a provider whose boot probe failed stays `'available'` in SQLite. Authorization, access-query, reconciliation and auth-flow all trust that value.

**3. Routes that can never run actions look connected and "ready", and are even preferred.** LIE, DEAD END.

- Nango: `execution` is unsupported (`S/providers/nango.ts:260-268`).
- A Composio user key: `operationClient = secret.startsWith('uak_') ? null` (`S/providers/composio.ts:560-568`, also `:82-83`, `:236-246`).
- The UI invites exactly that key: "Any Composio key works: the project key from your dashboard or the account key the composio CLI uses." (`C/features/connections/ui/KeyEntry.tsx:23-27`). The docs correctly say the opposite (`docs/connections/composio.mdx`).
- The way still reports `ready`, because it checks authentication only (`S/bootstrap.ts:434-470`).
- `chooseNewAppsWay` prefers your own key over a working DorkOS account (`app-connection-way.ts:62-66`), so a person with both sends every new app through a dead route.
- The row reads green "No agents yet" (`app-list.ts:220-225`). That contradicts the file's own contract at `:24` ("`ready` — agents can use it now").
- The actions line for Nango, "DorkOS can't list {app}'s actions, so everything agents do in it counts as a change." (`C/…/ui/AppActions.tsx:113-116`), implies agents can do things. They can do nothing.

**4. Agents must invent action names, then the person is told access was refused when it wasn't.** LIE, DEAD END. **[verified]**

- `requestedOperations` is required with `.min(1)` (`sh/connector-schemas.ts:677-702`).
- No agent tool lists an app's actions before a grant. `S/resources/app-actions-service.ts` has the data, but only the owner can reach it.
- Card path: Allow grants a level. Then `notGrantedOperations` (`S/agent-request-service.ts:2130-2145`) compares the guessed strings with real `operationSlug`s by exact string match.
- The resume message says: "The owner did not allow everything you asked for: read_email is not allowed. … tell the person what you could not do" (`:2040-2043`). The person just granted exactly that.
- Dialog path: only exact slug matches are offered (`C/…/AgentRequestDialog.tsx:126-156, 312-315`). Otherwise the owner sees "None of the requested actions are currently available on this account." and can only Decline. The server refuses anything else: "The selected service actions do not match this request." (`:1510-1540`).
- Fixtures use fake slugs that always match (`'gmail.read'`, `agent-request-service.test.ts:56,961,1272-1280`), so this is never exercised.
- PR #2299 widens the gap, because it lets agents request apps no way reaches, where no action list exists anywhere.

**5. A granted but unusable account is invisible to the agent, which then tells the person the wrong fix.** LIE.

- `listRuntimeGrantRows` (`S/execution/access-query-service.ts:493-534`) silently drops rows that are expired, paused, need review, have their provider down, have no execution support, or are turned off for this chat.
- The prompt says "If access is missing, use request_connection… say plainly that you asked for access" (`apps/server/src/services/runtimes/shared/accounts-access-context.ts:85`).
- The status line says "Currently granted accounts for this agent session: N" and "This snapshot describes grants, not a verified service connection" (`:79-82`). But N counts only executable rows (`access-query-service.ts:154-196`), so the text says the reverse of what the number means.
- After PR #2299, `unavailable[]` covers only "the way is down". The PR's new tool description ("Accounts granted to you that cannot be used right now are listed under unavailable, each with a note on why…") is false for expired, paused, needs-review, managed-pending and turned-off-for-this-chat. `unavailable[]` also has no `connectionId`.

**6. Relinking the same account, rotating a key, or touching any raw MCP server drops every agent's access. The UI blames "the app's actions".** LIE, DEAD END, INTERNALS.

- A material digest change flips every connection with a live grant to `migration_needs_reconcile` (`S/connection-store.ts:204-219`). Authorization requires `ready` (`S/execution/authorization-service.ts:300`).
- Relinking the same DorkOS account changes the token digest (`cloud-link.ts` `managedConnectorMaterialDigest`).
- The raw MCP digest hashes the whole server list (`S/bootstrap.ts:185-200`), so adding any MCP server knocks out all raw-MCP grants.
- Row copy: "Some of its actions changed. Check who can use it." Panel: "Some of {App}'s actions changed. Check who can use them." Both are false in this case.
- Change key warns "A new key pauses the apps… until you review their access again" (`KeyWayRow.tsx:153`), and then the row blames the actions.
- The review dialog cannot confirm without an edit: "Save access" stays disabled until something changes (`C/…/ConnectionAccessDialog.tsx:114-120`). This is a dead end.
- The owner must re-review every connection one by one. On managed connections, `activateCurrentGrants` flips back to `ready` only when every agent's scope applies (`S/resources/managed-authority-sync-service.ts:1531-1553`), so a partial re-review never clears it.

**7. "Couldn't update who can use it" is a permanent dead end, and "Updating…" spins forever.** DEAD END, LIE.

- `rejected` outbox commands are terminal and never re-staged (`S/resources/managed-authority-sync-service.ts:1278-1296`). Unlinking gives `unauthorized`, which becomes rejected with "This instance is no longer linked.", and that outlives a relink.
- `authoritySync()` aggregates across ALL scopes: every agent, every-agent, lifecycle and every event subscription (`operator-query-service.ts:1106-1147`). So one rejected event subscription marks the whole connection failed.
  - The session view then shows it disabled (`:863-882`), while execution keys off per-grant scope and works (`authorization-service.ts:425-470`). That is false.
  - Agents whose managed grant is pending or rejected vanish from the panel, because grants are inserted already revoked (`operator-query-service.ts:973-1007`).
- Row: "Couldn't update who can use it. Check it again." with [Review] (`app-list.ts:199-206`).
- Panel: "Couldn't update who can use {App}. {raw server reason}" with [Check exact actions] (`AccountPanel.tsx:158-163`).
- Both open an editor that doesn't mention the failure and has no retry.
- Pending: "`{who} · Updating who can use it…`" plus a spinner (`app-list.ts:217-218`). `authoritySync.pending.reason`/`retryAt` exist in the schema (`sh/connector-resource-schemas.ts:249-264`) but are shown only for disconnects.

**8. "Sign in again" can turn a working account into a paused one, and failures are silent or spin forever.** DEAD END.

- The reconnect claim sets `enabled=false` up front (`S/resources/authentication-flow-service.ts:150`, `:456`). It is unpaused only when the flow completes with the same account (`:281-283`).
- These paths leave the account **Paused** with nothing saying why:
  - `start_unknown` (`:494-501`)
  - expired, failed or abandoned flows (there is no sweeper; expiry happens only on poll, `:166-170`)
  - signing in as a different identity (a test pins `enabled:false` on the old row, `connector-authentication-flow-service.test.ts:285-345`)
- Row "Sign in again" failures are silent. `useReconnectConnectorConnection` sets `suppressErrorToast` (`C/entities/connectors/model/use-connector-resources.ts:225`), and `ConnectionsPage.tsx:141-144` never renders `reconnect.error`.
- Chat card: `AccountAttentionStep.tsx:93-98` shows "Getting the sign-in page ready…" for `failed`/`expired`/`start_unknown` flows too, and hides "Sign in again" once `flowId` is set (`:116`). The spinner never ends. `RequestConnectStep.tsx:130-144` doesn't handle a failed or expired flow either.
- L7: the store comment says a sign-in "does not overrule" a pause (`connection-store.ts:397-403`), but a same-account reconnect unpauses even a pause the owner chose.

**9. Rows that can never be removed.** DEAD END, hidden by a LIE of omission.

- **D1: own key removed, then Disconnect.**
  - The provider call throws, so cleanup becomes `failed` (`S/resources/lifecycle-service.ts:266-281`).
  - Retrying fails the same way. Its warning copy, "Try disconnecting again to finish removing access at the service." (`:278`), is false while the key is gone.
  - Remove refuses: "Finish disconnecting this account before removing it." (`:117-121`).
  - Reconnect refuses: "Finish disconnecting this account before signing in again." (`authentication-flow-service.ts:131-139`).
  - The only way out is re-adding the exact key, and nothing says so.
- **D2: managed disconnect rejected** (unlinked, relinked to a different DorkOS account, or conflict).
  - `external_cleanup_state` stays `pending` forever, because only an applied status writes it (`managed-authority-sync-service.ts:1182-1199`).
  - Remove and reconnect are both refused. A different-account relink can never be cleaned up.
- The row shows the plain greyed "Disconnected. Agents can't use it." (`app-list.ts:169-175`) whether or not cleanup finished. Only the panel admits "Still finishing disconnecting…" / "Disconnecting didn't finish…" (`AccountPanel.tsx:252-290`).

**10. A destructive action is approved blind.** **[verified]**

- `approvalDisplayFields: ['connectionId','operationRevisionId']` (`S/execution/execution-capabilities.ts:153-155`), with no subject, view or detail field.
- The approval card reads roughly: "<agent> wants to run 'Execute a destructive account operation' with connectionId: "01K…", operationRevisionId: "01K…"".
- It names no app, no account, no action and no arguments.
- The titles "Execute a {read|write|destructive} account operation" (`:144`) are jargon.

**11. Unlinking the DorkOS account leaves managed connections live locally and access held at the service.** LIE, INTERNALS.

- Unlink only unregisters the provider. Rows stay connected/active/ready, grants stay live, and nothing is queued for cleanup.
- The panel still says "DorkOS covers service usage." (`payer` is unchanged).
- Every pause, resume, disconnect or grant change made while unlinked is rejected permanently (see finding 7).
- The managed disconnect path (`stageLocalLifecycle`, `managed-authority-sync-service.ts:649-698`) skips `notifyEveryAgentEnded`. Owners aren't told that every-agent sharing stopped.
- `bootstrap.ts:124-130` promises an `onUnregistered` cleanup that `index.ts` never wires. `bootstrap.test.ts:636-705` tests the unwired hook.
- Relinking to a _different_ DorkOS account leaves ghost rows that can never be removed (D2).
- Known: DOR-2499 (a stable instance id before key rotation).

**12. Settings says "Working" for a DorkOS account that can't connect apps.** LIE, CONFUSING.

- `ConnectionWays.tsx:192-196` uses `cloud.data.linked` only. It ignores `appConnections.ways[].status` and `newApps.reason === 'dorkos_account_unavailable'`.
- The connect dialog meanwhile says "Your DorkOS account is linked, but it can't connect apps right now." (`connect-route.ts:124`).

**13. The main way in, from a chat, is closed until a way is set up. The first connect never offers the DorkOS account.** DEAD END.

- `serviceDirectory` marks unrouted popular apps `requestable:false, unavailableBecause:'not_reached'` (`operator-query-service.ts:296-307`). DOR-2494 / PR #2299 is in progress.
- `FirstConnectStep.tsx:26-29, 59-89`: the big button is "Use my Composio key", gated on DOR-1798. Design §6 says "Use my DorkOS account".
- A non-developer is asked for a supplier API key before anything works.
- A key-save failure toasts "Couldn't save the provider key" (`C/entities/connectors/model/use-connector-credential.ts:25`), which uses a banned noun. So does `:40`, "Couldn't remove the provider key".

**14. The same agent request is answered through two different models.** CONFUSING, LIE, DEAD END.

|               | Chat card (`AgentRequestCard`/`ConnectionAccessCard`) | Page dialog (`AgentRequestDialog.tsx`)                                          |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Title         | "Let X use Gmail?"                                    | "Review agent access"                                                           |
| Choice        | levels "Read" / "Read and write"                      | per-action checkboxes with raw badges `read`/`write`/`destructive` (`:342-350`) |
| Buttons       | Allow / Not now                                       | Deny / Grant access                                                             |
| Decision sent | `current_access`, raise only                          | `approved` with exact revision ids                                              |
| Status words  | "Allowed…" / "wasn't given…"                          | "Granted" / "Denied" / "Access pending" / "Account setup failed" (`:41-58`)     |

- Their account filters disagree:
  - The card ignores `authoritySync` (`account-readiness.ts:8-13`).
  - The dialog requires `authoritySync === 'ready'` (`:102-113`). It then says "Connect an account first" (`:243-259`) for an account that is merely paused, signed out or syncing. Following that creates a duplicate account.

**15. The chat card mishandles custom grants, and the saved summary under-reports access.** LIE, DEAD END.

- If the agent already holds a custom grant, the card says "{agent} already has exact actions chosen for this account. Change them there." (`ConnectionAccessCard.tsx:458-461`). No `onEditExactActions` is passed in chat, so "there" is not a link.
- Allow stays enabled (`allowAsHeld`, `:231-239`) and answers with the existing custom set.
- `RequestedActions` compares against a guessed level (`initialCardLevel(['custom'])` falls back to `'read'`).
- The every-agent saved summary maps `level === null` (custom) to "Every agent can read {app}." even when the set includes write or delete (`C/…/access/saved-summary.ts:37-41, 57-58`).

**16. Reclassified or new actions silently turn "Read" into custom.** JARGON, INTERNALS.

- A level is a snapshot of revision ids, not a policy (`access-card-selection.ts:43-51, 291-293`; `reconciliation-selection.ts:57-76`). The agent never gains new read actions and is never told its level.
- This surfaces under three names:
  - "Exact actions" (`access-labels.ts:17`)
  - "Custom access" (`ConnectionAccessDialog.tsx:182`)
  - "Every agent has exact actions chosen now. Pick a level to replace them." (`ConnectionAccessCard.tsx:553`), which implies the person chose them
- Nothing says "{App} changed its actions".
- `list_granted_operations` can return two revisions of one slug (it dedupes by revision id).

**17. Refusals give agents no next step, and some send the person into a dead end.** JARGON, DEAD END.

- All refusals below are in `S/execution/authorization-service.ts`:

| Line       | Message                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `:305-308` | "The selected connection is not ready for execution." (one message for 7 causes)                       |
| `:311-316` | "The operation classification does not match this execution capability." (doesn't name the right tool) |
| `:325-328` | "This agent is not granted the selected operation." (no pointer to request)                            |
| `:334-343` | "The selected connection provider is unavailable."                                                     |
| `:334-343` | "This provider does not support operation execution."                                                  |
| `:349-353` | "Review this managed action again before using it."                                                    |
| `:362-366` | "Managed connector access is still synchronizing."                                                     |

- `execution-broker.ts` adds:
  - "Connector caller authority changed before dispatch." (`:108-111`)
  - "Access changed before the operation was sent." (`:128-131`), which also fires on any managed scope-version change, even when this action is still granted
  - "Destructive connector execution requires approval for this exact authority." (`:199-200`)
  - "Managed account access is not ready." (`:243`)
- `managed-cloud.ts:326`: "This instance is not linked to a DorkOS account… Ask the owner to open Settings > Access and choose Link this instance." The separator also differs from `›` elsewhere.
- "Connections access ended. Start a new turn to continue." / "This agent session can no longer use connections. Start a new turn and try again." (`access-query-service.ts:420-436`, `connector-mcp/auth.ts:24`). Agents can't start turns, and scheduled runs have no person to do it.
- `list_granted_operations` on a connection paused mid-session returns "Connection not found." (`access-query-service.ts:371-373`).
- The list promises operations that execution refuses. `listRuntimeGrantRows` doesn't check managed-authority-applied or the hosted-UUID revision (`authorization-service.ts:345-367`).

**18. Event notifications are rough enough to be unusable.** JARGON, DEAD END.

- **Every event opens a brand-new chat**: `const sessionId = randomUUID()` per inbox row (`S/events/session-source-adapter.ts:~262`), with the prefix "Service notification: {title}". One chat per new email.
- **Failures are lost silently.** Delivery failure, refusal or quarantine (`event-inbox-store.ts:143,170,313`; max 8 attempts) is read by no route or UI.
- **Some rows can never be removed:**
  - Revoked subscriptions are listed forever (`subscription-store.ts:420-431`).
  - A key change makes every subscription `unavailable` (`:469-470`).
  - Remove is offered only for `active`/`pending` (`ConnectionNotifications.tsx:91`).
- **Raw internals on screen:**
  - `Filter {"labelIds":["INBOX"]}` (`:35-38`)
  - "Name (id)" (`:45-47,69-75`)
  - the raw state enum badge (`:88-90`)
  - "Replace an existing service notification if needed" (`:324`)
  - "Register an agent…" (`:302`)
- **The managed route contradicts itself.** The panel shows "Delivery is managed by DorkOS" (`ConnectionEventSourceSetup.tsx:47`), which design §5 removed, while the server throws `events_unavailable` for managed (`subscription-service.ts:78-84`) and the docs say managed notifications are unavailable.
- **Nango and raw MCP get two messages at once:** "Notifications are not available for this service." and "Couldn't load available notifications. Try again…" (503).
- **Every create error collapses to one line:** "We couldn't confirm this notification. Check its current state, then retry the same decision." (`:327-331`). It hides the server's `destination_unavailable` / `invalid_filter` / 503 messages.
- **Own-key setup gives no guidance.** "Public DorkOS address" (https) plus "Signing secret from Composio" (hard-coded even for Nango). The setting is per key, but it is edited per account, so it silently changes every account on that key. A bad origin returns 503, not a validation error.
- **BYO consent retries every 30s forever** (`grant-service.ts` `recoverPending`). The person only sees "pending".
- **Naming:** the section is titled "Notifications" (colliding with push notifications), while More calls it "When a new email arrives…".

**19. Chat apps that are off need an environment variable.** DEAD END for desktop users and non-developers.

- "Chat apps are turned off on this computer… start DorkOS with `DORKOS_RELAY_ENABLED=true`." (`C/…/AppList.tsx:265-270`; `ChatAppSettings.tsx:75-80`)

### P1: confusing, jargon, or partly broken

**20. Jargon leaks from server strings.**

- Raw provider types are used as names (`providerDisplayName` = `provider.type`, `S/connection-store.ts:175,191`), giving:
  - "dorkos-managed is temporarily unavailable." (`operator-query-service.ts:424`)
  - "Through composio." / "Through dorkos-managed." (`AccountPanelMore.tsx:142`)
  - "This tool connects straight to mcp." (custody disclosure)
- "Managed usage is temporarily unavailable." (`:1068,1087`) is permanent when unlinked (LIE).
- "Managed access could not synchronize." (`:1145`)
- "instance" / "authority" / "synchronization" strings:
  - `managed-authority-sync-service.ts:71,1573,1580,1587-1591`
  - `reconciliation-service.ts:739,912`
  - "Connector authority was removed." (authority-cleanup)
- Nango capability reasons reach the review via `reconciliation-service.ts:339`: "Nango does not provide trusted immutable operation metadata for brokered execution." (`nango.ts:260-315`)
- The uak reason "…Replace the legacy user key, then reconcile this provider." (`composio.ts:83`)
- Raw `_lastError` ("fetch failed", "composio timed out after 5000ms", `bootstrap.ts:510-521`)
- Raw Telegram/Slack `lastError`: "Stopped working: {lastError}" (`ChatAppPanel.tsx:59`); a test pins this leak.
- "Check sync status" (`ConnectionAccessCard.tsx:354`); "…until synchronization finishes." (`AccessOutcome.tsx:98-101`)
- The reconciliation code `'preview_stale'` is used for "not linked" (`reconciliation-service.ts:735-741`).
- A generic failure line: "The service could not complete sign-in. Try again." (`authentication-flow-service.ts:231-237`).
- L4: "This service setup changed while you were signing in. Start again." (`:186-191`) also fires when a probe merely failed.
- L5: "This service setup option is not available. Choose another option and try again." (`:397-414`) is shown for unlink or probe failure, with no relink hint.

**21. The management review dialog (program requests) shows raw fields.**

- Everything below is in `ManagementReviewDialog.tsx`:
  - the raw toolkit slug as Service (`:262`)
  - raw status (`:292`)
  - classification badge plus `v{toolkitVersion}` (`:336-338`)
  - "Through Composio" and "Composio keeps this sign-in" (`:264,354-358`)
  - "…Start a new connection request to try again." (`:171`), a dead end because a program made the request
- `presentation.ts:18` titles it `Connect ${label ?? toolkit}`.
- "A request made as you" (`needs-you-copy.ts:24`) is confusing.

**22. The panel's billing and custody lines are false for self-hosted routes.**

- "Service usage is billed to you." shows for any `payer !== 'dorkos_managed'`, including a self-hosted Nango server or raw MCP (`ConnectorPayerSchema` has only two values, `sh/connector-resource-schemas.ts:32`).
- Nango: "Nothing about this connection leaves your systems." (`S/custody-disclosure.ts:65-67`) is doubtful, since calls go to the app itself.
- "managed" means two things on one row: an own Composio key has `mode:'byo'` and `custody:'managed'` (`bootstrap.ts:241`).
- The connect dialog keeps the retired custody badges ("Change setup" / "Available setups" / "Managed by DorkOS" / "Your own account") while Settings says "way". Design §Vocabulary retired them.
- `authenticationGuidance` hard-codes Composio: "Continue to Composio to approve access to {App}." and "…DorkOS passes them to Composio without saving them." for managed routes (`ConnectDialog.tsx:68-87`). **Check this against the root rule that no supplier terms go in the public repo**; naming the managed route's supplier may be a problem.

**23. Four agent sources disagree on whether an app can be requested (after PR #2299).**

| Source                                                              | What it says                        |
| ------------------------------------------------------------------- | ----------------------------------- |
| `services[]`                                                        | "You can still request it"          |
| The legacy `toolkits[]` (`connector-capabilities.ts:124-136`)       | omits the app                       |
| `connector_recommend` (`routing.ts:174-187`, not touched by the PR) | `[]`, meaning "nothing can connect" |
| `request_connection`                                                | accepts it                          |

- `connector_recommend` also returns "Connect gmail through the composio gateway." and "Slack has a purpose-built two-way adapter in DorkOS — richer than the generic connector." (banned nouns).
- The vocab allowlist entry for `connector-capabilities.ts` cites a sentence no longer in the file (a stale exemption). `routing.ts`, which actually holds these strings, isn't listed.
- External `/mcp` exposes the catalog, whose description points at `request_connection`, but that tool has `surfaces:{}` (in-session only).
- Sessions without a mesh agent see the catalog but get no request tool.

**24. Request lifecycle gaps.**

- An in-hold denial returns a bare `{status:'denied'}`. The guidance "Do not retry it automatically." exists only in the async resume (`agent-request-service.ts:2045`).
- The dedupe key includes the free-text reason (`:451-458`), so a reworded request opens a new card (DOR-2497).
- Changing access on the page doesn't settle a pending request. The agent is resumed two hours later with "The request for service X expired…" although it already has access.
- `reviewUrl: "/connections?request=…"` is returned to agents (`:1275-1276`) while the prompt says "Never send a link to DorkOS, in any chat."
- "Turned off for this chat" isn't in `accountAttention`, so the card offers Allow and the server refuses: "This chat has that account turned off for its agent." (`:1346-1351`). Not verified in a browser.
- **Unverified:** the Codex `dorkos_connections` server sets no `tool_timeout_sec` (`codex/codex-options.ts:146-151`). The 10-minute request hold and destructive-approval holds likely exceed Codex's default MCP timeout. The OpenCode timeout was not checked.

**25. Smaller breaks.**

- The Connecting row's "Cancel" only hides the row; there is no cancel call (`ConnectionsPage.tsx:151-153`).
- `pending` sign-in flows are never swept.
- "Open Connections" from the chat card (`AccountAttentionStep.tsx:129-135`), "Manage agent access" and the agent profile "Manage" all land on the bare page with no `?app=`.
- After a reload, "Review requested access" stacks the exact-access editor over the request dialog (`ConnectDialog.tsx:420-433` + `ConnectionsPage.tsx:276-284`). Likely; verify.
- Disconnect impact check failure: "Couldn't check who will lose access. Try again before disconnecting." has no retry button. Disconnect errors appear only as the generic toast. The `AccountPanelBody` fix buttons show errors twice (inline and as a toast).
- A chat's own access can't be changed anywhere ("…and that can't be changed from the app yet.", `AgentRequestCard.tsx:43-49`). The session inspector says "Disabled in this session" with no control (DOR-2448), and "session" is jargon where the UI says "chat".
- Managed resume superseded: "A newer connection change replaced this request." (`managed-authority-sync-service.ts:1261`), when the real cause is expired or needs-review. The hosted side is active while the account stays paused locally.
- `lifecycle-service.result()` defaults `authoritySync:{status:'ready'}` (`:352`). A rename response can say ready while GET says failed.
- `disconnectImpact.affectedAgentCount` counts session grants but `agentCount` doesn't (`operator-query-service.ts:1089-1095` vs `:1024-1033`).
- The session `dominatingReason` reports a missing session grant as `'reconciliation_required'` (`:953-969`). `'grant_revoked'` is declared but never emitted.
- **Availability:**
  - `ManagedCloudConnectorProvider.listAccounts` throws above 100 connections, and that call IS the registration probe (`managed-cloud.ts:404-406`), so a heavy user can never register the DorkOS route.
  - Composio and Nango get no automatic re-probe after a transient boot failure.
  - The DorkOS route re-probes only on catalog reads.
  - The catalog is served stale with no maximum age (`catalog-cache.ts:140-175`), and an unregistered provider shows no warning at all.
- AppUseChoice "Let agents use my {App}" says "Agents can read and post as you." That overstates the default level (Read).
- Waiting-people naming: "N waiting" (row) / "Waiting on you" (panel) / "Needs you" (page strip).
- The composer prefill voice switches midway: "I need access to another service. Ask me which service and actions you need…" (`SessionConnectorsGroup.tsx:6-7`).

---

## 2. State inventory

Legend: ✅ fine, ⚠️ rough, ❌ dead end or lie.

### 2.1 Account states (Composio, Nango and DorkOS-account apps)

**Sign-in and lifecycle**

| State (stored fields)                                         | Page row                                                                         | Side panel                                                                            | Chat card                                         | Settings                   | Agent sees                                     | Verdict                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| connected · active · ready · sync ready · way up · executable | "{who} · Every agent" / "N agents", green                                        | Who can use it, Look/Change, Recently, Try it, More                                   | "Let X use {App}?" Allow / Not now                | counted "N apps connected" | listed; ops listed                             | ✅                                                                           |
| same, but 0 agents granted                                    | "No agents yet", **green**                                                       | same                                                                                  | card for one agent                                | —                          | not listed                                     | ⚠️ the green dot means "nobody can use it"                                   |
| same, but the route can't execute (Nango, Composio `uak_`)    | green                                                                            | Look/Change "everything counts as a change"                                           | Allow offered, but useless                        | way "Working"              | dropped silently                               | ❌ LIE, DEAD END (#3)                                                        |
| active in DB but expired or revoked at the service            | green                                                                            | nothing                                                                               | Allow                                             | —                          | listed; calls fail inside the provider         | ❌ (#1)                                                                      |
| `enabled=false` (paused by owner)                             | "{who} · Paused", greyed, [Resume]                                               | "Paused. Agents can't use {App} until you resume it." [Resume]                        | "…is paused. Resume it so X can use it." [Resume] | counted, no state          | dropped silently; prompt says "request access" | ⚠️ agent LIE (#5)                                                            |
| paused by an abandoned or failed "Sign in again"              | same as paused                                                                   | same                                                                                  | same                                              | —                          | dropped                                        | ❌ unexplained (#8)                                                          |
| status expired/revoked (only after a re-sign-in wrote it)     | amber "Signed out. Agents can't use it until you sign in again." [Sign in again] | "Signed out. Agents can't use {App}."                                                 | "You're signed out of {App} ({label})…"           | —                          | dropped silently                               | ⚠️ the retry failure is silent; the card spins (#8)                          |
| status pending                                                | amber "Sign-in didn't finish. Agents can't use it yet."                          | same                                                                                  | treated as signed out                             | —                          | dropped                                        | ⚠️                                                                           |
| paused and expired                                            | "Paused" wins → [Resume]                                                         | same                                                                                  | Resume                                            | —                          | dropped                                        | ⚠️ wrong fix first (a managed resume is then superseded with a false reason) |
| disconnected · cleanup complete/not_required                  | greyed "Disconnected. Agents can't use it.", no action                           | "Disconnected…" [Connect again] [Remove from your apps]                               | ignored; offers "Connect {App}" as new            | not counted                | absent                                         | ⚠️ Remove is a second trip                                                   |
| disconnected · cleanup pending (retrying)                     | **same row**                                                                     | "Still finishing disconnecting… Trying again at 12:48." [Try again now]               | —                                                 | —                          | absent                                         | ⚠️ the row hides it                                                          |
| disconnected · cleanup failed, key removed (D1)               | same row                                                                         | "Disconnecting didn't finish…" + raw reason [Try disconnecting again] → fails forever | —                                                 | "Key removed"              | absent                                         | ❌ DEAD END (#9)                                                             |
| disconnected · managed cleanup pending, command rejected (D2) | same row                                                                         | "Still finishing…" forever                                                            | —                                                 | —                          | absent                                         | ❌ DEAD END                                                                  |
| removed (`removed_at`)                                        | hidden                                                                           | —                                                                                     | —                                                 | —                          | —                                              | ✅                                                                           |

**Access sync and review**

| State (stored fields)                                                          | Page row                                                         | Side panel                                            | Chat card                                                                                         | Settings                     | Agent sees                                     | Verdict                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------- | ------------------------------------------- |
| reconciliation `migration_needs_reconcile` (real reclassification)             | "Some of its actions changed. Check who can use it." [Review]    | same + [Review]                                       | "{App} ({label}) needs a look on Connections before X can use it." [Open Connections] (bare page) | —                            | dropped silently                               | ⚠️ the editor can't confirm without an edit |
| `migration_needs_reconcile` caused by relink, key rotation or a raw MCP change | same copy                                                        | same                                                  | same                                                                                              | "A new key pauses the apps…" | dropped                                        | ❌ LIE about the cause; mass outage (#6)    |
| authoritySync pending (managed)                                                | spinner "Updating who can use it…"                               | nothing                                               | ignored, Allow offered                                                                            | —                            | ops listed, then refused "still synchronizing" | ❌ reason and retry time hidden (#7)        |
| authoritySync failed (any scope rejected)                                      | amber "Couldn't update who can use it. Check it again." [Review] | "Couldn't update… {raw reason}" [Check exact actions] | ignored                                                                                           | —                            | may still work                                 | ❌ DEAD END, LIE (#7)                       |

**Way health and outages**

| State (stored fields)                                  | Page row                                                                                                                              | Side panel                                            | Chat card                                                     | Settings                                                     | Agent sees                                               | Verdict                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------- |
| way down: DorkOS account unlinked                      | **green**                                                                                                                             | "DorkOS covers service usage." Try it                 | Allow; the server refuses with vague text                     | "Not linked… These apps stopped working…" [Manage in Access] | dropped silently (PR #2299: `unavailable[]` with a note) | ❌ LIE (#2, #11)                        |
| way down: DorkOS account linked but can't connect apps | green                                                                                                                                 | —                                                     | first-connect reason line                                     | **"Working"**                                                | —                                                        | ❌ LIE (#12)                            |
| way down: own key removed                              | **green**                                                                                                                             | —                                                     | —                                                             | "Key removed… Add the same key again"                        | dropped (PR: noted)                                      | ❌ LIE                                  |
| way down: own key refused                              | green                                                                                                                                 | —                                                     | "Your saved key didn't work the last time DorkOS checked it." | "Not working" + raw error                                    | dropped                                                  | ❌                                      |
| way down: probe failed at boot (stale DB `available`)  | green                                                                                                                                 | —                                                     | "This service setup option is not available…"                 | "Not working"?                                               | refused "provider is unavailable"                        | ❌                                      |
| service or catalog outage                              | Yours unchanged; All apps shows the raw warning "Composio is temporarily unavailable." / "dorkos-managed is temporarily unavailable." | "Couldn't load what {App} offers agents. [Try again]" | "Couldn't reach {App} just now…"                              | "Couldn't check how DorkOS reaches your apps"                | refusals                                                 | ⚠️ JARGON; stale list with no age shown |

**This chat and access levels**

| State (stored fields)                                       | Page row      | Side panel                                                                 | Chat card                                                            | Settings | Agent sees                      | Verdict                          |
| ----------------------------------------------------------- | ------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------- | ------------------------------- | -------------------------------- |
| session override `detached` (off for this chat)             | —             | —                                                                          | Allow offered, then refused "This chat has that account turned off…" | —        | dropped silently                | ❌ no UI to change it (DOR-2448) |
| grant level Read / Read and write                           | "N agents"    | segmented Read / Read and write; the exact editor says "Read + write"      | same                                                                 | —        | ops listed                      | ⚠️ two spellings                 |
| grant drifted to custom                                     | not visible   | "Exact actions" badge                                                      | "already has exact actions chosen… Change them there." (no link)     | —        | old ops only                    | ❌ (#15, #16)                    |
| Every agent                                                 | "Every agent" | radio + write warning; More › "Stop sharing with every agent" (no confirm) | never offered                                                        | —        | included, can't tell the source | ⚠️ three ways to stop sharing    |
| Every agent unavailable (DorkOS account, cloud unreachable) | —             | "Not available for this app right now. Pick agents one by one."            | —                                                                    | —        | —                               | ✅                               |

### 2.2 Requests (agent → owner)

| State                          | Card                                                            | Page                                                                                                                         | Agent gets                                                                      | Verdict                    |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------- |
| pending, in the 10-minute hold | card anchored to the call                                       | Needs you "{agent} wants to use {App}" [Review]                                                                              | blocks                                                                          | ⚠️ two answer models (#14) |
| pending after the hold         | card                                                            | same                                                                                                                         | `awaiting_owner`, no "end your turn" note                                       | ⚠️                         |
| allowed (card)                 | "Allowed {agent} to use {App}" (never mentions a partial grant) | —                                                                                                                            | `granted`, plus a false "X is not allowed" when the guessed slugs miss (#4)     | ❌                         |
| approved (dialog)              | —                                                               | "Granted"                                                                                                                    | `granted`                                                                       | ⚠️ word mismatch           |
| denied                         | "…wasn't given…"                                                | "Denied"                                                                                                                     | bare `denied` in the hold; the resume adds "don't retry"                        | ⚠️                         |
| expired (2h)                   | "…ran out of time…"                                             | —                                                                                                                            | "expired. Ask again only if still needed." even if access was given on the page | ❌                         |
| authentication failed          | "Signing in to {App} didn't finish. Nothing was shared."        | "Account setup failed"                                                                                                       | `authentication_failed`                                                         | ⚠️                         |
| target deleted                 | "…The agent or its chat is gone."                               | —                                                                                                                            | —                                                                               | ✅                         |
| app no way reaches (pre-PR)    | none; the agent says "go connect it yourself"                   | —                                                                                                                            | `not_reached`                                                                   | ❌ DOR-2494                |
| app no way reaches (PR #2299)  | card with the one-time setup step and `way_down` states         | —                                                                                                                            | accepted; `setupNote`                                                           | ⚠️ #4, #23 remain          |
| event request                  | "Review request" goes to the full page review                   | full review                                                                                                                  | —                                                                               | ⚠️                         |
| program (management) review    | —                                                               | Needs you "A program asks to pause Gmail (work)", raw fields (#21); "Approved: finish signing in to X" lingers until the TTL | —                                                                               | ⚠️                         |

### 2.3 Ways (Settings › Connections)

| Way state                       | Settings                                                                           | Connect dialog                                                                 | Page                                         | Verdict                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------- |
| nothing set up                  | "Set up when you connect your first app" [Open the Connections page]               | "First, pick how DorkOS reaches your apps…" with the big "Use my Composio key" | list shown (built-ins)                       | ⚠️ the DorkOS account isn't offered (DOR-1798); a key is asked of non-developers |
| DorkOS account linked and able  | "Working"                                                                          | skipped                                                                        | —                                            | ✅                                                                               |
| DorkOS account linked, not able | **"Working"**                                                                      | "Your DorkOS account is linked, but it can't connect apps right now."          | rows green                                   | ❌                                                                               |
| DorkOS account unlinked         | "Not linked" + stopped apps [Manage in Access]                                     | —                                                                              | rows green                                   | ❌                                                                               |
| own key working                 | "Working", N apps, "Used for new apps"                                             | skipped (preferred over the DorkOS account even when it can't execute)         | —                                            | ⚠️ #3                                                                            |
| own `uak_` key                  | "Working"                                                                          | —                                                                              | rows green, agents can't act                 | ❌                                                                               |
| own key refused                 | "Not working" + raw `status.error`                                                 | reason line                                                                    | green                                        | ❌                                                                               |
| own key removed                 | "Key removed" + stopped apps [Add key again]                                       | —                                                                              | green                                        | ❌                                                                               |
| key changed                     | "A new key pauses the apps… until you review their access again"                   | —                                                                              | "Some of its actions changed"                | ❌                                                                               |
| Nango (self-hosted)             | "Working"; the key form has no server-address field (verify where the host is set) | under "Other ways"                                                             | green; never agent-usable                    | ❌                                                                               |
| chat apps off (relay disabled)  | `DORKOS_RELAY_ENABLED=true dorkos`                                                 | —                                                                              | "Chat apps are turned off on this computer…" | ❌ for desktop users                                                             |

### 2.4 Chat apps (Telegram, Slack, Webhook)

| State                          | Row                                                                                  | Panel                                                   | Verdict            |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------ |
| paused                         | "Paused · no messages in or out" [Resume]                                            | —                                                       | ✅                 |
| error                          | "Stopped working. Messages aren't getting through." [Fix] (Fix only opens the panel) | "Stopped working: {raw lastError}" [Check its settings] | ⚠️ raw server text |
| connecting                     | "Connecting…"                                                                        | —                                                       | ✅                 |
| no answering agent             | "No agent answers yet"                                                               | Who answers                                             | ✅                 |
| people waiting                 | "N waiting"                                                                          | "Waiting on you" feed: Let … answer / Ignore / Block    | ⚠️ three names     |
| "Start working right away" off | rows still say "X answers" (verify)                                                  | —                                                       | ⚠️                 |

### 2.5 Event subscriptions

| State                            | Shown                                                                                     | Can the person act? | Verdict   |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ------------------- | --------- |
| active / pending                 | raw enum badge, raw filter JSON, "Name (id)"                                              | Remove              | ⚠️ JARGON |
| revoked                          | listed forever                                                                            | no remove           | ❌        |
| unavailable (after a key change) | listed                                                                                    | no fix or remove    | ❌        |
| managed route                    | "Delivery is managed by DorkOS", the form enabled; the server throws `events_unavailable` | —                   | ❌ LIE    |
| Nango / raw MCP                  | "not available" + "Couldn't load…" at once                                                | —                   | ⚠️        |
| delivery failed or quarantined   | nowhere                                                                                   | —                   | ❌ silent |
| delivered                        | a **new chat per event**                                                                  | —                   | ❌ flood  |

---

## 3. Journeys: friction and the ideal

**1. First connect, nothing set up**

- **Today:** Connect → "First, pick how DorkOS reaches your apps…" → "Use my Composio key" → paste the key → sign in.
  - The DorkOS account isn't offered (DOR-1798).
  - The key hint invites a `uak_` key that can't run actions.
  - A Nango key form has no host field.
  - Errors are in banned vocabulary.
  - "This step is saved in the page address. You can return or reload without starting over." is an internals line.
- **Ideal:** "Use my DorkOS account" first. Validate that the key can run actions before saving it (refuse `uak_` with a plain line). Name whose consent page opens.

**2. Connect through the DorkOS account, your own key, or Nango**

- **Today:**
  - The DorkOS account works, but the connect dialog shows "Managed by DorkOS"/"Your own account" and names Composio for the managed route.
  - Your own key works only with a project key.
  - Nango connects to a green row that agents can never use.
- **Ideal:** refuse, or clearly label, routes that can't run actions ("Agents can't use apps connected this way yet"). Never pick them for new apps over a working way.

**3. An agent requests access**

- **Today:** the agent needs the exact service id (good close-match hints). It must invent action names. The card appears. Allow grants a level. The agent may be told "X is not allowed" (#4). On denial in the hold it gets a bare status. On Codex the hold may time out (unverified).
- **Ideal:** request by level or by intent, with no action names required. Compute "not granted" by classification. Every status carries a `note` with the next step. Pin tool timeouts on every runtime.

**4. Share with every agent**

- **Today:** it works, with a write warning. Stopping has three places, and one has no confirm. The saved summary under-reports custom access ("Every agent can read").
- **Ideal:** one place to stop sharing. The summary is derived from the real set.

**5. Change the access level**

- **Today:** "Read and write" vs "Read + write"; custom drift under three names; new read actions are not picked up.
- **Ideal:** levels as policy (a new read action inside Read is included once reviewed by class), or an explicit "{App} added 3 actions — include them?" prompt.

**6. Disconnect**

- **Today:** it confirms who loses access. Errors only toast. The impact-check failure has no retry. The row hides unfinished cleanup. D1 and D2 are dead ends. Managed disconnect skips the every-agent notice.
- **Ideal:** the row shows "Finishing disconnecting…". If the way is gone, offer "Forget it here (DorkOS can't reach {service} to finish)" as a forced local remove, with an honest note.

**7. Remove**

- **Today:** a second trip (disconnect, then open the panel, then Remove), and blocked while cleanup is unfinished.
- **Ideal:** one "Disconnect and remove" choice.

**8. Reconnect / sign in again**

- **Today:**
  - Row failure is silent.
  - The card spins forever on a failed flow.
  - Abandoning leaves the account Paused.
  - Signing in as a different account leaves the old row paused and makes a new row.
- **Ideal:**
  - Don't pause on start; fence execution by flow state instead.
  - Surface every failure inline with a retry.
  - Ask "You signed in as a different account — replace or keep both?".

**9. The DorkOS account link ends (revoked or unlinked) with apps connected**

- **Today:**
  - The rows stay green and "DorkOS covers service usage." stays.
  - Only Settings admits the problem.
  - Every change made meanwhile is rejected forever.
  - Access stays held at the service.
  - Relinking the same account then forces a re-review of every app, and the stale rejected reasons stay.
- **Ideal:**
  - The rows say "Stopped: your DorkOS account isn't linked" with [Link again].
  - Relinking the same account restores everything with no re-review (DOR-2499; hosted half tracked privately).
  - Rejected commands from the unlinked period are re-staged on relink.

**10. Relink to a different account**

- **Today:** ghost rows that can never be removed.
- **Ideal:** detect it, and offer "These N apps belong to your other DorkOS account" with Forget.

**11. Key removed or rotated**

- **Today:**
  - Removed: rows stay green, disconnect is a dead end, and access stays held at the provider.
  - Rotated within the same project: mass re-review, with the "actions changed" lie.
  - Rotated to a different project: ghost rows.
- **Ideal:**
  - A same-project rotation keeps access.
  - Warn before removing ("apps stay signed in at Composio; disconnect them first?").
  - Rows state the way problem.

**12. Service outage**

- **Today:** raw provider type names; a stale catalog with no age; no auto re-probe for Composio or Nango; the DorkOS route re-probes only on catalog reads; the 100-account probe crash.
- **Ideal:** background re-probe with backoff; rows carry "{service} isn't answering; agents will retry" when it matters.

**13. Reclassified actions after an upgrade**

- **Today:** old Read grants show as "Exact actions"/"Custom access". Agents keep the old frozen ops and never gain new reads. After review, old ids return "not granted" with no "list again" hint.
- **Ideal:** see journey 5. Refusals should say "list your actions again".

**14. Telegram / Slack**

- **Today:** needs `DORKOS_RELAY_ENABLED` when off; raw `lastError`; "Answer in a channel" clashes with Telegram's own "channel"; three names for waiting people; "Agents can read and post as you." overstates the default.
- **Ideal:** an in-app toggle; plain error mapping.

**15. Event notifications**

- See §2.5 and finding #18. **Ideal:** reuse one chat per subscription or per thread, surface failures, remove anything, write filters and states in plain words, and don't offer it where the route can't do it.

**16. From a Telegram/Slack chat**

- **Today:** the agent can only say "the owner can answer in DorkOS"; no link, by design (DOR-2449).

---

## 4. DX

### 4.1 "Usable?" is decided in about 12 places

**Server:**

| #   | Location                                                                  | Notes                                                                      |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | `S/execution/authorization-service.ts:296-345, 425-470`                   | the fullest check                                                          |
| 2   | `S/execution/access-query-service.ts:493-534` (`listRuntimeGrantRows`)    | misses the managed-applied check and the UUID check                        |
| 3   | `operator-query-service.ts:863-882` (inherited)                           |                                                                            |
| 4   | `operator-query-service.ts:931-969` (session)                             |                                                                            |
| 5   | `lifecycle-service.ts:311-324` (`isCurrentForResume`)                     |                                                                            |
| 6   | `managed-authority-sync-service.ts:1382-1459` (`isBindingCurrent`)        | per kind                                                                   |
| 7   | `reconciliation-service.ts:638-652`                                       |                                                                            |
| 8   | `agent-request-service` `hasExactLiveGrants` / `requireRequestConnection` | skips the provider check                                                   |
| 9   | `registry.providerForAccount`                                             |                                                                            |
| 10  | PR #2299 `wayProblemFor` + `listWayBlockedConnections`                    | re-implements grant precedence already in `agentGrantScope`/`grantApplies` |

**Client:**

| #   | Location                          | Notes                                        |
| --- | --------------------------------- | -------------------------------------------- |
| 11  | `AccountPanel.tsx:119-122`        |                                              |
| 12  | `app-list.ts` `accountRow`        |                                              |
| 13  | `account-readiness.ts:27-32`      | ignores sync on purpose                      |
| 14  | `AgentRequestDialog.tsx:102-113`  |                                              |
| 15  | `ConnectionAccessLists.tsx:81-85` | badge "Available/Unavailable" with no reason |

**Also re-derived on the client:**

- `chooseConnectRoute` fallback (`connect-route.ts:34-51`)
- the DorkOS way status from `cloud.linked`
- NeedsYou time windows (`NeedsYou.tsx:18-29,57-64`)
- `checkSync` (`use-access-reconciliation.ts:150-202`)

**Recommendation:** one `ConnectionReadiness` in `sh/`, computed once on the server:

```ts
{
  state: 'usable' | 'blocked',
  reason:
    | 'way_down' | 'way_cannot_run_actions' | 'signed_out' | 'paused' | 'sign_in_in_progress'
    | 'needs_review' | 'access_syncing' | 'access_sync_failed' | 'off_for_this_chat'
    | 'cleanup_unfinished' | 'no_agents',
  fix: { action, label, fixableBy: 'owner' | 'agent' | 'wait', retryAt? },
  copy: { owner: string, agent: string }
}
```

It goes on the summary, on the agent's `unavailable[]`, in refusal payloads, and in card props. Retire the client predicates and fill (or delete) the hard-coded `warnings: []`.

### 4.2 Duplication and sprawl

- The paused/disconnected projection is duplicated about 8 times:
  - `connection-store.ts:442-447, 496-501` (disconnected → `'revoked'`, reusing the auth vocabulary)
  - `lifecycle-service.ts:344-350`
  - `operator-query-service.ts:136-142, 815`
  - `reconciliation-service.ts:1186-1190`
  - `management-review-context.ts:82`
  - `access-query-service.ts:243`
- `ownerColumns`/`ownerId` is copy-pasted in 13 files.
- Disconnect closure is implemented 4 times, plus a test-only fifth:
  - `revokeConnection` (writes `'unknown'`, doesn't clear `enabled`, contrary to its comment at `:397-400`)
  - the BYO wrapper
  - managed `stageLocalLifecycle` (no every-agent notice)
  - purge
- Action-name formatting has 5 implementations: `actionName`, `plainActionName`, `operationName`, `managementOperationLabel`, `operationLabel`. They give "Send email" vs "Gmail Send Email".
- `serviceNameFromToolkit` (`sh/connector-schemas.ts:1154`) renders "Googlecalendar"/"Github", and it is used where the catalog `displayName` exists.
- User-facing copy lives inside about 8 server services, with no single copy table.
- Oversized files:

| File                                | Lines                                                            |
| ----------------------------------- | ---------------------------------------------------------------- |
| `agent-request-service.ts`          | 2278                                                             |
| `managed-authority-sync-service.ts` | 1617 (outbox, scopes, events, lifecycle, grants, recovery, copy) |
| `operator-query-service.ts`         | 1227                                                             |
| `reconciliation-service.ts`         | 1221                                                             |
| ConnectionAccessCard                | 593                                                              |
| AccountPanel                        | 479                                                              |
| ConnectDialog                       | 474 (a five-branch nested ternary)                               |
| AgentRequestDialog                  | 428                                                              |
| ManagementReviewDialog              | 408 (six-deep ternaries at `:151-203`)                           |
| ConnectionsPage                     | 394                                                              |

### 4.3 Inconsistent names

| Concept       | Names in use                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Pause         | `enabled` / `paused` / `lifecycle:'paused'`                                                                    |
| Sign-in state | `status` / `authenticationStatus` / `connectionStatus`                                                         |
| Needs review  | `grantReconciliationStatus` / `reconciliationStatus` / `migration_needs_reconcile` / `reconciliation_required` |
| Closed        | `disconnected` / `revoked` / `connection_revoked` / `connection_removed`                                       |
| The route     | provider / provider instance / way / route / setup / service / backend                                         |
| The app       | toolkit / serviceSlug / service / app                                                                          |
| "managed"     | custody vs mode vs the `dorkos-managed` type vs the UI badge                                                   |
| Raw MCP type  | `'mcp'` vs "raw-mcp"                                                                                           |

- Tool names mix conventions: `connector_list_toolkits` vs `connectors.list_granted_connections`.
- Prompt "service actions" vs fields `operation*`.

### 4.4 Schema drift and dead code

- `ConnectorLifecycleResultSchema.externalCleanup` omits `'unknown'` (`sh/connector-resource-schemas.ts:465`).
- The lifecycle and auth enums are redeclared inline 4 times (`:310-311, 462-463, 561-562, 591`).
- Unreachable in production but tested:
  - `lifecycle-service` `!managed` branches and their copy
  - `management-action-service` fallbacks (`:97-146`)
  - `registry.listAccounts` (and check `listToolkits`/`providersForToolkit`)
  - `onUnregistered`
  - the byo→managed "moved_to_dorkos_account" branch (`connection-store.ts:220-237`)
  - `dominatingReason:'grant_revoked'`
  - `summary.warnings`

### 4.5 Test gaps and fragile fixtures

**Missing server tests:**

- sign-in status never refreshed
- stale provider status after a probe failure
- reconnect abandon, fail or `start_unknown` leaving the account paused
- remove after the key was deleted (D1)
- relink invalidating grants, and stale rejected reasons
- managed disconnect and the every-agent notice
- `authoritySync` aggregate vs per-grant execution
- more than 100 managed accounts as the probe
- the own-key way `ready` while execution is unsupported
- no `authorization-service` unit test at all

**Missing agent-side tests:**

- guessed slugs (fixtures always match)
- expired, paused or needs-review in `unavailable[]`
- `accountCount` vs its wording
- guidance on an in-hold denial
- agreement between `toolkits[]`, `recommend` and `request`
- Codex and OpenCode tool timeouts vs the hold
- the destructive approval-card text

**Components with no direct tests:** AccountAttentionStep, RequestConnectStep, RequestReceipt, AccountChoice, AccessOutcome, RequestedActions, WhoCanUseChoice, EveryAgentWarning, StopSharingFallback, KeyWayRow, WayRow, ConnectionKeyForm, ConnectionEventSourceSetup, ConnectionEventScopeFields, AgentRequestEventScopes, AppUseChoice, ChatAppSetup.

**Untested client cases:**

- a failed flow in the card
- a custom grant in the card
- the saved summary with `level===null`
- linked-but-unavailable in ConnectionWays
- a row whose way is gone
- a row reconnect failure

**Fragile fixtures:**

- Post-disconnect states are built through the test-only `registry.recordDisconnect` (`'unknown'`) and raw DB patches (`connector-lifecycle-service.test.ts:245-251`, `connector-authentication-flow-service.test.ts:313-317`). These are not the paths production takes.
- Lifecycle tests construct the service without `managed`, so they exercise branches production never runs.
- `accounts-access-context.test.ts` pins prose with `toContain`, which checks the wording is present but not that it is true.
- The `ChatAppPanel` test pins raw `lastError` leakage.

**Dev playground (checked locally):** it covers AppRow, AppList, AccountPanel, ChatAppPanel, ConnectionAccessCard, AgentRequestCard and ConnectionWays. Missing:

- NeedsYou
- ConnectDialog/FirstConnectStep
- AgentRequestDialog
- ManagementReviewDialog
- ConnectionAccessDialog
- ConnectionNotifications/EventSourceSetup
- ChatAppSettings
- KeyWayRow broken states
- the unlinked list state

---

## 5. Docs (stale, false or missing)

**Stale or false:**

- `docs/connections/composio.mdx`: "Open a connected account and choose **Notifications**". The control is More › "When a new email arrives…".
- `docs/connections/index.mdx`, "Agents can ask, but you decide": covers only the owner review. The in-chat card, the primary path, is missing. "When login is off… cannot approve itself" omits the ADR `260926-192625` risk (DOR-2440). `docs/self-hosting/threat-model.mdx:123-160` also omits it.
- `docs/self-hosting/threat-model.mdx:130`: "Composio keeps that service's login tokens" is false for Nango and raw MCP.
- `docs/guides/agents.mdx:94-100`: says the Connections tab is chat apps only, that Relay is "still unverified end to end", and uses "integrations". All stale.
- `docs/concepts/relay.mdx:30`: "Add a Telegram adapter in DorkOS" is a stale UI path and a banned noun.
- `specs/connection-app-details/04-implementation.md`, DOR-2465 row: says "Composio apps offer 'Read and write'". ADR `260928-121730` limits that to audited toolkits (Gmail, Calendar).
- Root `AGENTS.md` vocab paragraph still says "Messaging and Accounts as its two regions", which ADR `260927-033250` retired.
- `meta/chat-capabilities.md:312` ("removing disconnected accounts from Accounts") and CN-12 `:329` ("not on a managed account", stale since DOR-2439).

**Journeys the docs never cover:**

- disconnect → Remove / Connect again / Finish disconnecting
- row states and Sign in again
- changing or removing a key
- the DorkOS link ending, and relinking
- outage
- the Needs you strip
- Look/Change
- the chat-app panel
- notification failures and their states
- the public https address and signing secret for own-key notifications

**Banned nouns in `docs/`** (the vocab gate skips `docs/`, `scripts/check-vocab-gate.ts:49`):

- `getting-started/configuration.mdx:498-500` ("### Connectors"), `:589`, `:920`
- `self-hosting/threat-model.mdx:87` ("integration")
- `guides/agents.mdx:99`
- `guides/relay-messaging.mdx:244,257,278` ("adapter")
- `guides/relay-observability.mdx:21`
- `getting-started/uninstall.mdx:80`

**Consider:** extending the vocab gate to `docs/**/*.mdx` prose.

---

## 6. Known issues cross-reference

| Status             | Issues                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Done**           | DOR-2436 (Nango duplicates), 2439 (every agent for DorkOS-account apps), 2444, 2450/2451, 2463, 2464, 2465, 2466, 2467, 2468, 2485                                                                                                                                                                                                                                                                                                                                                           |
| **In Progress**    | DOR-2494, "request an app no way reaches" (= PR #2299; not in this snapshot)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Triage/Backlog** | DOR-2437 (Allow once), 2438 (per-app level words), 2440 (login-off wide writes), 2448 (turn an app back on for one chat), 2449 (one-tap from Telegram/Slack), 2472 (raw MCP reconnect flake), 2474 (end a change when the account is gone at the service; 404 → 5xx, re-sent hourly forever), 2495 (managed-connections contract test), 2496 (`cloud login` 429 backoff), 2497 (request spam via reason), 2498 (page doesn't show a way down), 2499 (stable instance id before key rotation) |
| **Doesn't exist**  | DOR-2489                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Cloud**          | The hosted-side items are tracked privately.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Mapping audit findings to filed issues:** #2 → DOR-2498; #11 → DOR-2499 + a private hosted issue; #13 → DOR-2494; #24 spam → DOR-2497; #25 session access → DOR-2448; the Telegram link → DOR-2449; the login-off docs → DOR-2440; D2-ish → DOR-2474.

**New and not filed** (every numbered finding not mapped above), notably:

- #1 sign-in status never refreshed
- #3 unusable routes shown as ready, plus the `uak_` hint
- #4 invented action names and the false "not allowed"
- #5 agent blind to why an account is unusable
- #6 relink or rotation mass re-review, and the "actions changed" lie
- #7 rejected sync is terminal, and the aggregate lies
- #8 reconnect leaves the account paused, and the card spins
- #9 D1 dead end
- #10 blind destructive approval
- #12 "Working"
- #14 two request models
- #15/#16 custom-grant handling and drift
- #17 refusal copy
- #18 event notifications (new chat per event, silent failures, unremovable rows)
- #19 the env-var chat-app toggle
- #20–#22 jargon, billing and custody lines, the ConnectDialog supplier naming
- #23 requestability disagreement and the external `/mcp` pointer
- #24 in-hold guidance, page-granted requests expiring, `reviewUrl`, the Codex timeout
- #25 Cancel no-op, the >100-account probe crash, no auto re-probe, stale catalog
- the docs items in §5

---

## 7. Suggested S-tier fix waves (for planning)

**Wave 1: one truth.**

- Server `ConnectionReadiness` (§4.1), including way health, execution capability and live sign-in status.
- Refresh sign-in status: a periodic `listAccounts` reconcile, plus marking `expired` on a provider auth error during execution.
- Fix the stale provider status on boot.
- The client renders readiness only; agents get it in `unavailable[]` and in refusals.
- This covers #1, #2, #3, #5, #12, #17, most of the state inventory, and closes DOR-2498.

**Wave 2: no dead ends.**

- Retry or re-stage rejected sync, and scope `authoritySync` per agent.
- A forced local "Forget" for D1/D2.
- Reconnect doesn't pause; a sweep for pending flows; inline errors everywhere.
- Relinking the same account or rotating within the same project keeps grants (DOR-2499; hosted half tracked privately).
- Confirm-without-edit for needs-review, with the true cause named.
- Covers #6, #7, #8, #9, #11.

**Wave 3: requests that tell the truth.**

- Request by level; a "not granted" check by classification.
- A `note` on every status; tool timeouts on Codex and OpenCode.
- Retire `toolkits[]` or align it with `recommend`.
- One answer model (the card component used on the page too).
- A destructive approval card with app, account, action and arguments.
- Covers #4, #10, #14, #15, #23, #24.

**Wave 4: plain words.**

- One server copy table; provider display names.
- Remove "instance", "authority", "managed", "sync" and raw enum/JSON/id text.
- Fix the billing and custody lines, the `uak_` hint and the provider-key toasts.
- Covers #20, #21, #22.

**Wave 5: events and chat apps.**

- One chat per subscription; visible failures; removable rows; a proper route gate.
- An in-app relay toggle.
- Covers #18, #19.

**Wave 6: docs and vocabulary gate, and grant drift as policy.**

- Covers #16 and §5.
