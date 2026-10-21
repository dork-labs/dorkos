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
import type { MemberRoom, TeamMember } from '@dorkos/shared/team-schemas';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import type { AgentLevelResponse } from '@dorkos/shared/permissions';
import { shortenHomePath } from '@/layers/shared/lib';
import { roomDisplayTitle } from '@/layers/entities/room';
import { formatRuntimeIdentity } from '@/layers/entities/runtime';
import type { ProfilePageId } from '../model/profile-stack';
import type { ProfileRelationship } from './profile-relationship';
import { nextCheckMeta, wakeRowValue } from './heartbeat-words';
import { levelRow } from './profile-level-row';

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
  /**
   * What a screen reader hears instead of the label, when the label alone is
   * ambiguous on a screen that has another control of the same name. It must
   * contain the visible label (WCAG 2.5.3, label in name).
   */
  accessibleLabel?: string;
  /** The right-hand value, or `null` when the row has nothing to show yet. */
  value: string | null;
  /** Dimmed trailing detail — "last 2 h", "next 9:00". */
  meta?: string;
  /** Where a `nav` row goes. */
  page?: ProfilePageId;
  /** Which popover a `pick` row opens. */
  pick?: 'runs-on' | 'personality' | 'reports-to';
  /** What a `copy` row puts on the clipboard. */
  copyValue?: string;
  /** Why a `locked` row is locked. Shown on hover and read out via `aria-describedby`. */
  lockedReason?: string;
  /** Faces drawn before the value — the Manages row's stack. */
  faces?: TeamMember[];
  /** Muted words after the value — "held there by you". */
  valueNote?: string;
  /** What a pointer resting on the row reads, for a fact the value cannot fit. */
  hint?: string;
  /** `attention`: the one tinted row, drawn only while something waits on a person. */
  tone?: 'attention';
}

/** The three folds an agent's profile keeps its less-read rows in. */
export type ProfileFoldId = 'work' | 'setup' | 'files';

/** What a folded group shows while it is closed. */
export interface ProfileFold {
  /** Which fold, and the key its open state is remembered under. */
  id: ProfileFoldId;
  /** The header's title. */
  title: string;
  /** One line of what is inside, or `null` when nothing in it is known yet. */
  summary: string | null;
}

/**
 * A block of rows, separated from its neighbours by space rather than a label.
 * A group with a `fold` is drawn collapsed under a header until opened.
 */
export interface ProfileRowGroup {
  /** Stable within a profile — the React key. */
  id: string;
  rows: ProfileRowModel[];
  /** Present on a folded group (Work, Setup, Files). */
  fold?: ProfileFold;
}

/** Rooms this identity is in, as the row wants them (W1.2's `useMemberRooms`). */
export interface ProfileRoomsSummary {
  /** How many rooms. */
  count: number;
  /** The rooms themselves, in the order the endpoint returned them. */
  rooms: Array<Pick<MemberRoom, 'name' | 'slug' | 'kind'>>;
}

