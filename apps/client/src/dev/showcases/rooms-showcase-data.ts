/**
 * The fleet, the people and the rooms every room showcase is built from.
 *
 * One cast across the whole page, so a reader who learns who Mio and Kai are in
 * the member-row section still recognises them in the sheet. Kept out of
 * `RoomsShowcases.tsx` for the same reason `settings-mock-data.ts` is kept out
 * of the settings showcases: the showcase file should be readable as a list of
 * states, not as a list of fixtures.
 *
 * @module dev/showcases/rooms-showcase-data
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { ServerConfig } from '@dorkos/shared/types';
import {
  createAgentAuthor,
  createAgentManifest,
  createAgentPickerCandidate,
  createRoomAuthor,
  createRoomMember,
  createRoomWithRoster,
  minutesBeforeNow,
} from '../mock-factories';
import { MOCK_SERVER_CONFIG } from './settings-mock-data';

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

/** Where each agent in the cast lives on disk. The join key for everything else. */
export const AGENT_PATHS = {
  pm: '/Users/dev/agents/mio-clicker-pm',
  code: '/Users/dev/agents/mio-click-code',
  kai: '/Users/dev/agents/kai',
  /** Deliberately has no manifest — see {@link ROOM_FLEET}. */
  unresolved: '/Users/dev/agents/ravi-bot',
} as const;

/**
 * The fleet as the mesh reports it, manifests and all.
 *
 * `ravi-bot` is present as a path with **no manifest**, which is the state the
 * cockpit cannot invent a face for: the visual is hashed from the manifest's
 * id, so with no manifest there is nothing to hash and the honest answer is a
 * letter on a neutral disc. It is the one fleet member whose row proves the
 * picker and the roster both refuse to guess.
 */
export const ROOM_FLEET: { agentPath: string; manifest: AgentManifest | null }[] = [
  {
    agentPath: AGENT_PATHS.pm,
    manifest: createAgentManifest({
      id: 'agent-mio-pm',
      name: 'mio-clicker-pm',
      displayName: 'Mio Clicker PM',
      description: 'Keeps the clicker roadmap honest and writes the weekly note.',
      color: '#b48c3c',
      icon: '💼',
    }),
  },
  {
    agentPath: AGENT_PATHS.code,
    manifest: createAgentManifest({
      id: 'agent-mio-code',
      name: 'mio-click-code',
      color: '#3ca078',
      icon: '🔔',
    }),
  },
  {
    agentPath: AGENT_PATHS.kai,
    manifest: createAgentManifest({
      id: 'agent-kai',
      name: 'kai',
      displayName: 'Kai',
      description: 'Reads every diff before you do.',
      color: '#c85a6e',
      icon: '🛰',
    }),
  },
  { agentPath: AGENT_PATHS.unresolved, manifest: null },
];

/** The same fleet as a picker reads it, for showcases that hand candidates over directly. */
export const ROOM_CANDIDATES = [
  createAgentPickerCandidate({
    agentPath: AGENT_PATHS.kai,
    displayName: 'Kai',
    visual: { color: '#c85a6e', emoji: '🛰' },
    description: 'Reads every diff before you do.',
  }),
  createAgentPickerCandidate({
    agentPath: AGENT_PATHS.pm,
    displayName: 'Mio Clicker PM',
    visual: { color: '#b48c3c', emoji: '💼' },
    description: 'Keeps the clicker roadmap honest and writes the weekly note.',
  }),
  createAgentPickerCandidate({
    agentPath: AGENT_PATHS.code,
    displayName: 'mio-click-code',
    visual: { color: '#3ca078', emoji: '🔔' },
    description: null,
  }),
  createAgentPickerCandidate({
    agentPath: AGENT_PATHS.unresolved,
    displayName: 'ravi-bot',
    visual: null,
    description: null,
  }),
];

// ---------------------------------------------------------------------------
// The people and the memberships
// ---------------------------------------------------------------------------

