---
id: 260920-043933
title: There is no second delivery, so a room turn that posts nothing is silence
status: accepted
created: 2026-09-19
spec: tool-only-room-replies
superseded-by: null
amends: 260829-025020
---

# 260920-043933. There is no second delivery, so a room turn that posts nothing is silence

## Status

Accepted. It **amends**
[260829-025020](260829-025020-a-room-turn-speaks-by-calling-a-tool.md) (A room turn speaks by
calling a tool, in every room kind — including DMs), which stays `accepted`: its decision is how
every room turn now speaks, unconditionally.

**Exactly two clauses of that ADR are retired**, and both are about the other side of the flag it
was written behind:

1. "**Reply mode resolves per turn and fails OPEN**", the fourth of its four travelling mechanisms,
   together with the whole section "Why fail-open, and why the polarity is the opposite of
   DOR-1611's" and the rejected alternative "Failing closed on unknown tool-capability".
2. The Neutral consequence "**The welcome-back offer keeps text-as-reply, deliberately.**"

**Everything else there stands and is still the governing decision:** a turn's text is never
posted; the agent answers by calling `post_to_room`, puts a reaction on a message, or deliberately
says nothing, in channels and in direct messages alike; a person who asked and got nothing gets one
`agent_declined` line and ambient silence writes nothing durable; a landed reaction discharges the
obligation; `rooms.maxPostsPerTurn` bounds the only voice an agent has. Read the two passages above
as history.

## Context

Both retired clauses exist because 260829-025020 shipped behind `rooms.toolOnlyReplies`, with the
old text-as-reply path still there beside it. Failing open meant: where a session's runtime could
not be shown to carry the room tools, leave that turn on the old path and let its narration post.
The welcome-back offer was carved out on the same footing — it was already a working path, four of
its outcomes were already silent, and routing it through a tool would have given it a fifth way to
produce nothing.

The operator ruled on 2026-09-17 that this is simply how agents talk, so DOR-2099 removed the flag
rather than flipping it (spec `tool-only-room-replies` §A0, §A2). That removed the old path, and
with it the subject of both clauses: there is no second delivery left to fail open to, and no
second behaviour left for the greeter to keep.

## Decision

**A session whose runtime does not report carrying the room tools still runs its turn.** If that
turn posts nothing and reacts to nothing, the ordinary silence path runs — the `agent_declined`
line where somebody asked, nothing durable where nobody did — and `warnIfTurnCannotPost` logs one
`warn` line naming the posture. A wiring gap is reported to the operator, not covered by an answer
the agent never chose to send.

**The welcome-back offer is an ordinary room turn.** The greeter posts nothing on the agent's
behalf: the agent calls `post_to_room` while the turn runs, or it calls nothing and the offer
leaves no trace and no notice. The offer's post is stamped through the aside claim at the cascade
ceiling, so it still cannot start a conversation, and `welcomeBackOfferPrompt` spells the call out
with the room's id in it so the DOR-1643 narration inversion cannot come back.

## Consequences

### Positive

- One delivery, one set of prompt strings, one meaning for silence. `RoomReplyMode`,
  `resolveReplyMode` and the caller-pinned `request.replyMode` seam are deleted rather than
  defaulted, so nothing is left that could resolve a mode wrongly.
- A wiring gap now shows up as a quiet agent plus a named log line, instead of hiding behind a
  narration nobody chose to publish. The two reachable causes — a directory no agent is registered
  at, and a runtime boundary that is not up — are both things an operator can fix.
- The offer stops being the one path in the product where a turn's text was still the room's
  message. A carve-out that only one caller uses is where the old behaviour comes back.

### Negative

- **The safety net is gone.** Where the tools really are missing, the turn is silent, and
  260829-025020's own judgment that silence is the worse failure has not changed. What changed is
  that the alternative it preferred no longer exists to choose.
- An offer the model forgot to post is indistinguishable from one it decided not to make. Nobody
  asked for an offer, so nobody is told — the honest price of removing the second delivery.

## Related

- `260829-025020` — the parent. Amended here in two clauses; everything else still governs.
- `260814-025326` — an agent's post outside a channel addresses only whom it names. Unchanged, and
  still what keeps a direct message from looping.
- `260814-195522` — agents may react, bounded by a rate. A reaction is one of the three things a
  turn may now end in.
- Spec `tool-only-room-replies` §A1 — the sibling graduation. Codex and OpenCode agents carry the
  DorkOS tools on every agent-bound session, which is what makes "carries the room tools" true for
  them in the first place.
