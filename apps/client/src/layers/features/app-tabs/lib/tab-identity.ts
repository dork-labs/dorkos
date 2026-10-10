/**
 * A tab's identity: who or where it is, and whether it needs you (DOR-2820).
 *
 * The tab strip, a tab's hover card, the History menu and the window title all
 * name a page from nothing but its href. They used to work that out on their
 * own and drift: a chat tab read "Session" while the title bar named the
 * last-selected agent. So every one of them reads a {@link TabIdentity} now, and
 * this module is the one place an identity is built. Pure functions only: the
 * hook that gathers live data for an href is `model/use-tab-identity.ts`.
 *
 * @module features/app-tabs/lib/tab-identity
 */
import {
  Activity,
  Cable,
  FolderGit2,
  Hash,
  Inbox,
  LayoutDashboard,
  ListTodo,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Puzzle,
  Settings,
  Store,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { IdentityFace } from '@/layers/shared/lib';

/**
 * The one status a tab shows, hottest first. Idle is absent: a tab that needs
 * nothing from you shows nothing, so the marks that do appear mean something.
 */
export type TabStatus = 'needs-you' | 'failed' | 'paused' | 'working' | 'new';

/** How a tab draws its glyph. */
export type TabIcon =
  /** An agent's emoji, in its colour when known. */
  | { kind: 'emoji'; emoji: string; color?: string }
  /** A person or agent disc: a DM, an open profile. */
  | { kind: 'face'; face: IdentityFace }
  /** The route's own icon. */
  | { kind: 'route'; Icon: LucideIcon }
  /**
   * An extension's own icon. `unknown` because it is the extension's value:
   * draw it through `ContributedIcon`, which checks it.
   */
  | { kind: 'extension'; icon: unknown };

/** Everything a tab says about the page it points at. */
export interface TabIdentity {
  /** The glyph. */
  icon: TabIcon;
  /** The name: "Scout", "#general", "Schedules". */
  primary: string;
  /** What follows the name: a chat title, "3 working", a Settings section. */
  secondary?: string;
  /** At most one status; absent when idle. */
  status?: TabStatus;
  /** One plain sentence for the hover card and screen readers. */
  statusSentence?: string;
  /** An unread, needs-you or waiting count. */
  count?: number;
  /** Whether the count is aimed at you (a DM, an @mention, something waiting). */
  countEmphasis?: boolean;
  /** When the page last had activity, epoch ms: "Last active 2m ago". */
  lastActiveAt?: number;
  /**
   * Where a chat came from ("Started from #general"). A seam for spin-off
   * chats (DOR-2790); nothing sets it yet.
   */
  origin?: string;
  /**
   * For a chat tab, which agent it is with. Two open tabs sharing one collapse
   * the agent to its emoji so they can be told apart (see {@link tabLabel}).
   */
  agentKey?: string;
  /** The name a screen reader announces: name, then the status sentence. */
  accessibleName: string;
}

/** A tab identity before its accessible name is spelled out. */
type IdentityParts = Omit<TabIdentity, 'accessibleName'>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The raw facts a status is picked from. Any can be true at once. */
export interface TabStatusSignals {
  /** A pending approval or question. */
  needsYou?: boolean;
  /** The last turn failed. */
  failed?: boolean;
  /** Out of usage, waiting for the reset. */
  paused?: boolean;
  /** A turn is streaming. */
  working?: boolean;
  /** Finished while you were away, not seen yet. */
  unseen?: boolean;
}

/**
 * The status a tab shows when several are true. This order lives here and
 * nowhere else, pinned by a table test:
 *
 * 1. **needs-you**: something is blocked on you.
 * 2. **failed**: the last turn failed.
 * 3. **paused**: out of usage.
 * 4. **working**: streaming.
 * 5. **new**: finished while you were away.
 *
 * @param signals - What is true about the page right now.
 * @returns The one status to show, or `undefined` for idle.
 */
export function pickTabStatus(signals: TabStatusSignals): TabStatus | undefined {
  if (signals.needsYou) return 'needs-you';
  if (signals.failed) return 'failed';
  if (signals.paused) return 'paused';
  if (signals.working) return 'working';
  if (signals.unseen) return 'new';
  return undefined;
}

/** The bare word for each status, the floor every sentence falls back to. */
export const TAB_STATUS_WORD: Record<TabStatus, string> = {
  'needs-you': 'Needs you',
  failed: 'Failed',
  paused: 'Paused',
  working: 'Working',
  new: 'New',
};

/** What a chat that needs you is waiting for, when the stores know. */
export type NeedsYouDetail = { kind: 'approval'; toolName?: string } | { kind: 'question' };

/** What the stores know beyond the status itself, for its sentence. */
export interface TabStatusDetail {
  /** The pending prompt, for `needs-you`. */
  needsYou?: NeedsYouDetail;
  /** When usage comes back, already written for people ("3:40 PM"), for `paused`. */
  resetsAt?: string | null;
  /** What the agent is doing, lower case ("running tests"), for `working`. */
  activity?: string | null;
}

/**
 * One plain sentence for a status: what the hover card says and what a screen
 * reader hears after the name. Falls back to the bare status word when nothing
 * more is known, and never guesses.
 *
 * @param status - The status to describe.
 * @param detail - Whatever the stores know beyond it.
 */
export function tabStatusSentence(status: TabStatus, detail: TabStatusDetail = {}): string {
  switch (status) {
    case 'needs-you': {
      const ask = detail.needsYou;
      if (ask?.kind === 'question') return 'Waiting for your answer';
      if (ask?.kind === 'approval') {
        return ask.toolName ? `Waiting for your OK to run ${ask.toolName}` : 'Waiting for your OK';
      }
      return TAB_STATUS_WORD['needs-you'];
    }
    case 'failed':
      return 'The last reply failed';
    case 'paused':
      return detail.resetsAt ? `Out of usage until ${detail.resetsAt}` : 'Out of usage';
    case 'working':
      return detail.activity ? `Working: ${detail.activity}` : TAB_STATUS_WORD.working;
    case 'new':
      return 'Finished while you were away';
  }
}

/**
 * Join a tab's name and status into what a screen reader announces:
 * "Scout, Fix the login bug, Needs you: Waiting for your answer".
 *
 * @param parts - The identity, without its accessible name.
 */
function spellAccessibleName(parts: IdentityParts): string {
  const words = [parts.primary];
  if (parts.secondary) words.push(parts.secondary);
  const sentence = parts.statusSentence;
  if (parts.status) {
    const word = TAB_STATUS_WORD[parts.status];
    // A sentence that already opens with the word ("Working: running tests")
    // or IS the word must not say it twice.
    words.push(
      !sentence || sentence.startsWith(word) ? (sentence ?? word) : `${word}: ${sentence}`
    );
  } else if (sentence) {
    words.push(sentence);
  }
  return words.join(', ');
}

/** Finish an identity: spell its accessible name from its parts. */
function identity(parts: IdentityParts): TabIdentity {
  return { ...parts, accessibleName: spellAccessibleName(parts) };
}

/** `1 room`, `3 rooms`. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Drop a zero or absent count, so an idle tab draws no badge. */
function positive(count: number | null | undefined): number | undefined {
  return count && count > 0 ? count : undefined;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** A route's own name and icon, before anything live is known. */
export interface RouteIdentity {
  /** The name a person would use for it. */
  primary: string;
  /** What follows the name, for a sub-page ("Marketplace · Sources"). */
  secondary?: string;
  /** Its icon, matching the sidebar nav where the sidebar has one. */
  Icon: LucideIcon;
}

/**
 * Every route the router serves, and what a tab on it is called before any
 * live data arrives. One map, so a name and an icon cannot drift apart: each
 * once missed `/channels` (DOR-587) and the icons missed two more routes
 * (DOR-919) while they lived in separate maps. The drift guard in
 * `__tests__/tab-identity.test.ts` checks it against `APP_ROUTE_PATHS`.
 *
 * @internal Exported for the drift guard and the Dev Playground.
 */
export const ROUTE_IDENTITY: Record<string, RouteIdentity> = {
  '/': { primary: 'Home', Icon: LayoutDashboard },
  '/activity': { primary: 'Activity', Icon: Activity },
  '/team': { primary: 'Team', Icon: Users },
  // The alias, named for where it lands: a tab saved before the rename still
  // restores as `/agents`, and "Agents" on a strip whose page says Team looks stale.
  '/agents': { primary: 'Team', Icon: Users },
  // Plural on purpose: a chat's single bubble is taken, and two tabs that
  // read alike should at least not look alike (DOR-587 review).
  '/channels': { primary: 'Channels', Icon: MessagesSquare },
  '/connections': { primary: 'Connections', Icon: Cable },
  // What the help menu calls it: the person's own reports (DOR-2232).
  '/feedback-requests': { primary: 'Your reports', Icon: Inbox },
  '/marketplace': { primary: 'Marketplace', Icon: Store },
  '/marketplace/sources': { primary: 'Marketplace', secondary: 'Sources', Icon: Store },
  // A chat is named after its agent once that resolves; this is the floor.
  '/session': { primary: 'Chat', Icon: MessageSquare },
  '/tasks': { primary: 'Schedules', Icon: ListTodo },
  '/workspaces': { primary: 'Workspaces', Icon: FolderGit2 },
};

/** The name of a route nobody told the strip about (a future route, a typo). */
const UNKNOWN_ROUTE: RouteIdentity = { primary: 'DorkOS', Icon: LayoutDashboard };

/**
 * A status or count a page reports for its own tab — the seam Schedules,
 * Activity, Connections and extension pages fill (DOR-2820 PR C).
 */
export interface RouteBadge {
  /** The page's status, when it has one. */
  status?: TabStatus;
  /** A count to show, when it has one. */
  count?: number;
  /** One plain sentence about it. */
  sentence?: string;
}

/**
 * A tab on a route that is named only by its route: Schedules, Workspaces,
 * Your reports. Takes the page's own badge when it reports one.
 *
 * @param pathname - The route path.
 * @param badge - What the page reports for its tab, when anything.
 */
export function routeTabIdentity(pathname: string, badge?: RouteBadge | null): TabIdentity {
  const route = ROUTE_IDENTITY[pathname] ?? UNKNOWN_ROUTE;
  const status = badge?.status;
  return identity({
    icon: { kind: 'route', Icon: route.Icon },
    primary: route.primary,
    secondary: route.secondary,
    status,
    statusSentence: badge?.sentence ?? (status ? tabStatusSentence(status) : undefined),
    count: positive(badge?.count),
    countEmphasis: status === 'needs-you' || status === 'failed',
  });
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

/** What is known about a chat tab. */
export interface ChatTabInput {
  /** The agent's display name, once its manifest resolves. */
  agentName?: string | null;
  /** The chat's project folder name, the floor before the agent resolves. */
  projectName?: string | null;
  /** The agent's emoji and colour, once known. */
  visual?: { emoji: string; color?: string } | null;
  /** The chat's own title, once its row resolves. */
  chatTitle?: string | null;
  /** Which agent the chat is with (its id, else its folder). */
  agentKey?: string | null;
  /** The live status facts. */
  signals?: TabStatusSignals;
  /** What the stores know beyond them. */
  detail?: TabStatusDetail;
  /** When the chat last changed, epoch ms. */
  lastActiveAt?: number;
}

/**
 * A chat tab: **Agent** · chat title, in the agent's emoji, wearing the chat's
 * status. Says "Chat", never "Session", until anything about it is known.
 *
 * @param input - What is known about the chat.
 */
export function chatTabIdentity(input: ChatTabInput): TabIdentity {
  const status = pickTabStatus(input.signals ?? {});
  return identity({
    icon: input.visual
      ? { kind: 'emoji', emoji: input.visual.emoji, color: input.visual.color }
      : { kind: 'route', Icon: MessageSquare },
    primary: input.agentName || input.projectName || ROUTE_IDENTITY['/session']!.primary,
    secondary: input.chatTitle || undefined,
    status,
    statusSentence: status ? tabStatusSentence(status, input.detail) : undefined,
    lastActiveAt: input.lastActiveAt,
    agentKey: input.agentKey ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** What is known about a channel or DM tab. */
export interface RoomTabInput {
  /** Channel or direct message. */
  kind: 'channel' | 'dm';
  /** The room, written the way it is spoken: `#general`, or a DM's title. */
  title: string;
  /** Messages above your read cursor; `null` when you are not a member. */
  unreadCount?: number | null;
  /** Times you are @mentioned above your cursor, when known. */
  mentionCount?: number;
  /** For a DM, the face of whoever it is with. */
  face?: IdentityFace | null;
  /** When the room last had activity, epoch ms. */
  lastActiveAt?: number;
}

/**
 * A channel tab (`#general`) or a DM tab (the person or agent it is with),
 * with its unread count. A DM is aimed at you by nature, and so is a
 * mention of you: either makes the count read as urgent, the sidebar's rule
 * (BC-40).
 *
 * @param input - What is known about the room.
 */
export function roomTabIdentity(input: RoomTabInput): TabIdentity {
  const unread = positive(input.unreadCount);
  const mentions = positive(input.mentionCount);
  const count = mentions !== undefined ? Math.max(mentions, unread ?? 0) : unread;
  const icon: TabIcon =
    input.kind === 'dm'
      ? input.face
        ? { kind: 'face', face: input.face }
        : { kind: 'route', Icon: MessageCircle }
      : { kind: 'route', Icon: Hash };
  return identity({
    icon,
    primary: input.title,
    count,
    countEmphasis: count !== undefined && (input.kind === 'dm' || mentions !== undefined),
    statusSentence:
      mentions !== undefined
        ? plural(mentions, 'mention of you', 'mentions of you')
        : unread !== undefined
          ? plural(unread, 'unread message', 'unread messages')
          : undefined,
    lastActiveAt: input.lastActiveAt,
  });
}

/**
 * `/channels` with no room picked: how many rooms hold unread messages.
 *
 * @param unreadRooms - Rooms with unread entries (rooms, not messages).
 */
export function channelsTabIdentity(unreadRooms: number): TabIdentity {
  const count = positive(unreadRooms);
  return identity({
    icon: { kind: 'route', Icon: ROUTE_IDENTITY['/channels']!.Icon },
    primary: ROUTE_IDENTITY['/channels']!.primary,
    count,
    statusSentence: count
      ? plural(count, 'room has new messages', 'rooms have new messages')
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Home and Team
// ---------------------------------------------------------------------------

/**
 * Home, with how many things are waiting on you.
 *
 * @param needsYouCount - Items waiting on a person, the Inbox's count.
 */
export function homeTabIdentity(needsYouCount: number): TabIdentity {
  const count = positive(needsYouCount);
  return identity({
    icon: { kind: 'route', Icon: ROUTE_IDENTITY['/']!.Icon },
    primary: ROUTE_IDENTITY['/']!.primary,
    status: count ? 'needs-you' : undefined,
    statusSentence: count
      ? plural(count, 'thing waiting on you', 'things waiting on you')
      : undefined,
    count,
    countEmphasis: count !== undefined,
  });
}

/** What the fleet is doing, for the Team tab. */
export interface TeamTabInput {
  /** Agents with a turn streaming right now. */
  workingCount: number;
  /** The fleet's live facts, folded across every agent. */
  signals: TabStatusSignals;
}

/**
 * Team · N working, wearing the hottest status across the fleet.
 *
 * @param pathname - `/team`, or its `/agents` alias.
 * @param input - What the fleet is doing.
 */
export function teamTabIdentity(pathname: string, input: TeamTabInput): TabIdentity {
  const route = ROUTE_IDENTITY[pathname] ?? ROUTE_IDENTITY['/team']!;
  const status = pickTabStatus(input.signals);
  const working = positive(input.workingCount);
  return identity({
    icon: { kind: 'route', Icon: route.Icon },
    primary: route.primary,
    secondary: working ? `${working} working` : undefined,
    status,
    statusSentence:
      status === 'needs-you'
        ? 'An agent is waiting on you'
        : status === 'failed'
          ? 'An agent’s last reply failed'
          : status === 'working'
            ? plural(input.workingCount, 'agent working', 'agents working')
            : undefined,
  });
}

// ---------------------------------------------------------------------------
// Overlays: the profile panel and the Settings dialog
// ---------------------------------------------------------------------------

/** What is known about the identity whose profile is open. */
export interface ProfileTabInput {
  /** Their display name, once the roster resolves. */
  name?: string | null;
  /** Their face, once the roster resolves. */
  face?: IdentityFace | null;
  /** For an agent, its live facts folded across its chats. */
  signals?: TabStatusSignals;
}

/**
 * The profile panel open over a page: **Name** · Profile. It is what the
 * person is looking at, so it names the tab while it is open.
 *
 * @param input - What is known about whose profile it is.
 */
export function profileTabIdentity(input: ProfileTabInput): TabIdentity {
  const status = pickTabStatus(input.signals ?? {});
  return identity({
    icon: input.face ? { kind: 'face', face: input.face } : { kind: 'route', Icon: Users },
    primary: input.name || 'Profile',
    secondary: input.name ? 'Profile' : undefined,
    status,
    statusSentence: status ? tabStatusSentence(status) : undefined,
  });
}

/**
 * The Settings dialog open over a page: Settings · the section, named as the
 * dialog's sidebar names it.
 *
 * @param section - The section's label, when it is one the strip knows.
 */
export function settingsTabIdentity(section?: string | null): TabIdentity {
  return identity({
    icon: { kind: 'route', Icon: Settings },
    primary: 'Settings',
    secondary: section || undefined,
  });
}

// ---------------------------------------------------------------------------
// Marketplace and extension pages
// ---------------------------------------------------------------------------

/** Where a person is in the Marketplace. */
export interface MarketplaceTabInput {
  /** `/marketplace` or `/marketplace/sources`. */
  pathname: string;
  /** The search box, when anything is typed. */
  query?: string | null;
  /** The package open in the detail sheet, when one is. */
  pkg?: string | null;
}

/**
 * Marketplace · what you are looking at: Sources, an open package, or a search.
 *
 * @param input - The Marketplace route and its search.
 */
export function marketplaceTabIdentity(input: MarketplaceTabInput): TabIdentity {
  const route = ROUTE_IDENTITY[input.pathname] ?? ROUTE_IDENTITY['/marketplace']!;
  const query = input.query?.trim();
  const secondary = route.secondary ?? (input.pkg || (query ? `“${query}”` : undefined));
  return identity({
    icon: { kind: 'route', Icon: route.Icon },
    primary: route.primary,
    secondary,
  });
}

/** The name an extension page shows before its extension registers it. */
export const EXTENSION_PAGE_FALLBACK_LABEL = 'Add-on';

/**
 * A page an extension registered (`/x/<ext>`): its own title and icon, or a
 * puzzle piece and "Add-on" while it is not registered (loading, or gone).
 *
 * @param page - What the extension registered, when it has.
 * @param badge - What the page reports for its tab, when anything.
 */
export function extensionTabIdentity(
  page: { title?: string; icon?: unknown } | null | undefined,
  badge?: RouteBadge | null
): TabIdentity {
  const status = badge?.status;
  return identity({
    icon: { kind: 'extension', icon: page?.icon ?? Puzzle },
    primary: page?.title || EXTENSION_PAGE_FALLBACK_LABEL,
    status,
    statusSentence: badge?.sentence ?? (status ? tabStatusSentence(status) : undefined),
    count: positive(badge?.count),
    countEmphasis: status === 'needs-you' || status === 'failed',
  });
}

// ---------------------------------------------------------------------------
// Display: smart names and the window title
// ---------------------------------------------------------------------------

/** The two halves of a tab's visible label. */
export interface TabLabel {
  /** The bold half. */
  lead: string;
  /** The quieter half after the `·`, when there is one. */
  trail?: string;
}

/**
 * What a tab shows. Normally the name, then what follows it. When another open
 * chat tab is with the same agent, the agent collapses to its emoji (the icon
 * already shows it) and the chat title leads, so the two can be told apart.
 * The hover card always has the full text.
 *
 * @param id - The tab's identity.
 * @param opts - `collapseAgent` when another open chat tab shares the agent.
 */
export function tabLabel(id: TabIdentity, opts: { collapseAgent?: boolean } = {}): TabLabel {
  if (collapsesAgent(id, opts)) return { lead: id.secondary! };
  return { lead: id.primary, trail: id.secondary };
}

/** Whether {@link tabLabel} leads with the chat title rather than the agent. */
function collapsesAgent(id: TabIdentity, opts: { collapseAgent?: boolean }): boolean {
  return Boolean(opts.collapseAgent && id.agentKey && id.secondary && id.icon.kind === 'emoji');
}

/**
 * What a screen reader announces for a tab: the identity's accessible name,
 * led by whatever the tab visibly leads with. When the chat title leads (see
 * {@link tabLabel}), it leads here too, then the agent, then the status.
 *
 * @param id - The tab's identity.
 * @param opts - `collapseAgent` when another open chat tab shares the agent.
 */
export function tabAccessibleName(id: TabIdentity, opts: { collapseAgent?: boolean } = {}): string {
  if (!collapsesAgent(id, opts)) return id.accessibleName;
  const head = `${id.primary}, ${id.secondary}`;
  return `${id.secondary}, ${id.primary}${id.accessibleName.slice(head.length)}`;
}

/** What every title ends with, so a pinned browser tab is still recognisably ours. */
const TITLE_SUFFIX = ' — DorkOS';

/** How long the part after the name may run in a title before it is cut. */
const MAX_TITLE_SECONDARY = 40;

/** The window's state, beside the identity of what it shows. */
export interface WindowTitleState {
  /** Whether the window is hidden (another tab, minimised). */
  hidden: boolean;
  /** Whether a reply finished while it was hidden. */
  unseenReply: boolean;
  /** Unread rooms plus waiting schedules, shown as `(N)` while hidden. */
  badgeCount: number;
  /** Whether anything in the app is blocked on you, beyond this page. */
  needsYou?: boolean;
}

/**
 * The browser and desktop window title:
 * `[(N) ][🔔 |🏁 ]primary[ · secondary] — DorkOS`.
 *
 * 🔔 when anything needs you; 🏁 when a reply finished while the window was
 * hidden. `(N)` only while hidden: a count you are looking at is noise. The
 * desktop app mirrors `document.title`, so its native title follows.
 *
 * @param id - The identity of the page on screen.
 * @param state - The window's state.
 */
export function windowTitle(id: TabIdentity, state: WindowTitleState): string {
  const badge = state.hidden && state.badgeCount > 0 ? `(${state.badgeCount}) ` : '';
  const flag = state.needsYou || id.status === 'needs-you' ? '🔔 ' : state.unseenReply ? '🏁 ' : '';
  const secondary =
    id.secondary && id.secondary.length > MAX_TITLE_SECONDARY
      ? `${id.secondary.slice(0, MAX_TITLE_SECONDARY)}…`
      : id.secondary;
  const name = secondary ? `${id.primary} · ${secondary}` : id.primary;
  return `${badge}${flag}${name}${TITLE_SUFFIX}`;
}
