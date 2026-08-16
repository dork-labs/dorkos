import type { PlaygroundSection } from '../playground-registry';

/**
 * Identity sections — the one page where the whole identity language is
 * reviewable at once (spec `identity-consistency` §W4).
 *
 * **This array holds only the sections the Identity page OWNS.** The page also
 * renders sections registered to other pages — the `shared/ui` primitives on
 * Components, the room and chat surfaces on Rooms and Chat — because a title
 * holds exactly one registry entry and moving those would break anchors people
 * already have. Cross-listing is done by RENDERING, and the page's TOC is
 * composed from both halves in `playground-config.ts`. See §W4.2.
 *
 * Sources: IdentityMatrixShowcases, IdentityMotionShowcases, AgentIdentityShowcases,
 * RoomPresenceShowcases, TeamShowcases, ProfileShowcases, AccountShowcases.
 */
export const IDENTITY_SECTIONS: PlaygroundSection[] = [
  // IdentityMatrixShowcases
  {
    id: 'identity-shape-matrix',
    title: 'Identity Shape Matrix',
    page: 'identity',
    category: 'Identity',
    keywords: [
      'identity',
      'matrix',
      'kind',
      'shape',
      'agent',
      'human',
      'external',
      'system',
      'photo',
      'emoji',
      'letter',
      'working',
      'handle',
      'roster',
    ],
  },
  // IdentityMotionShowcases
  {
    id: 'motion-and-interaction',
    title: 'Motion & interaction',
    page: 'identity',
    category: 'Identity',
    keywords: [
      'motion',
      'interaction',
      'hover',
      'focus',
      'press',
      'grammar',
      'surface',
      'mark',
      'chip',
      'tier',
      'flip',
      'layout',
      'travel',
      'echo',
      'owner',
      'badge',
      'wake',
      'drawer',
      'reduced motion',
      'keyboard',
    ],
  },
  // AgentIdentityShowcases
  {
    id: 'agentavatar',
    title: 'AgentAvatar',
    page: 'identity',
    category: 'Identity',
    keywords: ['agent', 'avatar', 'emoji', 'color', 'identity', 'health', 'status'],
  },
  {
    id: 'agentidentity',
    title: 'AgentIdentity',
    page: 'identity',
    category: 'Identity',
    keywords: ['agent', 'identity', 'card', 'name', 'avatar', 'detail', 'profile'],
  },
  {
    id: 'avatarpickergrid',
    title: 'AvatarPickerGrid',
    page: 'identity',
    category: 'Identity',
    keywords: ['agent', 'avatar', 'color', 'emoji', 'picker', 'grid', 'swatch', 'preset'],
  },
  // RoomPresenceShowcases
  {
    id: 'roompresenceline',
    title: 'RoomPresenceLine',
    page: 'identity',
    category: 'Identity',
    keywords: [
      'room',
      'presence',
      'working',
      'line',
      'live',
      'composer',
      'elapsed',
      'late',
      'announcer',
    ],
  },
  // TeamShowcases
  {
    id: 'team-roster',
    title: 'Team Roster',
    page: 'identity',
    category: 'Identity',
    keywords: ['team', 'roster', 'people', 'agents', 'grid', 'chips', 'group', 'manager', 'owner'],
  },
  {
    id: 'team-card',
    title: 'Team Card',
    page: 'identity',
    category: 'Identity',
    keywords: ['team', 'card', 'member', 'identity', 'handle', 'owner', 'attribution', 'external'],
  },
  // ProfileShowcases
  {
    id: 'profile',
    title: 'Profile',
    page: 'identity',
    category: 'Identity',
    keywords: [
      'profile',
      'identity',
      'person',
      'agent',
      'handle',
      'email',
      'rows',
      'push',
      'sheet',
      'portrait',
    ],
  },
  // AccountShowcases
  {
    id: 'account-menu',
    title: 'Account Menu',
    page: 'identity',
    category: 'Identity',
    keywords: ['account', 'menu', 'avatar', 'sidebar', 'sign out', 'profile', 'handle', 'chrome'],
  },
  {
    id: 'profile-tab',
    title: 'Profile Tab',
    page: 'identity',
    category: 'Identity',
    keywords: ['profile', 'settings', 'photo', 'avatar', 'handle', 'display name', 'email'],
  },
];