/** How much of an agent's own work the rows can name (`useManagedAgentFacts`). */
export interface ProfileAgentFacts {
  /** How many conversations, and when the newest one moved. `null` while unknown. */
  sessions: { count: number; newestAt: string | null } | null;
  /** How many schedules this agent has, and when the next one fires. */
  tasks: { count: number; nextRunAt: string | null } | null;
  /**
   * Every skill this agent's folder holds — the harness status's own count,
   * read from cache. `null` until the Skills page has filled it, which is the
   * honest middle state between a lie and the truth (Decision 28).
   */
  skills: number | null;
  /** Enabled managed MCP servers. */
  tools: number | null;
  /**
   * What this agent's traits currently add up to — a preset's name, or
   * "Custom" once they have been tuned off one.
   */
  personality: string | null;
  /**
   * Whether this install has tasks at all.
   *
   * False when the server has the tasks tool switched off, and then the Tasks
   * row is **not drawn** — not drawn empty, and not drawn locked. A row that
   * pushes a page explaining that the feature does not exist is a row about
   * DorkOS rather than about this agent.
   */
  tasksAvailable: boolean;
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
  /** What this agent has been doing, when the profile has asked. */
  facts?: ProfileAgentFacts;
  /**
   * Who this agent reports to, in the row's words ("You (default)"), or `null`
   * while its manifest is still being read (spec `heartbeats` §4.3).
   */
  reportsTo?: string | null;
  /**
   * This agent's open promises and how many are overdue, or `null` while
   * unknown. Read for every agent: anyone may read any agent's promises.
   */
  commitments?: ProfileCommitmentsSummary | null;
  /**
   * How this agent wakes on its own, or `null` while unknown. Read for every
   * agent: anyone may read any agent's heartbeat (spec `heartbeats` §7.6).
   */
  heartbeat?: Pick<HeartbeatStatus, 'enabled' | 'wake' | 'skippedReason' | 'nextBeatAt'> | null;
  /**
   * The level the agent actually runs at, or `null` while unknown. Read only
   * where the Permissions row is drawn (spec: same audience).
   */
  level?: AgentLevelResponse | null;
  /**
   * The moment "next in 12 min" is read from, as epoch ms. Passed in by a
   * ticking caller so the row moves with the clock; defaults to now.
   */
  now?: number;
  /**
   * Leave out the session's machinery: the model and account it runs on, and
   * how many chats it has (DOR-3075). Set beside a DM while Show sessions is
   * off, where the session behind the chat is not shown.
   */
  quietSessionDetail?: boolean;
}

/** The rows a DM keeps behind Show sessions: what it runs on, and its chats. */
const SESSION_DETAIL_ROWS = new Set(['runs-on', 'sessions']);

/** An agent's promises, as the Commitments row wants them. */
export interface ProfileCommitmentsSummary {
  /** Promises still open. */
  open: number;
  /** Open promises past their due date. */
  overdue: number;
}

/**
 * Why DorkBot's identity rows do not open.
 *
 * **Personality is deliberately NOT in this list.** Onboarding asks you to pick
 * DorkBot's voice on the first run and writes it, and the server's
 * `SYSTEM_PROTECTED_FIELDS` (`name`, `displayName`, `description`, `namespace`,
 * `isSystem`) never covered `traits` — so locking it here was the profile being
 * stricter than the product, and it broke a promise onboarding had already made.
 * What is genuinely fixed is who DorkBot IS: its name, its face and what it says
 * it does.
 */
const SYSTEM_LOCK_REASON = 'DorkBot’s name, face and description are part of DorkOS.';

/**
 * Why your email is not editable. It used to point at Settings › Login &
 * security, which has no such control (DOR-2964).
 */
const EMAIL_LOCK_REASON = 'Your email is how you sign in, so it stays fixed.';

/**
 * One room, written the way the rest of the cockpit writes it.
 *
 * `roomDisplayTitle` is the shared answer — a channel reads as its `#slug`,
 * which is the name people type and the one the server keeps unique, and
 * everything else reads as its title. This row used to prefix a `#` onto the
 * stored TITLE itself, which is a different string: a channel titled "Team
 * Standup" with slug `standup` read as `#Team Standup` here and `#standup`
 * everywhere else.
 */
function roomLabel(room: Pick<MemberRoom, 'name' | 'slug' | 'kind'>): string {
  return roomDisplayTitle({ kind: room.kind, slug: room.slug, title: room.name });
}

/** A room list as one value: the first two names, then how many more. */
function roomsValue(rooms: ProfileRoomsSummary | null | undefined): string | null {
  if (!rooms || rooms.count === 0) return null;
  const shown = rooms.rooms.slice(0, 2).map(roomLabel);
  const rest = rooms.count - shown.length;
  return rest > 0 ? `${shown.join(', ')}, +${rest}` : shown.join(', ');
}

/** "12 agents" / "1 agent" — the Manages row's value beside its face stack. */
function managesValue(count: number): string {
  return count === 1 ? '1 agent' : `${count} agents`;
}

