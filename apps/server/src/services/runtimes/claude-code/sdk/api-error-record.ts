/**
 * The CLI's synthetic API-error notices, as a transcript records them.
 *
 * When a turn dies at the API — an expired sign-in, a 5xx, a hit limit — the
 * Claude Code CLI writes a SYNTHETIC assistant record into the session JSONL:
 * `model: "<synthetic>"`, the failure text in a `text` block, and two markers on
 * the record itself, `isApiErrorMessage: true` and an `error` code. Nobody said
 * it.
 *
 * The LIVE stream already reads that same `error` off the SDK message and yields
 * a typed error event (`sdk/event-mappers/message-event-mapper.ts`), so a failed
 * sign-in shows the person an error card with a "Fix sign-in" action. Reading
 * the transcript back after a reload saw only the text blocks, so the identical
 * failure returned as a sentence the agent appeared to have said — no card, no
 * recovery, and the story of what happened changed on reload (DOR-1649).
 *
 * This module is the missing half: the same classification applied to the record
 * on disk, reusing the live path's own copy ({@link describeAssistantError}) and
 * the shared credential detector rather than restating either.
 *
 * **Measured against the local corpus (2026-09-01, 249 such records).** Every
 * one is an `assistant` record with `model: "<synthetic>"` carrying BOTH
 * markers, and every one carries exactly ONE `text` block: no bare-string
 * content, no `tool_use`, no empty text, no second block. The codes seen are
 * `rate_limit`, `server_error`, `oauth_org_not_allowed`,
 * `authentication_failed`, `unknown` and `model_not_found`. One `system` record
 * carries an OBJECT under `error`, which is why every read of that field
 * narrows first.
 *
 * It sits beside {@link describeAssistantError} rather than with the transcript
 * parser because it is the SAME error channel read from its other end: the SDK
 * assistant message live, the record the CLI persisted on reload.
 *
 * @module services/runtimes/claude-code/sdk/api-error-record
 */
import type { ErrorPart } from '@dorkos/shared/types';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import { describeAssistantError, SURFACED_ASSISTANT_ERRORS } from './sdk-error-mapping.js';

/**
 * The record fields this module reads — a structural subset of both
 * `TranscriptLine` and an SDK assistant message, so neither has to be imported
 * here (and the transcript parser can import this module without a cycle).
 */
export interface ApiErrorMarkers {
  /** The JSONL record kind. Only `assistant` records carry these notices. */
  type: string;
  /** The CLI's own marker for "this record reports an API failure". */
  isApiErrorMessage?: boolean;
  /**
   * The failure code, e.g. `authentication_failed`. Typed `unknown` because a
   * `system` record carries an object here, so every read must narrow.
   */
  error?: unknown;
}

/**
 * The failure code on an API-error record, or undefined when it carries none
 * that can be read as one.
 *
 * @param line - The transcript record to read.
 */
export function apiErrorCode(line: ApiErrorMarkers): string | undefined {
  return typeof line.error === 'string' && line.error !== '' ? line.error : undefined;
}

/**
 * Whether this record is a synthetic API-error notice rather than assistant
 * speech.
 *
 * Either marker is enough: the CLI has always written both together, and a
 * future version that drops one still gets a card rather than a fake sentence.
 *
 * @param line - The transcript record to classify.
 */
export function isApiErrorRecord(line: ApiErrorMarkers): boolean {
  if (line.type !== 'assistant') return false;
  return line.isApiErrorMessage === true || apiErrorCode(line) !== undefined;
}

/**
 * Build the typed error part an API-error notice becomes — the same shape the
 * live stream's error event folds into.
 *
 * DorkOS copy replaces the CLI's wording for every failure the live path has
 * copy for ({@link SURFACED_ASSISTANT_ERRORS}), and the category is decided by
 * the same shared detector the live path uses, so a reload of an auth failure
 * shows the identical "Sign in again" card. A code DorkOS has no copy for keeps
 * the CLI's own words as the message and takes no category: `rate_limit` is the
 * common one, and "You've hit your weekly limit · resets Aug 24 at 8pm" tells
 * the person more than any generic phrasing could.
 *
 * **`message` and `category` match the live part; `details` deliberately does
 * not.** The claude-code live channel emits no `details`, so `foldError`
 * (`project-session-turn.ts`) has only the code to fold and produces
 * `[authentication_failed]`. The transcript record carries the CLI's actual
 * sentence, so this stores that instead — strictly more than the live part has,
 * and the reason the two are not byte-identical. Codex's channel already does
 * the same thing through `describeRuntimeError` (DOR-1656); claude-code's
 * live channel is the one that still folds a bare code.
 *
 * **Why this does not call `describeRuntimeError`.** That helper decides
 * auth-vs-`execution_error` and nothing else, which is right for a runtime whose
 * failures are one or the other. Claude Code's are not: it has per-code copy for
 * five more failures ({@link describeAssistantError}) and, crucially, a tier
 * with NO DorkOS copy that must stay uncategorised — `describeRuntimeError`
 * would stamp `execution_error` on a rate-limit notice, which puts a Retry on a
 * card that cannot honour it. Its own TSDoc names this case: a runtime needing
 * richer categories classifies them itself.
 *
 * @param code - The record's `error` code, when it carried one.
 * @param noticeText - The text the CLI wrote into the record, trimmed.
 */
export function buildApiErrorPart(code: string | undefined, noticeText: string): ErrorPart {
  const hasDorkosCopy = code !== undefined && SURFACED_ASSISTANT_ERRORS.has(code);
  // A notice with no text of its own would otherwise render a blank card, so it
  // falls back to the mapper's default sentence. Measured 0 of 249 records, so
  // this is a guard rather than a case.
  const message =
    hasDorkosCopy || noticeText === '' ? describeAssistantError(code ?? '') : noticeText;

  const part: ErrorPart = { type: 'error', message };
  if (detectAuthError({ message, code })) {
    part.category = 'auth_error';
  } else if (hasDorkosCopy) {
    part.category = 'execution_error';
  }

  // The error card shows its CATEGORY's copy and keeps `message` out of sight,
  // so a categorised notice carries the CLI's words in `details` — the
  // collapsible the card already has. An uncategorised one shows `message`,
  // which IS those words, so a `details` copy would only repeat them.
  if (part.category !== undefined && noticeText !== '') part.details = noticeText;

  return part;
}
