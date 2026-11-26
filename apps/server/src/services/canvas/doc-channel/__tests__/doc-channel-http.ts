/**
 * The document channel's HTTP composition as boot builds it, with the room
 * routes' own caller check (`startup/steps/connector-events-approvals.ts`).
 */
import { resolveCaller } from '../../../../routes/room-caller.js';
import { createDocChannelHttpComposition } from '../http-composition.js';

/** Everything the composition takes but the caller check boot passes in. */
type ComposeDeps = Omit<Parameters<typeof createDocChannelHttpComposition>[0], 'resolveRoomCaller'>;

/**
 * Compose the document channel's HTTP side for a test.
 *
 * @param deps - The services it composes over.
 */
export function composeDocChannelHttp(deps: ComposeDeps) {
  return createDocChannelHttpComposition({ ...deps, resolveRoomCaller: resolveCaller });
}
