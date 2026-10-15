/**
 * The server's real routing for a test: the one Hono app with every route
 * group mounted (`http/hono-api.ts`), served through the front door as
 * `index.ts` serves it.
 */
import type { RequestListener } from 'node:http';
import type { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { frontDoorListener } from '../front-door.js';
import { composeFrontDoor, type HonoApiDeps } from '../hono-api.js';

/**
 * A Node request listener routing as the running server does
 * ({@link composeFrontDoor}). Build it after `initAuth`.
 *
 * @param admission - The main listener's shared terminal state.
 * @param deps - What the route groups read, when the test hands them any.
 * @returns The listener.
 */
export function composedListener(
  admission: MainRequestAdmission,
  deps?: HonoApiDeps
): RequestListener {
  return frontDoorListener(composeFrontDoor(admission, deps));
}
