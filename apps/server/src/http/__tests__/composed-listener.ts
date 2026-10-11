/**
 * The server's real routing for a test: the front door, the Hono `/api` app
 * with every moved group (`http/hono-api.ts`), and the Express app behind it.
 *
 * A test that builds the Express app with `createApp` and serves it directly
 * no longer reaches the groups that moved, Better Auth first among them. Serve
 * this instead, and every route answers from wherever production answers it.
 */
import type { RequestListener } from 'node:http';
import type { Express } from 'express';
import type { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { frontDoorListener } from '../front-door.js';
import { composeFrontDoor } from '../hono-api.js';

/**
 * A Node request listener routing as the running server does
 * ({@link composeFrontDoor}). Build it after `initAuth`.
 *
 * @param legacy - The Express app from `createApp`.
 * @param admission - The same admission the Express app was built with.
 * @returns The listener.
 */
export function composedListener(
  legacy: Express,
  admission: MainRequestAdmission
): RequestListener {
  return frontDoorListener(composeFrontDoor(legacy, admission));
}
