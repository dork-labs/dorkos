/**
 * Take something out of a section without taking it off the sidebar.
 *
 * Outside a section the sidebar draws an agent only once you have a direct
 * message with it or have pinned it (DOR-3092). So an agent you filed into a
 * section and never wrote to would vanish the moment it left — by a drag, by
 * "Remove from section", or with the whole section deleted. Every one of those
 * paths goes through here, which pins exactly the agents that would otherwise
 * vanish and leaves everything else as it was.
 *
 * @module entities/config/model/ungroup-keeping-in-reach
 */
import type { SidebarItemRef, SidebarPrefs } from '@dorkos/shared/config-schema';
import { deleteGroup, moveToGroup, pinItem } from './use-sidebar-prefs';

/** What leaves its section: one item, or every item in one section. */
export type UngroupTarget =
  { kind: 'item'; ref: SidebarItemRef } | { kind: 'section'; groupId: string };

/**
 * Whether an agent stays on the panel without a pin — it has a one-to-one
 * direct message, which Direct messages draws as the agent's row.
 */
export type HasDirectMessage = (agentPath: string) => boolean;

/**
 * Ungroup `target`, and pin any agent it releases that has no direct message.
 *
 * A smart section's stored `items` are not its members (rules are), so
 * deleting one pins nothing: nobody filed those agents there by hand.
 *
 * @param prev - Current prefs.
 * @param target - The item, or the whole section, leaving.
 * @param hasDirectMessage - Whether an agent is drawn without a pin.
 */
export function ungroupKeepingInReach(
  prev: SidebarPrefs,
  target: UngroupTarget,
  hasDirectMessage: HasDirectMessage
): SidebarPrefs {
  let released: readonly SidebarItemRef[];
  let next: SidebarPrefs;
  if (target.kind === 'item') {
    released = [target.ref];
    next = moveToGroup(prev, target.ref, null);
  } else {
    const group = prev.groups.find((entry) => entry.id === target.groupId);
    released = group === undefined || group.kind === 'smart' ? [] : group.items;
    next = deleteGroup(prev, target.groupId);
  }
  for (const ref of released) {
    if (ref.kind === 'agent' && !hasDirectMessage(ref.path)) next = pinItem(next, ref);
  }
  return next;
}
