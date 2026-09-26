/**
 * The small pieces every permission write shares: the refusal type, the Full
 * autonomy sentence, and the reads and writes of stored override maps that
 * never reach the prototype. Kept apart from the service so the Undo
 * (`permission-undo.ts`) and the service can both use them without importing
 * each other.
 *
 * @module services/core/permissions/permission-values
 */
import {
  PERMISSION_STATES,
  type AgentPermissions,
  type PermissionChangedMetadata,
  type PermissionState,
} from '@dorkos/shared/permissions';

import type { PermissionWriter } from './permission-history.js';

/** A permission write the service refused, with the HTTP status that fits it. */
export class PermissionError extends Error {
  /** Marks this class across module instances. */
  override readonly name = 'PermissionError';

  /**
   * Construct the refusal.
   *
   * @param code - Machine-readable refusal code.
   * @param message - One plain sentence a person can act on.
   * @param status - The HTTP status the route answers with.
   * @param details - Extra fields the route adds to the body (an Undo's conflicts).
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

/** The sentence a Full-autonomy write without an acknowledgement is refused with. */
export const AUTONOMY_ACK_MESSAGE =
  'Full autonomy lets agents edit files and run commands without asking. Confirm that in the ' +
  'app first, then try again.';

/**
 * True for a real state value.
 *
 * @param value - Anything read off a stored map.
 */
export function isState(value: unknown): value is PermissionState {
  return typeof value === 'string' && (PERMISSION_STATES as readonly string[]).includes(value);
}

/**
 * Drop empty maps so an agent with no overrides writes no `permissions` at all.
 *
 * @param permissions - The agent's overrides.
 * @returns The same overrides without empty maps, or `undefined` for none.
 */
export function compact(permissions: AgentPermissions): AgentPermissions | undefined {
  const areas = permissions.areas && Object.keys(permissions.areas).length > 0;
  const actions = permissions.actions && Object.keys(permissions.actions).length > 0;
  const next: AgentPermissions = {
    ...(areas ? { areas: permissions.areas } : {}),
    ...(actions ? { actions: permissions.actions } : {}),
    ...(permissions.filesAndCommands ? { filesAndCommands: permissions.filesAndCommands } : {}),
  };
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * An own-key read that never reaches the prototype.
 *
 * @param record - A stored map of states.
 * @param key - The area or action id.
 * @returns The state, or `null` for not set (or not a state).
 */
export function ownState(
  record: Record<string, unknown> | undefined,
  key: string
): PermissionState | null {
  if (!record || !Object.hasOwn(record, key)) return null;
  const value = record[key];
  return isState(value) ? value : null;
}

/** Who a setting DorkOS declined on arrival is recorded under. */
export const ARRIVAL_WRITER: PermissionWriter = {
  attribution: 'outside',
  actorType: 'system',
  actorLabel: 'DorkOS',
};

/** The line a declined-on-arrival event carries. */
export const ARRIVAL_NOTE =
  "Permissions in this folder's settings file that were not stricter than everyone's " +
  'defaults were not applied. Set them in DorkOS.';

/** The line an arrival whose file could not be written back carries. */
export const ARRIVAL_WRITE_FAILED_NOTE =
  "DorkOS couldn't apply this folder's settings file, so this agent follows everyone's " +
  'defaults except where its file is stricter. Set its permissions in DorkOS.';

/**
 * The two notes the arrival screen wrote before its lines carried `origin`
 * (the release that first shipped the screen). FROZEN: they identify lines
 * already in people's histories, so they must never change, even when the
 * live notes above are reworded. Only {@link isArrivalScreenLine} reads them.
 */
const PRE_MARKER_ARRIVAL_NOTES: ReadonlySet<string> = new Set([
  "Permissions in this folder's settings file that were not stricter than everyone's " +
    'defaults were not applied. Set them in DorkOS.',
  "DorkOS couldn't apply this folder's settings file, so this agent follows everyone's " +
    'defaults except where its file is stricter. Set its permissions in DorkOS.',
]);

/**
 * Whether a history line records the arrival screen declining settings a new
 * agent's own folder brought. Such a line has no Undo: undoing it would put
 * back, in one tap, settings nobody ever chose in DorkOS, past the check that
 * refused them. A person sets them one by one on the agent's page instead.
 *
 * - `origin: 'arrival-screen'` decides it.
 * - A line with no `origin` is one of the screen's only when its note is one
 *   of the frozen notes the screen wrote before the marker existed: a release
 *   could ship the screen before the marker, and those lines must not become
 *   undoable.
 * - A line with any other `origin` is an ordinary change, whatever its note.
 *
 * @param metadata - The line's `permission.changed` metadata.
 */
export function isArrivalScreenLine(
  metadata: Pick<PermissionChangedMetadata, 'origin' | 'note'>
): boolean {
  if (metadata.origin !== undefined) return metadata.origin === 'arrival-screen';
  return metadata.note !== undefined && PRE_MARKER_ARRIVAL_NOTES.has(metadata.note);
}
