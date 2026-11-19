---
slug: accounts-l1a-end-to-end
number: 261119-020000
created: 2026-11-19
status: draft
parent: everything-is-a-space
---

# L1a end to end: the build plan for milestone M3

**Status:** Draft. Planning only; no code lands from this document.
**Author:** Claude, for Dorian Collier
**Date:** 2026-11-19 (code read at `origin/main` on 2026-11-18)
**Linear:** project "Your DorkOS account, devices and private space (Feb launch)", milestones **M3a "L1a private-space path"** (January 15, 2027) and **M3b "L1a team-space leg"** (January 22, 2027; C5 and C10, after Cloud's team-spaces deploy); launch-gate ticket DOR-2962. The PM split L1a this way on 2026-11-19; steps below are unchanged, and step 9 (C5) plus the team-space browser test belong to M3b.
**Builds on:** [`everything-is-a-space/02-specification.md`](../everything-is-a-space/02-specification.md) (the build plan, "the parent spec"), its [01-ideation.md](../everything-is-a-space/01-ideation.md) and [design-agent-computers.md](../everything-is-a-space/design-agent-computers.md) ("the A7/A8 note"); ADRs `261015-042933` (the design) and `261015-125850` (this computer and other devices); plan `plans/2026-10-accounts-and-devices.md`.

This spec does not restate decisions. Where it says "as decided", the parent spec, the ADRs or the A7/A8 note hold the decision. "Hub" is the code's word; no app copy says it (VOICE).

## Overview

M3 is the parent spec's L1a: sign up on the web, land in your own DorkOS, run a credits turn on a cloud agent, chat with a Mac agent over the relay, take full control by page move, and get a teammate's mention in a team space, with a browser test for each.

Most of the groundwork is merged: the A1 contract (hubs, computers, directory, step-up, wake for the hub), hub mode, hub sign-in, the private space, the session relay with passkey approvals at the Mac (B4a to B4c), the sealed agent-computer role, and the agent-computer relay protocol. What is left is the wiring between them, a few contract additions, three threat models, and the end-to-end tests.

This document lists twelve steps in build order. Each is one ticket and ends in at least one PR.

## Goals

- Close every gap between what is merged and the L1a path in the parent spec's "Launch gate".
- Land the one open security fix (DOR-3137) before anything else that hashes an approval.
- Get DorkOS Security's threat model for A8, B4, B5 and C9 **before** a builder starts each one.
- Keep every app step buildable and testable against contract fakes, so a Cloud slip delays only the live proof.

## Non-goals

Everything in the parent spec's "Non-goals (before launch)" stays a non-goal. Also out of M3:

- B9 (one inbox), B10 (search across spaces), A10 (credits run out), A11 (export), C10 to C13 and D. They are other milestones.
- L1b hardening, except the threat models this spec asks for up front.
- The sidebar's visual design. The Designer owns it in `design-sidebar.md` (Reimagine #2, "A sidebar that scales", 2a and 2b).

## What the code says today (read on 2026-11-18)

- `packages/cloud-api/src/routes.ts` already has the A1 routes the A7/A8 note §6 proposed: `/v1/computers` (list, create, start, stop, delete, `link-code`), `/v1/agent-computers/self/assignment` and `/activity`, `/v1/hubs/self/next-wake`, `/v1/instances/{id}/viewer-open`, `/v1/directory` (+ `instances/self`, `settings`, `spaces/{id}`). `packages/cloud-api/src/step-up.ts` holds the approve-page statement and message shapes. `billing.ts` has the `fullControl` entitlement.
- **None of the directory, computers, link-code, activity or next-wake routes has an app caller.** `git grep` finds no use outside `packages/cloud-api`.
- `packages/shared/src/session-relay-agent-computer.ts` (A7 part 3) defines `agents.sync`, `turn.start`, `tools.list`, `tools.call`, `computer.status`. **Nothing in `apps/` imports it yet.**
- `apps/server/src/services/core/agent-computer/` holds the sealed role: `agent-gate.ts`, `agent-writes.ts`, `hub-owned.ts`, `sealed.ts`. Its own comment says any process on the computer is trusted at agent level until the hub owns authority. Runtimes are not limited to OpenCode yet.
- The test-mode fake Cloud (`apps/server/src/services/runtimes/test-mode/fake-cloud-v1.ts`) serves session, entitlements, balance, inference, usage, orgs, offers, nudge and communities. It serves **no** hub, computer, directory or wake route.
- `apps/community` is gone: the space server lives in `apps/server/src/services/spaces/` (server-merge step 7). The parent spec still names `apps/community`; read it as the new path.

## Plan if Cloud slips

Cloud's pieces, weakest first:

| Cloud piece                                                                                              | Risk                                          | Steps that wait on it live        |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------- |
| Agent computers (start, stop, assignment, link code, activity) and the capped gateway token per computer | **At risk**                                   | A7, A8, A9, L1a's cloud-agent leg |
| Team-spaces host, split from the Community Space host                                                    | **At risk**                                   | C5, C9, L1a's teammate leg        |
| Front door (hub routing, step-up popup on dorkos.ai, real "Continue with DorkOS" sign-in, the wake call) | **Critical path** for B4 and for real sign-in | B4, C9, L1a every leg             |
| Directory store                                                                                          | Medium                                        | B6, B7                            |
| Managed remote live and its metering                                                                     | Medium                                        | B5                                |

What proceeds anyway:

1. **Grow the fake Cloud first.** One PR extends `fake-cloud-v1.ts` with the hub, computer, directory, viewer-open and (once agreed) space-wake routes, answering from the `packages/cloud-api/fixtures/v1/` files. Every app step below tests against it. Size 3, owned by lane 1, lands before A7's first PR.
2. **A fake approve page.** A test-only page on a second loopback origin that speaks `StepUpMessageSchema` and signs with a software WebAuthn authenticator (Playwright's virtual authenticator). B4 builds and proves against it.
3. **A fake agent computer.** The real `agent-computer` role started in-process by the test harness, linked by a hub-minted code the fake Cloud hands over. A7 and A8 prove the whole loop on one machine.
4. **Merge against the fake, prove live later.** Each step's "Done when" has a fake line and a live line. A step merges on the fake line. The live line moves into L1a.
5. **If agent computers are not live by about December 15,** L1a's cloud-agent leg runs against the fake computer, and the gap goes to Dorian the same day with the cut list from the parent spec.

## Lanes

Three lanes, one writer each, matching the parent spec's chats:

| Lane                          | Steps, in order                                      | Main code                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Cloud agents**           | DOR-3137, fake Cloud growth, A7, A8 (+ DOR-3067), A9 | `services/core/agent-computer/`, `services/core/hub-relay/`, `services/runtimes/` (a new forwarding runtime), `features/agent-creation`   |
| **2. Your Mac from anywhere** | B6, B8, B7 (data), B4, B5                            | `services/core/session-relay/`, a new `services/core/cloud/directory/`, client `entities/computer`, `features/auth`, `features/approvals` |
| **3. Spaces**                 | C5, C9                                               | `services/spaces/`, `services/communities/remote/`, client `entities/community`, `features/community-hosting`                             |

L1a takes all three lanes in its last week. DOR-3137 goes first in lane 1 because B4 depends on it; it is small enough not to block lane 1's next step.

Where lanes meet:

- **`services/core/auth/`**: B4 (hub page, opener checks), B5 (entitlement check), C5 (members sign in with a DorkOS account). Land order: B4, C5, B5.
- **The directory report**: B6 owns the reporter. A7 adds cloud agents to the hub's report (`worksOn`). C5 adds spaces the hub joins. Both rebase on B6.
- **The sidebar**: B7 owns its data. A7's "Works on" tag and C5's spaces rows land as data first and render in today's sidebar until B7's layout ships.

---

## Step 1. DOR-3137: the approval hash drops a `__proto__` key

**Goal:** two tool inputs that differ only by an own `__proto__` key never share an approval hash.

**What exists:** `packages/connector-providers/src/stable-stringify.ts` rebuilds objects into a `{}` literal with `sorted[key] = …`. For the key `__proto__` that assignment sets the prototype instead of an own property, so the key vanishes from the output: `{"__proto__":{"x":1},"a":1}` and `{"a":1}` serialize the same. `apps/server/src/services/core/approvals/approval-input-hash.ts` (`hashApprovalInput`) calls it through `@dorkos/shared/capabilities` (`packages/shared/src/capabilities.ts:320` re-exports it). `assertBindableInput` walks `Object.entries`, which sees the own key but does not reject it. Relay approvals use the same hash (`session-relay/approval-challenges.ts`, `approval-proof.ts`). `packages/cloud-api/src/step-up.ts` (`canonicalJson`) already refuses a `__proto__` key.

**What to build:**

- In `sortKeysDeep`, build each copy with `Object.create(null)` and copy with `Object.defineProperty` (or plain assignment, which is safe on a null-prototype object). `JSON.stringify` then writes `__proto__` as an ordinary key. Catalog hashes do not change for any catalog without such a key.
- In `assertBindableInput`, also refuse own keys `__proto__`, `constructor` and `prototype` with `ApprovalInputNotBindableError`, naming the path. This matches `step-up.ts` and means a web approval and a local approval refuse the same inputs. (Open question 1 covers `constructor` and `prototype`.)
- Update the module doc in both files: the "plain data only" note gains the prototype-key rule.

**Security notes:** this is Security's own fix. No threat model is needed beyond its review of the PR. Check every other `stableStringify` caller in `apps/server/src/services/connectors/` that hashes for consent or grants (`grant-service.ts`, `authorization-service.ts`, `global-plugin-consent.ts`); list them in the PR body with a yes/no on whether they bind consent.

**User-facing parts:** none.

**Tests (write first, see them fail):**

- `stableStringify({ ['__proto__']: { x: 1 }, a: 1 })` built with `JSON.parse` differs from `stableStringify({ a: 1 })`.
- `hashApprovalInput` of those two inputs differs, or the first throws `ApprovalInputNotBindableError` (whichever the open question settles; both are tested).
- After hashing a `JSON.parse('{"__proto__":{"polluted":true}}')` input, `({} as any).polluted` is `undefined`, and the returned canonical copy has no inherited `polluted`.
- `constructor` and `prototype` own keys: refused by `assertBindableInput`.
- The catalog version fixture in `packages/connector-providers` is unchanged.

**Size:** 1

**Depends on:** nothing. No Cloud piece.

**Done when:**

- The four tests pass, and Security approves the PR.
- No catalog or consent fixture hash changes.

---

## Step 2. A7 rest (DOR-2939): "Works on", the forwarding runtime and the tool bridge

**Goal:** a person creates an agent that works on a cloud computer, chats with it from their DorkOS in the cloud, and every DorkOS tool it calls runs back on the hub as that agent.

**What exists:** merged #3044, #3055, #3060. The protocol in `packages/shared/src/session-relay-agent-computer.ts` (part 3). The hub's relay endpoint, computer store and waker in `apps/server/src/services/core/hub-relay/` (`relay-endpoint.ts`, `computer-store.ts`, `computer-waker.ts`, `viewer-tracker.ts`). The person-minted Mac link code in `hub-relay/link-codes.ts` and `routes/hub-computer-links.ts`. The request classifier already has the `agent-computer` kind (`apps/server/src/lib/request-classifier.ts`). Contract routes for computers and start/stop are in `packages/cloud-api/src/routes.ts`. **Not built:** `worksOn` in `agent.json` (only `packages/cloud-api/src/directory.ts` knows the word); the Works on choice in `apps/client/src/layers/features/agent-creation`; the hub asking Cloud to start or stop; the tool bridge (#3065 closed unmerged); the hub-setup refusal table on the hub side; the DorkBot setup grant; pair allowances; one wake for all due beats on the hub side.

**What to build** (the A7/A8 note §1 to §4 is the design; this is the cut):

1. **`worksOn` in the agent manifest.** `packages/shared` agent manifest schema gains `worksOn: { kind: 'cloud', computerId } | null`, default `null`. File-first write-through as today (ADR-0043). No config migration: `agent.json` is not user config. A manifest from an older build reads as `null`.
2. **Cloud client calls.** A `services/core/cloud/computers.ts` module wraps `GET/POST /v1/computers`, `/start`, `/stop` and `/link-code` with the hub's instance key, using the existing typed client. A computer's key never reaches it.
3. **The forwarding runtime** `services/runtimes/cloud-computer/`. It implements the `AgentRuntime` subset the note lists; each method is a relay request over the computer's connection. Everything else is refused. `runtimeRegistry.resolveForAgent` sends an agent with `worksOn.kind === 'cloud'` to it. It passes `runtimeConformance` for the subset it implements, and a test pins the refused remainder.
4. **Start on demand and the durable queue.** A per-computer queue on the hub (SQLite table in `packages/db`, one migration) holds due turns while the computer starts. `computer-waker.ts` gains the Cloud start path and answers 503 with `Retry-After` and "Starting the cloud computer…". On call-in, the hub drains the queue and sends every beat or task due within ten minutes, for every agent on that computer ("one wake serves every due beat", hub side). It sends `PUT /v1/hubs/self/next-wake` before it sleeps.
5. **The tool bridge.** The hub serves `tools.list` and `tools.call` for a connection whose **stored** record says `agent-computer`. It checks: the agent's `worksOn.computerId` is this connection's proven computer; the session is one the hub started for that agent; the tier is the hub's own record of the turn. The call runs through the normal capability and permission gate as that agent. A `destructive` call shows its card in the person's chat on the hub.
6. **The hub-setup table.** A pure function from (tier, area, tool name) to refuse/allow, as the note §3 sets out, plus the named `agents` subset. A conformance test runs every registered capability and every hand-registered MCP tool through it, so a new tool is covered by default.
7. **The DorkBot setup grant and pair allowances.** One owner-only file under the data folder (never `config.json`, never reachable by `config_patch`). A route to set it needs a person session with a recent sign-in (front-door step-up). DorkBot alone gets the setup set with the grant.
8. **Cross-computer turns.** `session_start` and `chat_send` from agent A on computer X to agent B on computer Y record tier `teammate` on B's turn unless the pair A → B is allowed. A bridged send toward a Mac agent is refused with "Message Atlas in a room instead."
9. **The Works on picker.** `features/agent-creation` offers Works on: Cloud (default on the web) or an online linked Mac. Picking a Mac at the Chat level shows the note's copy ("Open DorkOS on your Mac to add an agent there."). Making the first computer shows the `entitlement_required` card copy. Designer supplies copy; the data is `GET /v1/computers` plus the directory's online Macs.
10. **The hub's directory report** names each cloud agent with `worksOn` (rebases on B6's reporter).

Suggested PR split, each up to about three days: (a) `worksOn` + Cloud computer client + fake Cloud routes; (b) forwarding runtime + start-on-demand queue; (c) tool bridge + hub-setup table + conformance; (d) DorkBot grant + pair allowances + cross-computer tier; (e) picker.

**Security notes:** the bridge is the boundary that matters. Security reviews (c) and (d) as PRs; the A8 threat model (step 3) covers what the computer can claim. The rule to hold: nothing the computer sends sets the tier, the agent or the session.

**User-facing parts:** the picker and the "Starting…" state. Copy from the Designer.

**Tests (failing first):**

- A `tools.call` naming an agent whose `worksOn` is another computer is refused.
- A `tools.call` for a session the hub did not start is refused.
- A `turn.start` record says `teammate`; a call that claims `owner` in its body still runs at `teammate`.
- Every registered tool passes through the hub-setup table; a new fake `act` tool in area `settings` is refused with no table edit.
- DorkBot with the grant may call `create_agent`; without it, refused; another agent with the grant file present, refused.
- `config_patch` cannot write the grant file.
- A message to a stopped cloud agent returns 503 with `Retry-After`; after call-in, the queued message runs once.
- Two beats due within ten minutes on two agents run on one start.
- The forwarding runtime passes `runtimeConformance` for its subset.

**Size:** 8 (split into five PRs above).

**Depends on:** fake Cloud growth; A1 (merged); B6 for the report part. **Cloud:** agent computers (start, stop, link code) and the next-wake route. **At risk.**

**Done when:**

- Against the fake Cloud and an in-process agent computer, a person creates a cloud agent, chats with it, and a tool call runs on the hub with the hub's tier.
- The hub-setup conformance test covers every registered tool.
- Live: the same on Cloud's test environment (moves into L1a if Cloud is late).

---

## Step 3. A8 (DOR-2940) and DOR-3067: the cloud agent computer

**Goal:** the sealed agent computer links to its hub, runs OpenCode on credits with its own capped token, serves DorkOS's own Agent browser layer locally, and runs agent processes as a separate OS user.

**What exists:** merged #3044, #3053: the sealed role in `apps/server/src/services/core/agent-computer/` (`agent-gate.ts`, `agent-writes.ts`, `hub-owned.ts`, `sealed.ts`), `DORKOS_SERVER_ROLE=agent-computer` in `apps/server/src/env.ts`, `isAgentComputer()` in `services/core/server-role/role-checks.ts`, managed remote skipped in `index.ts`. Contract: `/v1/agent-computers/self/assignment`, `/activity`, the `agent_computer_assignment_changed` command fixture, `POST /v1/inference/tokens`. Credits mint-and-renew in `services/core/cloud/credits-inference.ts`. **Closed unmerged:** #3071 (hub-minted link), #3078 (capped gateway token and "won't run there" copy). **Not built:** reading the assignment and redeeming the code; `LinkedComputer` v2 with `role` and `cloudComputerId`; dial on boot; OpenCode-only registration; credits fixed as "Runs on"; the busy report; "doesn't work on cloud agents" for packages; DOR-3067 (not started).

**What to build:**

1. **Linking** (redo of #3071, smaller). The hub mints a machine link code bound to `CloudComputerSchema.id` and role `agent-computer`, and hands it to Cloud through `/v1/computers/{id}/link-code`. The computer reads `/v1/agent-computers/self/assignment`, redeems at `POST /api/hub/link` and pins the hub key from the hub's own signed answer. The computer store's record moves to a v2 shape with `role` and `cloudComputerId`; v1 records read as `role: 'computer'`. The computer dials on boot and on `agent_computer_assignment_changed`.
2. **The computer side of the protocol.** It advertises `agents.sync` and `turn.start`, applies `agents.sync` to a read-only identity copy, and starts turns as told. Its own `/mcp` maps the per-run agent token to an agent and sends `tools.call` to the hub. Only `local_browser_*` tools run locally (PM decision 2026-11-13: an agent computer runs DorkOS's own Agent browser layer).
3. **Runtimes:** only OpenCode registers when `isAgentComputer()`. The others refuse at registration with a log line. "Runs on" is fixed to credits; no token means the turn is refused.
4. **The capped token** (redo of #3078). The computer mints with its instance key through `POST /v1/inference/tokens`, reusing the loop in `credits-inference.ts`. The cap is Cloud's; the app only shows the refusal when it is hit.
5. **The busy report:** `PUT /v1/agent-computers/self/activity { busy }` on every turn start and end, plus a heartbeat.
6. **Packages:** an install whose package is another runtime's agent package, a Claude Code-only plugin or hook, a relay adapter, or a local MCP server not in the image is refused, and its card says "This doesn't work on cloud agents yet."
7. **DOR-3067, agent processes as a separate user.** The DorkOS server runs as one OS user; the runtime and every agent tool process run as another, with no read access to the server's data folder, the relay key, the instance key or the local MCP token. The runtime reaches DorkOS only through `/mcp` with its per-run token. The image work is Cloud's; the app's part is: spawn runtimes through a configurable launcher (`DORKOS_AGENT_RUN_AS` or a role setting), keep secrets in files mode `0600` owned by the server user, and refuse to boot the `agent-computer` role when the launcher is configured but the secret files are readable by the agent user. When this lands, update `agent-gate.ts`'s "any process is trusted at agent level" comment.

**Security notes — threat model by DorkOS Security before a builder starts.** It must answer:

- What exactly is the separate-user boundary: which files, sockets, ports and environment variables can the agent user reach, and how is each enforced (file modes, a separate network namespace, loopback-only binds)?
- Can the agent user read or forge another agent's per-run `/mcp` token? Are tokens per turn, per agent, or per computer, and how are they revoked when a turn ends?
- What happens if the agent user gets root inside the computer: what can it then claim to the hub, and what does the hub still refuse (step 2's rule: the hub never takes tier, agent or session from the computer)?
- A compromised computer and the link code: can it re-link to another hub or a fake hub? (The note accepts Cloud carrying the code.)
- What can the computer reach on the network (note open question 5), and is the gateway token useful off the computer?
- Agent browser on the computer: can a page in it reach the computer's own loopback `/mcp` or the server's ports?
- Logs and transcripts: what leaves the computer, and to whom.

**User-facing parts:** the "doesn't work on cloud agents yet" line and the refused-turn message. Copy from the Designer.

**Tests (failing first):**

- With `DORKOS_SERVER_ROLE=agent-computer`, registering the claude-code or codex runtime fails; OpenCode registers.
- A turn with no inference token is refused, never run another way.
- The computer redeems a hub-minted code once; a second redeem fails; a code for another computer fails.
- A v1 computer record reads as `role: 'computer'`.
- A `call` frame from a connection whose stored record is `computer` closes the connection (already in the protocol; pin it on the hub).
- An install of a Claude Code-only plugin on a cloud agent is refused with the copy above.
- DOR-3067: a process started through the launcher cannot read the instance key file; boot refuses when the key file is world-readable.

**Size:** 8 (A8 rest 5, DOR-3067 3; ship as separate PRs).

**Depends on:** step 2 parts (a) and (c); the threat model. **Cloud:** agent computers, the assignment route, the capped gateway token per computer, and the image (separate user). **At risk.**

**Done when:**

- Against the fake Cloud, a computer boots, links, takes `agents.sync`, runs an OpenCode turn on a fake token, and bridges a tool call.
- Security signs off on the threat model and on the DOR-3067 PR.
- Live: one credits turn on Cloud's test environment.

---

## Step 4. B4 rest (DOR-2947): approving from the web with a passkey

**Goal:** a person on their DorkOS in the cloud approves a Mac agent's tool call with a passkey, and the Mac checks the signature against exactly what it asked.

**What exists:** merged #3106, #3109, #3115, #3116, #3118 (B4a to B4c). The statement and message shapes in `packages/cloud-api/src/step-up.ts` (`StepUpStatementV1Schema`, `StepUpMessageSchema`, `encodeStepUpStatement`, `decodeStepUpStatement`, `stepUpChallenge`). At the Mac: `apps/server/src/services/core/session-relay/approval-challenges.ts`, `approval-proof.ts`, `approval-key-store.ts`, `relay-approvals.ts`, `passkeys/passkey-enrolment.ts`, and `routes/session-relay-passkeys.ts`. **Not built:** the hub's page opening the approve page as a popup and passing the statement and result. No file in `apps/client/src` uses `StepUpMessageSchema` or the `dorkos.stepup.*` messages.

**What to build:**

- A client module in `features/approvals` (model only; UI per Designer) that, on a relayed approval card with a statement: opens the approve page with `window.open` from the click, sets `noopener` off only for that window and waits for `dorkos.stepup.ready` from the **exact** approve origin the statement names (`statement.origin`); posts `dorkos.stepup.request` with the statement bytes to that window and that origin only; accepts `dorkos.stepup.result` or `cancel` only when `event.source` is that window, `event.origin` is that origin, and `challengeId` matches; then sends the assertion over the relay as `RelayApprovalProofSchema`.
- The hub serves its pages with `Cross-Origin-Opener-Policy: same-origin-allow-popups` (so its own popup can post back) and the existing CSP; a test pins the header on the approve-card route.
- Closing the popup or a timeout cancels cleanly; the card returns to its waiting state.
- The approve page itself is Cloud's (on dorkos.ai) or a self-hosted hub's own origin. For self-hosters, the computer's pinned approve origin decides; no app change is needed beyond reading it.

**Security notes — threat model by DorkOS Security before a builder starts.** It must answer:

- **What is signed:** the statement bytes only. Confirm every field the Mac acts on (`decision`, `toolName`, `inputSha256`, `sessionId`, `toolCallId`, `hubOrigin`) is inside them, and that the Mac re-hashes its own held input (needs step 1).
- **Replay:** one challenge, one use; `nonce` and `expiresAt` enforced at the Mac; a proof for challenge A presented for B fails; the WebAuthn sign count check.
- **Card versus signed text:** the hub's card may lie. Does the approve page show only the statement, all of it, with control and bidi characters escaped? What if the statement is too large to show (the 256 KB cap: "approved at the computer")?
- **Opener checks:** can another tab, frame or extension post a fake `result` to the hub page, or read the statement? Is `event.source` plus exact origin enough? What does COOP change?
- **A compromised Cloud** serves both pages: what does the passkey binding still stop (forged or replayed approvals), and what does it not (a page that asks for a different approval the person then signs)? The consent text says this; confirm the words.
- `__proto__` in tool input: after step 1, the local hash and the statement's canonical form refuse the same inputs.

**Which approvals are signed (Designer, agreed 2026-11-18):** only actions Security already marks person-only or destructive get passkey-signed, never every approval. A device with no passkey gets CLD-403's "add a passkey in place, then approve".

**User-facing parts:** Designer owns: `design-passkey-approvals.md` (draft Nov 23, ready Nov 25): the card's "Approve with passkey" state, popup blocked, cancelled, expired, and the add-a-passkey-in-place path.

**Tests (failing first):**

- A `result` message from the right origin but another window is ignored.
- A `result` from the right window but another origin is ignored.
- A `result` with a mismatched `challengeId` is ignored.
- The request is posted only after `ready`, and only to the statement's origin.
- An e2e (Playwright, virtual authenticator, fake approve page): approve flows to the Mac, which runs the tool; a replayed proof fails at the Mac.
- The COOP header is pinned on the hub's chat routes.

**Size:** 3

**Depends on:** step 1; B4a to B4c (merged); B2 and B3 (merged per parent plan). **Cloud:** the step-up popup on dorkos.ai, behind the front door. **Critical path.**

**Done when:**

- Against the fake approve page, a relayed approval is signed in a popup and accepted by the Mac; every opener test passes.
- Security signs off on the threat model.
- Live: one approval through dorkos.ai's popup.

---

## Step 5. B6 (DOR-2949): the account directory, app side

**Goal:** every linked computer and hub sends its report and reads the directory, so every DorkOS a person signs in to knows their computers, agents, spaces and settings.

**What exists:** shapes only, in `packages/cloud-api/src/directory.ts` (`DirectorySchema`, `DirectoryReportRequestSchema`, `DirectorySettingsSchema`, `DirectorySettingsPatchSchema`, `DirectoryRemovedResponseSchema`), fixtures in `packages/cloud-api/fixtures/v1/directory/`. The availability report to spaces (C3) in `apps/server/src/services/communities/remote/availability/` (`agent-availability-report.ts`, `agent-availability-reporter.ts`). Profile time zone and working hours in `packages/shared/src/config-schema/profile.ts` (`timezone`, `workingHours`). **No app code calls a directory route.**

**What to build:**

1. **A directory service** `services/core/cloud/directory/`: a reporter that sends `PUT /v1/directory/instances/self` every `reportEverySeconds` while linked and sync is on (agents from the same source as C3's report, plus names; spaces this computer joined, name and address only; `reach` from the relay pin's level, absent on a hub or agent computer), and a reader that caches `GET /v1/directory` with a stale time and serves it to the client.
2. **Stale handling.** The client renders `availability` as given (never recomputes). The cache keeps the last good read and marks it stale after two missed report intervals. An `unknown` agent is never shown as away.
3. **Safe links only.** The service accepts a link from the directory only if it is the account's hub origin (from the hub assignment) or a computer's `remoteAddress` the directory itself filled. Anything else is dropped and logged.
4. **The sync switch.** A config field `cloud.directorySync: boolean` (default `true` when linked). Off: send `DELETE /v1/directory/instances/self`, stop reporting, keep reading nothing. Unlinking is separate.
5. **Quiet hours and time zone move to the account.** See the contradiction below. A semver-keyed config migration (via the `adding-config-fields` skill): on first linked boot, `PATCH /v1/directory/settings` with `onlyIfUnset: true` carrying the local `profile.timezone` and the derived quiet hours. After that, the account's settings win; the local copy is a cache for when the Mac is offline. An offline Mac keeps using its last copy.
6. **Your spaces.** The reader exposes `spaces` (with `joinedBy`) to B7; "forget a space" calls `DELETE /v1/directory/spaces/{id}`.
7. **Client entity** `entities/computer` gains a directory query hook (TanStack Query, one transport method).

**Contradiction to settle (open question 3):** the app has **no quiet hours**. It has `profile.workingHours` (days, start, end; a window past midnight is refused). The contract has `quietHours` (start, end; may cross midnight; no days). Moving "quiet hours" to the account is really mapping working hours to quiet hours, which loses the days.

**Security notes:** the directory never carries a sign-in or a link it did not issue; the safe-link rule enforces that on the app side. A cloud agent computer reports only its own agents (A1's caller matrix); the hub refuses to read the directory from that role. No threat model needed beyond PR review.

**User-facing parts:** the sync switch line in Settings and the stale marker. Copy from the Designer.

**Tests (failing first):**

- The reporter sends the whole picture; dropping an agent sends a report without it.
- A report older than the last kept one is never sent after a newer one (clock-skew guard).
- Turning sync off sends `DELETE` and stops the timer.
- A directory link to a foreign origin is dropped.
- The migration calls `PATCH` with `onlyIfUnset: true` once, then never again.
- An agent computer role does not read the directory.
- Contract round trip against the fixtures and the fake Cloud.

**Size:** 5

**Depends on:** A1 (merged), C3 (merged), fake Cloud growth. **Cloud:** the directory store. Medium risk.

**Done when:**

- Against the fake Cloud, a Mac and a hub each report, and each reads the other's agents.
- The config migration passes the migration-closure guard.
- Live: two real instances on one account see each other.

---

## Step 6. B7 (DOR-2950), data, state and API only: one sidebar

**Goal:** the sidebar has one data source that lists the private space, spaces, and your agents grouped by computer, with away state and "Spaces you belong to".

**What exists:** today's sidebar (`apps/client/src/layers/features/dashboard-sidebar`), sidebar groups (`sidebar_add_to_group` tool), `features/linked-computers`, `entities/community`, `entities/computer`. **Not built.** Folded with Reimagine #2 "A sidebar that scales" (2a, 2b). The Designer owns the UI in `design-sidebar.md`. This spec covers only data, API and state.

**What to build:**

- A client view model `entities/sidebar` (or inside `entities/computer`, per the FSD skill) that merges: the hub's `LOCAL_COMMUNITY` (Private), paired spaces from `GET /api/rooms` and the qualified community routes, the directory's instances and agents (step 5), and the directory's spaces not in `joinedBy` for this instance ("Spaces you belong to").
- Each agent row carries: `instanceId`, `worksOn` tag, `availability`, `lastSeenAt`, unread count, and an `open` action that picks the route: local session, relayed session (B1), or page move (B5).
- An away agent exposes name, "away since", and waiting-message count only; its history query is disabled.
- "Add to this computer" calls the existing join flow (`useJoinSpaceRequest` in `entities/community/model/join-space-request.ts`) with the address; pairing still asks for its usual approval.
- Server: no new route if the directory reader (step 5) serves the client. One aggregation endpoint only if the Designer's layout needs ordering the client cannot do cheaply.

**Security notes:** an away agent's history is never fetched. No new trust boundary.

**User-facing parts:** Designer owns: `design-sidebar.md`.

**Tests (failing first):**

- Merge order: Private first, then spaces, then agents grouped by computer.
- An away agent's history query never fires.
- A space in the directory but not joined here appears once under "Spaces you belong to"; after joining it moves.
- `open` picks relay for an online Mac agent at Chat, page move at Full control with entitlement, and local for a local agent.

**Size:** 3 (data only; the UI is sized by the Designer's spec).

**Depends on:** step 5; B1 (merged). No Cloud piece beyond step 5's.

**Done when:**

- The view model passes its tests with directory fixtures.
- The Designer's sidebar renders from it with no extra fetches.

---

## Step 7. B8 (DOR-2951): linking a Mac to its hub

**Goal:** once a Mac is linked to its hub, new Mac agents post to the cloud private space by default, and the Mac's older rooms say where they live.

**What exists:** the pin in `apps/server/src/services/core/session-relay/pin-store.ts` (format 2: level, pause, name, hub origin; merged in #2994) and `relay-dialer.ts`, `relay-link.ts`. **Not built:** the default posting target for new agents, and the older-rooms note.

**What to build:**

- On agent creation on a linked Mac, the agent's default room membership is the hub's private space (reached through the existing remote community adapter for the hub). An agent created before linking keeps its rooms.
- A flag on each local room created before the link (or simply "local rooms while a hub pin exists"): the room header shows one sentence, "On Dorian's MacBook", explained once. Copy from the Designer.
- Unlinking reverts the default to local rooms; existing memberships are untouched.

**Security notes:** posting to the private space uses the existing pairing; only the owner's own computers may pair (A6). No new boundary.

**User-facing parts:** the one-line note. Copy from the Designer.

**Tests (failing first):**

- A new agent on a linked Mac gets the private space as its default room; on an unlinked Mac, a local room.
- An agent created before the link keeps its rooms after linking.
- A local room shows the "on this Mac" flag only while a pin exists.

**Size:** 2

**Depends on:** A6 (merged), B3 (merged). No Cloud piece beyond the hub.

**Done when:**

- A linked Mac's new agent posts to the private space, seen from the hub.
- Older rooms carry the note.

---

## Step 8. B5 (DOR-2948): full control by page move

**Goal:** from the web, "Open on Dorian's MacBook" moves the page to the Mac's own managed remote address, only when the Mac is at Full control and the account is entitled.

**What exists:** managed remote behind `DORKOS_MANAGED_REMOTE` (off by default) in `apps/server/src/services/core/remote/` (`managed-availability.ts`, `managed-command-service.ts`, `remote-boot.ts`). The `fullControl` entitlement in `packages/cloud-api/src/billing.ts`. `DirectoryInstanceSchema.remoteAddress` and `reach`. The pin's level in `pin-store.ts`. **Not built:** the button, the entitlement check, the directory read for `remoteAddress`.

**What to build:**

- The `open` action from step 6, for a Full-control Mac: read `reach === 'full-control'` and `remoteAddress` from the directory, check `fullControl` from `GET /v1/entitlements`, then `window.location.assign(remoteAddress)`. The address is accepted only if it came from the directory (step 5's safe-link rule).
- Not entitled: the button shows the plan card copy (Designer) instead.
- At the Mac: nothing new; the managed remote address keeps its own login (route-bound sessions, F4).
- Flip `DORKOS_MANAGED_REMOTE` default only when Cloud's managed remote is live; that is a separate one-line PR with a changelog fragment.

**Security notes — threat model by DorkOS Security before a builder starts.** It must answer:

- **Who can trigger the page move, and from where?** Only a signed-in owner session on the hub? From a relayed chat? From an agent (`control_ui`)? Recommended: only a person click on the hub page; no tool or agent can trigger it.
- Can a crafted directory entry or a compromised hub send the browser to an attacker's page that looks like the Mac? (Safe-link rule; the address is Cloud-issued.)
- Does the Mac's managed remote login stay independent of the hub session (no token passed in the URL)?
- What does the Mac do if its level drops to Chat while a full-control page is open?
- Is the entitlement check advisory (UI) with the Mac or Cloud enforcing, or must the app enforce? Recommended: Cloud enforces at its edge; the app only hides the button.

**User-facing parts:** the button label and the not-entitled card: **copy only from the Designer.**

**Tests (failing first):**

- No button when `reach` is `chat` or `off`.
- No button when `fullControl` is false; the card shows instead.
- A `remoteAddress` not from the directory is never navigated to.
- No agent tool can trigger the move.

**Size:** 3

**Depends on:** step 5, step 6's `open` action, B3 (merged). **Cloud:** the entitlement, managed remote live, and its metering. Medium risk.

**Done when:**

- Against the fake Cloud, a Full-control Mac with entitlement opens by page move; without entitlement, the card shows.
- Security signs off on the threat model.

---

## Step 9. C5 (DOR-2954): team spaces from the app

**Goal:** a person creates a team space on Cloud or on a self-hosted server, invites with a link that opens the app at "Join this space", members sign in with a DorkOS account, and "Start a team space from this" moves work out of the private space.

**What exists:** the host route from #2957: `apps/server/src/services/spaces/host/account-spaces.ts`, `routes/host/host-account-closures.ts`, migration `0044_accounts_read_scope.sql` (moved from `apps/community`). `packages/shared/src/community-admin-accounts.ts`. A space keeps no sign-in provider tokens (#2964, DOR-2957). **Also exists, not mentioned in the brief:** a hosted-community start flow in `apps/client/src/layers/features/community-hosting/` (`StartCommunityDialog.tsx`, `use-start-community.ts` calling `transport.startHostedCommunity` against `/v1/communities`). The Join dialog and its request store (`entities/community/model/join-space-request.ts`). **Not built:** a team-space create path (as distinct from a Community); self-hosted create through the server's own API; the invite link opening the app at Join; DorkOS-account sign-in for team-space members; "Start a team space from this"; the Community Space opt-in for invitees.

**What to build:**

1. **Create.** Reuse the hosting flow. Cloud: extend the start request with a space kind (team versus community) if Cloud's hosts split; **contract first, agreed with Cloud** (a `kind` field on the communities start request, or a new route; Cloud decides). Self-hosted: the app calls the server's own admin API with the owner's key.
2. **Invite link.** A link of the form `<app origin>/join?space=<address>&invite=<code>` (exact shape in the PR). The client route reads it and calls `useJoinSpaceRequest.ask(address)`. A person without the app lands on the web hub, signs in, and sees Join. Nobody types an address.
3. **Members sign in with a DorkOS account** on Cloud team spaces: the space's sign-in options (`apps/client/src/space/sign-in-options.ts`) show only "Continue with DorkOS" for a Cloud team space. This changes the sign-in surface C1 froze, so C1's promise tests change on purpose in the same PR, agreed with Cloud.
4. **Community Space opt-in** for someone who signed up through a team invite: one choice after sign-up, default off.
5. **Start a team space from this** (from the private space): create the space, then copy or move selected rooms, docs and agents. Moving an agent re-pairs it with the new space; its home stays on its computer.
6. US-only paying, anyone may join: the app shows the invite regardless of country; payment UI follows Cloud's answer.

**Security notes:** the private space keeps its refusal tests (A6): no invite route there. "Start a team space from this" is a copy out, never an invite in. Invite codes: single use or capped use, expiry, revocable; the space server enforces. Security reviews the PR; no separate threat model required.

**User-facing parts:** Join screen, invite sheet, "Start a team space from this" flow. Copy and layout from the Designer (fold into `design-sidebar.md`'s spaces section or its own note).

**Tests (failing first):**

- Opening an invite link with the app open fills the Join dialog with the address.
- The private space still refuses invite and join routes.
- A Cloud team space offers only DorkOS-account sign-in; C1's sign-in promise test is updated and passes.
- "Start a team space from this" copies two rooms and one agent; the private space still has its rooms after a copy, and not after a move.
- Self-hosted create calls the server's own API with the owner key and never Cloud.

**Size:** 5

**Depends on:** A1, A4, A6 (merged); C1 (merged). **Cloud:** team-spaces host split from the Community Space host. **At risk.**

**Done when:**

- Against the fake Cloud and a local space server, a person creates a team space, invites a second person by link, and the second person joins after a DorkOS-account sign-in.
- Live: the same on a Cloud team space.

---

## Step 10. C9 (DOR-2958): a space wakes an asleep computer for a mention

**Goal:** a mention in a space for an agent whose computer is asleep wakes that computer, which then catches up from the space's stream.

**What exists:** teammate wakes for **running** computers in `apps/server/src/services/communities/remote/wake/` (`teammate-wakes.ts`, `wake-policy.ts`, `wake-setting.ts`, `answer-in.ts`, `teammate-spend.ts`, `dispatch-addressing.ts`). The hub's own next-wake (`/v1/hubs/self/next-wake`) and the managed-remote tunnel wake token (`/v1/remote/wake-tokens`), neither of which is a per-computer space wake. **Not built:** a per-computer wake token in `packages/cloud-api`; the space calling the front door.

**What to build:**

1. **Contract first, agreed with Cloud** (`packages/cloud-api`, one PR):
   - `POST /v1/instances/self/space-wake-tokens` (instance key): mint a wake token scoped to **one** computer and **one** space address, with an expiry. Returns `{ token, expiresAt }`.
   - `DELETE` of the same to revoke one, and revocation of all on unlink.
   - `POST /v1/wake` (the front door; token only, no other credential): `{ token, reason: 'mention' }`. Answers 202 whether or not the computer was asleep. Rate-limited per token.
2. **On the computer:** on pairing with a space (and on rotation), mint a token and hand it to the space through the existing pairing channel. Rotate on a schedule and on any level change.
3. **On the space server** (`services/spaces/`): store the token per (member computer, space). When a mention for an agent whose computer is not connected arrives, call the wake route once per cooldown window. Never retry in a loop.
4. **Catch-up:** unchanged; the computer reads the space's stream from its last `seq` (as today).
5. A self-hosted space without Cloud has no wake route; the mention waits, as today.

**Security notes — threat model by DorkOS Security before a builder starts.** It must answer:

- **Scope:** can a token do anything but wake one computer for one space? Can it reveal whether the computer exists or is asleep (the 202-always answer)?
- **Rotation:** how often, who rotates, and what happens to a token mid-rotation?
- **Revocation:** on unlink, on leaving the space, on the space being deleted, on a member being removed by the space owner. Does the computer or Cloud revoke, and how fast does it take effect?
- **Abuse:** a hostile space owner holding many tokens; a leaked token. What does each cost the computer's owner (credits, wake-ups), and what caps it?
- **Where the token lives** on the space server (hashed at rest?) and in which backups.
- Does a wake ever carry message content? (It must not.)

**User-facing parts:** none beyond today's wake setting.

**Tests (failing first):**

- The contract: token request, response and wake shapes round-trip with fixtures.
- A space calls wake once per cooldown for repeated mentions.
- A revoked token's wake is refused (fake Cloud).
- A token minted for space A does not wake for space B.
- A computer catches up the missed mention from the stream after waking (existing catch-up path, new test).

**Size:** 3 (app side; the contract PR is part of it).

**Depends on:** C2 (merged), the threat model. **Cloud:** the front door accepting the wake, token minting and revocation. Critical path (front door).

**Done when:**

- The contract is agreed and merged.
- Against the fake Cloud, a mention for an asleep computer wakes it and the agent answers.
- Security signs off on the threat model.

---

## Step 11. A9 (DOR-2941): DorkBot and web onboarding

**Goal:** a person who signs up on the web gets plain onboarding that works without DorkBot, and, after adding a card, one DorkBot that lives on their cloud computer.

**What exists:** `apps/server/src/services/mesh/ensure-dorkbot.ts` (DorkBot on the local data folder), `features/onboarding` in the client. **Not built.**

**What to build:**

- One DorkBot per account, living where the account started. On a hub, `ensureDorkBot()` does nothing until the account has a cloud computer; then it creates DorkBot with `worksOn: { kind: 'cloud', computerId }` (step 2) and the setup grant off.
- A Mac linked to an account whose DorkBot already lives elsewhere does not make a second one; the directory says where DorkBot lives (a flag on the agent entry, **contract first, agreed with Cloud**, if `DirectoryAgentSchema` needs it; or derive it from `isSystem` in the report).
- Web onboarding for a person with no computer: plain app onboarding that never calls DorkBot. One honest line that DorkBot needs a card, and a path to add one.
- The timed "under a minute" run covers both cold starts (hub from the pool, first cloud computer).

**Security notes:** DorkBot's setup grant stays off until the owner turns it on (step 2). No new boundary.

**User-facing parts:** Designer owns: `design-web-onboarding.md`.

**Tests (failing first):**

- A hub with no cloud computer has no DorkBot, and onboarding completes.
- After the first computer is created, exactly one DorkBot exists, on that computer.
- Linking a Mac to that account does not create a second DorkBot.
- Onboarding never calls a DorkBot route.

**Size:** 3

**Depends on:** steps 2 and 3. **Cloud:** sign-up and the card page; agent computers. At risk (inherits A7/A8).

**Done when:**

- Against the fake Cloud, a web sign-up onboards with no DorkBot, adds a card, and gets one DorkBot on its computer.
- The timed run is recorded for both cold starts.

---

## Step 12. L1a (DOR-2962): end to end

**Goal:** browser tests prove every L1a path, first against the fakes, then against Cloud's test environment.

**What exists:** `apps/e2e/tests/` has `account-ui`, `relay`, `rooms`, `connections` and others, and `apps/e2e/first-run/first-run.journey.ts`. **No hub or cloud end-to-end spec.**

**What to build:** a new `apps/e2e/tests/accounts-l1a/` folder with one spec per path, a fixture that boots a hub, a Mac and (where needed) an agent computer and a space server in-process against the fake Cloud, and a second project config that points the same specs at Cloud's test environment (credentials from the environment; never in turbo's task env).

1. `web-signup.spec.ts`: sign up on the web, land in your own DorkOS, Private is first.
2. `cloud-agent.spec.ts`: create a cloud agent (Works on: Cloud), one credits turn, a tool call bridged to the hub.
3. `relayed-mac.spec.ts`: chat with a Mac agent over the relay; approve a tool call with a passkey (virtual authenticator).
4. `full-control.spec.ts`: page move to the Mac's managed remote address; not-entitled shows the card.
5. `team-mention.spec.ts`: create a team space, invite a teammate by link, teammate mentions your agent, your asleep computer wakes and answers.
6. `directory.spec.ts`: two instances on one account see each other's agents; away state after the Mac stops.

UI PRs run their affected specs locally before pushing (repo rule). The live project runs on demand, not in the merge queue.

**Security notes:** none new. The live project never runs with a paid flag in CI.

**User-facing parts:** none.

**Tests:** the six specs above, written first against the fakes, each failing until its step lands.

**Size:** 5

**Depends on:** steps 1 to 11. **Cloud:** all pieces, live. Critical path (front door).

**Done when:**

- All six specs pass against the fakes in the merge queue.
- All six pass once against Cloud's test environment, with the run's output kept under the evidence folder.

---

## Size totals

| Step | Ticket            | Size |
| ---- | ----------------- | ---- |
| 1    | DOR-3137          | 1    |
| —    | fake Cloud growth | 3    |
| 2    | A7 rest, DOR-2939 | 8    |
| 3    | A8 + DOR-3067     | 8    |
| 4    | B4 rest, DOR-2947 | 3    |
| 5    | B6, DOR-2949      | 5    |
| 6    | B7 data, DOR-2950 | 3    |
| 7    | B8, DOR-2951      | 2    |
| 8    | B5, DOR-2948      | 3    |
| 9    | C5, DOR-2954      | 5    |
| 10   | C9, DOR-2958      | 3    |
| 11   | A9, DOR-2941      | 3    |
| 12   | L1a, DOR-2962     | 5    |

Lane 1: 23 points. Lane 2: 16. Lane 3: 8 (lane 3 should pick up L1a's harness and the fake Cloud's space-wake routes).

## Threat models owed before a builder starts

| Step            | Owner           | Must exist before     |
| --------------- | --------------- | --------------------- |
| A8 (+ DOR-3067) | DorkOS Security | step 3's first PR     |
| B4              | DorkOS Security | step 4's first PR     |
| B5              | DorkOS Security | step 8's first PR     |
| C9              | DorkOS Security | step 10's contract PR |

Security holds each threat model privately; it answers the questions in its step, and the tests each first PR must include are on that step's ticket. All five (A8, B4, B5, C9 and D) were written on 2026-11-19.

## Open questions

1. **DOR-3137: refuse `constructor` and `prototype` too, or only `__proto__`?** **Decided (Security, 2026-11-19):** hash an `Object.create(null)` canonical form and refuse `__proto__` only, matching `step-up.ts`. Tests: inputs differing only in `__proto__` are refused, never hashed equal; the approve and execute paths hash the same canonical form; no prototype pollution.
2. **One PR for A8 and DOR-3067, or two?** **Recommended:** two. A8 can merge against the fake without the separate user; DOR-3067 needs Cloud's image and its own Security review.
3. **Quiet hours versus working hours.** The app stores working hours (days, start, end, no midnight crossing); the contract stores quiet hours (start, end, may cross midnight, no days). **Recommended:** keep working hours local for heartbeats, and add `workingHours` to `DirectorySettingsSchema` (contract first, agreed with Cloud) instead of mapping to quiet hours. If Cloud prefers no change, derive quiet hours as the inverse of the working window on working days only, and say in the PR what is lost.
4. **Invite link shape.** **Recommended:** the app's own origin with `/join?space=…&invite=…`, so a person with the app open goes straight to Join and one without lands on their hub.
5. **Does `DirectoryAgentSchema` need a "this is DorkBot" flag for A9?** **Recommended:** no; report DorkBot like any agent and let the hub tell from its own `isSystem`. Revisit only if a Mac must know where DorkBot lives before linking.
6. **Space-wake contract owner.** **Recommended:** the app drafts the C9 contract PR, Cloud agrees before merge, as A1 did.
7. **When to flip `DORKOS_MANAGED_REMOTE` on by default.** **Recommended:** in the release after Cloud confirms managed remote is live and metered, not inside B5.
8. **User-facing strings that say "hub".** `routes/session-relay-passkeys.ts` returns errors such as "Link this computer to your hub first." and "This hub doesn't name an account yet." VOICE says no app copy says "hub". **Recommended:** fix in step 4's PR (the strings are on its path), with copy from the Designer.
