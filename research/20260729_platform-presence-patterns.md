# How messaging platforms signal "heard you" and "working on a reply"

Researcher: Siskin. Date: 2026-07-29.
Scope: platform mechanics (Slack, Telegram, Discord, Matrix, iMessage/WhatsApp), acknowledgement conventions, etiquette evidence, and the three DorkOS-specific tensions (slow turns, N agents at once, failure honesty). Facts and cited practice only — no proposals.

Prior repo research this builds on (cited inline as [repo: …], not re-derived):

- `research/20260318_slack_bot_typing_processing_indicators.md` — Slack's typing-indicator API gap, `assistant.threads.setStatus`, reactions workaround, streaming API
- `research/20260322_grammy_typing_indicator_and_auto_retry.md` and `research/20260322_chat_sdk_typing_indicator_api.md` — Telegram `sendChatAction` mechanics, refresh loops, DorkOS's existing 4s implementation
- `research/20260727_messaging-etiquette.md` — CA/CMC/HAI literature (chronemics, typing-indicator obligation, simulated-delay dispute)
- `research/20260727_agents-in-group-chat-industry-survey.md` — Slack agent-design guidance, ChatGPT group chats, Teams, Hermes/OpenClaw
- `research/20260727_hermes-openclaw-group-chat.md` — Hermes 👀/✅/❌ reactions, OpenClaw `ackReactionScope`
- `meta/agent-etiquette.md` — the standard these findings inform (E15/E16 especially)

---

## Part 1 — Platform mechanics

### 1.1 Slack

