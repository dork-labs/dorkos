# Design note: "Works on" and the cloud agent computer (steps A7, A8)

**For:** Dorian and DorkOS Cloud · **Date:** 2026-10-18 · **Status:** proposed, waiting on agreement · **Builds on:** A1 (#2952), B1 to B3 (the session relay), C7 (the teammate tier) · **Tickets:** DOR-2939 (A7), DOR-2940 (A8)

"Hub" is the code's word for a person's own DorkOS in the cloud. No app copy says it: people see **Private**, **Cloud** and their computer's name.

## 0. The short version

- A cloud agent's **identity and rules live on your own DorkOS in the cloud.** Its **work** (files, the program running it, its chats) happens on the cloud computer.
- The cloud computer **calls in to your DorkOS the way a linked Mac does**, over the sealed, signed relay channel already built, with a few new operations.
- Every DorkOS tool an agent calls on the computer is **sent back** to your DorkOS. It runs there, as that agent, with that agent's permissions.
- Your DorkOS asks Cloud to start a computer when work is due. Cloud stops it when it is idle.
- The computer is **sealed**: no sign-in, no account secrets, no connections, no settings. At launch it runs OpenCode only and pays for models with a short-lived token.

## 1. Where an agent lives

| On your DorkOS in the cloud (the agent's home)                                  | On the cloud computer (where it works)                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `.dork/agent.json`: identity, permissions, `runtime: opencode`, a new `worksOn` | The workspace: project files, git checkouts                          |
| `SOUL.md`, `NOPE.md`, memory (`memory_write` is a DorkOS tool, so it runs here) | The runtime's own transcripts and session records                    |
| Tasks and heartbeats, room memberships, space pairings                          | A **read-only copy** of the identity files, replaced on every sync   |
| The chat list (id, title, last active), approval cards, the audit of tool calls | Installed package files                                              |
| The DorkBot setup grant and pair allowances (§3)                                | Its relay pin and key, its instance key, the short-lived model token |

**Why identity and permissions stay home.** The computer runs agent code and packages, so it is treated as untrusted. The permission gate reads `agent.json` fresh on every call, so that file lives where the tool runs, never where the agent could rewrite it. This matches A1's `DirectoryAgentSchema` (for a cloud agent, `instanceId` is the hub and `worksOn` is the computer) and the local sealed computer, where the host keeps the agent's home and the guest only runs it.

**"Works on: Cloud".** `agent.json` gains `worksOn: { kind: 'cloud', computerId }`. On the hub, `runtimeRegistry.resolveForAgent` sends that agent to a new **forwarding runtime** (`cloud-computer`). It implements just enough of `AgentRuntime`: ensure and list sessions, history, snapshot, subscribe, send, interrupt, approve, answer, models, commands, capabilities. Each one is a relay operation; locks stay on the hub, and everything else is refused. Rooms, tasks, heartbeats and approvals on the hub then work unchanged, and "a hub runs no agents" still holds, because the forwarding runtime only passes work along.

**"Works on: Dorian's MacBook".** The agent lives on the Mac exactly as today. The hub keeps no copy of its identity: it lists the agent (directory, B6) and chats with it over the relay (B1). Creating a Mac agent from the web is a page move to the Mac's own dialog (B5, Full control); at the Chat level the option says "Open DorkOS on your Mac to add an agent there." (Open question 1.)

## 2. The channel between your DorkOS and the computer

**The computer calls in, like a Mac.** It reuses `session-relay.ts`: the hub's Ed25519 key signs the `dorkos-session-relay/v1` transcripts, frames are sealed, and the relay endpoint, computer store and dialer are reused. Nothing dials into the computer, so it needs no open inbound port, and a self-hoster gets the same design.

**How it learns where to call, and proves who it is.** B3's link flow, with only the hand-over of the code changed:

1. When the hub makes or starts a computer that is not linked yet, it mints a **machine link code** bound to that computer's `CloudComputerSchema.id` and the role `agent-computer`, and hands it to Cloud (`POST /v1/computers/{id}/link-code`).
2. The computer reads `GET /v1/agent-computers/self/assignment`: the hub's origin and the one-time code.
3. The computer redeems the code at `POST /api/hub/link` as a Mac does. It learns the hub's key from the hub's own signed answer over TLS, not from Cloud, and pins it on its own disk.
4. `LinkedComputerSchema` moves to v2 with `role: 'computer' | 'agent-computer'` and `cloudComputerId`.

What we accept: Cloud carries the code, so a compromised Cloud could link a fake computer. Cloud already runs these computers, so this adds no new power, and the docs say so.

**Staying connected.** The computer dials on boot and stays connected while it has work; it closes after the relay's idle window with nothing running and no viewers, and `viewer_open` redials it. An agent computer has no Chat or Full control level: its hub is its only controller, and `interaction.respond` from that hub needs no passkey, because the person signed in at the hub.

**New operations,** each a feature name sent only when both sides advertise it (the protocol stays v1):

| Direction      | Operation         | What it does                                                                               |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| hub → computer | `agents.sync`     | Push one agent's identity copy and package list; also removes an agent                     |
| hub → computer | `turn.start`      | Start a turn: agent, session, content, origin (chat, room, task, beat) and its **tier**    |
| hub → computer | B1's operations   | `chats.list`, `session.stream`, `session.send`, `session.interrupt`, `interaction.respond` |
| computer → hub | `tools.list`      | Which DorkOS tools this agent may see now, so blocked areas stay hidden                    |
| computer → hub | `tools.call`      | Run one DorkOS tool as this agent, in this session                                         |
| computer → hub | `computer.status` | Busy or idle, and the turns it is running                                                  |

Two new frame types (`call`, `call.result`) carry the computer → hub direction; today only the hub asks.

**Directory.** The hub reports cloud agents (`instanceId` = hub, `worksOn` = computer). The computer reports only its own instance, with no agents, inside A1's caller matrix.

## 3. The tool bridge

- **The path.** On the computer, OpenCode reaches the computer's own `/mcp` with the agent token minted for that run. The computer maps the token to an agent and sends `tools.call {agentId, sessionId, tool, input}` to the hub.
- **What the hub trusts** is only what it can check: the agent's `worksOn` is this connection's proven computer, the session is one the hub started for that agent, and **the tier comes from the hub's own record of the turn**, never from the computer.
- **How it runs.** Through the normal capability and permission gate, as that agent, under a new caller kind `agent-computer` (in `request-classifier.ts`), which never counts as a person. A `destructive` call shows its card in the person's chat on the hub.
- **What stays on the computer:** only tools whose effect is the computer itself (`local_browser_*`).
- **Hub-setup tools are refused** from agent computers: tier `act` or `destructive` and area `settings`, `permissions`, `safety`, `packages` or `connections`, plus a named `agents` subset (`create_agent`, `update_agent`, `update_agent_execution`, `mesh_register`, `mesh_unregister`, `mesh_deny`). Reads stay allowed. The table is worked out from tier and area, so **a new tool is covered by default**, and a conformance test runs every registered tool against it. Rooms, tasks, messages, `own_chat` and running extensions are not setup tools.
- **DorkBot's setup level.** The owner grants it in DorkBot's settings, from their own browser with a recent sign-in. It is stored in an owner-only file under the data folder, never in config, so `config_patch` and agents can never reach it. With it, DorkBot alone gets the setup set; destructive calls still show their card. Copy: "Let DorkBot set things up for you: create agents, change settings, install."
- **Cross-computer turns.** When agent A on computer X starts a turn for agent B on computer Y (`session_start`, `chat_send`), B's turn runs at the **teammate tier** (C7), unless the owner allowed the pair A → B. Allowances are one-way, in the same owner-only file. Copy: "Let Scout start full turns for Atlas."
- **Toward a Mac agent,** a bridged send is refused at launch ("Message Atlas in a room instead."); rooms carry those turns (B8).

## 4. Start and stop

- The hub calls `POST /v1/computers/{id}/start` and `/stop` (A1) with its own key. A computer's key can never start a computer.
- **The hub starts one** when a person messages a cloud agent, a room turn or mention arrives for one, a task or heartbeat comes due, or someone opens a chat's history (the transcript is on the computer). **Never** to draw the sidebar: the chat list is cached.
- **While it starts,** the hub answers like B1's waker (503 with `Retry-After`, "Starting the cloud computer…") and keeps due work in a small durable queue per computer, drained when the computer calls in. No message is lost.
- **One wake serves every due beat:** on call-in, the hub sends everything queued, plus every beat or task falling due within ten minutes, for every agent on that computer.
- **Stopping** idle computers is Cloud's job, from the computer's busy report (§6), so Cloud never stops one mid-turn. The hub calls `/stop` only when the owner presses Stop. A hub that sleeps tells Cloud when to wake it for its schedules (§6).

## 5. The sealed computer (A8)

- **The role:** `apps/server` with `DORKOS_SERVER_ROLE=agent-computer`, so `ServerRole` stays the one switch.
- **Off:** person sign-in (registration closed, no owner, no client files); public listening (loopback only, for its own runtime's `/mcp`); account secrets (no cloud link, no runtime sign-ins, no API keys); connections (they live on the hub, reached through the bridge); settings (no writes except from `agents.sync`); its own schedulers (the hub schedules).
- **Runtimes:** OpenCode only (and Doe, if the spike says yes). The others refuse to register.
- **Models:** the computer mints its own token with its instance key through `POST /v1/inference/tokens`, capped per computer and short-lived, reusing the mint-and-renew loop in `credits-inference.ts`. "Runs on" is fixed to credits; with no token, the turn is refused rather than run another way.
- **Packages** are approved on the hub and carried out by `agents.sync`. A package **doesn't work on cloud agents** when it is an agent package for another runtime, a Claude Code-only plugin or hook, a relay adapter, or a local MCP server whose program is not in the image. Its card and the install refusal say "This doesn't work on cloud agents yet." A manifest field can replace this judgment after launch.

## 6. Proposed additions to the Cloud contract (`packages/cloud-api`, one PR, agreed first)

| Route or shape                                                                                                                                          | Who may call                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST /v1/computers/{id}/link-code` `{ code, expiresAt }` → 204. Held for that computer only, handed out once, then forgotten.                          | The account's hub key only                                 |
| `GET /v1/agent-computers/self/assignment` → `{ computerId, hubOrigin, ownerAccountId, issuer, linkCode: { code, expiresAt } \| null }`                  | That computer's own key only; anyone else gets `not_found` |
| Command `agent_computer_assignment_changed` (like `hub_assignment_changed`, carrying nothing else)                                                      | Sent by Cloud                                              |
| `PUT /v1/agent-computers/self/activity` `{ busy }`. Cloud idle-stops only after its idle window with `busy: false`.                                     | That computer's key                                        |
| `PUT /v1/hubs/self/next-wake` `{ at \| null }`. Cloud wakes the hub then, for due schedules.                                                            | The hub's key                                              |
| Optional `{ reason: 'turn' \| 'viewer' \| 'beat' }` on `/start`                                                                                         | As in A1                                                   |
| Confirm: `POST /v1/inference/tokens` with an agent-computer key, capped per computer                                                                    | That computer's key                                        |
| Confirm: the computer boots with `DORKOS_SERVER_ROLE=agent-computer`, its instance key and the API base, and can reach its hub's origin and the gateway | Cloud's image                                              |

## 7. Open questions

1. **Dorian:** from the web, is creating a Mac agent a page move that needs Full control (proposed), or a new relay operation allowed at the Chat level?
2. **Dorian:** A10 shows a stopped computer read-only. Should the hub keep a copy of each cloud agent's chat stream, so history opens without starting the computer? These chats already pass through the hub. Proposed: yes, in A10.
3. **Dorian:** one cloud computer per person means a person's cloud agents can read each other's files. Acceptable at launch?
4. **Cloud:** is a link code carried by Cloud acceptable, or would you rather vouch for the computer's key yourself (`signingPublicKey` on `CloudComputerSchema`)?
5. **Cloud:** what may a computer reach? Proposed: the public internet (git, npm), its own hub's origin through the front door, and the gateway; nothing private, nothing else on the account network.

## 8. Build order (each part up to about three days)

| #   | Part                                                                                                                      | Step | Waits on Cloud                    |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------- |
| 1   | The cloud-api contract (§6), with tests                                                                                   | both | **Agreement before merge**        |
| 2   | The `agent-computer` role: switches off, OpenCode only, credits fixed, loopback `/mcp`                                    | A8   | no                                |
| 3   | Protocol features in `packages/shared` (`agents.sync`, `turn.start`, `tools.*`, `computer.status`) with conformance tests | A7   | no                                |
| 4   | Linking: machine link codes, `LinkedComputer` v2, read the assignment, redeem, pin, dial on boot                          | A8   | live: assignment and link code    |
| 5   | The forwarding runtime, `worksOn` in `agent.json`, start on demand and the durable queue                                  | A7   | live: start                       |
| 6   | The tool bridge, the hub-setup table and its conformance test, the DorkBot grant, pair allowances                         | A7   | no                                |
| 7   | The "Works on" picker in agent creation; making the first computer (`entitlement_required` shows the card copy)           | A7   | live: `POST /v1/computers`        |
| 8   | One wake serves every due beat, the busy report, the hub's next wake                                                      | A7   | **activity and next-wake routes** |
| 9   | Model tokens on the computer; "doesn't work on cloud agents"                                                              | A8   | **gateway cap per computer**      |

Parts 2, 3 and 6 start now, against the test-mode fake Cloud. Parts 4, 5, 7, 8 and 9 merge against the fake and are proven live as Cloud ships each piece. A9 (DorkBot on a cloud computer) follows parts 6 and 7.
