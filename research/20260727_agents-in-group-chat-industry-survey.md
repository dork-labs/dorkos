---
title: 'How shipping products handle AI agents in multi-person group chats'
date: 2026-07-27
type: external-best-practices
status: active
tags:
  [
    group-chat,
    multi-agent,
    rooms,
    channels,
    trigger-policy,
    speaker-selection,
    loop-prevention,
    agent-etiquette,
  ]
feature_slug: room-participation
searches_performed: 18
sources_count: 38
---

# AI Agents in Multi-Person Group Chats: State of the Art (July 2026)

## Research Summary

Across every shipping product examined, the industry has converged on **mention-gated participation as the default**, with unprompted speech treated as an opt-in escalation that must be scoped narrowly (per-channel, per-thread) and backed by a cheap "should I speak?" judge. The second convergent pattern is **bot-source suppression** — nearly every platform either hides other bots' messages from bots at the platform layer (Telegram privacy mode) or makes `if (author.bot) return` the first line of every handler (Discord) — and where that guard is relaxed for legitimate multi-agent work, real infinite-loop incidents follow within weeks. The third is **channel restraint**: threads over main channel, batched notifications, reactions as status, and full transcripts moved to a side surface.

The biggest _unsolved_ problem across the board is multi-agent arbitration. No mainstream chat platform ships deduplication ("another agent already answered this"). Slack, Teams, and Discord all resolve contention by making the human name the agent. Frameworks (AutoGen, LangGraph, CrewAI) solve it with an explicit orchestrator, which is a different topology than a shared room.

---

## 1. Slack

Slack has the most explicit published design guidance of any vendor. It is worth reading in full.

### 1.1 Trigger / response policy

Slack's platform splits agent presence into two surfaces:

