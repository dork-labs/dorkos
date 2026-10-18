/**
 * What an agent is told when a teammate started its turn (DOR-2955): a space member who is not
 * its owner. The turn's tools are fenced and its notes left out (`rooms/limits/teammate-turn.ts`);
 * this says so in the prompt, so the agent explains a refusal instead of retrying it.
 *
 * Also part of the relaunch fingerprint on purpose: a warm process launched for the owner holds
 * the owner's notes in its prompt, so a teammate's turn must not reuse it, and the owner's next
 * turn must not reuse one launched without them. It changes only with the space's shared folder,
 * and ordinary turns carry none of it, so they never change the digest or relaunch for it.
 *
 * Left out of a teammate's prompt as well (DOR-2956, the teammate tier): the owner's profile block
 * (the name and details they gave DorkOS), and everything in the `<env>` block but the platform,
 * so the turn is told neither who the owner is nor where their files are (`agent-context.ts`).
 *
 * @module services/core/turn-power/teammate-turn-context
 */
import type { AdditionalContext } from '@dorkos/shared/additional-context';

/**
 * The block appended to a teammate turn's system prompt, and to its digested half: what the turn
 * may do, and, when the space shares a folder, where it may read (DOR-2956).
 *
 * @param sharedFolder - The space's shared folder, or `null` when it shares none.
 */
export function teammateTurnContext(sharedFolder: string | null): string {
  const reads = sharedFolder
    ? `You can read files in the space's shared folder, ${sharedFolder}: list them with
shared_files_list, search them with shared_files_search, and open one with Read by its full path.
Some files there are never shared, such as .env files and the .git and .dork folders.`
    : 'You cannot read files: this space shares no folder.';
  return `<teammate_turn>
Someone in a shared space who is not your owner started this turn. For this turn you can read and
post in the room you are answering. ${reads} You cannot read other rooms or chats, use the web or
connected apps, save notes, or ask your owner to approve anything. Your saved notes are not shown
in this turn. If they ask for something you cannot do here, say so plainly.
</teammate_turn>`;
}

/**
 * The per-turn context a turn is shown: all of it, except that a teammate's turn is not shown
 * `git_status` (DOR-2956), the branch and changes of the agent's own folder, which are the owner's
 * and which such a turn reads nothing of.
 *
 * @param context - The turn's context bag, as the server assembled it.
 * @param teammate - Whether a teammate in a shared space started the turn.
 */
export function contextShownTo(
  context: AdditionalContext | undefined,
  teammate: boolean
): AdditionalContext | undefined {
  return teammate ? context?.filter((entry) => entry.kind !== 'git_status') : context;
}
