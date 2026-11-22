import type { Room } from '@dorkos/shared/room-schemas';
import type { AsideResult } from '../room-trigger/aside.js';

/** Fixed wording for every decline except one the seat explained in its own words. */
function fixedReason(room: Room | null, result: AsideResult | null): string | undefined {
  if (room === null || room.archived) return 'the room is archived.';
  if (result?.why === 'deadline') return 'it waited too long to start. Send the post again.';
  if (result?.failure?.refusal !== undefined) {
    if (result.failure.refusal === 'pending-interaction') {
      return 'it needs an answer in its chat. Open the chat to continue.';
    }
    return "it couldn't start. Open its chat to see what's wrong.";
  }
  if (result?.outcome === 'failed') {
    return 'the chat stopped. Open it to continue.';
  }
  // No try ran to the end: the hand-off failed before its turn did (logged by the caller).
  if (result === null) return "it couldn't take a turn there.";
  if (result.outcome === 'busy') return 'it stayed busy for an hour.';
  if (result.outcome === 'halted') return 'somebody stopped it.';
  if (result.why === 'budget') return 'the room is out of automatic turns for now.';
  if (result.outcome === 'refused') return "it couldn't take a turn there.";
  if (result.replyOutsider) return 'it read words from outside your team. Its chat says why.';
  if (!result.text?.trim()) return "it didn't say why. Ask in the room.";
  return undefined;
}

/** Shared copy never forwards raw failure diagnostics, paths or account details. */
export function declineReason(room: Room | null, result: AsideResult | null): string {
  const fixed = fixedReason(room, result);
  if (fixed !== undefined) return fixed;
  const said = result!.text!.trim();
  const max = 280;
  return said.length > max ? `${said.slice(0, max - 1).trimEnd()}…` : said;
}

/**
 * The reason a private notice carries into the drafting chat. That chat wakes with its own
 * marks, not the seat's, so the seat's own reply never rides along: the status has it.
 */
export function noticeReason(room: Room | null, result: AsideResult | null): string {
  return fixedReason(room, result) ?? 'it chose not to post. Its hand-off status has its reply.';
}
