import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * What happens to an agent in a room or DM when its Claude account runs out,
 * and how it should behave in the fresh session it wakes up in (Re-seat P0).
 *
 * ## Why this is a skill
 *
 * A moved seat starts a new session whose only memory of the old one is a
 * summary in its background, and the turn it starts with is often the same
 * message the old session was answering. An agent that does not know that
 * answers twice, or apologises for a gap it did not cause. The rules are few
 * and only matter once it happens, so they live here rather than in every turn.
 *
 * Moving a seat by hand (`reseat_room_agent`) is people-only for now, so the
 * page says so instead of teaching the tool.
 */
export const continuingOnAnotherAccount: OperatingSkill = {
  name: 'continuing-on-another-account',
  description:
    'Use when your room or DM seat was moved to another Claude account: a room line says you ' +
    'ran out of usage and are continuing on another account, switched accounts, or started a ' +
    'fresh chat because your earlier one expired, or your background opens with a summary of a ' +
    'previous session. Covers what moved and what did not, finishing an answer without ' +
    'repeating it, and who can move you.',
  body: `# Continuing on another account

${TOOL_NAME_NOTE}

Each agent in a room or DM has one **seat** there: the chat it answers in. When the
Claude account that chat runs on runs out of usage, DorkOS moves the seat to the
account with the most usage left, and you carry on. Nobody had to step in.

## How you can tell

- A quiet line in the room, about you: "… ran out of usage on Claude4, so it's
  continuing on Claude3.", "… is continuing on Claude3, because Claude4 is almost
  out of usage.", or, in a room with people from outside, "… switched accounts to
  keep answering."
- "… started a fresh chat here. Its earlier one had expired." means Claude Code
  removed your old transcript. Same seat, nothing to recover.
- Your background opens with a summary of the previous session: where it stopped,
  the files it touched, its last messages, and the path to its transcript.

## What moved, and what did not

- **New:** this session, and the account it bills. Your memory of the old session
  is the summary, plus the room history in your context.
- **The same:** your power. The new session copies the old one's permission mode,
  model and effort, never more. Any mark the old session carried (words from
  outside your owner's circle) carries too, so what you pass on is capped exactly as
  before.
- **Unchanged:** your "Runs on" setting. Only this seat moved.

## Finish, don't repeat

The turn you wake up in is usually the message the old session was answering.

1. Read the summary and the room history first.
2. If the old session **already posted** an answer, do not answer again. Finish
   only what is left, if anything. Saying nothing more is fine.
3. If it was partway through work (files edited, a command run), check where that
   work stands and finish it rather than starting over.
4. Do not apologise for the move or explain it. The room already has its line.

## Who can move you

DorkOS moves you on its own when your account runs out or is almost out, at most
once per message. A person can also move you from your menu in the room
("Continue on another account…"). You cannot move yourself: the move tool is
for people only for now. If you think you need another account, say so to the
person in the room and they can move you.

DorkOS credits are never picked for you. Only a person chooses those, in a chat.
`,
};
