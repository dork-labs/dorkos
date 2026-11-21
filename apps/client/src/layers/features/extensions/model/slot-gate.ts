/**
 * The check every registration passes through: an app shows only in the
 * places DorkOS's record of it allows (`allowedSlots`, DOR-4282), which the
 * server reads from the person's stored approval, never from the manifest.
 * Anything else is refused with a console warning and drawn nowhere.
 *
 * Two refusals, told apart:
 *
 * - A place the manifest declares that a person has not allowed yet: it
 *   waits for them while the rest of the app runs. Nothing is noted; the
 *   Inbox asks about it.
 * - A place the manifest does not declare: noted for the app's Settings row,
 *   which asks its maker to update it.
 *
 * A place may be allowed without being declared only for an app approved
 * before places were recorded (the server's grace), and only for
 * `GRACE_CONTRIBUTION_KEYS`, so no record can grant ⌘K, dialogs or the rest
 * that way.
 *
 * @module features/extensions/model/slot-gate
 */
import {
  GRACE_CONTRIBUTION_KEYS,
  declaresContribution,
  type ExtensionContributionKey,
} from '@dorkos/extension-api';
import { noteUndeclaredSlot } from '@/layers/shared/lib/extension-undeclared-slots';

/** The part of an app's record the gate reads. */
export interface DeclaredPlaces {
  /** The manifest's `contributions` map, from DorkOS's records. */
  contributions?: Record<string, boolean>;
  /** The places DorkOS allows it now, from its record. Absent allows none. */
  allowedSlots?: readonly string[];
}

/** Whether DorkOS's record lets the app show in this place now. */
function isAllowed(places: DeclaredPlaces | undefined, key: ExtensionContributionKey): boolean {
  if (!(places?.allowedSlots ?? []).includes(key)) return false;
  return (
    declaresContribution(places, key) ||
    (GRACE_CONTRIBUTION_KEYS as readonly string[]).includes(key)
  );
}

/**
 * A gate for one app: `allows(key, call)` is `true` when DorkOS's record
 * allows `key`, and otherwise warns, notes an undeclared place and returns
 * `false`.
 *
 * @param extId - The app's id.
 * @param manifest - Its `contributions` and `allowedSlots` as DorkOS
 *   recorded them. Without `allowedSlots`, every place is refused.
 */
export function createSlotGate(
  extId: string,
  manifest: DeclaredPlaces | undefined
): (key: ExtensionContributionKey, call: string) => boolean {
  return (key, call) => {
    if (isAllowed(manifest, key)) return true;
    if (declaresContribution(manifest, key)) {
      console.warn(
        `[extensions] ${extId}: ${call} was refused because a person has not allowed ` +
          `"${key}" for this app yet. Nothing was added.`
      );
      return false;
    }
    console.warn(
      `[extensions] ${extId}: ${call} was refused because extension.json does not declare ` +
        `contributions["${key}"]: true. Nothing was added.`
    );
    noteUndeclaredSlot(extId, key);
    return false;
  };
}
