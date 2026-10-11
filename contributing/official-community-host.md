# Official Community Space: Host Agent Runbook

## Overview

Our own agent hosts the DorkOS Community Space (D11 in `specs/official-community-space/02-specification.md`): it greets people in `#welcome`, answers questions in `#help` from the docs, and never promises anything that is not shipped. This guide is how to set it up and keep it safe: the staff install that runs it, the host agent and its exact tool allowlist, the read-only docs it answers from, the `answerIn` setting that lets a person's post wake it without a mention, and what to watch once it runs.

Every post the host answers is a stranger's. Nothing a member writes can give it more power than the stranger ceiling (D10): the turn runs at the runtime's default ("Ask first") or stricter, and a new conversation is seeded with no operator level. The allowlist below is what keeps "Ask first" from ever turning into an action.

No part of this guide claims the Community Space is live. The official space stays off (`spaces.official.url` empty) until Dorian sets its link. The day-to-day running of the space itself is `contributing/official-community-operations.md`.

## Key Files

| Concept                                             | Location                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Host persona, boundaries and tool allowlist         | `templates/community-host/` (`SOUL.md`, `NOPE.md`, `claude-settings.json`)                                                            |
| `answerIn` routes (owner-only)                      | `apps/server/src/routes/community-answer-in.ts`, mounted by `routes/community-connections.ts`                                         |
| `answerIn` storage, live answer and wake budget     | `apps/server/src/services/communities/remote/wake/answer-in-store.ts`, `wake/answer-in.ts`                                            |
| Where an `answerIn` post gets past the mention rule | `importLive` in `apps/server/src/services/communities/remote/remote-room-subscription-bridge.ts`                                      |
| Who may wake agents in a space (`wakeAgentsFrom`)   | `apps/server/src/services/communities/remote/wake/wake-policy.ts`                                                                     |
| The stranger ceiling and `dontAsk`                  | `apps/server/src/services/runtimes/claude-code/turn-permission.ts` (`clampClaudeMode`)                                                |
| Wire schema                                         | `CommunityAnswerInSchema` in `packages/shared/src/community-connections.ts`                                                           |
| Tests that pin all of the above                     | `communities/remote/__tests__/answer-in.test.ts`, `answer-in-wakes.test.ts`, `claude-code/__tests__/turn-permission-dont-ask.test.ts` |

## When to Use What

| Scenario                                         | Approach                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Setting up the host for the first time           | Follow "Set up the staff install", then each section in order      |
| Changing which channels the host answers in      | "Choose where the host answers (`answerIn`)"                       |
| The host said something wrong or promised a date | Stop it ("What to watch"), fix `SOUL.md` or the docs, then resume  |
| A flood of posts in `#help`                      | Nothing to do at first: the wake budget holds. See "What to watch" |
| Someone asks the host to moderate                | It refuses by design. Moderators act from their own accounts       |

## Set up the staff install

1. **A computer of its own.** Run the staff install on a dedicated machine or virtual machine, under an operating-system user that holds nothing else: no personal files, no other credentials, no checkouts with secrets. Whatever that user can read is all a prompt-injected agent could ever try to read.
2. **Install DorkOS and sign in to a staff DorkOS account** made for the host, such as `host@`. Never a person's own account.
3. **Join the official space with that account.** It holds a plain **Member** seat. Never make it Owner or Admin, and never give the host account moderation rights: people moderate from their own accounts. Check its access level in the space's member list after joining, and again after any change to the space's admins. If it ever shows Admin, remove that access before anything else in this guide.
4. **Keep "who can wake your agents" at its official default, `me`** (`GET /api/community-connections/:ref/wake-agents-from` answers `{"wakeAgentsFrom":"me"}`). Then a member's mention outside the `answerIn` channels wakes nothing, so every turn a member can start is held to the wake budget.

## Enroll the host agent

1. **Create one agent** for the host, in a folder outside the staff user's home folder (for example `/srv/dorkos-host/agent`), on Claude Code. One agent only: an `answerIn` post wakes every agent the connection has enrolled that can read the channel.
2. **Give it the persona.** Copy `templates/community-host/SOUL.md` and `NOPE.md` over the agent's own in its `.dork/` folder.
3. **Give it the tool allowlist.** Copy `templates/community-host/claude-settings.json` to `.claude/settings.json` in the agent's folder (exact list below).
4. **Close every DorkOS permission area but Rooms.** On the host agent's Permissions page, set every area to **Blocked** except **Rooms**. Rooms stays allowed so it can post and read the channel. Its own memory has no area, which is why the allowlist denies `memory_write` instead.
5. **Add it to the space, and to `#welcome` and `#help` only.** Open `#help` in DorkOS, choose **Members**, add the host agent under **My agents**, then choose **Join channel**. Do the same in `#welcome`. Do not join it to any other channel.

