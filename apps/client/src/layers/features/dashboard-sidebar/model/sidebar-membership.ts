/**
 * Turning the sidebar's stored membership into what each section renders
 * (sidebar-groups, DOR-579 and DOR-580).
 *
 * `ui.sidebar` stores `SidebarItemRef`s, so a group can hold a room as well as
 * an agent. These functions are the one layer that decides which stored
 * reference belongs to which section, kept pure and out of `DashboardSidebar` so
 * the rules are unit-testable on their own and the component stays an
 * orchestrator.
 *
 * A few helpers stay agent-only on purpose: mute rendering and the collapsed
 * group's activity dot both read live *agent* session state, which a room has
 * none of.
 *
 * @module features/dashboard-sidebar/model/sidebar-membership
 */
import type { SidebarGroup, SidebarItemRef, SidebarPrefs } from '@dorkos/shared/config-schema';
import { evaluateSmartGroup, type SmartGroupCandidate } from '@dorkos/shared/smart-groups';
import { lookupSidebarItems, type SidebarItem, type SidebarItemIndex } from './sidebar-item';

/**
 * The agent `projectPath`s in a reference list, in order.
 *
 * @param refs - A stored membership list.
 * @param known - When given, paths outside it are dropped — stale membership is
 *   filtered at render, never pruned on write, so an agent that comes back finds
 *   its group intact.
 */
export function agentPathsOf(
  refs: readonly SidebarItemRef[],
  known?: ReadonlySet<string>
): string[] {
  return refs.flatMap((ref) =>
    ref.kind === 'agent' && (known === undefined || known.has(ref.path)) ? [ref.path] : []
  );
}

/**
 * Agent paths muted individually (`ui.sidebar.muted`), which is what a section's
 * filter and its rollup dot read.
 *
 * @param prefs - Current sidebar prefs.
 */
export function individuallyMutedAgentPaths(prefs: SidebarPrefs): Set<string> {
  return new Set(agentPathsOf(prefs.muted));
}

/**
 * The room ids in a reference list, in order.
 *
 * @param refs - A stored membership list.
 */
export function roomIdsOf(refs: readonly SidebarItemRef[]): string[] {
  return refs.flatMap((ref) => (ref.kind === 'room' ? [ref.roomId] : []));
}

/**
 * Agent paths that RENDER as muted: individually muted, or a member of a muted
 * group.
 *
 * Wider than {@link individuallyMutedAgentPaths} on purpose, and computed once so
 * every appearance of an agent — its home row and a pinned copy — renders
 * identically ("one agent, one mute state"). Group mute stays a pure lens: this
 * set is derived on read and never written back into `ui.sidebar.muted`, so
 * unmuting a group restores whatever individual state each member had.
 *
 * @param prefs - Current sidebar prefs.
 * @param individuallyMuted - The narrower set, passed in so both share one
 *   derivation rather than recomputing it.
 */
export function effectiveMutedAgentPaths(
  prefs: SidebarPrefs,
  individuallyMuted: ReadonlySet<string>
): Set<string> {
  const set = new Set(individuallyMuted);
  for (const group of prefs.groups) {
    if (!group.muted) continue;
    for (const path of agentPathsOf(group.items)) set.add(path);
  }
  return set;
}

/**
 * Agent paths that live in some group, and so are NOT shown in the ungrouped
 * "Agents" section.
 *
 * Multi-presence is structural: a smart group's own `items` stays `[]` until a
 * "Convert to manual group", so smart groups never contribute here — a
 * rule-matched agent still appears in its manual group or the ungrouped list.
 *
 * @param prefs - Current sidebar prefs.
 * @param known - The current roster; membership outside it is ignored.
 */
export function groupedAgentPaths(prefs: SidebarPrefs, known: ReadonlySet<string>): Set<string> {
  const set = new Set<string>();
  for (const group of prefs.groups) {
    // Enforce the invariant the TSDoc above states: a smart group's stored
    // items are ignored (config-schema says so too). A ref that leaked in —
    // the pre-DOR-581 move-to menu allowed it — must not hide the row from
    // its home section while nothing draws it.
    if (group.kind === 'smart') continue;
    for (const path of agentPathsOf(group.items, known)) set.add(path);
  }
  return set;
}

/**
 * Room ids that live in some group, and so are NOT shown in the "Channels" or
 * "Direct messages" sections.
 *
 * The agent-side twin of this ({@link groupedAgentPaths}) filters by the known
 * roster; this one does not need to, because a stored id nothing answers to
 * excludes nothing from a list it is not in anyway.
 *
 * @param prefs - Current sidebar prefs.
 */
export function groupedRoomIds(prefs: SidebarPrefs): Set<string> {
  const set = new Set<string>();
  for (const group of prefs.groups) {
    // Same invariant as groupedAgentPaths: smart items are ignored, so a
    // leaked ref cannot strand a room out of every visible list.
    if (group.kind === 'smart') continue;
    for (const roomId of roomIdsOf(group.items)) set.add(roomId);
  }
  return set;
}

/**
 * Each group's renderable members as view-model items, keyed by group id.
 *
 * A manual group contributes its stored members — agents and rooms interleaved,
 * in the stored order. A smart group (DOR-338) contributes its rule-derived
 * members instead, since its stored list is the convert-to-manual
 * materialization target rather than live membership; every smart-group rule is
 * an agent attribute, so a smart group can only ever hold agents.
 *
 * @param prefs - Current sidebar prefs.
 * @param index - The current item index; stale stored membership drops out.
 * @param smartMembers - Rule-derived member paths per smart group id.
 */
export function groupMemberItems(
  prefs: SidebarPrefs,
  index: SidebarItemIndex,
  smartMembers: ReadonlyMap<string, string[]>
): Map<string, SidebarItem[]> {
  const map = new Map<string, SidebarItem[]>();
  for (const group of prefs.groups) {
    const refs: SidebarItemRef[] =
      group.kind === 'smart'
        ? (smartMembers.get(group.id) ?? []).map((path) => ({ kind: 'agent', path }))
        : group.items;
    map.set(group.id, lookupSidebarItems(index, refs));
  }
  return map;
}

/**
 * The agent paths stored on one group, unfiltered by the roster.
 *
 * The collapsed-group activity dot subscribes across these: an unknown path
 * simply never matches, and keeping it in means the subscription does not
 * change shape as agents come and go.
 *
 * @param group - The group to read.
 */
export function storedAgentPaths(group: SidebarGroup): string[] {
  return agentPathsOf(group.items);
}

/**
 * Rule-derived membership for every smart group, keyed by group id
 * (smart-agent-groups, DOR-338).
 *
 * Membership is evaluated live and never persisted, so a smart group's stored
 * `items` stays empty until someone converts it to a manual group. Manual
 * groups are absent from the result — they own their membership.
 *
 * @param prefs - Current sidebar prefs.
 * @param candidates - The fleet, as the rules see it.
 * @param now - Evaluation instant, passed in so the caller owns the clock and
 *   this stays pure.
 */
export function evaluateSmartGroups(
  prefs: SidebarPrefs,
  candidates: SmartGroupCandidate[],
  now: number
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of prefs.groups) {
    if (group.kind !== 'smart' || !group.rules) continue;
    map.set(group.id, evaluateSmartGroup(group.rules, candidates, now));
  }
  return map;
}
