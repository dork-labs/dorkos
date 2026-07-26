# Ideation: Rooms — channels, DMs and threads

- **Slug:** rooms
- **Id:** 260726-170533
- **Date:** 2026-07-26
- **Project:** Agents as First-Class Operators
- **Tracker:** DOR-521 (phases: DOR-523 R0, DOR-524 R1, DOR-525 R2, DOR-526 R3, DOR-527 R4)

## Intent

Give DorkOS the container multi-participant conversation needs: Slack-style **channels** and **direct messages** in the left sidebar, with **threads** inside them, several humans and several agents in each.

Phase 1 of `multi-participant-message-list` (DOR-455) already shipped the rendering half — every message carries an author, grouping keys on author change, day and unread separators are real list rows. What is missing is the thing those messages belong to.

## Where this comes from

This spec does not re-open its own design. The decisions were taken elsewhere and are cited, not re-argued:

- `research/20260724_multi-user-communities.md` — the survey (Nostr/Buzz, Matrix, Zulip, Slack) and thirteen numbered decisions.
- A six-document review exchange between two agents over that research. It converged on four items: **A** (the room model), **A′-policy** (thread write intent), **A′-mechanism** (resource coordination), **B** (the community server). This spec is A and A′-policy. B is a separate business call. A′-mechanism is independently urgent but **not** thread-gated.
- `research/20260725_q3-contention-preregistration.md` and the DOR-500 runs, which measured what actually collides when six agents run at once.
- ADR 260726-170125 (a room is a membership-scoped durable stream), ADR 260726-170126 (author identity), ADR 260726-170127 (cascade guard).

## What the review settled, so nobody re-litigates it

| Question                          | Answer                                                       | Why it is closed                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is a room a session?              | No. Three agents in a room are three sessions on one stream. | Sessions are runtime-bound at first write (ADR-0255), so a mixed-runtime room could not be one session.                                                                                    |
| Does a room own a write lock?     | No. The lock is keyed on the resource.                       | DOR-500: tree-sharing is the collision. A room-shaped lock neither covers nor bounds it.                                                                                                   |
| Does a room have a turn policy?   | No. Rooms carry addressing and atomicity only.               | The idea decomposed into `responseMode` + log atomicity + cascade guard + claiming, each of which has an owner. `buzz-acp` is not a precedent — it is one Nostr member with a worker pool. |
| Where do claims live?             | On the work item. The room renders them.                     | The room is a projection surface for state owned elsewhere.                                                                                                                                |
| Is the author key `ctx.agent.id`? | No.                                                          | It is the manifest ULID, which the ADR-0043 reconciler may rebuild. See ADR 260726-170126.                                                                                                 |
| Sign messages in v1?              | No — reserve the field and fix canonicalization.             | Research decision 7: signing is additive, key auth is the risky half.                                                                                                                      |

## The naming problem, and the call

"Channel" already means two other things in this product, and one of them renders **inside the very sidebar surface** a Channels section would occupy:

| Today                                              | What the user sees                                             | What it means                                        |
| -------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `features/settings/ui/ChannelsTab.tsx`             | Settings tab "Channels"                                        | Configured Relay adapters (Telegram, Slack, webhook) |
| `features/agent-settings/ui/ChannelsTab.tsx`       | Per-agent "Channels" accordion                                 | Which external channels route to this agent          |
| `features/relay/ui/RelayPanel.tsx:68`              | Relay tab **"Connections"**, whose body says "Active Channels" | The same concept, already inconsistent with itself   |
| `entities/session/config/origin-descriptors.ts:28` | A badge reading **"Channel"** on rows in `RecentSessionRow`    | This session was started by an inbound Relay message |

Three metaphors, one word, and the last one would sit two inches from a nav section using the word differently.

**The call: "Channel" means an in-cockpit conversation. Relay's concept becomes "Connection" everywhere.** This is alignment, not invention — the Relay panel's own tab is already called Connections, so the rename settles an existing inconsistency rather than creating churn. The session-origin badge becomes "Connection", which is also more accurate: it says the session arrived over a connection to an outside service.

Sidebar agent groups keep their name. They are groups, and no user-facing copy calls them channels.

## Product shape

**Left sidebar** gains two sections beside Recent and Agents:

- **Channels** — `#` prefixed, unread count, click to open.
- **Direct messages** — one row per DM, avatar plus name.

Both collapse and persist like `recentsCollapsed` does today.

**A room view** reuses the phase-1 message list wholesale: same rows, same grouping, same day and unread separators, same tool cards and approvals. A room is where that list finally has more than two participants to render.

**Threads** open as a child room — the same entity with a parent — surfaced by a "N replies" summary row in the parent, exactly as `01-ideation.md` of `multi-participant-message-list` proposed.

## A′-policy — thread write intent

Threads share the parent room's working directory and are **read-oriented by default**: a thread is for asking why, comparing options, and reviewing what happened, and its agents inherit the parent's `cwd` without any promise of exclusive access to it. Promoting a thread to a branch is the escalation — it forks the conversation, allocates a worktree, and the thread becomes a peer room with its own tree. This is a policy, not an enforcement mechanism: nothing in v1 stops a thread's agent from writing, and nothing should pretend otherwise, because the real protection is a resource-keyed lock (A′-mechanism) that is **not** thread-gated and is sized by DOR-500 rather than by this spec. What the policy buys is that the common case — several threads reading and reasoning off one tree — is safe by construction because nobody is writing, and the case that does write has been given a tree of its own.

## Two corrections to `multi-participant-message-list/01-ideation.md`

Both are that document's own words, now falsified:

1. **Line 117** proposes that the conversation-tree write lock "extends the existing `session-lock` / `X-Client-Id` machinery rather than inventing a second one." `SessionLockManager` is keyed on `sessionId` (`apps/server/src/services/session/session-lock.ts:24`) and guards several clients contending for **one session**. The hazard is one resource with **many sessions** — the orthogonal case. No cwd-, worktree-, or resource-keyed lock exists anywhere in the repo. It needs a new primitive keyed on the resolved path.
2. **Open decision 3** ("do threads get their own runtime session, or one session multiplexed by a thread key?") is settled by runtime binding: ADR-0255 binds a session to a runtime at first write, so a multiplexed session cannot hold two runtimes. Threads get their own sessions.

## Out of scope

- **B — the community server** (`apps/community`, multi-install federation, accounts). Separate business call.
- **A′-mechanism** — the resource-keyed lock. Independently urgent, materially larger than "add a lock", and not blocking on anything here.
- **Message signing.** Field reserved, canonicalization fixed, nothing signs.
- **Room-workspace cwd resolution.** A room stores a workspace reference in v1; how it composes with the `agent-workspace-binding` precedence chain is that spec's business.
- **Reactions** — phase 2 of `multi-participant-message-list`, unblocked by the author key here.
