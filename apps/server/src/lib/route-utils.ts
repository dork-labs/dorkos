/**
 * Shared route handler utilities for validation, error extraction, boundary
 * checks, and letting go of a body nobody is going to read.
 *
 * @module lib/route-utils
 */
import type { Response } from 'express';
import type { Readable } from 'stream';
import type { ZodSchema } from 'zod';
import { z } from 'zod';
import { validateBoundary, validateBoundaryOrDorkHome, BoundaryError } from './boundary.js';

const uuidSchema = z.string().uuid();

/**
 * Parse and validate a request body against a Zod schema.
 *
 * Returns the validated data on success, or `null` after sending a 400 response on failure.
 *
 * @param schema - Zod schema to validate against
 * @param data - Raw request data (body or query)
 * @param res - Express response object (used to send 400 on failure)
 * @returns Validated data or null if validation failed (response already sent)
 */
export function parseBody<T>(schema: ZodSchema<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json(validationFailureBody(result.error));
    return null;
  }
  return result.data;
}

/**
 * The 400 body {@link parseBody} answers with, for a route that answers it
 * itself: a Hono route returns `c.json(validationFailureBody(error), 400)`.
 *
 * @param error - Why the data failed its schema.
 * @returns The body.
 */
export function validationFailureBody(error: z.ZodError) {
  return { error: 'Validation failed', details: z.flattenError(error) };
}

/**
 * Extract a human-readable error message from an unknown caught value.
 *
 * @param err - Caught error value
 * @param fallback - Default message when err is not an Error instance
 */
export function toErrorMessage(err: unknown, fallback = 'Internal server error'): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Validate that a raw route param is a valid UUID.
 *
 * Accepts `unknown` so raw `req.params` values (typed `string | string[]` by
 * Express 5 typings) flow straight in — a non-string is simply invalid.
 *
 * @param id - The raw value to validate
 * @returns The validated UUID string, or `null` if invalid
 */
export function parseSessionId(id: unknown): string | null {
  const result = uuidSchema.safeParse(id);
  return result.success ? result.data : null;
}

/**
 * Send a standardized JSON error response.
 *
 * @param res - Express response object
 * @param status - HTTP status code
 * @param message - Human-readable error message
 * @param code - Machine-readable error code
 */
export function sendError(res: Response, status: number, message: string, code: string): void {
  res.status(status).json(errorBody(message, code));
}

/**
 * The body {@link sendError} answers with, for a route that answers it itself:
 * a Hono route returns `c.json(errorBody(message, code), status)`.
 *
 * @param message - Human-readable error message
 * @param code - Machine-readable error code
 * @returns The body.
 */
export function errorBody(message: string, code: string): { error: string; code: string } {
  return { error: message, code };
}

/**
 * Abandon a readable body the handler decided not to send — the 304 path of
 * every route that streams stored bytes.
 *
 * **The `error` listener is the load-bearing half, not the `destroy()`.** These
 * bodies are opened lazily: an attachment store hands back an
 * `fs.createReadStream` over a path, because attachments are unbounded in size
 * and their validator comes from one `stat`, so answering a conditional request
 * must not cost a read. `createReadStream` submits its `fs.open` at
 * construction and `destroy()` does NOT cancel it — a file unlinked before that
 * open lands still emits `error`, and an `error` with no listener on it is a
 * process-level uncaught exception rather than a failed request. The window is
 * real: a delete or the retention sweep can unlink the file between the store's
 * `stat` and the open, so a plain `stream.destroy()` on a 304 path means a
 * conditional GET can take the whole server down (DOR-1831). The same fault
 * inside a test run ends a shard red with every test green, which is how
 * DOR-1830 ejected unrelated PRs from the merge queue.
 *
 * The listener is deliberately a no-op: this is a body nobody wanted, so
 * whatever it failed at cannot affect the answer already being sent. The
 * `destroy()` still earns its place — it closes the descriptor promptly once
 * the open has landed instead of waiting for garbage collection.
 *
 * @param stream - The stream to let go of.
 */
export function discardStream(stream: Readable): void {
  stream.on('error', () => {});
  stream.destroy();
}

/** Options for {@link boundaryRefusal}. */
export interface BoundaryRefusalOptions {
  /**
   * Also accept DorkOS's own `{dorkHome}/agents/*` subtree — the agent-registry
   * seam (PR #409, `validateBoundaryOrDorkHome`). Set it for a SESSION-CWD
   * check: a session whose working directory is a system or marketplace agent's
   * home (`{dorkHome}/agents/<name>`) must be allowed to stream, list, and read
   * even under a narrow `DORKOS_BOUNDARY` (e.g. Docker) — otherwise onboarding's
   * DorkBot session 403s.
   *
   * Not the only caller of `validateBoundaryOrDorkHome`: `GET /api/directory`
   * (DOR-437) calls it directly rather than through this option, for the same
   * reason — browsing `{dorkHome}/agents` itself must not 403 under a boundary-
   * scoped install. That call is read-only directory LISTING (names only, no
   * contents), which is why it is safe without going through this session-cwd
   * option at all.
   *
   * Never set this option, and never reach for `validateBoundaryOrDorkHome`,
   * for a raw file/content surface — read, write, terminal, git, diff, upload.
   * Those stay on the plain boundary so the encrypted credential store under
   * `{dorkHome}/extension-secrets/` stays unreachable.
   */
  allowDorkHome?: boolean;
}

/**
 * Validate that a path is within the directory boundary.
 *
 * With `allowDorkHome`, the `{dorkHome}/agents/*` subtree is additionally
 * accepted for agent-home session cwds (see
 * {@link BoundaryRefusalOptions.allowDorkHome}). A route answers a refusal with
 * `c.json(refusal, 403)`.
 *
 * @param pathToCheck - User-supplied path (skipped if undefined/null)
 * @param opts - Boundary options (e.g. `allowDorkHome` for session cwds)
 * @returns `undefined` if the path is valid or not provided, else the 403 body
 * @throws Anything the boundary check throws that is not a {@link BoundaryError}.
 */
export async function boundaryRefusal(
  pathToCheck: string | undefined | null,
  opts: BoundaryRefusalOptions = {}
): Promise<{ error: string; code: string } | undefined> {
  if (!pathToCheck) return undefined;
  try {
    if (opts.allowDorkHome) {
      await validateBoundaryOrDorkHome(pathToCheck);
    } else {
      await validateBoundary(pathToCheck);
    }
    return undefined;
  } catch (err) {
    if (err instanceof BoundaryError) return { error: err.message, code: err.code };
    throw err;
  }
}