/** A count, or `null` when nothing has answered yet — a row says nothing rather than "0" it invented. */
function countValue(count: number | null | undefined, one: string, many: string): string | null {
  if (count === null || count === undefined) return null;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** How long ago, in the two or three characters a row's trailing meta can carry. */
function lastWords(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return undefined;
  const elapsed = Math.max(0, Date.now() - then);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'last just now';
  if (minutes < 60) return `last ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last ${hours} h`;
  return `last ${Math.floor(hours / 24)} d`;
}

/** When the next run fires, as a clock time — or a weekday when it is not today. */
function nextWords(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return undefined;
  const today = new Date();
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  const clock = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return sameDay
    ? `next ${clock}`
    : `next ${when.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
}

/** A stored timestamp as a plain date, or `null` when it is not a date at all. */
function formatDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The Handle row: what people type after @, and the page that changes it. */
function handleRow(member: TeamMember): ProfileRowModel {
  return {
    id: 'handle',
    kind: 'nav',
    label: 'Handle',
    value: member.handle === null ? 'Add a handle' : `@${member.handle}`,
    page: 'handle',
  };
}

/** Your own rows: the four things about you, then the two lists you are in. */
function selfRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  return [
    {
      id: 'identity',
      rows: [
        { id: 'name', kind: 'nav', label: 'Name', value: member.displayName, page: 'name' },
        handleRow(member),
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

/**
 * The Commitments row: how many promises are open, and how many are overdue.
 * Drawn on every agent's profile, because anyone may read any agent's list.
 */
function commitmentsRow(ctx: ProfileRowsContext): ProfileRowModel {
  const summary = ctx.commitments;
  return {
    id: 'commitments',
    kind: 'nav',
    label: 'Commitments',
    value: countValue(summary?.open, 'open', 'open'),
    ...(summary && summary.overdue > 0 ? { meta: `${summary.overdue} overdue` } : {}),
    page: 'commitments',
  };
}

/**
 * The Heartbeat row: how this agent wakes, and when it next checks in. Drawn
 * on every agent's profile, like Commitments.
 */
function heartbeatRow(ctx: ProfileRowsContext): ProfileRowModel {
  const status = ctx.heartbeat;
  const meta =
    status?.enabled && status.wake === 'timed'
      ? nextCheckMeta(status.nextBeatAt, new Date(ctx.now ?? Date.now()))
      : undefined;
  return {
    id: 'heartbeat',
    kind: 'nav',
    label: 'Heartbeat',
    value: status ? wakeRowValue(status) : null,
    ...(meta ? { meta } : {}),
    page: 'heartbeat',
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

/**
 * The Needs you row, or nothing. Drawn only while a promise is overdue: a row
 * that says "nothing waiting" is noise on every profile where nothing is.
 */
function needsYouRows(ctx: ProfileRowsContext): ProfileRowModel[] {
  const overdue = ctx.commitments?.overdue ?? 0;
  if (overdue === 0) return [];
  return [
    {
      id: 'needs-you',
      kind: 'nav',
      label: 'Needs you',
      value: `${overdue} overdue`,
      tone: 'attention',
      page: 'commitments',
    },
  ];
}

/** The About row: what the agent says it does. */
function aboutRow(kind: 'nav' | 'text' | 'locked', ctx: ProfileRowsContext): ProfileRowModel {
  return {
    id: 'about',
    kind,
    label: 'About',
    value: ctx.description ?? null,
    ...(kind === 'nav' ? { page: 'about' as const } : {}),
    ...(kind === 'locked' ? { lockedReason: SYSTEM_LOCK_REASON } : {}),
  };
}

/** Summary parts that are known, joined; `null` when none is. */
function summaryOf(parts: Array<string | null | undefined>): string | null {
  const known = parts.filter((part): part is string => Boolean(part));
  return known.length > 0 ? known.join(' · ') : null;
}

/** A fold, wrapped around its rows. */
function fold(
  id: ProfileFoldId,
  title: string,
  rows: ProfileRowModel[],
  summary: string | null
): ProfileRowGroup {
  return { id, rows, fold: { id, title, summary } };
}

/**
 * Work: what this agent has been doing — its conversations, its schedules, its
 * promises, how it wakes, and every action on record.
 *
 * The same rows for an agent you manage and for DorkBot — what DorkBot
 * withholds is its identity, not its work.
 */
function workFold(ctx: ProfileRowsContext): ProfileRowGroup {
  const facts = ctx.facts;
  const tasksAvailable = facts?.tasksAvailable !== false;
  const rows: ProfileRowModel[] = [
    {
      id: 'sessions',
      kind: 'nav',
      label: 'Chats',
      value: countValue(facts?.sessions?.count, 'chat', 'chats'),
      meta: lastWords(facts?.sessions?.newestAt ?? null),
      page: 'sessions',
    },
  ];
  // Not "0 scheduled" and not a locked row: an install with the tasks tool off
  // has no such thing as a schedule, so there is nothing here to name (§1.4).
  if (tasksAvailable) {
    rows.push({
      id: 'tasks',
      kind: 'nav',
      label: 'Schedules',
      value: countValue(facts?.tasks?.count, 'scheduled', 'scheduled'),
      meta: nextWords(facts?.tasks?.nextRunAt ?? null),
      page: 'tasks',
    });
  }
  rows.push(commitmentsRow(ctx));
  rows.push(heartbeatRow(ctx));
  // What it did, and what was done to it, from the audit log. No value: a count
  // of every recorded action is a number nobody acts on.
  rows.push({ id: 'activity', kind: 'nav', label: 'Activity', value: null, page: 'activity' });
  return fold(
    'work',
    'Work',
    rows,
    summaryOf([
      // Beside a DM with Show sessions off, the Chats row is left out, so its
      // count is too.
      ctx.quietSessionDetail ? null : countValue(facts?.sessions?.count, 'chat', 'chats'),
      tasksAvailable ? countValue(facts?.tasks?.count, 'schedule', 'schedules') : null,
      ctx.commitments ? `${ctx.commitments.open} open` : null,
    ])
  );
}

/** The Personality row: a picker on every agent whose voice is yours to set. */
function personalityRow(ctx: ProfileRowsContext): ProfileRowModel {
  return {
    id: 'personality',
    kind: 'pick',
    label: 'Personality',
    // A control that makes you open it to find out what it is set to is worse
    // than the fact it replaced.
    value: ctx.facts?.personality ?? null,
    pick: 'personality',
  };
}

/** The Setup fold's summary: the personality, then how many servers. */
function setupSummary(ctx: ProfileRowsContext): string | null {
  const personality = ctx.facts?.personality;
  return summaryOf([
    personality ? `${personality} personality` : null,
    countValue(ctx.facts?.tools, 'server', 'servers'),
  ]);
}

/**
 * The rows every agent's Setup fold ends with: notifications, skills, servers
 * and permissions.
 */
function toolkitRows(ctx: ProfileRowsContext): ProfileRowModel[] {
  return [
    // No count on this one, deliberately: the number that would fit here —
    // unread — is a fleet-wide number the header bell already draws.
    {
      id: 'notifications',
      kind: 'nav',
      label: 'Notifications',
      value: null,
      page: 'notifications',
    },
    {
      id: 'skills',
      kind: 'nav',
      label: 'Skills',
      value: countValue(ctx.facts?.skills, 'skill', 'skills'),
      page: 'skills',
    },
    {
      id: 'tools',
      kind: 'nav',
      label: 'MCP servers',
      value: countValue(ctx.facts?.tools, 'server', 'servers'),
      page: 'tools',
    },
  ];
}

/** What this agent may do, where it differs from everyone (spec `agent-permissions`). */
const PERMISSIONS_ROW: ProfileRowModel = {
  id: 'permissions',
  kind: 'nav',
  label: 'Permissions',
  // The chat's status bar has its own "Permissions" control (the session's
  // permission mode), visible beside the docked profile.
  accessibleLabel: 'Agent permissions',
  value: null,
  page: 'permissions',
};

/**
 * An agent you manage: five rows always in view, then Work, Setup and Files,
 * folded. The row IS the control, all the way down; nothing is removed, only
 * folded.
 */
function managedAgentRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  const folder = member.agent?.projectPath;
  const setup: ProfileRowModel[] = [personalityRow(ctx)];
  if (folder) {
    setup.push({
      id: 'folder',
      kind: 'copy',
      label: 'Folder',
      value: shortenHomePath(folder),
      copyValue: folder,
    });
  }
  const [notifications, ...rest] = toolkitRows(ctx);
  setup.push(notifications!, ...rest);
  setup.push({
    id: 'connections',
    kind: 'nav',
    label: 'Connections',
    value: null,
    page: 'connections',
  });
  setup.push(PERMISSIONS_ROW);

  return [
    { id: 'needs-you', rows: needsYouRows(ctx) },
    {
      id: 'essentials',
      rows: [
        aboutRow('nav', ctx),
        {
          id: 'runs-on',
          kind: 'pick',
          label: 'Runs on',
          value: runsOnValue(member),
          pick: 'runs-on',
        },
        levelRow(ctx),
        // Who gets this agent's report and its escalations (spec `heartbeats` §4).
        {
          id: 'reports-to',
          kind: 'pick',
          label: 'Reports to',
          value: ctx.reportsTo ?? null,
          pick: 'reports-to',
        },
        roomsRow(ctx),
      ],
    },
    workFold(ctx),
    fold('setup', 'Setup', setup, setupSummary(ctx)),
    fold(
      'files',
      'Files',
      [
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
        // Beside the other two files, because it is one: the agent's own notes,
        // in markdown, in the same `.dork/` folder. No count — what an operator
        // wants from this row is the file.
        { id: 'memory', kind: 'nav', label: 'Memory', value: 'MEMORY.md', page: 'memory' },
      ],
      'SOUL.md · NOPE.md · MEMORY.md'
    ),
  ];
}

/**
 * Someone else's agent: what a teammate should see, and nothing else.
 *
 * Private is not the same as locked. A locked row says "you cannot change
 * this"; these rows are simply not theirs to read, so they are absent — no
 * sessions, no tools, no instructions, no level, and no lock icons implying a
 * door.
 */
function otherAgentRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  return [
    {
      id: 'essentials',
      rows: [
        aboutRow('text', ctx),
        { id: 'runs-on', kind: 'text', label: 'Runs on', value: runsOnValue(member) },
        roomsRow(ctx),
      ],
    },
    fold(
      'work',
      'Work',
      [commitmentsRow(ctx), heartbeatRow(ctx)],
      ctx.commitments ? `${ctx.commitments.open} open` : null
    ),
  ];
}

/**
 * DorkBot: the same frame as your own agent, with the identity rows locked.
 *
 * Locked, not hidden — the server answers 403 `SYSTEM_PROTECTED` on these, and
 * a row that explains itself is better than a control that fails after you use
 * it. The model still runs on your machine and stays yours to set, and so does
 * its voice: `personalityUpdate` puts the traits in the manifest AND
 * regenerates SOUL.md's trait block. Its permissions are a person's to set like
 * any agent's: it is the agent that most often needs Rooms.
 */
function systemAgentRows(member: TeamMember, ctx: ProfileRowsContext): ProfileRowGroup[] {
  return [
    { id: 'needs-you', rows: needsYouRows(ctx) },
    {
      id: 'essentials',
      rows: [
        aboutRow('locked', ctx),
        {
          id: 'runs-on',
          kind: 'pick',
          label: 'Runs on',
          value: runsOnValue(member),
          pick: 'runs-on',
        },
        levelRow(ctx),
        roomsRow(ctx),
      ],
    },
    workFold(ctx),
    fold(
      'setup',
      'Setup',
      [personalityRow(ctx), ...toolkitRows(ctx), PERMISSIONS_ROW],
      setupSummary(ctx)
    ),
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
  return groups
    .map((group) =>
      ctx.quietSessionDetail
        ? { ...group, rows: group.rows.filter((row) => !SESSION_DETAIL_ROWS.has(row.id)) }
        : group
    )
    .filter((group) => group.rows.length > 0);
}
