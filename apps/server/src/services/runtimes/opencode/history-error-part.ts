/**
 * OpenCode message-level error → {@link ErrorPart}, for the HISTORY read.
 *
 * OpenCode persists a failed turn as an assistant message carrying an `error`
 * object (`ProviderAuthError`, `APIError`, `UnknownError`,
 * `MessageOutputLengthError`, `MessageAbortedError`). That field is the ONLY
 * durable record of the failure: the live `session.error` event that carried it
 * to the open client is ephemeral, and the sidecar's own store keeps just the
 * message. Measured on this machine's `~/.local/share/opencode/opencode.db`
 * (2026-09-01): twelve messages carry a persisted error, and every one of the
 * six `APIError` rows has ZERO parts — so a reader that maps only parts drops
 * the whole message and the turn vanishes from a reopened transcript.
 *
 * Live, {@link mapSessionError} in `session-event-mapper.ts` makes the same
 * decisions on the `session.error` event, whose payload is the SAME union. That
 * module cannot be imported here: it pulls in the server logger, which imports
 * `fs`, and the mapper's import graph is filesystem-free by test guard
 * (ADR-0308 — the guard was measured to catch it). The overlap is kept to the
 * two rules that decide what a reader SEES — an abort is not a failure, and a
 * credential failure gets the `auth_error` category — with `detectAuthError`
 * shared from `@dorkos/shared`. The live path's friendly model-unavailable copy
 * is deliberately NOT restated here: history shows the provider's own words,
 * and a second copy of those patterns would drift from the first.
 *
 * @module services/runtimes/opencode/history-error-part
 */
import type { AssistantMessage } from '@opencode-ai/sdk';
import type { ErrorPart } from '@dorkos/shared/types';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';

/**
 * The error name OpenCode stamps on a user interrupt. Suppressed rather than
 * surfaced, matching the live path: the person stopped the turn on purpose, and
 * whatever the agent had already written is still in the message's parts.
 */
const ABORT_ERROR_NAME = 'MessageAbortedError';

/** The persisted error union an OpenCode assistant message can carry. */
type OpenCodeMessageError = NonNullable<AssistantMessage['error']>;

/**
 * Project a persisted OpenCode message error onto an {@link ErrorPart}, or
 * `null` when the message carried no error worth showing (none at all, or a
 * user interrupt).
 *
 * `ErrorPart` has no `code` field, so the OpenCode error NAME is folded into
 * `details` — the same convention the log-backed history fold uses — and left
 * off entirely when the name is all the message says, which would print it
 * twice.
 *
 * @param error - The message's `error` field, if the store carried one.
 */
export function mapMessageError(error: OpenCodeMessageError | undefined): ErrorPart | null {
  if (error === undefined) return null;
  if (error.name === ABORT_ERROR_NAME) return null;

  const data: Record<string, unknown> = error.data;
  const message =
    typeof data.message === 'string' && data.message.length > 0 ? data.message : error.name;

  return {
    type: 'error',
    message,
    category: detectAuthError({ message, code: error.name }) ? 'auth_error' : 'execution_error',
    ...(message === error.name ? {} : { details: `[${error.name}]` }),
  };
}
