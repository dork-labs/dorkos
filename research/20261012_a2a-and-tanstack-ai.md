---
title: 'A2A and TanStack AI: what to adopt for agent-to-agent communication'
date: 2026-10-12
type: strategic
status: active
asked-by: Dorian ("are we reinventing the wheel?")
---

> **Decision (Dorian, 2026-10-12):** keep this as research. No tickets are filed for the A2A or TanStack AI recommendations yet.

# A2A and TanStack AI: what to adopt for agent-to-agent communication

## 1. Summary

- **We are not reinventing A2A.** A2A is a way for one program to hand a task to one remote agent over HTTP. Our hard work is group conversation: rooms, many agents and people, loop limits, audit, power that flows downstream. A2A has none of that.
- **We already speak A2A v1.0** (`packages/a2a-gateway`, SDK `@a2a-js/sdk` 1.2.0, off by default). It is the right shape: A2A at the edge, our own conversation system inside.
- **Recommendation: keep A2A at the edge, and make the edge two-way.** Keep the inbound gateway, point it at chats (Relay is retiring), and add the missing half: bring an outside A2A agent into a room as a member.
- **Agent cards: yes, generated, never stored.** `.dork/agent.json` stays the source. Cards are a published view of it, opt-in per agent, signed once we have stable identity.
- **Spaces keep their own wire protocol.** It is a chat protocol, not a task protocol. Do not route Spaces through A2A.
- **TanStack AI: nothing to adopt in the core now.** It is still 0.x (0.68.0, RC since Aug 2026) and our durable session stream already does more. Revisit at v1 as a second engine option and as the AI library for tools our agents build.

## 2. What A2A is, in plain words

A2A (Agent2Agent) is a shared language that lets an agent built by one company ask an agent built by another company to do a job. It works like this:

1. **Find the agent.** Every A2A agent publishes an **Agent Card**, a small JSON file at `/.well-known/agent-card.json`. It says the agent's name, what it is good at (its "skills"), where to reach it, and what login it needs.
2. **Send it a job.** The caller sends a **message**. The agent answers with a **task**: a job with a state (submitted, working, needs input, needs login, done, failed, canceled, rejected).
3. **Get results.** The agent can stream progress live (SSE), or call the caller back later on a web address the caller gave it (a "push notification", really a webhook). Finished outputs are called **artifacts**.
4. **Group related jobs.** A `contextId` ties several tasks into one ongoing exchange.

It runs over three wire formats (JSON-RPC, gRPC, plain HTTP+JSON). Logins use standard schemes (bearer tokens, OAuth, OpenID, mutual TLS). Cards can be **signed** (JWS over a canonical form of the card) so a caller can check who published them. **Extensions** let a vendor add fields without breaking anyone.

**Where it stands (Oct 2026):**

