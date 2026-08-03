---
title: 'Multi-agent messaging routing and credential scoping — prior art (2026-08)'
date: 2026-08-03
type: external-best-practices
status: active
tags:
  [
    connections,
    bindings,
    telegram,
    credential-scoping,
    agent-scoping,
    openclaw,
    zapier,
    dust,
    claude-code,
    mcp,
  ]
related:
  [
    research/20260727_hermes-openclaw-group-chat.md,
    research/20260729_connections-ux-critique.md,
    research/20260727_agents-in-group-chat-industry-survey.md,
  ]
---

# Research: Multi-Agent Messaging Routing & Credential Scoping — Existing Prior Art

This task substantially overlaps with prior research already in `research/`. I did fresh web research to fill named gaps (n8n, Botpress, Chatwoot, Lindy.ai, Zapier Agents, ChatGPT/Claude.ai connector scoping, Claude Code's new "channels" feature, Dust.tt spaces, Claude Code MCP scope ladder) and combined it with deep existing coverage. Below are findings with citations, organized as requested, followed by synthesis.

Relevant existing DorkOS research (all still current, cited inline as [repo: …]):

- `/Users/doriancollier/Keep/dork-os/dorkos/research/20260727_hermes-openclaw-group-chat.md` — OpenClaw + Hermes Agent mechanics in exhaustive source-level detail
- `/Users/doriancollier/Keep/dork-os/dorkos/research/20260727_agents-in-group-chat-industry-survey.md` — Slack/Teams/ChatGPT/Discord/Telegram trigger-policy survey
- `/Users/doriancollier/Keep/dork-os/dorkos/research/20260729_platform-presence-patterns.md` — typing/ack signal mechanics
- `/Users/doriancollier/Keep/dork-os/dorkos/research/20260625_agent_auth_patterns_meta_harnesses.md` — LLM-provider credential patterns across 10 agent harnesses (adjacent to but distinct from third-party service credential scoping)
- `/Users/doriancollier/Keep/dork-os/dorkos/research/20260729_connections-ux-critique.md` — DorkOS's own Composio/Nango/direct-connect critique, with primary-source findings on Claude connectors, Zapier, and MCP OAuth (CIMD/DCR) that answer part of Problem 2 already

---

## PROBLEM 1 — Multiple agents behind one messaging bot

### Telegram: the real mechanisms, verified against `core.telegram.org`

Telegram enforces **one bot token = one bot identity** with no first-party multi-persona concept. The actual routing mechanisms available to a developer:

1. **Deep-link start parameters.** `https://t.me/your_bot?start=airplane` fires `/start airplane` in a private chat; `?startgroup=` does the same for group-add flows. Payload is base64url-recommended, capped at 64 characters. This is the standard way one bot routes a user into a specific _context_ (not a different assistant identity) — "Deep linking allows bots to receive additional context on startup" ([Telegram Bot Features](https://core.telegram.org/bots/features)).
2. **`/commands`.** Slash commands are the baseline router; `/command@OtherBot` disambiguates which bot a command targets in a multi-bot group.
3. **Forum topics (`message_thread_id`).** Telegram groups converted to supergroups support Topics; `channels.createForumTopic`/`getForumTopics` manage them, and a bot includes `message_thread_id` on `sendMessage` to target a specific topic ([Forum topics](https://core.telegram.org/api/forum), [Bot API](https://core.telegram.org/bots/api)). **This is the mechanism real products use to fan one bot token into many isolated conversation contexts** — see OpenClaw below.
4. **Inline mode.** `@botusername keyword` from any chat's input field — a context switch, not a multi-agent router; must be enabled via BotFather.
5. **Privacy mode.** On by default for group-added bots — the bot only receives commands/mentions/replies addressed to it, not the full stream ([Telegram Bot Features](https://core.telegram.org/bots/features)). Toggling it requires **removing and re-adding the bot to every group**, a deliberate friction that makes the escalation from "sees mentions" to "sees everything" a visible, consent-requiring event rather than a silent config flip [repo: 20260727 agents-in-group-chat-industry-survey.md §5].
6. **"Last bot to speak owns the bare `/command`."** In a multi-bot group, an unaddressed `/start` routes to whichever bot spoke most recently — a zero-config, recency-based arbitration heuristic [repo: same, §5].

There is **no platform-level "one token, many assistants" primitive.** Every product that offers multiple assistants behind Telegram either (a) issues one bot token per assistant, or (b) uses forum topics / session keys to fan one token into many _conversation contexts_ served by one process.

### OpenClaw (openclaw/openclaw, formerly Clawdbot/Moltbot) — the fullest real implementation

Verified from `docs.openclaw.ai` and source, 2026-07-27 [repo: `20260727_hermes-openclaw-group-chat.md` Part 2]:

- **Multi-agent, one process.** Each agent gets "its own: Workspace, State directory (agentDir), and Session store," separate `AGENTS.md`/`SOUL.md`, and its own SQLite file.
- **Deterministic routing via `bindings`**, most-specific-wins: `exact peer → parent peer → peer wildcard → guild+roles → guild → team → account → channel → default agent`. Example: a specific WhatsApp phone number routes to `opus`; everything else in that account routes to `chat`. "Peer bindings always win, so keep them above the channel-wide rule." No LLM in the routing loop — this is a specificity ladder like CSS, fully auditable.
- **Per-agent mention patterns.** `agents.entries.*.groupChat.mentionPatterns` lets `@family` route to one agent and `@opus` to another inside the _same room_.
- **Broadcast groups** for the deliberate fan-out case: multiple agents reply to the same peer for the same trigger.
- **Telegram forum topics as conversation isolation, confirmed independently**: "when OpenClaw responds to a message in Thread A, it reads the history of Thread A. It doesn't see Thread B, Thread C, or your main group chat" ([MindStudio: Telegram Threads with OpenClaw](https://www.mindstudio.ai/blog/telegram-threads-openclaw-agent-memory)). Session keys append `:topic:<threadId>` — i.e., **the Telegram topic ID becomes part of the session key**, so one bot token serves N isolated conversations with zero custom mapping logic.
- **Session key = chat identity ("the chat IS the thread")**: `agent:<agentId>:<channel>:group:<id>`; Slack threads key as `agent:<agentId>:slack:channel:<channelId>:thread:<threadTs>`. Default is **one shared session per room**, with per-sender splitting available via bindings.
- **"Ambient room events"** — unmentioned messages become quiet context (session/memory updates) without triggering a reply; the agent must call an explicit `message` tool to speak. Room events use "strict visible delivery" — this is the mechanism that repudiates the older `NO_REPLY` silence-token pattern (below).

### Hermes Agent (NousResearch/hermes-agent) — the second full implementation, contrasting design

[repo: same file, Part 1]:

- **No LLM relevance gate at all** — admission is a deterministic Python predicate at ingress (`_discord_message_admission`), not a judged decision.
- **Silence token** (`[SILENT]`, `NO_REPLY`, etc.) — the model runs every time it's admitted and can only retroactively suppress delivery by outputting the exact token.
- **Session key derivation is per-platform, per-chat-type, with `thread_id` explicitly documented for "forum topics, Discord threads, etc."** — the same chat-identity-as-session-key pattern as OpenClaw.
- **Multi-agent posture is explicitly unsupported, in writing**: "Bot-to-bot conversation is not supported... Wiring multiple Hermes profiles to reply to one another in a shared channel... is an unsupported topology" — because Discord auto-mentions the replied-to author, so two bots satisfy each other's mention gate and ack-loop forever. **Multiple assistants = multiple OS processes with separate `HERMES_HOME`,** i.e., separate bot tokens, not one token routed internally.
- **Real user report** ([hermes-agent#14853](https://github.com/NousResearch/hermes-agent/issues/14853)): a user running three Hermes instances as separate systemd services in shared channels reports "Bot-mention loops — bot-generated @mentions trigger cascades; no gateway-level prevention exists," with loop prevention delegated to prompt instructions (SOUL.md telling agents never to @mention peers). No maintainer fix shipped.

### Anthropic's own "Channels" (Claude Code, research preview, 2026) — directly relevant precedent

Fetched live from [code.claude.com/docs/en/channels](https://code.claude.com/docs/en/channels):

- A **channel is an MCP server that pushes events into your running Claude Code session** — Telegram, Discord, and iMessage ship as official plugins. "Events only arrive while the session is open... for an always-on setup you run Claude in a background process."
- Setup is per-bot-token, same as everyone else: create a bot via BotFather, `/telegram:configure <token>`, saved to `~/.claude/channels/telegram/.env`.
- **Explicit sender allowlist with a pairing flow**: text the bot, it replies with a pairing code, `/telegram:access pair <code>`, then `/telegram:access policy allowlist` locks it down. "Only IDs you've added can push messages, and everyone else is silently dropped."
- **Two-way and session-anchored**: "the event arrives in the session you already have open" — explicitly contrasted with cloud-session-spawning integrations. "You see the inbound message in your terminal but not the reply text... the actual reply appears on the other platform."
- **Layered enterprise gating**: a master switch `channelsEnabled` (Team/Enterprise default OFF, Console default ON), plus `allowedChannelPlugins` to restrict which plugins can register — the exact same allowlist-of-allowlists pattern seen in OpenClaw's agent-to-agent gating.
- Anthropic's own comparison table distinguishes **Claude in Slack** (spawns a fresh cloud session from an `@Claude` mention) from **Channels** (pushes into an _already-running_ local session) from **Remote Control** (you drive an existing session from your phone) — three different continuity models in one product family, explicitly named as different tools for different jobs.

### Claude in Slack (code.claude.com/docs/en/slack) — verified scope ladder [repo: 20260727 survey §1.4]

Four-level: **Enterprise Grid org → Workspace (admin installs) → Channel (`/invite @Claude` gates access) → per-user Routing Mode** (Code-only vs Code+Chat, set in App Home). Context scoping is concrete and published: "when mentioned in a channel, Claude will have access to the last 20 messages... when using @Claude in a thread, it will have access to the last 50 messages in that thread." Mention-gated, hard — no unprompted speech, no DMs.

### Adapt (3rd-party Slack agent) — the one product with an opt-in relevance gate

`@-mention only` by default; admins can opt a channel or thread into a plain-English policy evaluated per-message by a "fast judge model." Thread-level settings override channel-level. This is the cleanest shipped example of **hierarchical, natural-language relevance policy with opt-in escalation** ([Adapt changelog](https://adapt.com/changelog/proactive-agent-slack)) [repo: same survey §1.1].

### ChatGPT group chats — the industry's only "speak-when-relevant-by-default" product

"ChatGPT decides when to respond and when to stay quiet based on the context of the group conversation... You can always mention 'ChatGPT'" ([OpenAI, secondary-sourced via 9to5Mac](https://9to5mac.com/2025/11/20/chatgpt-gaining-group-chat-feature-in-four-regions/)). Up to 20 participants, join by link, **rate limits only count when it responds** — an elegant incentive that makes silence free [repo: same survey §3].

### n8n — agent-first setup, channel as a deploy target, workflow is the unit of binding

Fresh research, verified via [n8n Chat Trigger docs](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger) and search corroboration:

- The unit is the **workflow**, not a persistent "agent" object: a `Chat Trigger` node (webhook) feeds an `AI Agent` node. One workflow can receive from Slack, Telegram, WhatsApp, or a website widget "or any platform that supports webhooks" via the same trigger abstraction.
- **Binding is per-workflow, not mandatory at a global setup step** — you build the workflow (agent logic) first, then attach whichever trigger/channel node you want; a single agent logic can be deployed to multiple channel triggers by duplicating/wiring nodes.
- Credentials for the channel connection (Slack token, Telegram bot token) are separate n8n **Credential** objects scoped by n8n's project/RBAC system: "n8n uses projects to group workflows and credentials, and assigns roles to users in each project... Custom project roles let you define granular access to workflows, credentials" ([n8n RBAC docs](https://docs.n8n.io/user-management/rbac/), [Organize work in projects](https://docs.n8n.io/administer/manage-users-and-access/set-permissions-and-roles-rbac/organize-work-in-projects)). This is n8n's precedent for **layered credential scoping** — global vault secrets, restricted to instance owners/admins in personal projects; shared credentials scoped per-project with custom roles.

### Botpress — channel-first, multi-channel single agent

"Botpress is a visual AI agent studio that deploys the same bot to webchat, WhatsApp, Slack, Telegram, and other channels... Incoming messages are normalized into Botpress events so the agent can apply policies, knowledge retrieval, and workflows just like on any other channel" ([Channel integration](https://botpress.com/blog/channel-integration), [Configuring Channels](https://botpress.com/academy-lesson/configuring-channels)). Setup per-channel: BotFather token → paste into Botpress Studio integration config → webhook URL. **One agent, many channel bindings** — the inverse emphasis from OpenClaw's "many agents, one channel token."

### Chatwoot / Intercom — inbox-and-handoff routing (the support-desk pattern, not a coding-agent pattern but directly answers "team routing")

- **Chatwoot AgentBot**: "connect external AI agents and custom bot logic directly to your Chatwoot inbox... new conversations are automatically assigned a pending status and Chatwoot sends conversation events to your configured bot URL as webhook events. The AgentBot can toggle a conversation status to open to hand off the conversation to a human agent" ([Chatwoot Agent Bots docs](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots)). Binding is **inbox-level**: a bot is attached to an inbox, and the inbox's status field (`pending`/`open`) is the handoff signal — a lightweight FSM instead of routing logic.
- **Intercom Fin AI Agent**: "Turning on the bot inbox allows you to automatically assign conversations to a separate bot inbox while a workflow or Fin AI Agent is active... Fin AI Agent conversations will be assigned out of the bot inbox automatically after 3 minutes of inactivity" with configurable handover rules to specific teams ([Intercom: Turn on the bot inbox](https://www.intercom.com/help/en/articles/3722087-turn-on-the-bot-inbox)). This is the clearest example of **inbox-as-container + timeout-based handoff** as a routing primitive — a different axis than mention-gating, built for the "escalate to human" case rather than "route to correct assistant."

### Lindy.ai and Zapier Agents — account-OAuth-first, agent logic built on top

- **Lindy**: "authorize your Slack workspace by clicking 'Connect' and following the OAuth flow... Configuration options allow you to monitor specific channels or listen to every channel in your workspace" ([Lindy Slack docs](https://docs.lindy.ai/skills/popular-integrations/slack)). Connection is account/workspace-level; individual "Lindies" (agents) are then wired to specific triggers within that connected workspace via Lindy's "Rails" workflow builder.
- **Zapier Agents**: setup is explicitly **agent-first with mandatory connection at creation** — verified from the docs: "In the _Connect your apps_ step, you'll see all apps identified from your instructions. Create a new connection for each app..." The sequence is create-agent-with-instructions → system identifies required apps → connect/select app connections → configuration proceeds ([Build an agent in Zapier Agents](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents)). "Zapier Agents are personal automations tied to your account" — connections are user-account-level, not independently documented as agent-isolated.

### The continuity/history problem — how products keep conversation memory across turns

The dominant pattern across every product surveyed is **"the chat IS the thread": the external chat/thread identifier becomes (part of) the session key, with no separate DorkOS-style transcript store.** Concrete instances:

- **OpenClaw**: `agent:<agentId>:<channel>:group:<id>` [+ `:topic:<threadId>` for Telegram forum topics, `:thread:<threadTs>` for Slack threads]. One shared session per room by default.
- **Hermes**: `SessionSource.thread_id`, explicitly documented for "forum topics, Discord threads, etc." Per-user-inside-channel isolation is the default (`group_sessions_per_user: true`), invertible to one shared room conversation.
- **Slack (platform-native)**: `thread_ts` = the parent message's own `ts` — there is no separate thread object at all; "the parent message _is_ the thread" ([Slack docs, via 20260727_thread-models.md]).
- **Claude Code Channels**: session-anchored by design — events arrive into whatever session is already open; there is no persistent external mapping beyond "this session is currently subscribed to this channel."

**No product found lets multiple internal sessions/workers all send coherently into one external chat** as a first-class feature. The closest approximation is Hermes's `group_sessions_per_user: false` mode, which explicitly warns: "the entire channel shares one conversation transcript and one running-agent slot... follow-up messages from different people can interrupt or queue behind each other" — i.e., when a product does try to let multiple senders share one external chat, it degrades to a single serialized run, not true multi-worker coherence. This is a genuine, well-documented gap across the industry [repo: 20260727_hermes-openclaw-group-chat.md, 20260727_agents-in-group-chat-industry-survey.md §9].

---

## PROBLEM 2 — Scoping third-party account credentials to agents

### ChatGPT connectors — user/org, not per-conversation

"ChatGPT connectors can be scoped as Individual (private) or Organization (shared; admins can share org-wide)" — account/org-level scoping, verified via search corroboration of OpenAI's own documentation structure ([composio.dev summary of ChatGPT vs Claude connectors](https://composio.dev/content/how-to-connect-chatgpt-and-claude-to-your-apps-safely-today)). No per-conversation toggle was found documented for ChatGPT connectors — once connected, a connector's data is available across the account (or org, if admin-shared).

### Claude.ai connectors — the clean two-level example the brief asked for

Verified via Claude Help Center search results and corroborated by a live GitHub issue:

- **Level 1 — org/account enablement**: "Connectors are enabled at the organization level, and once enabled, any user in the org can connect their individual account." Per-user or per-group connector _gating_ (restricting which users see which connectors) is explicitly **not currently available**.
- **Level 2 — per-conversation toggle**: "you can enable connectors for individual conversations via the '+' button... then 'Connectors,' where you'll see your configured connectors with toggles allowing you to enable/disable them per conversation."

This is the cleanest real-world instance of "this agent/account can always use X" (standing, org-provisioned) layered under "this session may use X" (per-conversation toggle) that the brief asked for. **But the boundary is coarser than it looks**: a live user complaint ([anthropics/claude-code#26625](https://github.com/anthropics/claude-code/issues/26625), closed as duplicate) shows the _client_ axis is missing entirely — "Claude.ai MCP connectors are managed exclusively at the account level... When enabled on your account, they automatically connect in every Claude Code session — there is no local setting to disable specific connectors for Claude Code only... if you want connectors available in Claude.ai Chat/Cowork but not in Claude Code (or vice versa), you're out of luck." The user tried `permissions.deny` (blocks tool calls but the server still connects), `deniedMcpServers` regex (can't match server names with dots/spaces), and server-URL filtering (no effect on cloud connectors) — all three workarounds failed. **This is the concrete failure mode of collapsing "per-surface" and "per-conversation" into one setting.**

### Claude Code MCP config scoping — the layered-scoping precedent explicitly asked for

Verified live from [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) and corroborated by third-party docs:

- **Three scopes, strict precedence, no field-merging across scopes**: **local** (`~/.claude.json`, keyed to the exact project path, private to you — the default) → **project** (`.mcp.json` at repo root, checked into version control, shared with the team) → **user** (`~/.claude.json` globally, available across all your projects, private to you). "Local scope takes precedence over project, which takes precedence over user. When the same server is defined in more than one place, Claude Code uses the entire entry from the highest-precedence source and does not merge fields."
- Set explicitly via `--scope`: `claude mcp add <name> <command>` (local, default) / `--scope project` (writes `.mcp.json`) / `--scope user`.
- This gives three genuinely distinct _intents_ in one ladder: **experiment privately in one project** (local) → **standardize for a team on one repo** (project) → **carry a tool everywhere I work** (user) — a materially richer model than "session vs standing," worth studying even though it's a different axis (project/team/personal rather than conversation/agent).

### Claude Code Channels — organization-level master switch + allowlist, session-level opt-in

From the same live fetch above: `channelsEnabled` (org master switch, admin-controlled) → `allowedChannelPlugins` (which specific plugins may register, replacing the default Anthropic allowlist) → **`--channels <plugin>` at process-launch is the session-level opt-in** ("no channel runs until a user opts it in for the session with `--channels`"). This is a third real instance of the standing-vs-session split, on the _messaging-channel_ credential axis rather than the tool-connector axis.

### Claude Code MCP connector tools — org-level ask/allow controls (adjacent precedent)

The channels doc references `/docs/en/mcp#organization-controls-on-connector-tools` and per-tool `requiresUserInteraction` — org admins can force specific connector tools to always prompt (`ask`) regardless of the user's local permission mode, which is a fourth scoping axis (tool-level policy override) layered on top of the connection-level scopes above.

### Zapier — per-agent connection at creation, credentials never exposed to the model

"Your underlying app credentials (your Gmail OAuth token, your Salesforce login) are never exposed to the AI client—the client only ever sees the Zapier MCP endpoint. Zapier manages authentication, encryption, and rate limiting centrally" ([Zapier MCP](https://zapier.com/mcp)). Community guidance for the MCP surface specifically: "give each agent its own server rather than one over-scoped server shared across many... scope deliberately and only enable the actions this particular agent actually needs" — a per-agent-server recommendation, though not a platform-enforced boundary.

### Dust.tt Spaces — the most explicit agent-level standing-scope model found

Verified via [Dust Spaces docs](https://docs.dust.tt/docs/data) and [Access Controls and Permissions](https://docs.dust.tt/docs/access-controls-and-permissions):

- **Spaces are the access-control container.** "Agents that access data from a specific space are only available to members of that space." An agent's `requestedSpaceIds` is an **AND condition** — a user must have access to _every_ listed space to use the agent at all, computed automatically from "action requirements, skill requirements from their attached knowledge sources and MCP servers, and additional user-selected spaces."
- **Tool credentials are shared, not per-user**: "Tools' credentials will be used by all users who have access to the tool" — i.e., one connected credential serves every member with space access, a workspace-shared model rather than per-user OAuth.
- **API keys scoped to multiple spaces** as of a recent changelog, replacing single-space binding.

This is standing/agent-level scoping done through _space membership_ rather than a toggle — access is a side effect of who's in the room, which is structurally different from (and arguably cleaner than) a per-agent checkbox list.

### Nango, Composio, and DCR/CIMD (MCP OAuth) — already deeply researched in `/Users/doriancollier/Keep/dork-os/dorkos/research/20260729_connections-ux-critique.md`

That report, produced 2026-07-29 with live API probes, already answers most of "who asks for consent, and when":

- **Composio and Nango are per-user-id (`user_id`/`entity_id`) aggregators**: "Authentication is always per user... Composio stores and refreshes those credentials against that userID" ([Composio auth docs](https://docs.composio.dev/docs/authentication)), quoted in the DorkOS report. Critically, **the vendor consent screen names the aggregator, not the product**: "Users will see 'Composio wants to access your account' during OAuth," and Nango's own guide says "users authorize Nango instead of your product" — both vendors explicitly recommend registering your own OAuth app for production.
- **Direct-connect via current MCP spec (2026-07-28)** is documented as MUST-support OAuth 2.1 + PKCE, with DCR now _deprecated_ in favor of **Client ID Metadata Documents (CIMD)** — "host a JSON metadata doc at an HTTPS URL and use that URL _as_ the `client_id`... no registration round-trip." The DorkOS report live-verified DCR registration success against Linear, Notion, Stripe, and Vercel's MCP endpoints.
- **Claude connectors/Cowork's own pattern**, quoted in that report: "authenticate directly with your Google account," return to Claude — in-app OAuth redirect with **no aggregator and no vendor name shown**, the cleanest custody story surveyed. **Google itself runs official Workspace remote MCP servers** reachable via a bring-your-own-OAuth-client model (a Google Cloud project + consent-screen verification + CASA assessment for restricted scopes) — meaning the aggregator is a shortcut around OAuth-client registration, not a structural requirement.
- **Raycast's pattern** is also documented there: OAuth through Raycast's own PKCE proxy so extensions never hold a secret, or a per-extension API-key field — "Raycast is visible as the platform; no third-party aggregator is."
- The report's central finding: **"across this survey, no consumer- or prosumer-facing product asks a user to bring an aggregator API key. That pattern exists only in developer/B2B contexts."**

### Failure modes on credential scoping (forum/complaint evidence found)

1. **Coarse account-level scoping bleeds into every surface** — the concrete anthropics/claude-code#26625 complaint above: connectors enabled once apply to every client (Chat, Cowork, Code) with no way to scope down per-surface, and every documented workaround (permission deny-lists, regex server-name filters, URL filtering) failed.
2. **Vendor-naming-at-consent as a phishing-shaped surprise** — not a forum complaint but a structural finding in the DorkOS connections critique: Composio's and Nango's own docs concede the user sees the aggregator's name, not the product's, at the exact moment of highest trust sensitivity (granting mailbox access) — "For Priya that is a red flag. For Lil it is indistinguishable from a phishing page," and the report recommends disclosing the aggregator's name _before_ the redirect rather than letting the user discover it mid-flow.
3. **General LLM-connector privacy alarm** (secondary/less specific, but corroborates the category of complaint): coverage of "LLM Scope Violations" — a named risk pattern where a connected model accesses or leaks data the user didn't intend it to reach once a connector is broadly enabled — circulates in 2026 AI-security commentary, though I could not pin a single canonical incident report to cite as primary (flagged as weak sourcing).
4. **Bot-mention loops from ungated multi-bot routing** (Problem 1's analogue) — the Hermes #14853 and #32791 reports above are the concrete, well-documented version of "routing confusion," not on Telegram/OpenClaw specifically but structurally identical: ungated bot-to-bot addressing satisfies mention gates indefinitely.

---

## Synthesis

### Problem 1 — dominant patterns

1. **Mention-gating is the industry default everywhere except ChatGPT group chats.** Slack, Teams, Telegram (privacy mode), Discord-bot convention, Hermes, and OpenClaw's default `mention` mode all require an explicit address before an agent speaks; ChatGPT alone ships a trained relevance gate as the default, with silence costing nothing against rate limits.
2. **One bot token routes to many _conversation contexts_ via chat/thread identifiers, not to many _assistant identities_.** No platform lets one Telegram token present as multiple bot personas; every real multi-agent product either issues one token per agent (Hermes's explicit stance) or fans one token into many sessions keyed by `chat_id`/`thread_id`/forum-topic-id (OpenClaw, Hermes's own per-chat session keys, Slack's `thread_ts`).
3. **"The chat IS the thread" is the near-universal continuity mechanism** — no product surveyed maintains a separate DorkOS-style durable transcript store distinct from the external chat/thread; the external identifier _is_ the session key.
4. **Multi-worker-into-one-chat is unsolved industry-wide.** The one product that tried (Hermes's shared-session mode) documents it as a degradation (interrupt/queue contention), not a feature.

**Best mechanisms found for Problem 1:**

- **OpenClaw's binding specificity ladder** (exact peer → wildcard → guild → account → default agent, first-match-wins, no LLM) is the most auditable, debuggable multi-agent router in the survey — a deterministic routing table, not a judged decision.
- **Telegram forum topics as free per-conversation memory isolation**, confirmed by both OpenClaw's and Hermes's independent adoption of `thread_id`/topic-id as a session-key component — zero custom infrastructure, entirely riding a platform primitive.
- **Anthropic's own Channels feature's pairing-code allowlist** (text the bot → get a code → approve it in-session) is the cleanest consent UX for "who may push into my running session" found anywhere in this survey, better than Telegram/Discord bot-invite alone because it requires an explicit round-trip approval rather than trusting group membership.

### Problem 2 — dominant patterns

1. **Consent happens at the vendor's own OAuth screen, always** — every product surveyed (Claude connectors, ChatGPT connectors, Zapier, Nango, Composio, Google Workspace MCP) routes final consent through the third-party's own authorization page; the only variable is _whose name appears on that screen_ (the product's own registered OAuth app vs. an aggregator's).
2. **Scoping converges on two independent axes that most products conflate**: _who provisions the connection_ (org admin enables the connector type vs. an individual user connects their own account) and _where it's usable_ (account-wide vs. per-conversation/per-agent). Claude.ai is the only product surveyed that cleanly separates these into two settings — org enablement, then per-conversation toggle — but even it collapses a third axis (per-client/per-surface) that users have already asked for and been refused (#26625).
3. **Aggregators (Composio/Nango) cannot hide themselves from the OAuth consent screen** — this is a documented vendor admission, not a design choice a client-side product can route around.

**Best mechanisms found for Problem 2:**

- **Claude Code's MCP scope ladder (local → project → user)** is the strongest _layered, precedence-based_ scoping model found — highest-precedence scope wins wholesale (no field-merging), which is simple to reason about and matches DorkOS's likely need for session/agent/global layering.
- **Dust.tt's space-membership-as-access-control** (agent access is an AND over required spaces, computed automatically from the agent's own attached tools/knowledge sources) is the cleanest _standing, agent-level_ model — access follows structural membership rather than a manually maintained per-agent checkbox list, so it can't silently drift out of sync the way a checkbox list can.
- **Claude.ai's org-enable-then-per-conversation-toggle pair**, read together with its documented gap (#26625), is the best available precedent _and_ the clearest cautionary tale: it proves the two-level pattern is buildable and usable, but also proves that a third axis (client/surface) must be designed in from the start or it becomes an unfillable gap later.

Sources: [Telegram Bot Features](https://core.telegram.org/bots/features) · [Telegram Forum topics](https://core.telegram.org/api/forum) · [Telegram Bot API](https://core.telegram.org/bots/api) · [OpenClaw docs](https://docs.openclaw.ai) (via repo research) · [Hermes Agent](https://github.com/NousResearch/hermes-agent) (via repo research) · [MindStudio: Telegram Threads with OpenClaw](https://www.mindstudio.ai/blog/telegram-threads-openclaw-agent-memory) · [Claude Code Channels](https://code.claude.com/docs/en/channels) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Claude Code Slack](https://code.claude.com/docs/en/slack) (via repo research) · [n8n Chat Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger) · [n8n RBAC](https://docs.n8n.io/user-management/rbac/) · [Botpress channel integration](https://botpress.com/blog/channel-integration) · [Chatwoot Agent Bots](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots) · [Intercom bot inbox](https://www.intercom.com/help/en/articles/3722087-turn-on-the-bot-inbox) · [Lindy Slack docs](https://docs.lindy.ai/skills/popular-integrations/slack) · [Zapier Agents build guide](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents) · [Zapier MCP](https://zapier.com/mcp) · [Dust Spaces](https://docs.dust.tt/docs/data) · [Dust Access Controls](https://docs.dust.tt/docs/access-controls-and-permissions) · [anthropics/claude-code#26625](https://github.com/anthropics/claude-code/issues/26625) · [Composio auth docs](https://docs.composio.dev/docs/authentication) (via repo research) · [Adapt Slack proactive mode](https://adapt.com/changelog/proactive-agent-slack) (via repo research) · [OpenAI ChatGPT group chats, via 9to5Mac](https://9to5mac.com/2025/11/20/chatgpt-gaining-group-chat-feature-in-four-regions/)