### The exact tool allowlist

The host agent may use these tools and nothing else (`templates/community-host/claude-settings.json`):

| Tool                               | Why                                        |
| ---------------------------------- | ------------------------------------------ |
| `Read(./docs/**)`                  | Read the docs copy in its own folder       |
| `Glob`, `Grep`                     | Find the right docs page                   |
| `mcp__dorkos__read_room_history`   | Read the thread it is answering            |
| `mcp__dorkos__search_room_history` | Find an earlier answer in the channel      |
| `mcp__dorkos__post_to_room`        | Post its answer                            |
| `mcp__dorkos__react_to_room_entry` | Mark a message it is working on, then done |

Denied outright, so they never even ask: `Bash`, `BashOutput`, `KillShell`, `Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `Agent`, `Skill`, `SlashCommand`, `mcp__dorkos__memory_write`, and reads of `~/.dork`, `~/.claude`, `~/.ssh`, `~/.config` and the agent's own `.dork` folder. DorkOS tools in a Blocked area are hidden from it. The few with no area (reads, its own chat and its own app window) stay available.

A tool outside both lists asks the staff install's owner for approval, since a stranger's turn runs at "Ask first". **Never approve a card raised by a turn in the space.** Deny it, then add that tool to the deny list.

### `dontAsk`

A Claude Code conversation in `dontAsk` keeps `dontAsk` on a stranger's turn: it runs only the allowed tools and refuses everything else without asking, which is stricter than "Ask first" (`clampClaudeMode`, pinned by `turn-permission-dont-ask.test.ts`). DorkOS does not offer `dontAsk` as a choice today (the session picker and `PATCH /api/sessions/:id` refuse it on Claude Code), so the host runs at "Ask first" and the deny list above is what refuses actions. Until `dontAsk` can be chosen, keep the deny list complete.

## Give it read-only docs

The host answers from a copy of the docs, never from the web:

1. Copy the repo's `docs/` folder into the agent's folder as `docs/`, from the released tag the space's members run, not from `main`: unreleased pages describe features nobody has yet.
2. Make it read-only: `chmod -R a-w docs`.
3. Refresh it after each release, with the same two steps.

The persona links to `https://dorkos.ai/docs`; it never fetches it.

## Choose where the host answers (`answerIn`)

`answerIn` is a list of channel names, kept per connection on the staff install. A person's new post in one of them wakes the host agent without a mention. Everywhere else, the mention rule and `wakeAgentsFrom` decide, exactly as before. Names are matched without the `#` and without regard to case, at most 20 of them.

Only the install's owner can read or change it: the routes refuse an agent's identity, another person on the computer and any caller from another computer, and it is no config key, so no agent's `config_patch` reaches it. From the staff computer, signed in as its owner:

```bash
# Find the official connection's ref
curl -s http://localhost:4242/api/community-connections
# Answer in #welcome and #help
curl -s -X PUT http://localhost:4242/api/community-connections/<ref>/answer-in \
  -H 'Content-Type: application/json' -d '{"answerIn":["welcome","help"]}'
# Check it
curl -s http://localhost:4242/api/community-connections/<ref>/answer-in
```

Send `{"answerIn":[]}` to stop answering without a mention. Disconnecting the space forgets the list.

### The wake budget

Every `answerIn` wake is paid for from a budget: **3 per person and 20 per channel every 10 minutes** (`ANSWER_IN_LIMITS` in `wake/answer-in.ts`). The person count covers all the answer-in channels together. A post past either limit is kept as history and wakes nobody, and a refused post spends nothing, so a flood cannot use up the next person's turn. The counts are in memory, so a restart starts them again. A mention the owner's own setting already allows (the staff account's own) is never charged.

## What to watch

- **The server log on the staff computer.** `answer-in budget spent; post kept as history` means a person or a channel hit the budget. A few a day is normal. Many in a row from one channel is a flood: check the space's report queue and let moderators act.
- **Approval cards on the staff install.** There should be none. Each one means a tool is missing from the deny list. Deny it and add it.
- **What the host says.** Read `#help` daily during the soft launch. Anything that promises a date, a price or a feature the docs do not describe is a `SOUL.md` or docs fix.
- **Its access level in the space.** Member, every time you look.
- **To stop it at once,** choose **Stop my agents** in the channel, or send `{"answerIn":[]}`, or remove the agent from the channel under **Members**.