**Typing indicators (humans).** Human typing is surfaced by the client; when many people type at once the client collapses to the string "Several people are typing" — famous enough to be a meme and the title of a 2021 novel set inside Slack ([Know Your Meme](https://knowyourmeme.com/memes/several-people-are-typing), [TechCrunch on the Kasulke novel](https://techcrunch.com/2021/10/19/several-people-are-typing-is-the-slack-workspace-of-your-worst-nightmares/)). This is the canonical precedent for **aggregating simultaneous typing signals into one line**.

**Typing indicators (bots): there is no API.** Established in [repo: 20260318] with primary sources:

- The legacy RTM API's `typing` message (the only way a bot could ever emit typing) died with RTM's shutdown for custom bots in **September 2024**. `user_typing` is **receive-only** ([Slack docs](https://docs.slack.dev/reference/events/user_typing/)).
- Bolt-js issues [#885](https://github.com/slackapi/bolt-js/issues/885) and [#2580](https://github.com/slackapi/bolt-js/issues/2580) track "bot is typing" as a feature request; #2580 closed June 2025 as duplicate with "no immediate plans."
- The three substitutes in 2026: (1) **`assistant.threads.setStatus`** — renders "`<Bot> is thinking…`" below the composer, supports up to 10 rotating `loading_messages`, **auto-clears after 2 minutes** if no message follows, works _only_ in the AI-assistant split-panel surface, 600 req/min, now needs only `chat:write` (scope change 2026-03-05); (2) **`reactions.add`/`remove`** (hourglass on the user's message, remove when done) — the community-standard workaround, Tier 3/Tier 2 rate limits; (3) **`chat.startStream`/`appendStream`/`stopStream`** (shipped Oct 2025) — native streaming that renders a live typing animation in the message itself, making the indicator implicit. ([docs.slack.dev method pages](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/), [chat streaming changelog](https://docs.slack.dev/changelog/2025/10/7/chat-streaming/))

**Bot/AI-specific guidance.** Slack's [agent design doc](https://docs.slack.dev/concepts/agent-design/) is prescriptive [repo: 20260727 survey §1.2]: "Show a status indicator immediately after the user sends a message. This can range from a lightweight emoji reaction to a 'Working on it...' status," and "Status updates as the agent progresses. 'Searching your workspace...' → 'Found 3 matching issues...' → 'Formatting results...'". Same doc: thread replies to avoid flooding, batch notifications ("five issue updates should be one message, not five"), and graceful failure ("save what it's accomplished, explain where it got stuck and why, give the user options"). Note the framing: **an immediate ack signal is treated as required behavior for an agent, distinct from (and not counted as) conversational participation.**

**Read receipts.** Slack has none at the message level (no per-user "seen" indicator on channel messages) — presence dots and unread markers only. Not a receipts platform; the acknowledgement culture routes through reactions instead (below).

**Reactions as acknowledgement.** Slack's own blog documents the convention: 👀 = "I'm looking into this" / claim; ✅ (white check) = resolved/done ([Some of the ways we use emoji at Slack](https://slack.com/blog/productivity/some-of-the-ways-we-use-emoji-at-slack), [Slack 103: Communication and culture](https://slack.com/blog/collaboration/slack-103-communication-and-culture)). Support/ops teams formalize it: eyes to claim an issue, checkmark when resolved, sometimes written into onboarding docs ([Zapier](https://zapier.com/blog/automate-slack-emoji/), [Slab etiquette guide](https://slab.com/blog/slack-etiquette-guide/)). **Formalized versions:** Slack Workflow Builder has a first-party "when an emoji reaction is used" trigger (emoji + channel → workflow) ([Slack help](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack)); the common template is reaction → create ticket (Linear/Jira) ([Workflow Builder templates for software engineers](https://slack.com/resources/using-slack/workflow-builder-templates-for-software-engineers), [Zapier Linear-Slack](https://zapier.com/apps/linear/integrations/slack)).

### 1.2 Telegram

**Typing indicators.** `sendChatAction(chat_id, action)` — bots may emit `typing` (plus `upload_photo`, `record_voice`, etc.). Established with primary sourcing in [repo: 20260322 grammY]:

- Status shows for **5 seconds or less**; cleared immediately when the bot's message arrives; **no stop API** — you stop refreshing and let it expire.
- Long operations require a refresh loop; grammY's official `auto-chat-action` plugin uses a 5000ms `setInterval`; DorkOS's `GrammyPlatformClient` uses **4000ms** for a 1s margin (the repo report recommends 4s over 5s explicitly).
- `sendChatAction` shares the global ~30 msg/sec bot limit; a 4–5s refresh is negligible. Best-effort: failures must never block the reply path.
- Human typing is emitted automatically by clients ("typing…" under the chat title; in groups, with the typist's name).

**Bot-specific affordances.** No status text, no streaming API for bots; `sendChatAction` is the entire vocabulary. The platform-level differentiator is **privacy mode** (bots in groups see only messages addressed to them, on by default; changing it requires re-adding the bot to each group) [repo: 20260727 survey §5].

**Read receipts.** One check = delivered to Telegram's cloud; two checks = read. Telegram's official account: "In all chats, two checkmarks means that your message was read – one check means it was delivered. In small groups, you can select your message to see who in the group has seen it already" ([@telegram on X, Apr 2022](https://x.com/telegram/status/1518850277859860480)). There is **no separate delivered-to-device state** (unlike WhatsApp's grey double tick) and **no way to disable read receipts** for chats ([TechMesto explainer](https://www.techmesto.com/telegram-checkmarks/)). In groups, a double check means at least one member read it; the per-member "seen by" list exists only in small groups (commonly reported as ≤100 members — see Unverified).

### 1.3 Discord

**Typing indicators.** REST endpoint `POST /channels/{channel.id}/typing` ("Trigger Typing Indicator") — "posts a typing indicator for the specified channel... expires after **10 seconds**," fires a `TYPING_START` gateway event ([Discord Channels resource](https://discord.com/developers/docs/resources/channel), [Postman mirror of the endpoint](https://www.postman.com/discord-api/discord-api/request/39j46sv/trigger-typing-indicator)). Bots and users use the same event; libraries expose `sendTyping()`/`channel.typing()` and discourage keeping it on when not actually about to post ([discord.py API ref](https://discordpy.readthedocs.io/en/latest/api.html), [discord.js Typing class](https://discord.js.org/docs/packages/discord.js/main/Typing:Class)). Long work requires re-triggering roughly every 8–10s.

**Aggregation.** The client shows individual names for a few simultaneous typists, then collapses to "Several people are typing…" (threshold ~3+; hover reportedly reveals the list — community-documented, see Unverified) ([Know Your Meme](https://knowyourmeme.com/memes/several-people-are-typing), [Discord support forum threads asking for the list](https://support.discord.com/hc/en-us/community/posts/360051761153-Several-people-are-typing-list)).

**Opt-out.** Users cannot disable seeing or emitting typing indicators; it's a long-standing feature request ([Discord support forum](https://support.discord.com/hc/en-us/community/posts/360049385634-Option-to-Disable-the-User-is-Typing-Indicator)). Third-party plugins (BetterDiscord "Invisible Typing") exist to suppress emission.

**Read receipts.** None. Discord has no per-user read indicators at all — only your own unread markers. Of the five platforms surveyed it is the only one with zero social read-state surface.

**Bot/AI practice.** Hermes Agent ships reaction lifecycle default-on for Discord: "👀 added when the bot starts processing your message, ✅ added when the response is delivered successfully, ❌ added if an error occurs during processing" (`DISCORD_REACTIONS=true`) [repo: 20260727 hermes report, docs-only caveat noted there]. OpenClaw's equivalent is `ackReaction`/`typingReaction` scoped by `messages.ackReactionScope: "all" | "direct" | "group-mentions" | "group-all" | "off"`, default `"group-mentions"` — i.e. **ack reactions only when explicitly addressed in a group, and suppressed entirely for room events** [repo: same report §2.1].

### 1.4 Matrix

**Typing indicators.** `PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId}` with a `typing` boolean and a client-chosen `timeout` in milliseconds; servers fan it out as the **`m.typing` ephemeral event (EDU)** carrying a `user_ids` array of everyone currently typing ([Matrix Client-Server API, Typing Notifications](https://spec.matrix.org/latest/client-server-api/#typing-notifications)). The spec advises clients to be conservative and to re-send before expiry to keep the indicator alive. Two structurally interesting properties: (a) the indicator is **an array, natively aggregated at the protocol level** — the event is "who is typing in this room," not N separate signals, so the client renders one line however many participants are composing; (b) it is ephemeral by definition — never persisted, never federated into history.

**Read receipts and the privacy pushback.** `m.read` receipts are **public and federated by default** — every participant's server and client sees where everyone's read marker is. The pushback is recorded in [MSC2285](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/2285-hidden-read-receipts.md): "not everyone wants to broadcast that they've read a message," but because receipts were tied into notification-clearing, opting out meant stuck unread badges across your own devices. The fix — a new **`m.read.private`** receipt type that behaves identically but is visible only to the sender's own devices — landed in [Matrix v1.4 (Sept 2022)](https://matrix.org/blog/2022/09/29/matrix-v-1-4-release/), and Element added a "send read receipts" toggle on top. The design lesson MSC2285 encodes: **read state does double duty (social signal + own-device sync), and privacy requires splitting those two functions apart.** Background on the mechanics: [Patrick Cloke, "Matrix Read Receipts & Notifications"](https://patrick.cloke.us/posts/2023/01/05/matrix-read-receipts-and-notifications/).

### 1.5 iMessage and WhatsApp (brief)

**iMessage.** Typing bubble (the grey three-dot ellipsis) appears when the other party is composing; reported to linger up to **60 seconds** if they pause without sending ([BGR](https://www.bgr.com/2192532/why-imessage-shows-three-blinking-dots-explained/) — see Unverified). No user setting to disable typing indicators exists. Typing indicators were **1:1-only for the feature's entire life until iOS 26** (announced WWDC 2025), which extended them to group chats ([9to5Mac](https://9to5mac.com/2026/01/12/ios-26s-messages-app-adds-five-great-new-group-chat-features/), [MacRumors iOS 26 Messages guide](https://www.macrumors.com/guide/ios-26-messages-app/)). Read receipts are opt-in/out globally (Settings → Messages → Send Read Receipts) and per-conversation.

**WhatsApp.** "typing…" presence label (in groups, with the typist's name; newer clients show typing bubbles with profile photos in groups — see Unverified); **cannot be disabled** in settings, for either 1:1 or groups ([androidayuda](https://en.androidayuda.com/applications/Tutorials/How-to-hide-the-typing-indicator-on-WhatsApp-and-other-social-media/)). Read receipts (blue ticks) are toggleable for 1:1 chats — turning them off also blinds you to others' — but are **always on in groups**, with no override ([Tom's Guide](https://www.tomsguide.com/how-to/how-to-turn-off-read-receipts-on-whatsapp), [blueticks explainer](https://blueticks.co/blog/whatsapp-read-receipts-explained)).

**Read receipts as a privacy surface — the consensus.** Across platforms the pattern is consistent: read receipts create sender-side expectation and receiver-side obligation, so every major platform except Telegram/Matrix-public-default has moved to opt-out (iMessage, WhatsApp 1:1) or private-by-choice (Matrix 1.4) — while **group contexts systematically get fewer privacy rights than 1:1** (WhatsApp groups always-on; Telegram small-group seen-by lists). Research findings: read receipts "create pressure to respond for receivers and anxiety when awaiting a response for senders," with avoidance strategies (not opening the app to avoid triggering the receipt) and compulsive checking as documented behavioral effects ([Exploring the impact of 'read receipts' in Mobile Instant Messaging, PDF](https://scispace.com/pdf/exploring-the-impact-of-read-receipts-in-mobile-instant-3vid403m1p.pdf)); a Pew figure of 41% of adults feeling pressure to respond quickly circulates in secondary coverage (see Unverified); receipts/presence metadata are flagged as a stalking and intimate-partner-abuse vector ([UNILAD Tech summarizing researcher warnings](https://www.uniladtech.com/news/shocking-reason-turn-off-phone-read-receipts-783753-20250310)). The CMC-research framing from [repo: 20260727 messaging-etiquette §2.3]: receipts and online status "transform what was once invisible processing time into a publicly observed silence."

### 1.6 Reactions as acknowledgement — origin, formalization, failure modes

**The convention.** 👀 = "seen / I'm on it," ✅ = "done" is Slack ops culture, documented by Slack itself (§1.1 above) and independently re-invented by agent products:

- **GitHub Copilot coding agent** reacts 👀 to an issue the moment it's assigned, and 👀 to comments it has seen, before starting an Actions session ([GitHub blog](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/), [assigning issues walkthrough](https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/)). User reception is explicitly positive: "The immediate acknowledgement (like the emoji reaction when assigning an issue) adds a delightful touch that reassures the user it's listening" ([first-impressions writeup](https://manjit28.medium.com/my-first-impressions-of-github-copilots-coding-agent-bae730a1d69d)).
- **Hermes** (Discord): 👀 processing / ✅ delivered / ❌ error, default-on [repo: hermes report].
- **OpenClaw**: ack reactions scoped, default only-when-mentioned-in-groups [repo: hermes report].
- **Teams** (Build 2026): agents "participate in conversations with lightweight signals like emoji reactions" — reactions as a first-class _alternative to speaking_ [repo: 20260727 survey §2.1]. **ChatGPT group chats** likewise gave the model emoji reactions as a low-cost participation channel [repo: survey §3.2].

**Formalized versions.** Slack Workflow Builder's emoji-reaction trigger (§1.1); reaction→Linear-issue automations via Zapier/Latenode; older art: `emoji-to-issue` and Hubot reaction-to-GitHub-issue bots ([uiur/emoji-to-issue](https://github.com/uiur/emoji-to-issue)).

**Known failure modes:**

1. **Ambiguity of meaning.** A bare 👍 is undecidable between "received," "agree," and "will do" — a business-consultant critique in the Gen-Z thumbs-up debate ([Mondo on the Reddit thread + CNN coverage](https://mondo.com/insights/thumbs-up-emoji-passive-aggressive-workplace/)); the same debate shows reactions carry unintended _tone_ (thumbs-up read as passive-aggressive by younger workers).
2. **Reaction misread as approval.** Documented anecdote: a designer's 🚀 on a mockup was read by engineering as a ship approval and triggered a premature release ([GetMoji](https://getmoji.app/blog/emoji-for-business-slack-teams)).
3. **"Reacted but never replied."** 👀 creates an expectation of a follow-up that nothing enforces; the Slack-ops convention only works when the ✅ reliably arrives. No platform mechanically links the claim-reaction to a completion obligation — the only system found that does is **Linear's agent sessions**, where the acknowledgment (a `thought` activity) starts a session state machine that visibly times out (§3.3 below).
4. **Notification asymmetry.** Reactions notify the message author only (Slack/Discord), which is exactly why the convention is _quieter_ than a reply — but it also means third parties in the room may never see the ack unless they look.

---

## Part 2 — Etiquette: the judgement layer

### 2.1 Acknowledging without answering — is 👀 rude or polite?

The practitioner consensus treats a reaction-ack as _more_ polite than a message-ack, because it doesn't cost a notification or take the floor: "Use reactions instead of 'thanks!' messages when acknowledgment is all that is needed" is a convergent norm across Slack's own guidance, LeadDev, and remote-team handbooks [repo: messaging-etiquette §3.2]. Conversation-analysis grounding: reactions are the text analogue of **backchannels** ("mhm") — cheap precisely because they do not claim a turn [repo: messaging-etiquette §1.3]. The caveat is §1.6's failure modes: the ack is polite only if it is unambiguous in the room's local dialect and the promised follow-up actually comes. Whether an _agent_ reacting reads as attentive or creepy is explicitly not established — the repo etiquette report lists "backchannel equivalents in chat (reactions) are under-studied as agent behavior" as a research gap [repo: messaging-etiquette, Gaps].

### 2.2 Typing indicators that vanish without a message ("typing anxiety")

Well-documented in both journalism and HCI:

- The typing awareness indicator was built in **1997 by IBM developers Jerry Cuomo and Richard Redpath**; the anxiety literature around it is a genre of its own ([ASMR.education explainer with the origin story](https://asmr.education/faq/text-messages/what-is-a-typing-indicator)).
- The canonical failure: "they were typing a reply, and then the blinking dots stopped blinking. Then the reply never came" — the indicator-without-message is named as _worse_ than no indicator ([Pamela Pavliscak, "Three-dot anxiety"](https://medium.com/@pamelapavliscak/three-dot-anxiety-b1c9318ed27b); [Saratoga Falcon, "Typing awareness indicator more stressful than helpful"](https://saratogafalcon.org/5988/features/typing-awareness-indicator-more-stressful-helpful/)).
- iMessage's 60-second lingering dots are singled out as the worst offender; Facebook Messenger's 5–10s expiry reads as more honest ([Pavliscak](https://medium.com/@pamelapavliscak/three-dot-anxiety-b1c9318ed27b)).
- HCI: CHI 2023 "Together but not together" found richer typing indicators increase perceived co-presence but "at the cost of making them feel overwhelmed and obliged to communicate" — **presence signals are not free; they convert one party's activity into social pressure on the other** [repo: messaging-etiquette §2.3, [ACM](https://dl.acm.org/doi/10.1145/3544548.3581248)].
- Chronemics: silence and latency are read as meaningful (expectancy violations), which is the empirical basis for acknowledging before a long silence [repo: messaging-etiquette §2.2].

### 2.3 Read receipts creating obligation

Covered in §1.5: research documents sender anxiety + receiver obligation + avoidance behavior; every platform's privacy trajectory (opt-outs, private receipts) is the market's answer. Matrix's MSC2285 is the cleanest articulation of _why_ pure removal doesn't work (receipts also drive your own cross-device unread sync).

### 2.4 Multiple participants signalling at once

Human platforms already aggregate: Slack and Discord collapse to "Several people are typing…"; Matrix's `m.typing` is an aggregate array by protocol design; WhatsApp groups name the typists (with avatars in newer clients); iMessage groups (iOS 26) show per-person bubbles. No etiquette literature was found condemning simultaneous indicators per se — the platforms treat it as a rendering problem (collapse past ~3) rather than a behavior problem. The behavior-side analogue is the overlap-resolution machinery in turn-taking (one party drops out) [repo: messaging-etiquette §1.1], which applies to _messages_, not indicators.

### 2.5 Agent-specific guidance: are signals "participation"?

The question: `meta/agent-etiquette.md` holds that over-participation is the failure mode — does that extend to ephemeral signals?

**Evidence that signals are exempt from the over-participation rule (vendors mandate them):**

- Slack's agent-design guidance _requires_ an immediate status signal ("lightweight emoji reaction to a 'Working on it...' status") and progressive status updates, in the same document that demands minimal channel responses and batching ([Slack agent design](https://docs.slack.dev/concepts/agent-design/)). Slack clearly categorizes status signals and messages differently.
- Linear _enforces_ signalling: no activity within 10 seconds of session start → the agent is publicly marked **unresponsive** ([Linear agent best practices](https://linear.app/developers/agent-best-practices)). Silence is treated as the failure, not the signal.
- Teams and ChatGPT group chats both added emoji reactions to agents explicitly as a _lower-cost alternative_ to speaking [repo: survey §§2.1, 3.2] — the design intent is that signals absorb what would otherwise be messages.
- GitHub Copilot's 👀 receives explicitly positive user feedback (§1.6).

**Evidence that signals still carry participation cost (they are not free):**

- CHI 2023: typing indicators create felt obligation in the humans watching them [repo: messaging-etiquette §2.3]. A minutes-long "agent is typing" converts compute time into ambient social pressure — the repo report's own design read: "A persistent 'agent is typing' for minutes at a time converts the agent's compute time into social pressure on humans."
- The typing-anxiety literature (§2.2): an indicator that doesn't resolve into a message is actively worse than silence.
- OpenClaw's shipped defaults encode restraint _for signals specifically_: ack reactions default to `group-mentions` only, and "typing and lifecycle status reactions stay suppressed for room events" [repo: hermes report] — a shipping product concluded that unaddressed-room signal noise is a real cost.
- Reactions do generate notifications to the message author; N agents each 👀-ing one message is N notifications.

**Net of the sourced record:** vendor guidance uniformly distinguishes ephemeral/ambient signals (status text, typing, a single reaction) from messages, mandates the former where the agent was _addressed_, and none of the over-participation findings (IUI 2025, CHI 2025/2026 — all about message turns) implicate indicators. But the CHI 2023 obligation finding and OpenClaw's scoping show the exemption is conditional: signals about work _someone asked for_ are welcome; broadcast signals in rooms where the agent wasn't addressed are treated as noise by the one product that had to pick a default. No study directly tests "agent typing indicators annoy rooms" — gap.

---

## Part 3 — The three tensions

### 3.1 Slow turns (30–90s) vs 5–10s indicator expiry

Platform expiries: Telegram **≤5s**, Discord **10s**, Matrix client-chosen timeout with refresh-before-expiry, Slack assistant status **auto-clears at 2 min**, iMessage dots ~60s. The universal mechanic for outlasting expiry is the **refresh loop** (Telegram 4–5s [repo: grammY report], Discord ~8–10s re-trigger, Matrix re-PUT before timeout). The expiry-plus-refresh design is itself the platforms' honesty mechanism: a crashed sender stops refreshing and the indicator dies within seconds.

What long-running AI UIs do instead of raw typing indicators:

- **Elapsed time + labeled reasoning**: ChatGPT shows a live "Thinking" state that resolves to "Thought for N seconds," with user-selectable thinking-duration controls ([Skywork on the thinking-duration UI](https://skywork.ai/blog/chatgpt-thinking-duration-controls/)). Claude products show the same collapsible thinking affordance.
- **Progress narration for multi-minute work**: ChatGPT Deep Research (5–30 min runs) shows a progress side panel of steps/sources, and users "can follow progress as it runs and interrupt at any time" ([OpenAI, Introducing deep research](https://openai.com/index/introducing-deep-research/)).
- **Rotating status strings**: Slack's `loading_messages` (up to 10 rotating statuses) and its "Searching your workspace... → Found 3 matching issues... → Formatting results..." guidance ([Slack agent design](https://docs.slack.dev/concepts/agent-design/); [repo: 20260318]).
- **Streaming as implicit indicator**: Slack `chat.startStream`; UX research consistently finds streaming cuts _perceived_ wait 40–70% at identical total latency ([Telerik, Loading UI/UX Patterns for AI Applications](https://www.telerik.com/blogs/loading-ui-ux-patterns-ai-applications), [AI UX Playground streaming pattern](https://www.aiuxplayground.com/pattern/streaming/)).
- **Duration-matched indicator escalation** (general loading UX): spinners ≤3s; determinate progress 3–10s; 10s+ needs status text/progress ([Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/), [uxpatterns.dev AI loading states](https://uxpatterns.dev/patterns/ai-intelligence/ai-loading-states)).
- **Session state machine**: Linear — `thought` activity within **10s** or shown _unresponsive_; ongoing activities (thoughts, tool calls, elicitations); **30 min** without activity → _stale_ (recoverable by emitting another activity); terminal `response`/`error` required ([Linear agent best practices](https://linear.app/developers/agent-best-practices), [Linear, Our approach to building the Agent Interaction SDK](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk)).

The convergent shape across these: **fast ack (≤10s), then a state that carries information (what it's doing / how long it's been), rather than a bare pulsing indicator stretched past its social meaning.** A typing indicator means "message imminent" on every human platform; every AI product doing 30s+ work replaced it with a labeled working/thinking state.

### 3.2 N agents addressed at once

Precedents for aggregation, strongest first:

1. **Matrix `m.typing`**: aggregation is protocol-native — one ephemeral event with a `user_ids` array; the client renders "who is typing" as one unit ([spec](https://spec.matrix.org/latest/client-server-api/#typing-notifications)).
2. **Slack / Discord clients**: names up to ~3 typists, then the collapsed "Several people are typing…" string; Discord's hover reveals the list (community-reported).
3. **WhatsApp groups**: named/avatared typing bubbles for multiple simultaneous typists (newer clients — see Unverified); iMessage groups (iOS 26) show per-person indicators.
4. On the burst-input side (the mirror problem), [repo: hermes-openclaw report] recommends `collect`-with-debounce queueing because "rooms produce bursts — three humans typing at once."

No platform was found that _rate-limits or arbitrates_ simultaneous indicators — collapse-at-render is the entire industry answer. Note also OpenClaw's contrasting answer for agents specifically: suppress room-event signals entirely rather than aggregate them [repo: hermes report].

### 3.3 Failure honesty: indicator appeared, then nothing

Who leaves you hanging:

- **iMessage**: the archetype — dots linger up to ~60s, vanish silently; the anxiety genre of §2.2 is largely about this exact experience. No resolution signal of any kind.
- **Telegram/Discord/Matrix**: expiry-based — the indicator dies within 5–10s of the sender stopping (or crashing). Silent, but the short TTL bounds the dishonesty window; this is the _implicit_ honesty of expiring signals.
- **Slack assistant status**: auto-clears after 2 minutes with no message — silent failure, but bounded ([repo: 20260318]).
- **Slack agent guidance** addresses failure at the _message_ level, not the indicator level: when stuck, "save what it's accomplished, explain where it got stuck and why, give the user options"; "The agent broke, not the user" ([agent design doc](https://docs.slack.dev/concepts/agent-design/)).

Who handles it well:

- **Linear** is the only system found that makes the hang itself a first-class, visible state: no ack in 10s → shown **unresponsive**; activity stops for 30 min → **stale**; failures must emit a terminal `error` activity ([Linear agent best practices](https://linear.app/developers/agent-best-practices)). The signal isn't just presence — it's a session with an enforced lifecycle whose broken states have names the user can see.
- **Hermes' ❌ reaction on processing error** is the lightweight version: the ack-emoji vocabulary includes a failure terminal, so 👀-then-silence cannot happen without a visible ❌ or a bug [repo: hermes report].
- Negative examples of unhandled failure states in agent chat: OpenClaw's in-band stop not working while generating ([#20600](https://github.com/openclaw/openclaw/issues/20600)); the Hermes ack-loop where a human "stop" was consumed as a turn ([#32791](https://github.com/NousResearch/hermes-agent/issues/32791)); Zendesk's July 2026 incident of agents continuing after humans replied [all repo: 20260727 survey §§6.4, 7].

The pattern: human platforms rely on **short TTLs** so a dead sender's indicator dies fast; agent platforms that took slow turns seriously (Linear) added **explicit terminal and timeout states** because a 30–90s working signal is too long-lived for TTL honesty alone.

---

## Unverified / weakly sourced

Things I could not pin to a primary source; do not cite as fact:

- **Discord "several people are typing" exact threshold and hover-list behavior.** Community/meme sources say ~3+ names then collapse, hover reveals list; Discord's docs don't specify client rendering. Direction is certain (the string exists), the numbers are not.
- **Telegram small-group "seen by" member threshold** (commonly reported as groups ≤100 members). Telegram's tweet confirms the feature for "small groups" without a number.
- **iMessage 60-second typing-bubble persistence.** Reported by BGR/Pavliscak; Apple publishes nothing.
- **WhatsApp group typing bubbles with profile photos.** Reported from client tests/rollouts (WABetaInfo-tier sourcing); the base "typing…" label and its non-disableability are solid.
- **Pew "41% feel pressure to respond quickly"** — circulates in secondary read-receipt coverage; I did not locate the primary Pew report.
- **Typing-indicator origin (Cuomo/Redpath, IBM, 1997)** — consistently reported in the explainer literature; I did not verify against a primary IBM/patent source.
- **Hermes reaction semantics** are docs-only, not verified against source [flagged in repo: hermes report itself].
- **ChatGPT group-chat behavior** (reactions, relevance gate) is via secondary reporting; openai.com 403'd the repo's earlier fetches [repo: survey §3].
- **No direct study exists** on (a) agents emitting typing indicators in group rooms, (b) whether an agent's reaction-ack reads as attentive or creepy, (c) any numeric threshold for signal frequency. All three are named gaps in the repo research too.

## Source index (web, this report)

Platform docs/spec: [Discord Channels resource](https://discord.com/developers/docs/resources/channel) · [Matrix C-S API typing](https://spec.matrix.org/latest/client-server-api/#typing-notifications) · [MSC2285](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/2285-hidden-read-receipts.md) · [Matrix v1.4 release](https://matrix.org/blog/2022/09/29/matrix-v-1-4-release/) · [Slack agent design](https://docs.slack.dev/concepts/agent-design/) · [Linear agent best practices](https://linear.app/developers/agent-best-practices) · [Linear Agent Interaction SDK post](https://linear.app/now/our-approach-to-building-the-agent-interaction-sdk) · [Slack Workflow Builder help](https://slack.com/help/articles/17542172840595-Build-a-workflow--Create-a-workflow-in-Slack)
Vendor/product: [Telegram checkmarks tweet](https://x.com/telegram/status/1518850277859860480) · [GitHub Copilot coding agent](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/) · [OpenAI deep research](https://openai.com/index/introducing-deep-research/) · [Slack emoji culture blog](https://slack.com/blog/productivity/some-of-the-ways-we-use-emoji-at-slack) · [9to5Mac iOS 26 group chats](https://9to5mac.com/2026/01/12/ios-26s-messages-app-adds-five-great-new-group-chat-features/) · [MacRumors iOS 26 Messages](https://www.macrumors.com/guide/ios-26-messages-app/)
Etiquette/HCI/UX: [Pavliscak, Three-dot anxiety](https://medium.com/@pamelapavliscak/three-dot-anxiety-b1c9318ed27b) · [Saratoga Falcon on typing indicators](https://saratogafalcon.org/5988/features/typing-awareness-indicator-more-stressful-helpful/) · [read receipts in MIM (PDF)](https://scispace.com/pdf/exploring-the-impact-of-read-receipts-in-mobile-instant-3vid403m1p.pdf) · [Mondo, thumbs-up debate](https://mondo.com/insights/thumbs-up-emoji-passive-aggressive-workplace/) · [Telerik AI loading patterns](https://www.telerik.com/blogs/loading-ui-ux-patterns-ai-applications) · [Smart Interface Design Patterns, loading UX](https://smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/) · [uxpatterns.dev AI loading states](https://uxpatterns.dev/patterns/ai-intelligence/ai-loading-states) · [Know Your Meme, Several People Are Typing](https://knowyourmeme.com/memes/several-people-are-typing) · [Patrick Cloke on Matrix receipts](https://patrick.cloke.us/posts/2023/01/05/matrix-read-receipts-and-notifications/)
