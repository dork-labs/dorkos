import type { Room } from '@dorkos/shared/room-schemas';
import type { AsideResult } from '../room-trigger/aside.js';

/** Shared copy never forwards raw failure diagnostics, paths or account details. */
export function declineReason(room: Room | null, result: AsideResult | null): string {
  if (room === null || room.archived) return 'the room is archived.';
  if (result?.why === 'deadline') return 'it waited too long to start. Send the post again.';
  if (result?.failure?.refusal !== undefined) {
    if (result.failure.refusal === 'pending-interaction') {
      return 'it needs an answer in its chat. Open the chat to continue.';
    }
    return 'it could not start. Open its chat to see what needs attention.';
  }
  if (result?.outcome === 'failed') {
    return 'the chat stopped. Open it to continue.';
  }
  if (result === null) return 'nobody has said anything there yet, so there is nothing to answer.';
  if (result.outcome === 'busy') return 'it stayed busy for an hour.';
  if (result.outcome === 'halted') return 'somebody stopped it.';
  if (result.why === 'budget') return 'the room is out of automatic turns for now.';
  if (result.outcome === 'refused') return 'it could not take a turn there.';
  const said = result.text?.trim();
  if (!said) return 'it did not post or explain why. Ask in the room.';
  const max = 280;
  return said.length > max ? `${said.slice(0, max - 1).trimEnd()}…` : said;
}
