/**
 * How the chat reads the capability mount serves refuse over HTTP (DOR-4978):
 * the hand routes' problem codes and sentences, kept. A capability throws a
 * `CapabilityToolError` whose problem comes from a fixed table
 * (`routes/capability-refusals.ts`); {@link SESSION_READ_TOOL_REFUSALS} is
 * this domain's part of it, and the capabilities throw only these sentences.
 *
 * A chat an agent may not read throws `SESSION_NOT_FOUND`, which is a shared
 * problem code already: it answers `session_not_found` with that code's title.
 *
 * @module services/session/reads/session-read-refusals
 */
import type { ProblemCode } from '@dorkos/shared/problem';

/** Every sentence the chat reads refuse with, as the hand routes said it. */
export const SESSION_READ_SENTENCES = {
  invalidId: 'That chat id isn’t valid.',
  canvasPersonOnly: 'A chat’s canvas is the person’s own.',
  agentUnverified:
    'That agent identity could not be verified. Its token may have been revoked, or it may have expired.',
  canvasUnavailable: 'The canvas isn’t available on this server.',
  noSuchDocument: 'No such document on this canvas',
} as const;

/** One refusal: its problem code and its fixed sentence. */
interface SessionReadToolRefusal {
  readonly code: ProblemCode;
  readonly detail: string;
}

const S = SESSION_READ_SENTENCES;

/** The chat reads' tool codes, each with the hand route's problem code and sentence. */
export const SESSION_READ_TOOL_REFUSALS: Readonly<Record<string, SessionReadToolRefusal>> = {
  CHAT_ID_INVALID: { code: 'invalid_request', detail: S.invalidId },
  CHAT_CANVAS_PERSON_ONLY: { code: 'person_only', detail: S.canvasPersonOnly },
  CHAT_CANVAS_AGENT_UNVERIFIED: { code: 'agent_identity_unverified', detail: S.agentUnverified },
  CHAT_CANVAS_UNAVAILABLE: { code: 'temporarily_unavailable', detail: S.canvasUnavailable },
  CHAT_CANVAS_DOCUMENT_NOT_FOUND: { code: 'not_found', detail: S.noSuchDocument },
};
