/**
 * Wiring for tests about the approval card itself.
 *
 * Under Trusted, the default since ADR `261006-225605`, a destructive action
 * whose area is Allowed runs and is recorded, so `tasks_delete` and
 * `mesh_unregister` no longer raise a card on their own. A test about the card
 * (its hold, its expiry, the subject it names, the retry token) says so by
 * setting the actions it drives to Ask, the way a person would, and leaves
 * every other action exactly as Trusted has it.
 */
import { initPermissionGate } from '../permission-enforcement.js';

/**
 * Wire the permission gate to Trusted with the named actions set to Ask for
 * everyone. Undo it with `resetPermissionGate()`.
 *
 * @param actionIds - The capability ids or hand-registered tool names that should ask.
 */
export function askFor(...actionIds: string[]): void {
  initPermissionGate({
    readConfig: () => ({
      preset: 'trusted',
      defaults: {
        areas: {},
        actions: Object.fromEntries(actionIds.map((id) => [id, 'ask' as const])),
      },
    }),
  });
}
