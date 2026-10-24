/**
 * The small vocabulary every rule shares: what a row's key is, and when two
 * targets are the same place.
 *
 * Not a rule — spellings that would otherwise be repeated in several files and
 * drift in one of them.
 *
 * @module features/dashboard-sidebar/model/rules/targets
 */
import type { SidebarTarget } from '../build-sidebar-model';

/**
 * A row's stable key: `${target.kind}:${id}`.
 *
 * Two rows may not share a key: they would collide as React children, and —
 * because the active row is found by key — opening one would tint both.
 *
 * @param target - What the row points at.
 */
export function rowKey(target: SidebarTarget): string {
  switch (target.kind) {
    case 'session':
      return `session:${target.sessionId}`;
    case 'room':
      return `room:${target.roomId}`;
    case 'agent':
      return `agent:${target.path}`;
    case 'command':
      return `command:${target.commandId}`;
    case 'add-on':
      // The page's own contribution id after the prefix, so one page is one
      // key however many places draw it.
      return `add-on:${target.extensionId}:${target.path}`;
  }
}

/**
 * Whether two targets name the same row — compared through the key, so a
 * room's kind or a session's directory can never make one place two.
 *
 * @param a - A row's target.
 * @param b - What is open, or `null`.
 */
export function sameTarget(a: SidebarTarget, b: SidebarTarget | null): boolean {
  return b !== null && rowKey(a) === rowKey(b);
}
