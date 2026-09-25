import { isTombstoneText, REMOVED_ENTRY_TEXT } from '../content/tombstones.js';
import type { Entry, Member } from './types.js';

/** What the viewer may do to a message or file: delete their own, or remove someone else's. */
export type RemovalAction = 'delete' | 'remove';

/** What the browser knows about the signed-in person when it decides which actions to offer. */
export interface RemovalViewer {
  memberId: string;
  role: Member['role'];
  /** The viewer's own active agents: their messages count as the viewer's. */
  ownAgentIds: ReadonlySet<string>;
  /**
   * The open channel's roster, by member or agent id. Only an admin needs it: it names who is the
   * owner or an active admin, and whose agent is whose. Anyone absent from it is unknown.
   */
  roster: ReadonlyMap<string, Pick<Member, 'kind' | 'role' | 'ownerMemberId'>>;
}

/**
 * The action to offer on a message (and its files), mirroring the server's rank rule: content
 * counts as its human's, an agent's as its owner's. Your own content is Delete; an owner may
 * Remove anything else; an admin may Remove content whose human is not the owner and not an
 * active admin. The server decides: when the roster cannot say who a message's human is (they
 * left the channel), an admin is offered Remove and a refusal is shown if the server says no.
 */
export function removalAction(entry: Entry, viewer: RemovalViewer): RemovalAction | null {
  if (isTombstoneText(entry.text)) return null;
  const author = entry.authorMemberId;
  if (entry.authorKind === 'human' ? author === viewer.memberId : viewer.ownAgentIds.has(author))
    return 'delete';
  if (viewer.role === 'owner') return 'remove';
  if (viewer.role !== 'admin') return null;
  const humanId =
    entry.authorKind === 'human' ? author : (viewer.roster.get(author)?.ownerMemberId ?? null);
  const humanRole = humanId ? viewer.roster.get(humanId)?.role : undefined;
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
