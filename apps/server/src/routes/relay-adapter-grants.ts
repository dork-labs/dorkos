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

/**
 * Whether a save opens the connection's DMs to anyone: `dmPolicy` moves to
 * anything but `'allowlist'` from a connection that only took listed people,
 * or a new connection starts that way. Open DMs are the whole DM list at once
 * (Security M2 on DOR-4355 M3), so this is a list addition too. A save that
 * doesn't name `dmPolicy` leaves it as it is. A stored value that is absent is
 * read as the schemas' default, `'allowlist'`.
 *
 * @param incoming - The connection settings as the request sends them.
 * @param existing - The settings as stored, or none for a new connection.
 */
export function opensDirectMessages(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined
): boolean {
  if (!Object.hasOwn(incoming, 'dmPolicy')) return false;
  const before = existing?.dmPolicy ?? 'allowlist';
  return incoming.dmPolicy !== 'allowlist' && before === 'allowlist';
}

/**
 * The sheet's sentence for a save that adds people or opens DMs: the exact
 * ids, that anyone may now message, and the connection.
 *
 * @param added - What the save adds to the lists.
 * @param opensDms - Whether it opens the DMs to anyone.
 * @param connection - The connection's name, already quoted.
 */
export function ownerGrantReason(
  added: readonly AddedListId[],
  opensDms: boolean,
  connection: string
): string {
  if (!opensDms) return addedListReason(added, connection);
  const open = `Let anyone message your agents on ${connection}.`;
  return added.length > 0 ? `${open} ${addedListReason(added, connection)}` : open;
}

/** The refusal anything but the owner gets for adding to one of those lists. */
export function ownerAddsListIdRefusal(): { error: string; code: string } {
  return {
    error: 'Only the owner can let someone approve or message agents here.',
    code: OWNER_ADDS_LIST_ID_CODE,
  };
}

/**
 * The stored owner lists and DM rule, as one comparable value. An agent's card
 * is judged on this, and its write lands only while it still matches.
 *
 * @param config - The connection's settings as stored.
 */
export function ownerListState(config: Record<string, unknown> | undefined): string {
  return JSON.stringify({
    approverAllowlist: toIdList(config?.approverAllowlist),
    dmAllowlist: toIdList(config?.dmAllowlist),
    dmPolicy: config?.dmPolicy ?? 'allowlist',
  });
}

/** The words for one owner list on a card. */
const LIST_WHAT: Record<(typeof OWNER_LIST_KEYS)[number], string> = {
  approverAllowlist: 'Who may approve your agents’ requests',
  dmAllowlist: 'Who may message your agents directly',
};

/** A list of ids for a card, or "Nobody". */
function idsText(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(', ') : 'Nobody';
}

/**
 * What a save that adds people or opens DMs does, read against what is stored,
 * for an agent's card (DOR-4355 M4). Every word comes from the stored settings
 * and the ids the save names, never from anything else the agent sent.
 *
 * @param incoming - The connection settings as the request sends them.
 * @param existing - The settings as stored.
 * @param connection - The connection's name, already quoted.
 */
export function ownerGrantEffect(
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
  connection: string
): { summary: string; changes: { what: string; from: string; to: string }[] } {
  const added = addedListIds(incoming, existing);
  const opensDms = opensDirectMessages(incoming, existing);
  const changes = OWNER_LIST_KEYS.filter((list) => added.some((entry) => entry.list === list)).map(
    (list) => ({
      what: `${LIST_WHAT[list]} on ${connection}`,
      from: idsText(toIdList(existing?.[list])),
      to: idsText(toIdList(incoming[list])),
    })
  );
  if (opensDms) {
    changes.push({
      what: `Who may message your agents directly on ${connection}`,
      from: 'Only people on the DM list',
      to: 'Anyone',
    });
  }
  return { summary: ownerGrantReason(added, opensDms, connection), changes };
}