| Fact                                                                   | Date                                                                      | Source                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google launches A2A                                                    | Apr 2025                                                                  | [Google blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)                                                                               |
| Donated to the Linux Foundation                                        | Jun 2025                                                                  | [LF press](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project)                                                               |
| IBM's ACP merges into A2A                                              | 2025-08-29                                                                | [LF AI & Data](https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/)                                     |
| Spec v1.0.0 is the released version                                    | by Mar 2026 (our `research/20260322_a2a_protocol_v1_breaking_changes.md`) | [a2a-protocol.org spec](https://a2a-protocol.org/latest/specification/)                                                                                                    |
| 150+ orgs, in Azure Foundry, Copilot Studio, Bedrock AgentCore, Vertex | 2026-04-09                                                                | [LF press](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) |
| JS SDK 1.0.0 (full v1.0 spec, opt-in v0.3 compatibility)               | 2026-07-22                                                                | [a2a-js changelog](https://raw.githubusercontent.com/a2aproject/a2a-js/main/CHANGELOG.md)                                                                                  |
| A2A moves into the Agentic AI Foundation, beside MCP                   | 2026-08-20                                                                | [A2A blog](https://a2a-protocol.org/latest/blog/2026/08/27/a-new-chapter-for-a2a-joining-the-agentic-ai-foundation/)                                                       |
| JS SDK 1.3.0 (database-backed task stores); we pin 1.2.0               | 2026-09-29                                                                | npm registry, `packages/a2a-gateway/package.json`                                                                                                                          |

**Who uses it:** Google ADK (the reference), Microsoft (Copilot Studio, Azure AI Foundry), AWS (Bedrock AgentCore), Salesforce, SAP, ServiceNow, LangGraph through LangSmith ([docs](https://docs.langchain.com/langsmith/server-a2a)), CrewAI. **Anthropic does not ship A2A** in Claude Code or the Claude Agent SDK. It co-governs A2A through the foundation, but its own bet is MCP. Only a community wrapper exists ([claude-a2a](https://github.com/ericabouaf/claude-a2a)).

**The honest read:** mid-2026 had a wave of "what happened to A2A?" posts ([Credal](https://credal.ai/blog/what-happened-to-a2a-protocol)). The enterprise clouds kept it alive. The settled view is: MCP is how an agent uses tools, A2A is how an enterprise agent calls another enterprise agent. A2A's real users are big-company platforms, not founders.

**Neighbours that touch the decision:**

- **MCP Tasks.** The MCP spec of 2025-11-25 added experimental async **Tasks** (start now, fetch later, with states like working, input required, completed) ([changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog), [WorkOS](https://workos.com/blog/mcp-2025-11-25-spec-update)). So MCP now overlaps A2A's task model. We already run an MCP server at `/mcp`, so many callers can reach our agents that way.
- **ANP** (decentralized IDs, discovery across unknown domains) and **AGNTCY** (Cisco, Linux Foundation, the OASF schema and an Agent Directory) each have their own discovery story ([survey](https://arxiv.org/pdf/2505.02279), [AGNTCY dir](https://dir.agntcy.org/latest/)). No one registry has won. Nothing here changes our choice.

## 3. What we built

**Relay** (`packages/relay`). A message bus with NATS-style subjects (`relay.agent.{namespace}.{agentId}`), a Maildir plus SQLite store, envelopes that carry a budget (hop count, max hops, ancestor chain, expiry, call budget; `packages/shared/src/relay-envelope-schemas.ts`), rate limits, circuit breakers, backpressure and a dead-letter queue. Today its real job is the outside chat apps (Telegram, Slack, webhooks) and the runtime hand-off. ADR `261006-235240` decides Relay folds into conversations after launch (DOR-2744): every message becomes a DM, group DM, channel post or thread reply, and the Maildir store and access rules retire. ADR `261009-171114` already retired the agent-facing relay tools (`relay_send`, `relay_send_and_wait`, `relay_inbox`).

**Mesh** (`packages/mesh`). Finds agents on disk (ten strategies: Claude Code, Codex, Cursor and others), registers them, and gives each a ULID. The source of truth is `.dork/agent.json` (ADR-0024, ADR-0043): name, displayName, description, runtime, capabilities (free strings), namespace, persona, traits, model, permissions, MCP servers, workspace, `reportsTo`. Discovery is local and filesystem-based. There is no network discovery of other people's agents.

**Rooms** (`apps/server/src/services/rooms`). Many-party conversations: DMs, channels, threads, people and agents together. A post picks its targets by mention and response mode (`addressing.ts`). A cascade guard (depth plus "this agent already spoke in this chain", ADR `260726-170127`) and a per-room and per-hour turn budget (ADR `260823-000218`) stop runaway loops. Rooms have presence, reactions, receipts, a shared canvas and a git-backed file repo. Every refusal is posted as a visible notice.

**chat_send** (`apps/server/src/services/session/chat-messages/chat-message-service.ts`, ADR `261009-171114`). How one chat messages another today, on every runtime. `to` is an agent id (opens a DM chat) or a chat id. The server stamps the sender, never the model. Messages queue by default (steer and interrupt are opt-in). The receiving turn runs no looser than the sender's (power flows downstream). Spin-offs report back on their own. By the operator's choice there is no loop guard on this path; a person sees it in both chats and can stop it.

**Communities / Spaces** (`apps/community`, `packages/shared/src/community-wire.ts`, `community-adapter.ts`). A separate Hono plus Postgres server that holds channels, members, entries and history. It **never runs an agent** (ADR `260727-184933`). An agent joins when its owner's DorkOS enrolls it (`POST /agents` with `localAgentId`, `displayName`, `handle`), bound to the owner and a connection grant. The local server mirrors remote rooms (ADR `260916-210002`) and posts agent output through a confirmed outbox (ADR `260916-210003`). The `CommunityAdapter` port carries conversation only: no turns, no sessions, no credentials. Presence follows the install: if your computer is off, your agents are offline.

**A2A gateway** (`packages/a2a-gateway`, `apps/server/src/routes/a2a.ts`). Speaks **A2A v1.0 and still accepts v0.3**, through the official SDK. Serves a fleet card at `/.well-known/agent-card.json` (plus the old `agent.json` alias), a card per agent at `/a2a/agents/:id/card`, and JSON-RPC at `POST /a2a/agents/:id`. Cards come from Mesh manifests (each capability becomes a skill) and advertise bearer auth. Inbound messages are published onto Relay; the reply stream is gathered into one task result. Tasks live in SQLite. Streaming yes, push notifications no, signed cards no, extended card no, text only (file and data parts are dropped, and every caller shows up as the same `a2a-client` sender; `schema-translator.ts`). Off by default (`a2a.enabled`, "Let outside agents reach yours"), rate limited, never unauthenticated. There is **no outbound A2A client**: our agents cannot call an outside A2A agent. The July deep review found it broken; the 16 fix PRs (#110 to #126) made it work and added a real wire test.

## 4. Side by side

| Area                    | A2A                                                               | DorkOS                                                                                                 | Same?  | Who is better, and why                                                                                        |
| ----------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| Discovery               | Agent Card at a well-known URL. You must already know the host.   | Mesh scans your disk. Spaces list enrolled agents. Gateway serves A2A cards.                           | Partly | A2A for strangers on the internet. Ours for "find my agents" with zero setup. Both are needed.                |
| Identity and cards      | Card: name, skills, interfaces, security, optional JWS signature. | `.dork/agent.json` with ULID, persona, runtime, permissions; card generated from it.                   | Partly | Ours is richer inside. A2A wins on a portable, signable public profile. We do not sign yet.                   |
| Addressing              | One URL per agent.                                                | Agent id, chat id, room id, (legacy) Relay subject.                                                    | No     | Ours fits many places at once. A2A is simpler for one-off calls.                                              |
| Message shape           | Message with Parts (text, file, data) and metadata.               | Chat and room entries with mentions, attachments, a stamped sender.                                    | Close  | Even. A2A's typed data part is nice; our sender stamp is safer.                                               |
| Long-running work       | Task with eight states, `GetTask`, `CancelTask`, resubscribe.     | A chat or session that runs, queues, stops, reports back.                                              | Close  | A2A has a cleaner formal state machine. We have the real thing (a whole chat) and spin-offs that report back. |
| Streaming               | SSE per task.                                                     | Durable per-session stream over WebSocket and SSE, with snapshot, gap-free replay and 45+ event types. | Partly | Ours, by a lot: survives reconnects and syncs every window.                                                   |
| Push                    | Webhook to the caller.                                            | Phone push, Telegram, Slack; chats wake their parent.                                                  | No     | Different jobs. A2A push is machine-to-machine, which we do not need inside.                                  |
| Auth                    | OpenAPI-style schemes: bearer, OAuth2, OIDC, mTLS.                | Local token, per-user keys, login, owner-bound community grants.                                       | Partly | A2A for cross-company. Ours is right for one owner. The gateway already maps one to the other.                |
| Trust and strangers     | Not covered. Every caller is whoever its token says.              | Outsiders seed no power and run in a prompting mode (ADR `261006-225605`).                             | No     | Ours. A2A leaves this to you.                                                                                 |
| Budgets and loop guards | None.                                                             | Cascade guard plus turn budgets in rooms; Relay hop budgets; launch cap. chat_send has none by choice. | No     | Ours. A2A has nothing that stops two agents looping.                                                          |
| Group conversation      | None. Strictly one caller, one remote agent.                      | Rooms, threads, mentions, presence, canvas.                                                            | No     | Ours. This is the core of the product and A2A does not try.                                                   |
| History                 | Task history on the remote side only.                             | Every message in a chat or room a person can read, plus search and the audit trail.                    | No     | Ours.                                                                                                         |
| Human approvals         | `INPUT_REQUIRED` and `AUTH_REQUIRED` states only.                 | Approval cards, who may approve, ceilings, audit.                                                      | Partly | Ours. A2A can only say "I am waiting"; we decide who answers.                                                 |

## 5. Where A2A solves a hard part for us, and where it does not

**Hard parts A2A really does solve:**

1. **Talking to agents we did not build.** Microsoft, AWS, Google, Salesforce and LangGraph agents all speak it. A one-off bridge per vendor would be real waste.
2. **A standard public profile.** The card format, the well-known path, how to advertise login, and how to sign it. We should not invent our own.
3. **A job lifecycle strangers understand.** The eight task states and cancel and resubscribe are well thought out. Mapping our chats onto them at the edge is cheap.
4. **Version handling.** The SDK serves v1.0 and v0.3 from one card. We already get this for free.

**Hard parts A2A does not solve, which we must keep solving ourselves:**

1. **Rooms.** A2A is one caller and one agent. No rooms, no mentions, no "who should answer", no thread. Our group conversation is the product.
2. **Loops.** Nothing in A2A stops two agents ping-ponging forever. Our cascade guard and turn budgets do.
3. **Trust.** A2A says how to log in, not what a stranger may make your agent do. Our "outsiders seed no power" rule does.
4. **People in the loop.** No sender stamp, no person-first queue, no audit trail, no approval routing.
5. **Durable, readable history.** Everything said lives in a chat a person can open. A2A history lives on the far side and is not for humans.
6. **Offline delivery.** A2A needs the remote agent to be up. Our queue, and Spaces' "presence follows the install" rule, handle this honestly.
7. **Finding agents nobody told you about.** A2A needs a known URL. Only ANP or AGNTCY try open discovery, and neither has won.

So: **A2A is the plug on the outside wall, not the wiring in the house.**

## 6. Recommendation

**A2A at the edge, not inside.** Keep the gateway. Do not replace chats, rooms or Relay with A2A. This holds the line from ADR-0175 (archived, never formally accepted) and the March research; nothing since has changed it. What has changed: Relay is retiring into conversations, so the gateway should target chats, not Relay subjects. A2A contextId maps to one external chat; that chat carries the outsider origin, so the trust rule already applies; a person can open and read it.

**Make the edge two-way.** Today outside agents can call ours, but ours cannot call theirs. The valuable missing half is an **outside A2A agent as a room member**. A person adds one by its card URL. Our server becomes the A2A client: a mention in the room becomes an A2A message, the task's progress and result are posted back as entries, and `INPUT_REQUIRED` becomes a question in the thread. It is an outsider: its posts seed no power, and room turn budgets cover it. This fits the founder story ("your agents join your team chat") far better than exposing ours to enterprises.

**Standard agent cards: yes, as a published view.**

- Keep `.dork/agent.json` as the only source (ADR-0024 still right).
- Mapping: `name` or `displayName` to `name`; `description` to `description`; `icon` to `iconUrl`; the instance to `provider`; the DorkOS version to `version`; the per-agent endpoint to `supportedInterfaces`; login to `securitySchemes`.
- **Skills need work.** Today each free-form capability string becomes a skill with filler text (`"X capability: Y"`). Let the owner write one to five public skills, with examples, in a small optional `publicProfile` block in the manifest. Fall back to capabilities.
- **Opt-in per agent.** With the gateway on, the fleet card currently lists every agent. Persona, permissions, model and paths must never appear on a card.
- **Signed cards later,** once each agent has the stable DID-like ID proposed in `research/20261006_one-server-sync-publish-identity.md`. Sign with the instance key, the same owner-attestation idea as `research/20260727_agent-identity-in-communities.md`.

**What Spaces should speak.** Keep the community wire protocol (`community-wire.ts`): channels, entries, events, owner-bound agent enrollment. A2A cannot carry a channel, and the community server never runs an agent, so it cannot be an A2A server. Two small, optional uses later: a Space can show an enrolled agent's public card as its profile, and the room bridge above can bring outside A2A agents into a Space room through the owner's own server (compute stays on the member's machine).

**Tickets (2 to 4):**

1. _A2A gateway delivers into chats, not Relay subjects_ (contextId maps to one external chat; an outsider origin; readable in the app). Ride the Relay merge, DOR-2744.
2. _Bring an outside A2A agent into a room as a member_ (A2A client; mention to message; task updates to entries; outsider trust; turn budgets apply).
3. _Agent card as an opt-in public profile_ (per-agent publish switch, `publicProfile` skills, nothing private on a card; bump `@a2a-js/sdk` to 1.3.0).
4. _Signed agent cards_ (JWS with an instance key; after stable agent identity lands). Lowest priority.

Do not market any of this until each piece is verified (the demo-claim gate in `meta/ROADMAP.md`).

## 7. TanStack AI

**What it is.** A TypeScript toolkit from the TanStack team for building AI chat features: a server `chat()` function, adapters for 24+ model vendors, tools defined once that run on the server or in the browser, a tool-approval flow, a React `useChat` hook with resumable streams, an MCP client (`@tanstack/ai-mcp`), and devtools. Its wire format is now **AG-UI** both ways ([post](https://tanstack.com/blog/ag-ui-compliance)). A custom backend needs a hand-written client "connection adapter", and the chunk format is thinly documented ([discussion #212](https://github.com/TanStack/ai/discussions/212)).

**Maturity.** Alpha Dec 2025, beta Jun 2026, RC from 2026-08-21 ([RC post](https://tanstack.com/blog/tanstack-ai-rc)). Still 0.x on npm: `@tanstack/ai` 0.68.0 (2026-10-09), `@tanstack/ai-client` 0.39.2, `@tanstack/ai-react` 0.30.3. That is 68 minor versions in ten months, with recent wire changes. Multi-agent orchestration is on its roadmap, not shipped. No A2A support. No named production users found.

**How it compares to what we have:**

- **Client stream.** Ours is a durable per-session stream (snapshot, replay by sequence number, WebSocket and SSE, ADR `260805-041016`), shared by every open window, with 45+ event types (tool calls, approvals, subagents, hooks, compaction, background tasks; `packages/shared/src/schemas.ts`). TanStack's `useChat` assumes one request starts one run. Swapping would lose replay and multi-window sync, and we would write a big translation layer anyway. ADR `260708-111459` already declined AG-UI for this reason.
- **Engine.** Our own runtime (DoE, `packages/doe`) runs on Pi core behind an `Engine` port, with the Vercel AI SDK named as fallback (`research/20261007_dorkos-runtime.md`). The AI SDK appears in our code only as a package name we hand to OpenCode (`credits-sidecar.ts`). TanStack AI's `chat()` could be a third engine option, but it is the least stable of the three.
- **Markdown.** `streamdown` renders our messages. TanStack AI has nothing to replace it.

**Adopt now:** nothing in the app's core.

**Adopt later (at its v1, and only if it holds steady for a quarter):**

- As the **recommended AI library for the tools and mini apps our agents build** for founders. It is TanStack like our router and query, works with many model vendors, and can point at the DorkOS credits endpoint through an OpenAI-compatible adapter. This is the one place it could pay off soon, because those apps are throwaway-friendly and not on our critical path.
- As a **second candidate behind the DoE `Engine` port**, compared against the AI SDK fallback.
- Its **tool-approval and isomorphic-tool patterns** are worth reading when we design approvals for agent-built tools. Borrow ideas, not code.

**Never (for now):** replacing our session stream, the Transport, or `streamdown` with TanStack AI or AG-UI; using it for agent-to-agent traffic (it has no such layer).

**Ticket (optional, after its v1):** _Evaluate TanStack AI v1 as the default AI library in the builder's mini-app template._

## 8. Risks and open questions

1. **Opening the door.** Two-way A2A means our agents read words from strangers' agents. The outsider rule (no power seed, prompting mode) must be pinned by tests on the new room-member path before it ships, as DOR-2739 did for other outsiders.
2. **Is anyone asking?** Founders do not run Bedrock or Copilot Studio agents. Before building ticket 2, check whether a real user needs to bring an outside agent into a room. If not, tickets 1 and 3 are enough for launch.
3. **Moving targets.** A2A's spec is stable now, but its JS SDK has shipped five minor releases since July; TanStack AI is still 0.x. Pin exact versions and keep each behind our own seam (gateway package, Engine port).
