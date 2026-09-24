/**
 * The area registry: every area a person can set, in display order, with the
 * copy the permissions pages show. Membership is NOT here: each action declares
 * its own `area` beside its tier (spec `agent-permissions` D2, one fact per tool
 * in one place).
 *
 * @module shared/permissions/permission-areas
 */
import type { PermissionAreaId } from './permission-schemas.js';

/** The id of any row on the permissions page: the ten state areas plus `files`. */
export type PermissionRowAreaId = PermissionAreaId | 'files';

/** One area as a person sees it. */
export interface PermissionArea {
  /** Stable id. */
  readonly id: PermissionRowAreaId;
  /** The row label. */
  readonly label: string;
  /** One plain sentence saying what the area covers. */
  readonly description: string;
  /** A floor area is never Allowed, whatever any layer says. */
  readonly floor: boolean;
  /** `state` rows take Blocked/Ask/Allowed; the `files` row takes a trust stop. */
  readonly kind: 'state' | 'trust-stop';
}

/** Every area, in display order. */
export const PERMISSION_AREAS: readonly PermissionArea[] = Object.freeze([
  {
    id: 'rooms',
    label: 'Rooms',
    description: 'Make rooms, add or remove people, rename them, leave them, put them away',
    floor: false,
    kind: 'state',
  },
  {
    id: 'tasks',
    label: 'Tasks & schedules',
    description: 'Create, change, and delete scheduled tasks',
    floor: false,
    kind: 'state',
  },
  {
    id: 'agents',
    label: 'Other agents',
    description: 'Set up, change, and remove agents, and sort the sidebar',
    floor: false,
    kind: 'state',
  },
  {
    id: 'messages',
    label: 'Messages',
    description: 'Message other agents, and message you',
    floor: false,
    kind: 'state',
  },
  {
    id: 'connections',
    label: 'Chat connections',
    description: 'Turn Telegram and Slack connections on or off, and change where chats go',
    floor: false,
    kind: 'state',
  },
  {
    id: 'packages',
    label: 'Tools & packages',
    description: 'Install or remove packages, add or change MCP servers, build extensions',
    floor: false,
    kind: 'state',
  },
  {
    id: 'settings',
    label: 'DorkOS settings',
    description: 'Change your everyday settings, like notifications and the sidebar',
    floor: false,
    kind: 'state',
  },
  {
    id: 'safety',
    label: 'Safety limits',
    description: "Change reply limits, message caps, and an agent's safety boundaries",
    floor: true,
    kind: 'state',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    description: 'Change what any agent is allowed to do',
    floor: true,
    kind: 'state',
  },
  {
    id: 'reach',
    label: 'Reach & secrets',
    description: 'Open this computer to the internet, change login, sign-ins, keys, and folders',
    floor: true,
    kind: 'state',
  },
  {
    id: 'files',
    label: 'Files & commands',
    description:
      'How often the agent stops to check with you while editing files and running commands',
    floor: false,
    kind: 'trust-stop',
  },
] satisfies PermissionArea[]);

const AREAS_BY_ID = new Map<string, PermissionArea>(PERMISSION_AREAS.map((a) => [a.id, a]));

/**
 * Look up an area by id.
 *
 * @param id - An area id; unknown ids (a newer build's area) return `undefined`.
 */
export function getPermissionArea(id: string): PermissionArea | undefined {
  return AREAS_BY_ID.get(id);
}

/**
 * Whether an area is a floor area (Safety limits, Permissions, Reach & secrets):
 * never Allowed at any layer.
 *
 * @param id - An area id.
 */
export function isFloorArea(id: string): boolean {
  return AREAS_BY_ID.get(id)?.floor === true;
}
