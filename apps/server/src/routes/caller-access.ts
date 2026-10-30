/**
 * What a room caller is about to do, from the request method (DOR-3330): a
 * read looks, a write acts in the room as its author. Its own module so the
 * room routes can ask it without loading `room-caller.ts`.
 *
 * @module routes/caller-access
 */

/**
 * What the caller is about to do: `read` looks (a list, a stream, a search,
 * its own read position), `write` acts in the room as its author.
 */
export type CallerAccess = 'read' | 'write';

/**
 * The access a request method stands for: `GET`, `HEAD` and `OPTIONS` read,
 * everything else writes.
 *
 * @param method - The request method.
 */
export function callerAccessOf(method: string): CallerAccess {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'read' : 'write';
}
