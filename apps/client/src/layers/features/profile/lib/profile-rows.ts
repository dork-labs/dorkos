/**
 * The property list, per relationship — the profile's whole body (spec
 * `profile-unification` §1.4, `design/05-states-final.html`).
 *
 * A pure function over the roster row, because this table IS the contract: what
 * an operator may act on, what they may only read, and what stays visible but
 * locked. Written as data so it can be checked against the spec table directly
 * rather than inferred from six render paths.
 *
 * @module features/profile/lib/profile-rows
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { shortenHomePath } from '@/layers/shared/lib';
import { formatRuntimeIdentity } from '@/layers/entities/runtime';
import type { ProfilePageId } from '../model/profile-stack';
import type { ProfileRelationship } from './profile-relationship';

/**
 * What a row lets you do.
 *
 * - `nav` — pushes a full-height page (›)
 * - `pick` — opens a small popover (▾); only ever offered on an identity you manage
 * - `copy` — puts its value on the clipboard (⧉)
 * - `locked` — visible, unavailable, and says why (🔒)
 * - `text` — a fact, and nothing to do about it
 */
export type ProfileRowKind = 'nav' | 'pick' | 'copy' | 'locked' | 'text';

/** One row of the property list. */
export interface ProfileRowModel {
  /** Stable within a profile — the React key, the focus target after a pop, and the test hook. */
  id: string;
  kind: ProfileRowKind;
  /** The left-hand label. Never wraps. */
  label: string;
  /** The right-hand value, or `null` when the row has nothing to show yet. */
  value: string | null;
  /** Dimmed trailing detail — "last 2 h", "next 9:00". */
  meta?: string;
  /** Where a `nav` row goes. */
  page?: ProfilePageId;
  /** Which popover a `pick` row opens. */
  pick?: 'runs-on' | 'personality';
  /** What a `copy` row puts on the clipboard. */
  copyValue?: string;
  /** Why a `locked` row is locked. Shown on hover and read out via `aria-describedby`. */
  lockedReason?: string;
  /** Faces drawn before the value — the Manages row's stack. */
  faces?: TeamMember[];
}

/** A block of rows, separated from its neighbours by space rather than a label. */
export interface ProfileRowGroup {
  /** Stable within a profile — the React key. */
  id: string;
  rows: ProfileRowModel[];
}

/** Rooms this identity is in, as the row wants them (W1.2's `useMemberRooms`). */
export interface ProfileRoomsSummary {
  /** How many rooms. */
  count: number;
  /** Their names, in the order the endpoint returned them. */
  names: string[];
}

/** Everything the row table needs that is not on the roster row itself. */
export interface ProfileRowsContext {
  /** What this identity is to you. */
  relationship: ProfileRelationship;
  /** The agents this identity owns, resolved from the roster. */
  manages: TeamMember[];
  /** The agent's description, when one has been read. */
  description?: string | null;
  /** Rooms this identity is in, or `null` while unknown. */
  rooms?: ProfileRoomsSummary | null;
  /** When a bridged person was first seen here, when anything knows. */
  firstSeenAt?: string | null;
}

/** Why DorkBot's identity rows do not open. */
const SYSTEM_LOCK_REASON = 'DorkBot’s name, face and personality are part of DorkOS.';

/** Why your email is not editable here. */
const EMAIL_LOCK_REASON =
  'Your email comes from the account you signed in with. Change it in Settings › Security.';

/** A room list as one value: the first two names, then how many more. */
function roomsValue(rooms: ProfileRoomsSummary | null | undefined): string | null {
  if (!rooms || rooms.count === 0) return null;
  const shown = rooms.names.slice(0, 2).map((name) => `#${name}`);
  const rest = rooms.count - shown.length;
  return rest > 0 ? `${shown.join(', ')}, +${rest}` : shown.join(', ');
}

/** "12 agents" / "1 agent" — the Manages row's value beside its face stack. */
function managesValue(count: number): string {
  return count === 1 ? '1 agent' : `${count} agents`;
}

/** A stored timestamp as a plain date, or `null` when it is not a date at all. */
function formatDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Your own rows: the four things about you, then the two lists you are in. */
function selfRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  return [
    {
      id: 'identity',
      rows: [
        { id: 'name', kind: 'nav', label: 'Name', value: member.displayName, page: 'name' },
        {
          id: 'handle',
          kind: 'nav',
          label: 'Handle',
          value: member.handle === null ? 'Add a handle' : `@${member.handle}`,
          page: 'handle',
        },
        {
          id: 'photo',
          kind: 'nav',
          label: 'Photo',
          value: member.imageUrl ? 'Uploaded' : 'Add a photo',
          page: 'photo',
        },
        {
          id: 'email',
          kind: 'locked',
          label: 'Email',
          value: member.person?.email ?? 'No email on this machine',
          lockedReason: EMAIL_LOCK_REASON,
        },
      ],
    },
    { id: 'belonging', rows: [managesRow(ctx), roomsRow(ctx)] },
  ];
}

/** The Manages row — a face stack, a count, and the list behind it. */
function managesRow(ctx: ProfileRowsContext): ProfileRowModel {
  return {
    id: 'manages',
    kind: 'nav',
    label: 'Manages',
    value: managesValue(ctx.manages.length),
    page: 'manages',
    faces: ctx.manages,
  };
}

/** The Rooms row — the same row for every identity that has one. */
function roomsRow(ctx: ProfileRowsContext): ProfileRowModel {
  return {
    id: 'rooms',
    kind: 'nav',
    label: 'Rooms',
    value: roomsValue(ctx.rooms),
    page: 'rooms',
  };
}

