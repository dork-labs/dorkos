/**
 * The two lists on a chat connection that make someone count as you there
 * (DOR-4595): `approverAllowlist` (who may answer an agent's approval from the
 * chat app) and `dmAllowlist` (who may message your agents directly). Adding an
 * id to either is a lasting grant, so only the owner makes one, after confirming
 * it's them; removing one narrows and stays immediate.
 *
 * @module routes/relay-adapter-grants
 */
import { toIdList } from '@dorkos/relay';

/** The connection settings whose ids act as the owner on that chat app. */
export const OWNER_LIST_KEYS = ['approverAllowlist', 'dmAllowlist'] as const;

/** One id a save would add to one of those lists. */
export interface AddedListId {
  /** Which list. */
  list: (typeof OWNER_LIST_KEYS)[number];
  /** The platform user id being added. */
  id: string;
}

/** Refusal code when anything but the owner adds someone to one of those lists. */
export const OWNER_ADDS_LIST_ID_CODE = 'OWNER_ADDS_LIST_ID';

/**
 * Every id a save adds to either list, compared with what is stored.
 * A list the save does not name is left as it is.
 *
 * @param incoming - The connection settings as the request sends them.
 * @param existing - The settings as stored, or none for a new connection.
 */
export function addedListIds(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): AddedListId[] {
  return OWNER_LIST_KEYS.flatMap((list) => {
    if (!Object.hasOwn(incoming, list)) return [];
    const before = new Set(toIdList(existing?.[list]));
    return toIdList(incoming[list])
      .filter((id) => !before.has(id))
      .map((id) => ({ list, id }));
  });
}

/**
 * The sheet's sentence for those additions: the exact ids, and the connection.
 *
 * @param added - What the save adds.
 * @param connection - The connection's name, already quoted.
 */
export function addedListReason(added: readonly AddedListId[], connection: string): string {
  const ids = [...new Set(added.map((entry) => entry.id))].join(', ');
  const approves = added.some((entry) => entry.list === 'approverAllowlist');
  const messages = added.some((entry) => entry.list === 'dmAllowlist');
  const what =
    approves && messages
      ? 'approve and message your agents'
      : approves
        ? 'approve your agents’ requests'
        : 'message your agents';
  return `Let ${ids} ${what} on ${connection}.`;
}

/** The refusal anything but the owner gets for adding to one of those lists. */
export function ownerAddsListIdRefusal(): { error: string; code: string } {
  return {
    error: 'Only the owner can add someone who approves or messages agents here.',
    code: OWNER_ADDS_LIST_ID_CODE,
  };
}