/** The person reading. Every room fixture has them in it, because every room does. */
export const READER = createRoomAuthor({
  id: 'author-me',
  displayName: 'Dorian',
  color: '#7b8cdc',
});

/** One roster row per agent in the cast, at a rung that makes its point. */
export const MEMBER = {
  reader: createRoomMember({
    author: READER,
    joinedAt: minutesBeforeNow(60 * 24 * 12),
  }),
  pm: createRoomMember({
    author: createAgentAuthor(AGENT_PATHS.pm, {
      id: 'author-mio-pm',
      displayName: 'Mio Clicker PM',
      emoji: '💼',
      color: '#b48c3c',
    }),
    responseMode: 'engaged',
    joinedAt: minutesBeforeNow(60 * 24 * 9),
  }),
  code: createRoomMember({
    author: createAgentAuthor(AGENT_PATHS.code, {
      id: 'author-mio-code',
      displayName: 'mio-click-code',
      emoji: '🔔',
      color: '#3ca078',
    }),
    responseMode: 'mention-only',
    joinedAt: minutesBeforeNow(60 * 24 * 4),
  }),
  kai: createRoomMember({
    author: createAgentAuthor(AGENT_PATHS.kai, {
      id: 'author-kai',
      displayName: 'Kai',
      emoji: '🛰',
      color: '#c85a6e',
    }),
    responseMode: 'silent',
    joinedAt: minutesBeforeNow(60 * 26),
  }),
  /**
   * The agent whose manifest could not be read, and whose author row carries no
   * render cache either — so nothing on the wire knows what it looks like.
   */
  unresolved: createRoomMember({
    author: createAgentAuthor(AGENT_PATHS.unresolved, {
      id: 'author-ravi',
      displayName: 'ravi-bot',
    }),
    responseMode: 'always',
    joinedAt: minutesBeforeNow(35),
  }),
} satisfies Record<string, RoomRosterEntry>;

// ---------------------------------------------------------------------------
// The rooms
// ---------------------------------------------------------------------------

/** A channel with a person and three agents at three different rungs. */
export const CHANNEL_ROOM: RoomWithRoster = createRoomWithRoster({
  members: [MEMBER.reader, MEMBER.pm, MEMBER.code, MEMBER.kai],
});

/** A channel nobody has been put in yet — the sheet's most consequential moment. */
export const EMPTY_ROOM: RoomWithRoster = createRoomWithRoster({
  id: 'room-design',
  slug: 'design',
  title: 'Design',
  topic: null,
  members: [MEMBER.reader],
});

/**
 * A one-to-one, which offers three rungs rather than four and warns that a
 * second agent turns it into a group conversation.
 */
export const DM_ROOM: RoomWithRoster = createRoomWithRoster({
  id: 'room-dm-mio',
  kind: 'dm',
  slug: null,
  title: 'Mio Clicker PM',
  topic: null,
  members: [MEMBER.reader, { ...MEMBER.pm, responseMode: 'always' }],
});

/** A retired room: the banner, the dormant meters, and the way back. */
export const ARCHIVED_ROOM: RoomWithRoster = createRoomWithRoster({
  id: 'room-old-thing',
  slug: 'old-thing',
  title: 'Old thing',
  topic: 'Shipped in April, kept for the log',
  archived: true,
  members: [MEMBER.reader, MEMBER.pm, MEMBER.code],
});

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

/**
 * A server config carrying the two engaged-window ceilings.
 *
 * The `Engaged` rung quotes them — "10 more minutes or 5 more messages" — and
 * says less rather than guessing when the config read has not landed, so a
 * showcase without this shows the sentence that has no numbers in it.
 */
export const ROOMS_SERVER_CONFIG: ServerConfig = {
  ...MOCK_SERVER_CONFIG,
  rooms: { engagedWindowMinutes: 10, engagedWindowPosts: 5 },
};
