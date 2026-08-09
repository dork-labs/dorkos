/**
 * What mute does to a row, and where a muted row is not allowed to appear
 * (BC-40, design-decisions §18).
 *
 * @module features/dashboard-sidebar/model/rules/apply-mute-rules
 */
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarModelPrefs } from '../sidebar-state';

/** Every target key the operator has muted, individually or through a group. */
export interface MuteIndex {
  /** Muted agent `projectPath`s. */
  agents: ReadonlySet<string>;
  /** Muted room ids. */
  rooms: ReadonlySet<string>;
}

/**
 * Which targets are muted, reading both the individual list and every muted
 * group's membership.
 *
 * **Group mute is a lens, never a write.** A muted group dims its members while
 * it is muted and gives each of them its own state back when it is not, which
 * only works if membership is resolved on read. A smart group's stored `items`
 * are ignored here for the same reason `groupedAgentPaths` ignores them: they
 * are a convert-to-manual target, not live membership.
 *
 * @param prefs - The operator's stored sidebar preferences.
 */
export function muteIndex(prefs: SidebarModelPrefs): MuteIndex {
  const agents = new Set<string>();
  const rooms = new Set<string>();
  const add = (refs: readonly SidebarItemRef[]) => {
    for (const ref of refs) {
      if (ref.kind === 'agent') agents.add(ref.path);
      else rooms.add(ref.roomId);
    }
  };
  add(prefs.muted);
  for (const group of prefs.groups) {
    if (!group.muted || group.kind === 'smart') continue;
    add(group.items);
  }
  return { agents, rooms };
}

/**
 * Whether one row's target is muted.
 *
 * A session inherits its agent's mute: muting an agent means "this teammate is
 * quiet for now", and a conversation with it that kept shouting would make the
 * setting a lie.
 *
 * @param row - The row to test.
 * @param index - The resolved mute sets.
 */
export function isMuted(row: SidebarRowModel, index: MuteIndex): boolean {
  const { target } = row;
  if (target.kind === 'agent') return index.agents.has(target.path);
  if (target.kind === 'room') return index.rooms.has(target.roomId);
  if (target.kind === 'session') return index.agents.has(target.agentPath);
  return false;
}

/** How {@link applyMuteRules} should treat a muted row. */
export interface ApplyMuteOptions {
  /**
   * Whether a muted row is dropped rather than dimmed. True in Today, where
   * mute means Today-ineligible; false in Library, where a muted row keeps its
   * place in the structure the operator built.
   */
  dropMuted: boolean;
  /** A row key exempt from the drop — the anchor, which is where the operator is. */
  exemptKey?: string;
}

/**
 * Mark, quieten, and (in Today) remove muted rows.
 *
 * Mute kills bold and the badge and takes the row out of Today. The one
 * exception is an @mention of the operator, which still renders its numbered
 * badge — {@link deriveUnreadSignal} has already applied that, so this rule
 * only has to set the flag and decide about Today.
 *
 * The anchor is exempt from the drop. Being inside a conversation you muted is
 * an ordinary thing to do, and a sidebar that refuses to show you where you are
 * standing has confused a preference for a rule.
 *
 * @param rows - Rows to filter, already carrying their unread state.
 * @param index - The resolved mute sets.
 * @param options - Whether muted rows are dropped, and what is exempt.
 */
export function applyMuteRules(
  rows: readonly SidebarRowModel[],
  index: MuteIndex,
  options: ApplyMuteOptions
): SidebarRowModel[] {
  const out: SidebarRowModel[] = [];
  for (const row of rows) {
    const muted = isMuted(row, index);
    if (muted && options.dropMuted && row.key !== options.exemptKey) continue;
    out.push(muted === row.muted ? row : { ...row, muted });
  }
  return out;
}
