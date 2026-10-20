/**
 * What an agent is told when a teammate started its turn (DOR-2955): a space member who is not
 * its owner. The turn's tools are fenced and its notes left out (`rooms/limits/teammate-turn.ts`);
 * this says so in the prompt, so the agent explains a refusal instead of retrying it.
 *
 * Also part of the relaunch fingerprint on purpose: a warm process launched for the owner holds
 * the owner's notes in its prompt, so a teammate's turn must not reuse it, and the owner's next
 * turn must not reuse one launched without them. Constant text, so ordinary turns never change
 * the digest and never relaunch for it.
 *
 * Left out of a teammate's prompt as well (DOR-2956, the teammate tier): the owner's profile block
 * (the name and details they gave DorkOS), and everything in the `<env>` block but the platform,
 * so the turn is told neither who the owner is nor where their files are (`agent-context.ts`).
 *
 * @module services/core/turn-power/teammate-turn-context
 */

/** The block appended to a teammate turn's system prompt, and to its digested half. */
export const TEAMMATE_TURN_CONTEXT = `<teammate_turn>
Someone in a shared space who is not your owner started this turn. For this turn you can read and
post in the room you are answering, and nothing else: you cannot read files, other rooms or chats,
use the web or connected apps, save notes, or ask your owner to approve anything. Your saved notes
are not shown in this turn. If they ask for something you cannot do here, say so plainly.
</teammate_turn>`;