/** Another person on this install: what they do, what they own, where they are. */
function personRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  const rows: ProfileRowModel[] = [];
  const role = member.person?.role;
  if (role) rows.push({ id: 'role', kind: 'text', label: 'Role', value: role });
  rows.push(managesRow(ctx), roomsRow(ctx));
  return [{ id: 'belonging', rows }];
}

/** Someone reaching this install over Telegram or Slack: rooms, and since when. */
function bridgedRows(ctx: ProfileRowsContext): ProfileRowGroup[] {
  const rows: ProfileRowModel[] = [roomsRow(ctx)];
  const firstSeen = ctx.firstSeenAt ? formatDate(ctx.firstSeenAt) : null;
  // Drawn only when something knows the date. Nothing serves it today, so this
  // row is normally absent rather than reading "First seen —".
  if (firstSeen)
    rows.push({ id: 'first-seen', kind: 'text', label: 'First seen', value: firstSeen });
  return [{ id: 'belonging', rows }];
}

/** How the agent runs, as one value. */
function runsOnValue(member: TeamMember): string | null {
  return member.agent ? formatRuntimeIdentity(member.agent).text : null;
}

/** An agent you manage: the row IS the control, all the way down. */
function managedAgentRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  const folder = member.agent?.projectPath;
  const setup: ProfileRowModel[] = [
    { id: 'about', kind: 'nav', label: 'About', value: ctx.description ?? null, page: 'about' },
    { id: 'runs-on', kind: 'pick', label: 'Runs on', value: runsOnValue(member), pick: 'runs-on' },
    { id: 'personality', kind: 'pick', label: 'Personality', value: null, pick: 'personality' },
  ];
  if (folder) {
    setup.push({
      id: 'folder',
      kind: 'copy',
      label: 'Folder',
      value: shortenHomePath(folder),
      copyValue: folder,
    });
  }

  return [
    { id: 'setup', rows: setup },
    {
      id: 'work',
      rows: [
        { id: 'sessions', kind: 'nav', label: 'Sessions', value: null, page: 'sessions' },
        { id: 'tasks', kind: 'nav', label: 'Tasks', value: null, page: 'tasks' },
        roomsRow(ctx),
      ],
    },
    {
      id: 'toolkit',
      rows: [
        { id: 'skills', kind: 'nav', label: 'Skills', value: null, page: 'skills' },
        { id: 'tools', kind: 'nav', label: 'Tools & MCP', value: null, page: 'tools' },
        { id: 'connections', kind: 'nav', label: 'Connections', value: null, page: 'connections' },
        {
          id: 'instructions',
          kind: 'nav',
          label: 'Instructions',
          value: 'SOUL.md',
          page: 'instructions',
        },
        {
          id: 'boundaries',
          kind: 'nav',
          label: 'Boundaries',
          value: 'NOPE.md',
          page: 'boundaries',
        },
      ],
    },
  ];
}

/**
 * Someone else's agent: what a teammate should see, and nothing else.
 *
 * Private is not the same as locked. A locked row says "you cannot change
 * this"; these rows are simply not theirs to read, so they are absent — no
 * sessions, no tools, no instructions, and no lock icons implying a door.
 */
function otherAgentRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  return [
    {
      id: 'setup',
      rows: [
        { id: 'about', kind: 'text', label: 'About', value: ctx.description ?? null },
        { id: 'runs-on', kind: 'text', label: 'Runs on', value: runsOnValue(member) },
        roomsRow(ctx),
      ],
    },
  ];
}

/**
 * DorkBot: the same rows as your own agent, with the identity ones locked.
 *
 * Locked, not hidden — the server answers 403 `SYSTEM_PROTECTED` on these, and
 * a row that explains itself is better than a control that fails after you use
 * it. The model still runs on your machine and stays yours to set.
 */
function systemAgentRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  return [
    {
      id: 'setup',
      rows: [
        {
          id: 'about',
          kind: 'locked',
          label: 'About',
          value: ctx.description ?? null,
          lockedReason: SYSTEM_LOCK_REASON,
        },
        {
          id: 'runs-on',
          kind: 'pick',
          label: 'Runs on',
          value: runsOnValue(member),
          pick: 'runs-on',
        },
        {
          id: 'personality',
          kind: 'locked',
          label: 'Personality',
          value: null,
          lockedReason: SYSTEM_LOCK_REASON,
        },
      ],
    },
    {
      id: 'work',
      rows: [
        { id: 'sessions', kind: 'nav', label: 'Sessions', value: null, page: 'sessions' },
        { id: 'tasks', kind: 'nav', label: 'Tasks', value: null, page: 'tasks' },
        roomsRow(ctx),
      ],
    },
    {
      id: 'toolkit',
      rows: [
        { id: 'skills', kind: 'nav', label: 'Skills', value: null, page: 'skills' },
        { id: 'tools', kind: 'nav', label: 'Tools & MCP', value: null, page: 'tools' },
      ],
    },
  ];
}

/**
 * The whole property list for one identity.
 *
 * The six shapes of §1.4, chosen by relationship and — inside `other`, which
 * covers both a person and their agent — by kind.
 *
 * @param member - The identity being drawn.
 * @param ctx - What the roster row does not carry (see {@link ProfileRowsContext}).
 * @returns Groups of rows, in reading order. Empty groups are dropped.
 */
export function rowsFor(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  const groups = (() => {
    switch (ctx.relationship) {
      case 'self':
        return selfRows(member, ctx);
      case 'managed':
        return managedAgentRows(member, ctx);
      case 'system':
        return systemAgentRows(member, ctx);
      case 'bridged':
        return bridgedRows(ctx);
      case 'other':
        return member.kind === 'agent' ? otherAgentRows(member, ctx) : personRows(member, ctx);
    }
  })();
  return groups.filter((group) => group.rows.length > 0);
}
