import { isTombstoneText, REMOVED_ENTRY_TEXT } from '../content/tombstones.js';
import type { Entry, Member } from './types.js';

/** What the viewer may do to a message or file: delete their own, or remove someone else's. */
export type RemovalAction = 'delete' | 'remove';

/**
 * Whether a message was removed or erased, so it has nothing left to act on. The wire carries no
 * removal flag (a strict schema older installations parse), so this reads the tombstone's whole
 * shape: a removal sentence as the entire text, no files and no mentions. The server refuses a new
 * post whose text is one of those sentences, so a living message cannot pose as a removed one.
 */
export function isRemovedEntry(entry: Entry): boolean {
  return (
    isTombstoneText(entry.text) && entry.attachments.length === 0 && entry.mentions.length === 0
  );
}

/** What the browser knows about the signed-in person when it decides which actions to offer. */
export interface RemovalViewer {
  memberId: string;
  role: Member['role'];
  /** The viewer's own active agents: their messages count as the viewer's. */
  ownAgentIds: ReadonlySet<string>;
  /**
   * Every active human in the community and their role, from the member directory an owner or
   * admin may read; `null` until it has loaded. Only an admin needs it. A human absent from it is
   * no longer an active member (a former admin, an erased husk), whom an admin may remove.
   */
  humanRoles: ReadonlyMap<string, NonNullable<Member['role']>> | null;
  /** Agent id to owner id, from the open channel's roster: whose agent is whose. */
  agentOwners: ReadonlyMap<string, string>;
}

/**
 * The action to offer on a message (and its files), mirroring the server's rank rule: content
 * counts as its human's, an agent's as its owner's. Your own content is Delete; an owner may
 * Remove anything else; an admin may Remove content whose human is not the owner and not an
 * active admin. Before the directory loads an admin is offered nothing on others' messages. An
 * agent that left the channel has no known owner; an admin is offered Remove and the server has
 * the final word.
 */
export function removalAction(entry: Entry, viewer: RemovalViewer): RemovalAction | null {
  if (isRemovedEntry(entry)) return null;
  const author = entry.authorMemberId;
  if (entry.authorKind === 'human' ? author === viewer.memberId : viewer.ownAgentIds.has(author))
    return 'delete';
  if (viewer.role === 'owner') return 'remove';
  if (viewer.role !== 'admin' || !viewer.humanRoles) return null;
  const humanId = entry.authorKind === 'human' ? author : viewer.agentOwners.get(author);
  if (humanId === undefined) return 'remove';
  const humanRole = viewer.humanRoles.get(humanId);
  return humanRole === 'owner' || humanRole === 'admin' ? null : 'remove';
}

/** The message as everyone will see it once the action succeeds, shown while the server answers. */
export function expectedTombstone(entry: Entry, action: RemovalAction): Entry {
  return {
    ...entry,
    text: REMOVED_ENTRY_TEXT[action === 'delete' ? 'author' : 'moderator'],
    mentions: [],
    attachments: [],
  };
}

/** The line every message confirmation ends with: what a removal cannot reach. */
const MESSAGE_LEFTOVERS =
  'People who already saw it may have a copy, and exports made before now still contain it until they expire.';

/** The confirmation copy for each action, exactly as the dialogs show it. */
export const REMOVAL_COPY = {
  message: {
    delete: {
      menuItem: 'Delete',
      title: 'Delete this message?',
      body: `Everyone will see "${REMOVED_ENTRY_TEXT.author}" in its place. Its files are deleted too. This can't be undone.`,
      leftovers: MESSAGE_LEFTOVERS,
      confirm: 'Delete',
    },
    remove: {
      menuItem: 'Remove',
      title: 'Remove this message?',
      body: `Everyone will see "${REMOVED_ENTRY_TEXT.moderator}" in its place. Its files are deleted too. This can't be undone.`,
      leftovers: MESSAGE_LEFTOVERS,
      confirm: 'Remove',
    },
  },
  file: {
    delete: {
      menuItem: 'Delete file',
      title: 'Delete this file?',
      body: "It's removed from the message and deleted. This can't be undone.",
      leftovers: null,
      confirm: 'Delete file',
    },
    remove: {
      menuItem: 'Remove file',
      title: 'Remove this file?',
      body: "It's removed from the message and deleted. This can't be undone.",
      leftovers: null,
      confirm: 'Remove file',
    },
  },
} as const;