- **Assistant threads / "Agents & AI apps"** — a dedicated split-view side panel. Slack lists the surfaces as "a split-view container, top navigation entry point, app threads, text streaming, and suggested prompts" ([AI in Slack overview](https://docs.slack.dev/ai/)).
- **Channels** — where the agent is a member and must behave like a guest.

Event scoping is the trigger mechanism. The `app_mention` event fires only when the bot is named:

> "This app event allows your app to subscribe to message events that directly mention your bot users."
> "If your app is mentioned but not part of a conversation (and not invited to join), you won't receive an event."
> "The `app_mention` event is not a `message` like the `message.*` event types."
> "Messages sent to your app in direct message conversations are **not** dispatched via `app_mention`" — use `message.im`.
> — [app_mention event, Slack Developer Docs](https://docs.slack.dev/reference/events/app_mention/)

The alternative, `message.channels`, delivers _every_ message in a public channel. The practical distinction: "with the `app_mention` event, you'll receive only the messages pertinent to your app, whereas `message.channels` captures all messages in public channels" ([Enabling interactions with bots](https://api.slack.com/bot-users)). **The choice of event subscription IS the trigger policy** — this is the cleanest platform-level expression of the pattern anywhere.

Anthropic's Claude app is mention-only and channel-membership-gated:

> "Claude is not automatically added to any channels after installation. To use Claude in a channel, invite it by typing `/invite @Claude` in that channel. Claude can only respond to @mentions in channels where it has been added."
> — [Claude Code in Slack](https://code.claude.com/docs/en/slack)

Agentforce is likewise mention-gated in channels: "You can work with Agentforce agents in channels by adding an agent to a channel and getting their attention by mentioning them in a message" ([Use Agentforce in Slack](https://slack.com/help/articles/36218786859667-Use-Agentforce-in-Slack)). Proactive behavior exists but is **system-initiated from outside the chat** (a Salesforce record change fires a notification), not the agent deciding to interject in a human conversation.

The one product found that lets an agent decide to interject on its own is third-party: Adapt's proactive agent mode.

> "By default, every channel and thread stays in **`@-mention only`** mode — exactly the behavior that already existed. Nothing changes until you explicitly opt a scope into one of the new modes."
> "You write a one-line policy in plain English (e.g. _'respond to top-level messages reporting a bug, skip emoji-only replies'_)."
> "For each new message, a fast judge model evaluates the message + surrounding context against your policy and decides whether Adapt should respond."
> "Modes can be set at the channel level or overridden per thread. Thread-level settings take precedence."
> — [Adapt changelog: Proactive agent mode in Slack](https://adapt.com/changelog/proactive-agent-slack)

This is the **relevance gate** pattern in its most explicit shipped form: natural-language policy + cheap judge model + hierarchical scope (thread overrides channel) + opt-in default.

### 1.2 Verbosity norms — Slack's guidance is unusually prescriptive

> "Agent responses should be made in threads. This prevents flooding the main conversation."
> "Responses in DM and channels should behave differently and be appropriate to the expectations of these different spaces. DMs can be more conversational but responses in channels should be minimal."
> "Organize related notifications into batches. Five issue updates should be one message, not five."
> "If the agent is sharing private information, send it only through DMs, private channels, or ephemeral messages."
> "Show a status indicator immediately after the user sends a message. This can range from a lightweight emoji reaction to a 'Working on it...' status."
> "Status updates as the agent progresses. 'Searching your workspace...' → 'Found 3 matching issues...' → 'Formatting results...'"
> — [Agent design, Slack Developer Docs](https://docs.slack.dev/concepts/agent-design/)

Additional from the AI best-practices page:

> "Add a disclaimer at the footer of app messages indicating that the response was generated by an LLM (large language model)"
> "Slack will automatically group your app conversations into threads, shown in a timeline above the composer."
> Enable users to "see the response from the LLM as a text stream, rather than a single block of text sent all at once."
> Show "plan" or "task update" views so "users [can] better understand what the app is doing."
> "Do not store any Slack data you obtain. Instead, store metadata and pull in data in real time if needed."
> — [AI apps best practices](https://docs.slack.dev/ai/ai-apps-best-practices)

Slack also prescribes graceful failure with bounded autonomy: when stuck, an agent should "save what it's accomplished, explain where it got stuck and why, give the user options" including "skip the blocked step or take over manually." And it frames error tone: "Use a calm, helpful tone. The agent broke, not the user." ([Agent design](https://docs.slack.dev/concepts/agent-design/))

Confirmation gates: agents should pause for approval on "actions that ha[ve] real-world implications like creating, sending, or deleting content" — bounded autonomy means "freedom to figure out how to achieve it, but also set clear boundaries around what it can and cannot do without asking."

### 1.3 Context window in channels (concrete numbers)

Claude in Slack publishes exact context scoping — a rare concrete number:

> "when mentioned in a channel, Claude will have access to the last 20 messages in that channel, including any files shared within those messages, while when using @Claude in a thread, it will have access to the last 50 messages in that thread."
> — reported from [Claude Help Center](https://support.claude.com/en/articles/12461605-use-claude-in-slack) via search; the developer docs state qualitatively: "When you @mention Claude in a thread, it gathers context from all messages in that thread... When mentioned directly in a channel, Claude looks at recent channel messages."

Anthropic also flags the prompt-injection consequence of channel context:

> "When @Claude is invoked in Slack, Claude is given access to the conversation context to better understand your request. Claude may follow directions from other messages in the context, so users should make sure to only use Claude in trusted Slack conversations."
> — [Claude Code in Slack](https://code.claude.com/docs/en/slack)

### 1.4 Settings surfaces (scope ladder)

Claude in Slack has a clean four-level scope ladder, which is a good model:

| Scope               | Control                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enterprise Grid org | "organization admins can control which workspaces have access to the Claude app"                                                                     |
| Workspace           | "Workspace admins decide whether to install the Claude app"; "Removing the app from a workspace immediately revokes access for all users"            |
| Channel             | "`/invite @Claude`... Channel membership controls access... Admins can control who uses Claude Code by managing which channels Claude is invited to" |
| Per-user            | Routing Mode (**Code only** vs **Code + Chat**), set in App Home; sessions run under the user's own account and count against their own rate limits  |

— [Claude Code in Slack](https://code.claude.com/docs/en/slack)

The **Routing Mode** setting is notable: it's a per-user policy for how an ambiguous mention is interpreted, with a per-message escape hatch ("Retry as Code" / choose Chat in that thread).

### 1.5 Multi-agent arbitration in Slack

Nothing native. Slack does not deduplicate across apps; if two agents are in a channel and both are mentioned, both respond. Community practice is to give **one Slack app per agent identity** and rely on distinct @names ([Running Multiple AI Agents as Slack Teammates via OpenClaw](https://gist.github.com/rafaelquintanilha/9ca5ae6173cd0682026754cfefe26d3f)).

### 1.6 Duplicate-response failure mode (real report)

A documented debugging writeup of a Slack agent producing **6 duplicate responses** to one message traces it to Slack's retry semantics rather than multi-agent contention: "Deduplication is critical—retries WILL happen; handle them gracefully using event IDs to detect duplicate deliveries" ([Debugging Slack Integration: From 6 Duplicate Responses to Instant Acknowledgment](https://startaitools.com/posts/debugging-slack-integration-from-6-duplicate-responses-to-instant-acknowledgment/)). Lesson: **event-id dedupe is table stakes before any agent-level dedupe.**

---

## 2. Microsoft Teams

### 2.1 Trigger policy

Mention-gated, with agents explicitly added to a chat first: "You can choose multiple agents and add them to a chat"; "agents added to Teams can then be @mentioned in the chat" ([Find and add Copilot agents to group chats in Microsoft Teams](https://support.microsoft.com/en-us/office/find-and-add-copilot-agents-to-group-chats-in-microsoft-teams-4a837195-3d75-438f-a336-840c16a74432)).

Microsoft's Build 2026 developer post is the richest source on the newer interaction patterns:

> "seamless @ mention from your Teams channels, group chats, and meetings."
> "Agents can now have 1:1 interactions with individuals in a group setting through targeted messages" — "an agent can message an individual user in a Teams channel if they need access to a tool to complete a task without cluttering an ongoing conversation."
> "participate in conversations with lightweight signals like emoji reactions and feedback"
> "With agent sessions — context-aware interactions that allow agents to maintain continuity and track progress over time — and threaded conversations in channels, agents can track work."
> "quoted replies, further enable agents to participate in real processes like approvals, clarifications, and iterative decision-making."
> As of June 2026, agents work in "standard, private, and shared channels."
> — [Build collaborative agents where work happens, Microsoft 365 Developer Blog](https://devblogs.microsoft.com/microsoft365dev/build-collaborative-agents-where-work-happens/)

**Two ideas here are distinctive and directly transferable:**

1. **Targeted messages** — the agent addresses one person inside a group room without adding a public message. This is a middle ground between "post to channel" and "DM", and it's explicitly motivated by noise ("without cluttering an ongoing conversation").
2. **Emoji reactions as a first-class participation channel** — a way to acknowledge without speaking.

### 2.2 Multi-agent

Multiple agents can be in a chat, each @mentionable. Microsoft's multi-agent _arbitration_ story lives in Copilot Studio "connected agents" / multi-agent orchestration, which is a supervisor-delegation topology outside the chat room, not in-room contention resolution ([Connected agents, Microsoft Learn](https://learn.microsoft.com/en-sg/answers/questions/2280477/connected-agents-feature-on-microsoft-copilot-stud)).

### 2.3 Known friction

There are live reports of `@mention` of Copilot failing to resolve in Teams chats, with the mitigation being "Once the agent is part of the chat, the @mention should resolve normally" ([Microsoft Q&A: Copilot in Teams Chats - @mention Copilot does not work](https://learn.microsoft.com/en-us/answers/questions/5763221/copilot-in-teams-chats-@mention-copilot-does-not-w)). Membership-before-mention is a real UX cliff.

**Not verified:** admin/governance scope details for agents in group chats, and agent-in-meeting turn-taking specifics. The Build post does not cover them and the Q&A thread on meeting connections is unresolved.

---

## 3. ChatGPT group chats (OpenAI, shipped Nov 2025)

This is the closest analogue to a room where an AI is one participant among many humans, and OpenAI explicitly built a _social_ trigger policy rather than a mention gate.

**Caveat: openai.com and help.openai.com both returned HTTP 403 to direct fetch.** Every quote below is a secondary source reporting OpenAI's own description. Treat wording as approximate.

### 3.1 Trigger policy — a learned relevance gate, not a mention gate

> ChatGPT "decides when to respond and when to stay quiet based on the context of the group conversation." "You can always mention 'ChatGPT' in a message when you want it to respond."
> — [Introducing group chats in ChatGPT](https://openai.com/index/group-chats-in-chatgpt/) as reported by [9to5Mac](https://9to5mac.com/2025/11/20/chatgpt-gaining-group-chat-feature-in-four-regions/)

> "OpenAI taught ChatGPT contextually appropriate social behaviors, and the AI now understands when to contribute to conversations and when to remain silent, mimicking the natural rhythm of human group discussions."
> — [Technology.org](https://www.technology.org/2025/11/21/openai-brings-multi-user-chatgpt-conversations-to-everyone/)

So: **default is a model-judged relevance gate, with explicit name-mention as a guaranteed override.** This is the inverse of the Slack default (gate off by default, name required).

### 3.2 Concrete parameters

- **Up to 20 participants** per group chat, across Free/Go/Plus/Pro ([Technology.org](https://www.technology.org/2025/11/21/openai-brings-multi-user-chatgpt-conversations-to-everyone/), [GSMArena](https://m.gsmarena.com/openai_chatgpt_group_chats_global_rollout-amp-70394.php)).
- Joining is by **shareable link**, and "anyone in the group can share that link to bring others in."
- Model: **GPT-5.1 Auto**, which "chooses the best model to respond with based on the prompt and the models available to the user that ChatGPT is responding to based on their Free, Go, Plus or Pro plan." Note the subtlety: **the responding model tier is determined by the plan of the user being responded to** — a per-addressee resource policy inside a shared room.
- **Rate limits only count when ChatGPT responds** ([9to5Mac](https://9to5mac.com/2025/11/20/chatgpt-gaining-group-chat-feature-in-four-regions/)). Silence is free. This is an elegant incentive design: staying quiet costs the user nothing.
- **Emoji reactions**: ChatGPT has "the ability to react to messages with emojis" — the same "acknowledge without speaking" affordance Teams shipped.
- **Profile photos**: it can "reference profile photos—so it can, for example, use group members' photos when asked to create fun personalized images."
- **Per-user isolation**: "personal settings and memory remain isolated for each individual user" ([Technology.org](https://www.technology.org/2025/11/21/openai-brings-multi-user-chatgpt-conversations-to-everyone/)).

### 3.3 What is _not_ published

No description of interruption handling, no dedupe (there is only one agent), no admin scope, no documented statement of how aggressive the relevance gate is or how it was tuned. Commentary was skeptical about the social fit ([The Register](https://www.theregister.com/2025/11/14/openai_chatgpt_group_texts/), [TechRadar](https://www.techradar.com/pro/openai-wants-chatgpt-to-contribute-to-your-group-chats)) but neither contains behavioral specifics.

---

## 4. Discord

### 4.1 Trigger policy and the universal first line of every handler

Discord does **not** hide bot messages from bots at the platform level (unlike Telegram). Consequently the community convention is a hard-coded source filter, taught in beginner guides:

> "The first line checks if the author of the message is the bot, which will exit the method and protect from an infinite loop when the bot sends a message in response to a command." — `if (message.author.bot) return;`
> — [discord.js newcomers guide](https://zachary-murphy.gitbooks.io/discordjs-docs/newcomers.html)

There is a documented discord.js issue where a naive reply handler self-triggered an infinite loop on the word "cute" ([discord.js #2899](https://github.com/discordjs/discord.js/issues/2899)) — the canonical illustration that content-triggered reply without a source filter is unsafe.

### 4.2 Channel-scoped AI response zones

The prevailing 2026 deployment pattern is spatial rather than conversational: "AI responses should be limited to relevant channels to avoid disrupting organic conversations, with many successful servers separating bot interaction zones from social discussion areas." Bots expose settings like `discord_respond_in_threads`, "a boolean that controls whether the bot creates a new thread for each conversation or replies inline, with thread mode keeping channels cleaner on busy servers" ([The Ultimate 2026 Guide to Building a Discord AI Chat Bot](https://skywork.ai/skypage/en/discord-ai-chatbot-guide/2034503847422218240)).

### 4.3 A shipping product's full Discord policy matrix (Hermes Agent)

Hermes Agent (Nous Research) publishes the most complete trigger matrix found for Discord:

> - **DMs**: "Hermes responds to every message. No `@mention` needed."
> - **Server channels**: requires `@mention` by default — `DISCORD_REQUIRE_MENTION=true`
> - **Free-response channels**: `DISCORD_FREE_RESPONSE_CHANNELS` — skip mention requirements and auto-threading
> - **Threads**: reply in-thread; mention rules apply unless parent channel is free-response
> - `DISCORD_IGNORE_NO_MENTION=true` (default): the bot "stays silent if a message @mentions other users but does **not** mention the bot."
>   — [Hermes Agent Discord docs](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/messaging/discord.md)

That last flag is subtle and worth stealing: **if a message names some other participant and not you, shut up** — even in a free-response channel. It is an explicit "this turn is addressed to someone else" signal.

Bot-source policy is a tri-state, not a boolean:

> `DISCORD_ALLOW_BOTS`: `"none"` (default) ignore all other bots; `"mentions"` accept only bot messages that mention Hermes; `"all"` accept all bot messages.

And the docs carry an explicit loop warning:

> Under the `"mentions"` setting, "two bots will satisfy each other's mention gate indefinitely and ack-loop." The supported configuration is leaving `DISCORD_ALLOW_BOTS` at `"none"`.

Session model, relevant to interruption:

> "With `group_sessions_per_user: true` (default), each user gets isolated session history within shared channels. Interrupts only affect individual user sessions. Setting this to `false` creates one shared room conversation with shared running-agent slots."

**This is the key architectural fork for a room with N humans + M agents:** per-user session slices inside a shared channel, versus one shared room conversation. Hermes defaults to per-user isolation, which makes interruption semantics tractable (your stop only stops your run) at the cost of the agents not truly sharing one conversation.

---

## 5. Telegram — the strongest platform-level guard

Telegram is the only major platform where the anti-noise and anti-loop policy is enforced **by the platform, on by default**, rather than left to bot authors.

> "By default, **all bots** added to groups run in Privacy Mode and only see relevant messages and commands."
> Bots in privacy mode receive only: "Commands explicitly meant for them (e.g., `/command@this_bot`)"; general commands like `/start` "if the bot was the last bot to send a message to the group"; inline messages sent through the bot; and "Replies to any messages implicitly or explicitly meant for this bot." Plus "All service messages."
> "On Telegram, bots generally **cannot see** messages from other bots." Exceptions: when bots explicitly mention each other via `/command@OtherBot` or reply directly to another bot's message, "provided at least one has bot-to-bot communication enabled."
> "bot admins always receive **all messages**" in groups where they have administrative privileges.
> — [Telegram Bot Features](https://core.telegram.org/bots/features)

Two design points worth copying:

1. **"Last bot to speak owns the bare command."** `/start` with no `@botname` routes to whichever bot spoke most recently. That's a lightweight, zero-config arbitration heuristic for ambiguous addressing in a multi-bot room — recency-of-turn as implicit addressee.
2. **Privacy escalation requires a re-add.** "when you toggle privacy mode, Telegram requires removing + re-adding the bot to each group for the change to take effect" — the escalation from "sees only mentions" to "sees everything" is deliberately made a visible, consent-requiring event for the group, not a silent config flip.

---

## 6. OpenClaw / Moltbot / Clawdbot lineage

This open-source messaging-gateway lineage (Clawdbot → Moltbot → OpenClaw; `docs.molt.bot` now 301s to `docs.openclaw.ai`) is the richest source of _implementable_ group-chat mechanics, because it has to work across WhatsApp, Telegram, Discord and Slack simultaneously.

### 6.1 Two activation modes, and the NO_REPLY silent token

> **Mention mode (default)** "requires a ping: a real WhatsApp @-mention (`mentionedJids`), a configured regex pattern, the bot's E.164 digits anywhere in the text, or a quoted reply."
> **Always mode** "wakes the agent on every message, but the injected group prompt tells it to reply only when it adds value and to return the exact silent token `NO_REPLY` (case-insensitive) otherwise."
> "Defaults come from config (`channels.whatsapp.groups requireMention`) and can be overridden per group via `/activation`."
> — [OpenClaw group messages](https://docs.openclaw.ai/channels/group-messages.md)

The **`NO_REPLY` sentinel** is the cheapest possible relevance gate: no second judge model, just an instruction that a specific literal token means "suppress this turn entirely." Compare Adapt's approach (separate fast judge model). Both are shipping; the sentinel is simpler, the judge is cheaper per token and less prone to the main model rationalizing itself into speaking.

### 6.2 Pending-context injection — the trick that makes silence work

> "pending-only group messages (default 50) that did not trigger a run are prefixed under `[Chat messages since your last reply - for context]`" and "the pending window clears after each run."

This solves the hard part of a mention-gated agent in a busy room: when it is finally summoned, it needs the conversation it stayed out of. A bounded ring buffer of un-acted-on messages, clearly labeled as context-not-instruction, is the mechanism. (Note the prompt-injection risk Anthropic flags in §1.3 applies squarely here.)

### 6.3 Multi-agent routing (deterministic, not LLM-judged)

> Messages route deterministically through **bindings** mapping channel accounts to agents, over a strict tier hierarchy: "exact peer, parent peer, peer wildcard, guild+roles, guild, team, account, channel, default agent."
> "If multiple bindings match within the same tier, the first one in config order wins."
> "if a binding sets multiple match fields (for example `peer` + `guildId`), all specified fields must match (`AND` semantics)."
> Per-agent mention patterns: `agents.entries.*.groupChat.mentionPatterns`, e.g. `["@family", "@familybot", "@Family Bot"]`.
> "agent-to-agent messaging must be explicitly enabled + allowlisted" via `tools.agentToAgent.enabled` and allowlists.
> — [OpenClaw multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)

**Arbitration here is a deterministic specificity ladder with first-match-wins**, exactly like CSS specificity or routing tables. No LLM in the loop. For a room product this is much easier to explain, debug, and make settings for than an LLM arbiter. Note also that agent-to-agent messaging is **off by default and allowlisted** — the same posture as Hermes' `DISCORD_ALLOW_BOTS=none`.

Community multi-agent Slack setups on top of OpenClaw use `requireMention: true` plus `replyToMode: "off"` to "prevent bots from replying to other bot messages" ([How to Create a Multi-Agent Slack Channel with OpenClaw](https://medium.com/@would-you-kindly/how-to-create-a-multi-agent-slack-channel-with-openclaw-82b7bec55374), [Running Multiple AI Agents as Slack Teammates](https://gist.github.com/rafaelquintanilha/9ca5ae6173cd0682026754cfefe26d3f)).

### 6.4 Interruption — a documented failure

> "User messages sent via chat (e.g., Telegram) while the agent is mid-generation are not processed as interrupts. Users must resort to the dashboard to abort a running agent."
> — [openclaw #20600: Chat-based interrupt commands (stop/abort) don't work while agent is generating](https://github.com/openclaw/openclaw/issues/20600) (Feb 2026)

**Interruption via the chat channel itself is genuinely unsolved in these products.** The in-band "stop" is just another message that gets queued behind the run it is trying to stop. See §9.

---

## 7. Real reported agent-loop incidents

### 7.1 Hermes Agent: two bots ack-looping in Discord (26 May 2026)

The single most instructive incident found.

> Two Hermes profiles (Ghost and Syn) entered an infinite reply loop in a shared Discord channel, continuing for several minutes until an operator force-shut-down the system.
> Transcript: "09:18:55 Ghost → 'Locked.' 09:18:55 Syn → 'State unchanged.' 09:19:00 Ghost → 'Ack.'" …
> **Guard bypass:** `DISCORD_ALLOW_BOTS=mentions` was supposed to require @mentions for bot-to-bot replies, but `discord.free_response_channels` silently overrode it — in listed channels "bot messages from other Hermes profiles trigger replies WITHOUT @mention."
> **Human STOP ignored:** at 09:19:38 the operator posted "`<@bot_id> you are in a loop, stop`" and the bot "continued to reply (96-char response) anyway, treating it as just another conversation turn." No gateway-level halt signal existed.
> **Proposed fixes:** (1) make the bot-allow gate unconditional regardless of channel config; (2) "anti-loop circuit breaker: suspend auto-reply after N consecutive bot-sourced replies (suggested N=3)"; (3) "a documented in-band HALT signal pattern for operators to trigger emergency suspension without host access."
> — [NousResearch/hermes-agent #32791](https://github.com/NousResearch/hermes-agent/issues/32791)

Three transferable lessons: **two independent gates can compose into an open door**; **the loop content is degenerate and trivially detectable** ("Ack." / "Locked." / "State unchanged." — short, low-entropy, no new information); **a human "stop" typed into the room must be handled at the transport/gateway layer, not by the model.**

A related open issue proposes "a per-channel anti-loop circuit breaker that suspends auto-reply after N consecutive replies from another bot, with suggested defaults of N=3 and M=10 minutes" and "a gateway-level option to ignore bot-originated mentions" ([hermes-agent #14853](https://github.com/NousResearch/hermes-agent/issues/14853); see also [#6419](https://github.com/NousResearch/hermes-agent/issues/6419) on a Telegram inter-bot collaboration protocol and [#30091](https://github.com/NousResearch/hermes-agent/issues/30091) on Slack bot-to-bot messages being silently dropped even with `allow_bots=all`).

### 7.2 Zendesk AI Agents repeating messages (14 July 2026) — a vendor incident report

> "between 14:40 UTC and 17:00 UTC, some customers experienced AI Agents getting stuck in loops and sending repeated messages in bot conversations. In some cases, this continued even after an end user stopped responding or after a human agent replied."
> Resolution: rolled back a recent change; resolved 18:13 UTC.
> — [Zendesk Service Incident - July 14, 2026](https://support.zendesk.com/hc/en-us/articles/11046894936218-Service-Incident-July-14-2026-AI-Agents-Multiple-Pods-AI-Agents-Repeating-Messages)

Note the two escape conditions that _should_ have stopped it and didn't: end-user silence, and a human agent replying. **"A human joined the thread" is a natural loop-breaker and it needs to be wired explicitly.**

### 7.3 Retry-storm class

A widely-cited 2026 write-up describes a support agent that "called an order lookup tool that returned a timeout error, which the agent retried four hundred times in five minutes," arguing "Loop problems are the engineering challenge of 2026 that most teams are not treating as a first-class concern" ([HackerNoon: Your Agent Is Not Stuck, It Is Looping](https://hackernoon.com/your-agent-is-not-stuck-it-is-looping-there-is-a-difference-and-it-costs-you-either-way); see also [FutureAGI: Infinite-Loop Agent Failure](https://futureagi.com/glossary/infinite-loop-agent/)). **Unverified** — the incident is anonymized and I could find no primary postmortem.

---

## 8. Agent frameworks: speaker-selection taxonomy

### 8.1 AutoGen 0.2 `GroupChat` / `GroupChatManager`

Four `speaker_selection_method` values: `"auto"` (LLM picks), `"round_robin"`, `"random"`, `"manual"` (human picks). `"round_robin"` "selects the next speaker in a round robin fashion, iterating in the same order as provided in agents" ([agentchat.groupchat, AutoGen 0.2](https://microsoft.github.io/autogen/0.2/docs/reference/agentchat/groupchat/)). Also `allow_repeat_speaker`.

Documented failure modes from the issue tracker:

- **Selector returns a non-agent string.** "The GroupChat select_speaker can fail to resolve the next speaker's name, and in at least one documented case, the speaker selection call returned 'TERMINATE' unexpectedly, causing the first conversation cycle to break" ([autogen #1064](https://github.com/microsoft/autogen/issues/1064)).
- **General instability of `auto`.** The maintainer-recommended mitigation when "GroupChat doesn't work well" is to "set `speaker_selection_method` to `'round_robin'` or set `allow_repeat_speaker` to `False`, or use direct communication" ([autogen #3462](https://github.com/microsoft/autogen/issues/3462)). That is: **when the LLM arbiter misbehaves, fall back to a deterministic policy.**
- **No way to restrict the candidate set** without a custom callable ([autogen #3215](https://github.com/microsoft/autogen/issues/3215)).
- **Tool-calling breaks under custom selection** ([autogen #2472](https://github.com/microsoft/autogen/issues/2472)).
- In AG2 (the AutoGen fork), "when a Callable returns an Agent directly, `eligibility_policies` are not applied to that agent" ([AG2 GroupChat API](https://docs.ag2.ai/latest/docs/api-reference/autogen/GroupChat/)) — i.e. **custom selectors silently bypass the safety policies.** Same shape as the Hermes free-response-channel bypass.

### 8.2 AutoGen (current) `SelectorGroupChat`

> "a generative model (e.g., an LLM) [selects] the next speaker based on the shared context, enabling dynamic, context-aware collaboration." The model examines "the current conversation context, including the conversation history and participants' `name` and `description` attributes, to determine the next speaker."
> Selector prompt template variables: `{participants}` (candidate names), `{roles}` ("a newline-separated list of names and descriptions of the candidate agents"), `{history}`.
> **`allow_repeated_speaker`**: by default the system prevents consecutive turns by the same agent; "this can be changed by setting `allow_repeated_speaker=True`."
> **`selector_func`**: "Returning `None` from the custom selector function will use the default model-based selection."
> **`candidate_func`**: filters potential speakers per turn; "only valid if `selector_func` is not set. Returning `None` or an empty list `[]` will raise a `ValueError`." And `allow_repeated_speaker` "will be ignored if `candidate_func` is set."
> Termination: no max-turns param; instead conditions like `MaxMessageTermination(max_messages=25)` "to prevent infinite loops."
> — [Selector Group Chat, AutoGen](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/selector-group-chat.html)

Reported failure: "SelectorGroupChat ignores selector function randomly" ([autogen #4289](https://github.com/microsoft/autogen/issues/4289)).

**Design points worth stealing:** (a) the arbiter's input is literally _name + description + history_ — so agent descriptions are load-bearing routing metadata, not decoration; (b) **no-repeat-speaker is the default**, which is a cheap anti-monologue rule; (c) hard message-count termination is the backstop, and it's mandatory rather than optional.

### 8.3 Magentic-One orchestrator (ledger + stall detection)

> The orchestrator maintains a **Task Ledger** ("facts and educated guesses") and a **Progress Ledger** used for self-reflection where it "checks whether the task is completed."
> "If the Orchestrator finds that progress is not being made for enough steps, it can update the Task Ledger and create a new plan."
> Safety cautions include Docker isolation, monitoring execution logs, human oversight, restricting internet access, and a note that "Magentic-One may be susceptible to prompt injection attacks from webpages."
> — [Magentic-One, AutoGen](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/magentic-one.html)

**Stall detection ("no progress for N steps → replan") is the closest thing to a semantic loop-breaker** in any framework, as opposed to purely syntactic counters. The exact stall threshold is not stated in the docs page. **Unverified: the specific max-stalls constant.**

### 8.4 LangGraph

Three named architectures: **Subagents / centralized orchestration** (a supervisor coordinates specialists), **Handoffs / state-driven transitions** (agents transfer control with persistent state), **Router / parallel dispatch and synthesis** ([LangChain multi-agent docs](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents-personal-assistant), [langgraph-supervisor reference](https://reference.langchain.com/python/langgraph-supervisor)).

The stated decision rule is directly relevant to a rooms product: "The deciding factor between handoff and supervisor is usually whether you want the user to 'talk to' a specialist directly (handoff) or always talk to one orchestrator that delegates (supervisor)." Supervisor is recommended when "sub-agents don't need to converse directly with users"; handoffs "when agents need to have conversations with users."

A shared human-visible room is inherently the **handoff** case, not the supervisor case — the humans are talking to the specialists directly.

### 8.5 OpenAI Agents SDK and CrewAI

- **OpenAI Agents SDK — handoffs**: "Agent A finishes its work and explicitly passes control to Agent B, carrying conversation context through the transition. This handoff model is explicit and predictable, so you always know which agent is running and why" ([Agent orchestration, OpenAI Agents SDK](https://openai.github.io/openai-agents-python/multi_agent/); comparison via [Fastio](https://fast.io/resources/openai-agents-sdk-vs-crewai/)). Exactly one agent holds the conversational baton at a time. **This is a lock, and locks are how you avoid two agents answering.**
- **CrewAI**: "sequential processing (one agent after another), hierarchical processing (a manager agent delegates to specialists), and consensual processing (agents vote on outcomes)." Criticism: "CrewAI's crew model is more flexible but less transparent, as the framework makes delegation decisions that can be harder to debug when something goes wrong" ([Fastio comparison](https://fast.io/resources/openai-agents-sdk-vs-crewai/)).
- Consensual/voting is the only **bidding-style** arbitration found in a mainstream framework.

### 8.6 A2A protocol conversation semantics

> `contextId`: "an identifier that logically groups multiple related Task and Message objects, providing continuity across a series of interactions" — "a server-generated string that groups related tasks in a conversation, with one `contextId` mapping to many task IDs (one per turn), functioning as the conversation thread identifier."
> `taskId`: "a unique identifier for a Task object, representing a stateful unit of work with a defined lifecycle. Once a task reaches a terminal state (completed, failed, canceled, rejected), it CANNOT be restarted and any subsequent interaction must initiate a new task with a new `taskId`."
> Clients MAY send `contextId` alone (new task in existing conversation), `taskId` (continue/refine a specific task), or both.
> — [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/), [Multi-Turn Conversations](https://deepwiki.com/google-a2a/A2A/2.7-multi-turn-conversations)

Microsoft's ISE describes "three context-passing patterns that differ in where domain agents get their context and who owns the state, with domain agents using `contextId` to read conversation history from a shared Context Store" ([Passing Context Between Agents in Multi-Agent A2A Systems](https://devblogs.microsoft.com/ise/a2a-context-passing-multi-agent-systems/)).

A2A's `contextId` ≈ a room; `taskId` ≈ one agent turn/job. **Terminal tasks being non-restartable is a useful invariant**: it forces a new id for a follow-up, which makes replay/dedupe tractable and prevents zombie resumption.

---

## 9. Interruption handling

Weakest-covered area across the whole industry. What exists:

- **LangChain message queues** — the most concrete shipped model:
  > "Pass `multitaskStrategy: 'enqueue'` when you want a submission to wait behind the currently running request."
  > "Remove a specific message from the queue by its ID. The agent will skip it and move to the next entry."
  > "Remove all pending messages at once. Useful when the user changes context or wants to start over."
  > "Use `stream.stop()` to interrupt the current run."
  > "Cancelling a queue entry only affects messages that have **not yet started processing**."
  > — [Message queues, LangChain docs](https://docs.langchain.com/oss/python/langchain/frontend/message-queues)
  > So: three distinct verbs — **stop the run**, **cancel one queued item**, **clear the queue** — and messages sent mid-run are queued, not merged.
- **Hermes Agent**: per-user session slices mean "Interrupts only affect individual user sessions" — in a shared room, one person's stop doesn't kill another person's run ([Hermes Discord docs](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/messaging/discord.md)).
- **OpenClaw**: in-band stop does not work at all ([#20600](https://github.com/openclaw/openclaw/issues/20600)).
- **Hermes loop incident**: the human's in-room "stop" was consumed as a conversational turn ([#32791](https://github.com/NousResearch/hermes-agent/issues/32791)).
- Voice AI has a mature barge-in literature (discard queued audio, halt the stream, turn-detection) that text products have not ported ([Hamming AI runbook](https://hamming.ai/resources/voice-agent-interruption-handling-runbook), [FutureAGI barge-in guide](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/)).

**Conclusion: there is no established convention for "user speaks while agent is generating" in group text chat.** Whoever ships a clean model here has a differentiator. The obvious synthesis: transport-layer stop-word detection (never routed to the model) + explicit enqueue-vs-interrupt policy + per-participant run scoping.

---

## 10. Published research and etiquette guidance

### 10.1 Slack's etiquette guidance (vendor, human-facing but applied to bots)

Slack's own etiquette guide and its agent-design doc converge on the same rule: keep channel noise low, use threads, batch. Additional community guidance recommends "creating separate channels for bots and automation updates so important conversations don't get buried" ([Best Practices for Organizing Slack Channels](https://www.questionbase.com/resources/blog/best-practices-for-organizing-slack-channels); [2022 Slack Etiquette Guide PDF](https://d34u8crftukxnk.cloudfront.net/slackpress/prod/sites/6/2022-Slack-Etiquette-Guide.pdf); [Slack etiquette at Zapier](https://zapier.com/blog/slack-etiquette-at-zapier/)).

### 10.2 HCI / academic

- **"Time to Talk: LLM Agents for Asynchronous Group Communication in Mafia Games"** (arXiv 2506.05309). Directly on point. Architecture: "an adaptive asynchronous LLM agent consisting of two modules: **a generator that decides what to say, and a scheduler that decides when to say it**." Evaluated against human players in online Mafia games; the agent "performed on par with human players, both in game performance metrics and in its ability to blend in with the other human players," and "the agent's behavior in deciding when to speak closely mirrors human patterns, although differences emerge in message content." ([arXiv](https://arxiv.org/abs/2506.05309))
  **The generator/scheduler split is the single most useful architectural idea in the academic literature for this problem** — decide _whether/when_ separately from _what_, so you can make the timing decision with a small cheap model and evaluate it independently.
- **"Bot Among Us: Exploring User Awareness and Privacy Concerns About Chatbots in Group Chats"** (PoPETs 2026). "Many users were unaware of bots in their group chats and significantly underestimated their data access: **only 41.7% correctly identified what messages chatbots could access**." ([PoPETs PDF](https://petsymposium.org/popets/2026/popets-2026-0016.pdf))
  Implication: **an agent's read scope in a room must be visibly disclosed in the UI**, because users' mental models are wrong by default. Telegram's "privacy mode toggle requires re-adding the bot" is the strongest existing answer.
- **"Chatbots in Collaborative Settings and their Impact on Virtual Teamwork"** (PACM HCI / CSCW) — [dl.acm.org/doi/10.1145/3710945](https://dl.acm.org/doi/10.1145/3710945).
- **SeeSawBot** (CHI 2026) — an LLM chatbot mediating across private and shared Slack channels to support team dynamics; relevant prior art for an agent that reads one space and acts in another ([dl.acm.org/doi/10.1145/3772318.3791880](https://dl.acm.org/doi/10.1145/3772318.3791880)).
- **Unsolicited/proactive AI provokes reactance.** Research indicates "automatically initiated chatbots (that is, unsolicited advice from chatbots, as contrasted with user-prompted reactive responses) may elicit heightened psychological reactance, subsequently contributing to increased choice difficulty," and proactive service "may also generate negative responses if customers feel overwhelmed or pressured by excessive engagement" (summarized from the search over the CSCW/HCI corpus above; individual paper attribution not pinned down).
- **"What LLM Agents Say When No One Is Watching: Social Structure and Latent Objective Emergence in Multi-Agent Debates"** (arXiv 2607.02507) — on emergent social dynamics in agent-only conversation ([arXiv](https://arxiv.org/abs/2607.02507v1)).
- **"GCAgent: Enhancing Group Chat Communication through Dialogue Agents System"** (arXiv 2603.05240) — [PDF](https://arxiv.org/pdf/2603.05240).

### 10.3 The specific question: how often can a bot speak before it's irritating?

**I could not find a published number.** No vendor guideline, no HCI study, and no postmortem in the sources surveyed states a frequency threshold (messages/hour, % of turns, etc.) above which group-chat participants find a bot irritating. The closest usable proxies are:

- Slack's qualitative rule — batch related notifications ("five issue updates should be one message, not five") and keep channel responses "minimal" ([Slack agent design](https://docs.slack.dev/concepts/agent-design/)).
- The Hermes circuit-breaker proposal's suggested constants: **N=3 consecutive bot-sourced replies, M=10 minute suspension** ([hermes-agent #14853](https://github.com/NousResearch/hermes-agent/issues/14853)) — these are engineering guesses, not user-research findings.
- AutoGen's default of **no consecutive repeat speaker** ([Selector Group Chat](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/selector-group-chat.html)).

**Treat any "N messages per hour" number as unsourced.** This is a genuine gap and a candidate for our own instrumentation.

---

## 11. Character.AI and multi-persona chat

Character.AI shipped Character Group Chat in Oct 2023 — "interact with multiple AI Characters and humans in the same room" ([Character.AI blog](https://blog.character.ai/new-feature-announcement-character-group-chat/); [TechCrunch](https://techcrunch.com/2023/10/11/character-ai-introduces-group-chats-where-people-and-multiple-ais-can-talk-to-each-other)). The announcement does **not** publish turn-taking mechanics, character caps, or whether characters respond to each other.

Secondary/community accounts describe:

- A **PipSqueak** model described as "the platform's lightweight, fast-inference model built for multi-character interactions" that "handles turn-taking and response coherence across multiple characters simultaneously" ([aiinsightsnews](https://aiinsightsnews.net/how-to-make-a-group-chat-on-character-ai/)). **Unverified — SEO-blog source, no Character.AI primary confirmation found.** Do not cite this as fact.
- Manual and random speaker selection in adjacent products: "users can select which character responds in each turn... or enable the 'random selector' option to allow a randomly chosen character to reply" ([aitechatlas](https://aitechatlas.com/character-ai-group-chat/)).
- The user-side workaround for a dominant character: "If one Character 'takes over,' change your pinned rules so turn-taking is explicit (example prompt: 'Only speak when tagged.')" ([roborhythms](https://www.roborhythms.com/multiple-characters-in-one-character-ai-chat/)).

SillyTavern (open source) documents group chats with explicit multi-character orchestration, including auto/manual reply modes and per-character mute — the most inspectable implementation in this category ([DeepWiki: SillyTavern group chats](https://deepwiki.com/SillyTavern/SillyTavern/9-group-chats-and-multi-character-interactions)).

**Net for us:** the persona-chat world has independently landed on the same three modes as the enterprise world — **manual (user picks), round-robin/random, and auto** — and its dominant reported failure mode is _one character monopolizing the room_, mitigated by explicit "only speak when tagged" rules. That is the same disease AutoGen's `allow_repeated_speaker=False` default treats.

---

## 12. Poke (Interaction Co. → Cognition) and companion-in-group products

Poke lives inside iMessage/WhatsApp, launched publicly March 2026, and was reported acquired by Cognition ([TechCrunch: Poke makes using AI agents as easy as sending a text](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/); [AppleInsider: first AI agent for Messages Business Chat approved by Apple](https://appleinsider.com/articles/26/06/04/first-ai-agent-for-messages-business-chat-approved-by-apple); [Startup Fortune](https://startupfortune.com/cognition-buys-poke-to-plant-its-ai-agent-inside-your-text-messages/)).

Verifiable behavioral details:

- Short-message style: "delivering short, conversational text bubbles and one-tap responses that act on your behalf."
- "Poke reacts to your messages, can see your iMessage reactions, understands voice notes."
- Proactive by design (it initiates, not just replies) — the marketing frame is "proactive AI assistant" ([TechFundingNews](https://techfundingnews.com/poke-launches-15m-seed-imessage-ai-assistant/)).

**Not found / unverified:** Poke's group-chat reply policy. I could not locate any published description of how Poke decides whether to speak in a multi-human group thread, nor whether it participates in group threads at all. Do not assume it does.

---

## 13. Comparison matrix — trigger policies

| Product / system                | Default trigger in a group                                                                                | Unprompted speech?                                                          | How over-eagerness is prevented                                                                                                                                                     | Multi-agent arbitration                                                                                       | Loop prevention                                                                                      | Scope of settings                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Slack (platform)**            | `app_mention` subscription = mention-only; `message.channels` = firehose                                  | Only if the app subscribes to the firehose and chooses to                   | Event-scope choice; not invited to channel = no events at all                                                                                                                       | None native — one app per agent identity                                                                      | App's own responsibility; `bot_id` filtering is convention                                           | Org (Grid) → workspace → channel membership → app config                                    |
| **Claude in Slack**             | `@Claude` mention, in channels only (no DMs); must be `/invite`d                                          | No                                                                          | Mention-only, hard                                                                                                                                                                  | N/A (single agent)                                                                                            | N/A                                                                                                  | Grid org → workspace → channel invite → per-user Routing Mode (Code only / Code+Chat)       |
| **Agentforce in Slack**         | @mention after adding agent to channel                                                                    | Only system-initiated notifications from Salesforce triggers                | Mention gate + trigger conditions defined in Salesforce                                                                                                                             | None documented                                                                                               | Not documented                                                                                       | Workspace/Salesforce admin; channel automations                                             |
| **Adapt (3rd-party Slack)**     | `@-mention only` by default                                                                               | **Yes, opt-in**                                                             | Plain-English per-scope policy evaluated by a "fast judge model" per message                                                                                                        | Not documented                                                                                                | Not documented                                                                                       | Channel-level mode, overridable per thread (thread wins)                                    |
| **Microsoft Teams**             | @mention after adding agent to chat/channel                                                               | Targeted 1:1 messages to an individual inside a group; emoji reactions      | Mention gate; targeted messages avoid channel clutter                                                                                                                               | Multiple agents co-present, each @mentionable; orchestration lives in Copilot Studio connected agents         | Not documented                                                                                       | Tenant/admin + chat membership (details unverified)                                         |
| **ChatGPT group chats**         | **Model-judged relevance** — replies when contextually appropriate                                        | **Yes, by default**                                                         | Trained social behavior; naming "ChatGPT" forces a reply; emoji reactions as a low-cost alternative to speaking; **rate limits only count when it responds**                        | N/A (single agent)                                                                                            | N/A                                                                                                  | Per-user memory/settings isolated; ≤20 participants; link-based join                        |
| **Discord (platform)**          | Nothing enforced; bots see all messages incl. other bots'                                                 | Entirely up to the bot                                                      | Community convention only                                                                                                                                                           | None native                                                                                                   | `if (message.author.bot) return;` is the universal first line                                        | Per-guild, per-channel bot permissions                                                      |
| **Hermes Agent (Discord)**      | `DISCORD_REQUIRE_MENTION=true`; DMs answer everything                                                     | Yes in `DISCORD_FREE_RESPONSE_CHANNELS`                                     | `DISCORD_IGNORE_NO_MENTION=true` — silent if the message mentions someone else and not the bot                                                                                      | Per-agent identities; no dedupe                                                                               | `DISCORD_ALLOW_BOTS` = none / mentions / all; docs warn `mentions` ack-loops between two bots        | Env-var per deployment; per-channel free-response list; `group_sessions_per_user`           |
| **Telegram**                    | **Privacy Mode on by default** — bot only sees commands addressed to it, @mentions, and replies to itself | Only if privacy mode is disabled (requires re-adding the bot to each group) | Platform-enforced, not bot-enforced                                                                                                                                                 | **"Last bot to send a message" owns bare `/commands`**                                                        | Platform hides other bots' messages from bots                                                        | Per-bot via BotFather; per-group re-add required to change; admin bots see everything       |
| **OpenClaw / Moltbot**          | `mention` mode: real @-mention, regex `mentionPatterns`, phone digits, or quoted reply                    | `always` mode, per-group via `/activation`                                  | In `always` mode the prompt instructs "reply only when it adds value" and emit literal **`NO_REPLY`** otherwise; pending un-acted messages injected as labeled context (default 50) | Deterministic **binding specificity ladder** (exact peer → … → default agent), first-match-wins within a tier | Agent-to-agent messaging **off by default, allowlisted**; community configs use `replyToMode: "off"` | Global config → channel → per-group `/activation` (owner-only) → per-agent mention patterns |
| **AutoGen `GroupChat` (0.2)**   | Manager picks each turn                                                                                   | N/A (closed system)                                                         | `allow_repeat_speaker=False`                                                                                                                                                        | `auto` (LLM) / `round_robin` / `random` / `manual`                                                            | `max_round`; fall back to `round_robin` when `auto` misbehaves                                       | Code                                                                                        |
| **AutoGen `SelectorGroupChat`** | LLM selector over `{participants}`, `{roles}`, `{history}`                                                | N/A                                                                         | **No consecutive repeat speaker by default**; `candidate_func` narrows the slate                                                                                                    | LLM selector, overridable by `selector_func`                                                                  | `MaxMessageTermination(max_messages=N)` as explicit anti-infinite-loop                               | Code                                                                                        |
| **Magentic-One**                | Orchestrator assigns each subtask                                                                         | N/A                                                                         | Progress ledger self-reflection                                                                                                                                                     | Central orchestrator                                                                                          | **Stall detection → replan** (semantic, not just counting)                                           | Code                                                                                        |
| **LangGraph**                   | Supervisor routes, or agents hand off                                                                     | N/A                                                                         | Explicit graph edges                                                                                                                                                                | Supervisor / handoff / router-parallel                                                                        | Graph termination + recursion limits                                                                 | Code                                                                                        |
| **OpenAI Agents SDK**           | Exactly one agent holds the baton; explicit handoff transfers it                                          | N/A                                                                         | Single-active-agent invariant                                                                                                                                                       | Handoff = a lock; "you always know which agent is running and why"                                            | Handoff graph                                                                                        | Code                                                                                        |
| **CrewAI**                      | Sequential / hierarchical manager / consensual voting                                                     | N/A                                                                         | Manager delegation                                                                                                                                                                  | **Voting (bidding-like)** in consensual mode                                                                  | Not surfaced; criticized as hard to debug                                                            | Code                                                                                        |
| **A2A protocol**                | Client addresses an agent explicitly                                                                      | N/A                                                                         | N/A                                                                                                                                                                                 | `contextId` groups a conversation; one `taskId` per turn                                                      | Terminal tasks cannot be restarted — forces new ids                                                  | Protocol                                                                                    |

### Speaker-selection algorithm taxonomy, with failure modes

| Algorithm                              | Where it ships                                                               | Primary failure mode                                                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mention gate** (addressed-to-me)     | Slack, Teams, Telegram, Discord bots, OpenClaw/Hermes default                | Silent when it should help; user must know the agent's name and that it exists; **two mention-gated bots that mention each other satisfy each other's gate forever** (Hermes #32791) |
| **Relevance gate — judge model**       | Adapt (fast judge + NL policy), ChatGPT group chats (trained-in)             | Over-eagerness; unauditable; cost per message; policy drift                                                                                                                          |
| **Relevance gate — sentinel token**    | OpenClaw `NO_REPLY`                                                          | Main model rationalizes itself into speaking; full inference cost paid even when silent                                                                                              |
| **Round-robin**                        | AutoGen `round_robin`                                                        | Irrelevant agents burn turns; unnatural in a human room                                                                                                                              |
| **Random**                             | AutoGen `random`, Character.AI-adjacent "random selector"                    | Incoherence; no relation to competence                                                                                                                                               |
| **LLM-selected (auto)**                | AutoGen `auto` / `SelectorGroupChat`, CrewAI hierarchical                    | Returns a non-agent string (`"TERMINATE"`); ignores the custom selector; picks the same agent repeatedly; custom selectors bypass eligibility policies                               |
| **Manual (human picks)**               | AutoGen `manual`, Character.AI                                               | Doesn't scale; human becomes the bottleneck/dispatcher                                                                                                                               |
| **Bidding / voting**                   | CrewAI consensual                                                            | Opaque, expensive, hard to debug                                                                                                                                                     |
| **Deterministic specificity ladder**   | OpenClaw bindings (exact peer → guild → account → default), first-match-wins | Config complexity; silent shadowing by an earlier rule                                                                                                                               |
| **Recency-of-turn**                    | Telegram (last bot to speak owns bare `/command`)                            | Wrong agent captures an ambiguous request                                                                                                                                            |
| **Baton / lock (single active agent)** | OpenAI Agents SDK handoffs                                                   | Serializes work; a stuck holder blocks the room                                                                                                                                      |
| **Scheduler module (learned "when")**  | "Time to Talk" (arXiv 2506.05309)                                            | Research-stage; game-domain evaluation                                                                                                                                               |

---

## Research Gaps & Limitations

1. **No published irritation threshold.** No vendor or study gives a "bots should speak at most X times per Y" number. The 2026 engineering constants that exist (N=3 consecutive bot replies, 10-minute suspension) are proposals in an issue tracker, not findings.
2. **openai.com and help.openai.com returned HTTP 403** to direct fetch. All ChatGPT group-chat behavior is quoted via secondary reporting of OpenAI's announcement.
3. **Poke's group-chat policy is undocumented publicly.** Could not verify whether/how it participates in multi-human threads.
4. **Character.AI publishes no turn-taking mechanics.** The "PipSqueak model handles turn-taking" claim comes from a low-quality SEO source and should be treated as unverified.
5. **Teams admin/governance scope for agents in group chats** is not documented in the sources found; the Build 2026 post covers capabilities, not controls.
6. **Discord has no first-party AI-app group-behavior guidance** that I could locate; official developer docs were not directly retrievable through search, so Discord findings lean on discord.js convention and third-party agents.
7. **Magentic-One's stall threshold constant** is not published on the docs page.
8. **Slack does not publish anything on multi-agent contention** — the "two agents could both answer" case appears genuinely unaddressed by every mainstream platform.
9. The Hermes Agent issue numbers (#32791, #30091, #14853, #6419) are unusually high for the repo; #32791 was fetched and returned substantive content, so it exists, but these are community issue reports, not vendor documentation.

## Contradictions & Disputes

- **Default posture is genuinely contested.** ChatGPT group chats default to _speak when relevant_; every workplace tool defaults to _speak only when named_. This is not a maturity gap — it is a deliberate split by context (social group vs. work channel). Adapt's product exists precisely because the workplace default is sometimes too quiet, and it still ships `@-mention only` as the default.
- **Bot-to-bot visibility.** Telegram hides it at the platform layer, Discord exposes everything, Slack sits in between (and there is a report of Slack bot-to-bot messages being _silently dropped_ even when a gateway sets `allow_bots=all` — [hermes-agent #30091](https://github.com/NousResearch/hermes-agent/issues/30091)). Any cross-platform design must not assume it can see or be seen by peer agents.
- **LLM arbiter vs. deterministic routing.** AutoGen's own maintainers recommend falling back to `round_robin` when the LLM selector misbehaves; OpenClaw never uses an LLM to route at all. The frameworks that bet hardest on LLM arbitration have the most issue-tracker pain.

## Search Methodology

- Searches performed: 18 WebSearch + 20 WebFetch.
- Most productive terms: `app_mention vs message.channels bot loop prevention`; `docs.openclaw.ai group chat requireMention activation always`; `Hermes Agent allow_bots loop prevention`; `AutoGen SelectorGroupChat allow_repeated_speaker candidate_func`; `"agent etiquette" design guidelines group chat Slack channel noise`; `arxiv 2026 LLM agents group chat "when to speak"`.
- Primary domains: docs.slack.dev, code.claude.com, core.telegram.org, docs.openclaw.ai, microsoft.github.io/autogen, devblogs.microsoft.com, docs.langchain.com, a2a-protocol.org, github.com issue trackers, arxiv.org, dl.acm.org, petsymposium.org.
