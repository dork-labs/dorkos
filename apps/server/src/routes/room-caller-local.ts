/**
 * Where `resolveCaller` leaves the room caller it resolved, for
 * `sendRoomError` to read (DOR-2457).
 *
 * Its own module, not an export of `room-caller.ts`, so the refusal path never
 * depends on the caller resolver's module: a test that stands in for
 * `resolveCaller` replaces that whole module, and a constant living there would
 * vanish with it, turning every refusal the route sends into a throw.
 *
 * @module routes/room-caller-local
 */

/**
 * The `res.locals` key the resolved room caller is kept under. Unset when the
 * caller was never resolved, or was refused.
 */
export const ROOM_CALLER_LOCAL = 'roomCaller';
