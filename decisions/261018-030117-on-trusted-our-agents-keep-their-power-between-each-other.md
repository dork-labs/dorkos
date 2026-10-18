---
id: 261018-030117
title: On Trusted, our own agents keep their power when they talk to each other
status: proposed
created: 2026-10-18
spec: trusted-by-default-flip
superseded-by: null
amends: [261004-235818, 261009-171114]
---

# 261018-030117. On Trusted, our own agents keep their power when they talk to each other

## Status

Proposed. A governance change (it raises what our agents may do): it becomes Accepted only on Dorian's own OK on the PR.

**Amends:**

- [261004-235818](261004-235818-started-chat-inherits-starter-level-as-ceiling.md): a chat still starts nothing above its own level. Full autonomy no longer has to be named when the start raises no approval card.
- [261009-171114](261009-171114-chat-message-origin-and-delivery-rules.md): power still flows downstream for everyone DorkOS cannot vouch for. On Trusted, a chat message from one of our agents that DorkOS vouches for carries no bound.

## Context

Spec `trusted-by-default-flip` §4 says power flows downstream: a turn that somebody else's words start runs no looser than that somebody. It was written to stop a stranger reaching a shell through a chain of agents, and for strangers it stays. But it held our own agents to each other too, and the levels it compares were often wrong in the strict direction. Auto is recorded as Default. An unknown level, and many routine ones, became the runtime's default. In #dorkos-marketing one agent in Auto mentioned three teammates, and all three ran at Default and raised cards Dorian had turned off by setting Bypass. A spin-off woken by a `chat_send` or a report-back fell to Default on every later turn. And `session_start` refused to pass on Bypass unnamed "so the person approving can see it", on Trusted, where no card shows, so agents retried at Auto and their spin-offs ran below them.

Trusted by default (DOR-2738) says our agents are trusted co-workers. Between them, the bound took power away and protected nobody.

## Decision

**On Trusted, words one of our own agents sends do not lower the turn they start, when DorkOS can vouch for them.** The receiver runs at its own mode.

- **Vouched** means, at the moment the post or message is written: the sender is a registered agent the surface verified, calling from a session the surface verified, and that session ran no turn in this process that read an outsider's words (sticky: background work such a turn started, a helper or a monitor, keeps calling as the session after a later clean turn). When the session's level is unknown, the agent vouches only while none of its turns that read an outsider's words is running, the same reading `outsiderBoundOf` already uses for memory and `session_start`. This splits the two meanings `'runtime-default'` had: "our agent, level unknown" is no longer treated like "a stranger".
- **Never vouched:** a caller with no session at all (the external `/mcp` server, so Codex and OpenCode posts, or a process an agent left running). It may be doing the bidding of a turn that ended long ago, so it keeps today's bound until a session-bound token exists (spec §4.5).
- **Where it applies:** room posts written with `post_to_room`, and `chat_send` messages, report-backs and a spin-off's first message. A queued row stores the vouch beside the bound (`chat-ceiling.ts`), so a row that launches after a restart, or after a switch to Careful, is judged as it was sent. A room post's vouch is in memory, like its level: after a restart a post falls back to the runtime default.
- **What stays bounded, on every preset:** a stranger's message, a Telegram or Slack chat, a relayed message, a space teammate, A2A, an outsider-marked level, a post from an unverified caller or a forged session id, and a post made through the HTTP route (it never carries a vouch).
- **`session_start`** passes Full autonomy on unnamed when the call raises no approval card: on Trusted, with the agent's Agents area (or the tool itself) resolving to Allowed (`session-start-card.ts`). Where a card shows, the rule that Full autonomy is named holds. A chat still never starts one above its own level.
- **Careful** changes nothing.

## Consequences

- An agent at Bypass that a teammate at Default mentions now runs at Bypass. That is the point; a person who wants agents to bound each other picks Careful.
- Prompt injection that reaches an agent through a page it reads (not a stranger's message) already ran at that agent's own level; it can now also reach a teammate at the teammate's level. The outsider mark covers stranger messages, not every page read, the same line §4.7 drew for memory.
- A person who answers a `session_start` card with "allow, and stop asking" has also passed on the calling chat's level for that call: the resume runs under the new standing permission, so no card is left for the rule to protect.
- Words a turn reads through a tool (`read_room_history`, `transcript_read`, a web page) never mark it (§4.7). Vouching inherits that gap: such a turn's posts are vouched.
- Owner-only areas (Safety limits, Reach & secrets, adding or changing MCP servers) and the "get a yes" working rules are not touched.
