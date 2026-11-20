/** Durable projector identity validation, before any in-memory target replacement. */
import { RequiredSessionIdentityError } from '../../../lib/replay/required-session-identity-error.js';
import { logger } from '../../../lib/logger.js';
import { moveDurableSessionIdentity } from './durable-rekey.js';

/**
 * Move required identity with exact live owner validation; only optional failures may continue.
 * @param fromId - The source projector's resolved key.
 * @param newId - The proposed native destination.
 * @param projector - The original live source object.
 * @param projectors - Current owners, read again by the mandatory transaction's guard.
 */
export function moveProjectorDurableIdentity<T>(
  fromId: string,
  newId: string,
  projector: T,
  projectors: ReadonlyMap<string, T>
): void {
  try {
    moveDurableSessionIdentity(
      fromId,
      newId,
      () =>
        projectors.get(fromId) === projector &&
        (projectors.get(newId) === undefined || projectors.get(newId) === projector)
    );
  } catch (error) {
    if (error instanceof RequiredSessionIdentityError) throw error;
    logger.warn('[SessionStateProjector] durable identity move blocked', { fromId, newId, error });
  }
}
