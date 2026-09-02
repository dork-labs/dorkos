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
 * Live, `mapSessionError` in `session-event-mapper.ts` makes the same decisions
 * on the `session.error` event, whose payload is the SAME union. That module
 * cannot be imported here: it pulls in the server logger, which imports `fs`,
 * and the mapper's import graph is filesystem-free by test guard (ADR-0308 —
 * the guard was measured to catch it). The overlap is kept to the rules that
 * decide what a reader SEES — an abort is not a failure, and a credential
 * failure gets the `auth_error` category and DorkOS's own sentence — with
 * `detectAuthError` and `describeAuthError` shared from `@dorkos/shared`.
 *
 * **A dead sign-in reads the same live and after a reload, and that took
 * fixing.** DOR-1656 gave every runtime's credential failure one DorkOS
 * sentence naming the runtime, with the vendor's words demoted to `details` —
 * but only on the LIVE channel. This reader kept showing the provider's raw
 * `AuthenticationError: 401 {…}`, so the same expiry spoke DorkOS's voice
 * during the turn and the vendor's the next morning, offering no remedy where
 * the live card had offered one. The shared runtime-conformance floor (DOR-1678)
 * is what caught it; both halves now answer identically.
 *
 * **The two surfaces still disagree on wording elsewhere, and it shows on the
 * commonest real failure.** Live, `mapSessionError` rewrites an
 * unavailable-model failure to friendly copy pointing at the model menu; here,
 * history shows the provider's own words. So a turn that failed with
 * "No endpoints found that support tool use. Try disabling \"bash\"" — three of
 * the six measured `APIError` rows, the modal case — reads as the friendly
 * sentence live and as the raw vendor text after a reload. Restating those
 * patterns here would put a second copy of them in the tree to drift from the
 * first, and the live copy is itself questionable for this row (the remedy it
 * suggests, pick another model, is not what that error asks for). The raw text
 * is accurate and carries the provider's own links; the divergence is recorded
 * rather than papered over, and unifying it is a follow-up on the live regex.
 *
 * **The SDK's declared error type is a claim, not a guarantee.** The sidecar is
 * an unpinned external binary whose generated types this adapter has already
 * caught being wrong (DOR-1147: the shipped server emits permission shapes the
 * SDK does not declare). So the payload is Zod-parsed before it is trusted,
 * the same house rule `session-event-mapper.ts` applies to every untyped
 * sidecar payload. The stakes here are higher than one bad card: this runs
 * inside `getMessageHistory`, whose throw is caught by the runtime facade and
 * turned into the log-backed fallback — which for a session adopted from the
 * OpenCode TUI holds nothing, so ONE off-type row would blank the entire
 * conversation. A shape that will not parse costs its own error part and
 * nothing else. Unlike the live mapper this drops silently, because the
 * filesystem-free rule leaves no logger to warn through.
 *
 * @module services/runtimes/opencode/history-error-part
 */
import { z } from 'zod';
import type { ErrorPart } from '@dorkos/shared/types';
import { describeAuthError, detectAuthError } from '@dorkos/shared/runtime-error-classification';

/**
 * The error name OpenCode stamps on a user interrupt. Suppressed rather than
 * surfaced, matching the live path: the person stopped the turn on purpose, and
 * whatever the agent had already written is still in the message's parts.
 */
const ABORT_ERROR_NAME = 'MessageAbortedError';

/**
 * This adapter's runtime type — the identity {@link describeAuthError} turns
 * into the name a person reads, so an OpenCode credential failure says
 * "OpenCode" and never another runtime's name.
 *
 * Spelled here rather than imported from `session-event-mapper.ts`, which
 * carries the same constant for the live path: that module pulls in the server
 * logger, which imports `fs`, and this file's import graph is filesystem-free by
 * test guard (ADR-0308). One string is the smaller duplication.
 */
const OPENCODE_RUNTIME_TYPE = 'opencode';

/**
 * What a persisted message error must carry to be worth rendering.
 *
 * `name` is the ONLY required field, and required because it does double duty:
 * it is the error's code AND the fallback text when the payload carries no
 * message, so an error without one has nothing to say. Everything else degrades
 * — a missing, null, or unexpectedly-shaped `data` yields a name-only error
 * part rather than dropping the failure, which is the same outcome a real
 * `MessageOutputLengthError` (whose `data` genuinely has no `message`) already
 * produces.
 */
const MessageErrorSchema = z.object({
  name: z.string().min(1),
  // `.catch` rather than a bare `.nullish()`: a `data` that is present but not
  // an object at all must degrade this ONE field to "absent", not fail the
  // parse and take the whole failure down with it.
  data: z.record(z.string(), z.unknown()).nullish().catch(undefined),
});

/**
 * Project a persisted OpenCode message error onto an {@link ErrorPart}, or
 * `null` when the message carried no error worth showing — none at all, a user
 * interrupt, or a payload too malformed to describe.
 *
 * `ErrorPart` has no `code` field, so the OpenCode error NAME is folded into
 * `details` — the same convention the log-backed history fold uses — and left
 * off entirely when the name is all the message says, which would print it
 * twice.
 *
 * Takes `unknown` on purpose: the caller's value is typed by the OpenCode SDK,
 * but that type is the sidecar's claim about itself (see the module doc), and
 * this function's contract is that no shape it is handed can throw.
 *
 * @param error - The message's `error` field, straight off the sidecar.
 */
export function mapMessageError(error: unknown): ErrorPart | null {
  const parsed = MessageErrorSchema.safeParse(error);
  if (!parsed.success) return null;

  const { name, data } = parsed.data;
  if (name === ABORT_ERROR_NAME) return null;

  const reported = data?.['message'];
  const message = typeof reported === 'string' && reported.length > 0 ? reported : name;

  // A dead credential speaks DorkOS's one sentence, exactly as the live turn
  // did, with the provider's own words demoted into `details` (DOR-1656,
  // DOR-1678). Until this, the two halves disagreed on the one failure that has
  // a remedy: the live card said "OpenCode's model provider stopped accepting
  // its sign-in", and reopening the same session the next morning showed the
  // raw `AuthenticationError: 401 {"type":"error",…}` instead — the same
  // failure, in the vendor's voice, telling the person nothing they could act
  // on. The shared conformance floor is what caught it.
  //
  // Only the AUTH branch is translated. Everything else keeps the provider's
  // words on purpose (see the module doc): they are the only account of what
  // went wrong, and several of them carry the very link that fixes it.
  if (detectAuthError({ message, code: name })) {
    return {
      type: 'error',
      message: describeAuthError(OPENCODE_RUNTIME_TYPE),
      category: 'auth_error',
      // The name AND what the provider said — the live path carries the name as
      // the event's `code`, and an `ErrorPart` has no such field, so both ride
      // `details` here. When the provider said nothing, `message` already fell
      // back to the name and repeating it twice would say nothing extra.
      details: message === name ? `[${name}]` : `[${name}] ${message}`,
    };
  }

  return {
    type: 'error',
    message,
    category: 'execution_error',
    ...(message === name ? {} : { details: `[${name}]` }),
  };
}
