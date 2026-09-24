/**
 * Small pieces every marketplace package command shares: how `--project` is
 * sent, how a path is echoed back in a hint, and how a server older than the
 * CLI is explained.
 *
 * @module lib/package-commands
 */
import path from 'node:path';
import { ApiError } from './api-client.js';

/** The code the app's catch-all stamps on a 404 for an `/api` route it does not have. */
const UNKNOWN_ROUTE_CODE = 'API_NOT_FOUND';

/**
 * The message for a server that does not have a route this CLI calls: it was
 * started before this CLI was installed or upgraded.
 */
export const OLDER_SERVER_MESSAGE =
  'Error: the running DorkOS is older than this CLI and cannot do this yet. ' +
  'Restart DorkOS, then try again.';

/**
 * Resolve a `--project` value against the caller's working directory.
 *
 * The server resolves a relative path against ITS working directory, which for
 * the desktop app, or a DorkOS started in another folder, is not the terminal's.
 * So `--project .` would name the wrong project, or one outside the boundary.
 * Sending the absolute path means the project the person is standing in.
 *
 * @param value - The flag's value as typed, or `undefined` when it was not given.
 * @returns The absolute path, or `undefined`.
 */
export function resolveProjectFlag(value: unknown): string | undefined {
  return typeof value === 'string' ? path.resolve(process.cwd(), value) : undefined;
}

/**
 * A value as it can be pasted back into a POSIX shell: bare when it holds only
 * characters no shell treats specially, otherwise single-quoted, with each
 * single quote written as `'\''`.
 *
 * @param value - The value to quote, typically a path.
 * @returns The shell word.
 */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./,:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether an error means the server does not have the route at all — a DorkOS
 * started before this CLI. The app's catch-all answers such a request 404 with
 * `code: 'API_NOT_FOUND'`; a bare 404 with no code is read the same way. A 404
 * carrying any other code is a route's own answer and is not this. Because a
 * code-less 404 counts, call it only for routes that have no 404 of their own
 * (`GET /updates`, `POST /updates` without `names`).
 *
 * @param err - The thrown value.
 * @returns True for an unknown-route 404.
 */
export function isOlderServer(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 404 &&
    (err.body.code === UNKNOWN_ROUTE_CODE || err.body.code === undefined)
  );
}
