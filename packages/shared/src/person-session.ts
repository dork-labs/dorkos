/**
 * The owner's one password step-up at this computer (DOR-3330): the code a
 * person-only action answers with while the browser holds no session, the
 * route that takes the password, and its body.
 *
 * At this computer DorkOS asks for no password by default, so the app there
 * may carry no session. Once an owner exists, what only the person may do
 * needs one. The server answers such an action `401` with
 * {@link PERSON_SESSION_REQUIRED_CODE}; the app asks the owner's password
 * once, posts it to {@link PERSON_SESSION_PATH}, and retries. The session
 * that leaves works only at this computer, beside the proof the app keeps
 * ({@link PERSON_PROOF_HEADER}), and lasts, so it asks once.
 *
 * @module shared/person-session
 */
import { z } from 'zod';

/** The code a person-only action answers with when no session proves the person. */
export const PERSON_SESSION_REQUIRED_CODE = 'person_session_required';

/** The route that takes the owner's password and leaves a session for this computer. */
export const PERSON_SESSION_PATH = '/api/person-session';

/**
 * The header the app sends its person proof in: the code the step-up answered
 * with, kept in the app page's own storage. A browser sends the session
 * cookie to every port on this computer, so a page on any other port could
 * carry it; only the app's own page can read the proof, so at this computer
 * the session stands for the person only beside it.
 */
export const PERSON_PROOF_HEADER = 'x-dorkos-person';

/**
 * The marker the app window's own API calls carry, so a refusal for want of
 * the person's session is answered with the step-up only where someone can
 * answer it. Not a credential: it decides which refusal a caller hears, never
 * what it may do. A program without it hears the route's own refusal.
 */
export const PERSON_APP_HEADER = 'x-dorkos-app';

/** Where the app page keeps its person proof (its own origin's storage). */
export const PERSON_PROOF_STORAGE_KEY = 'dorkos.person-proof';

/** What a step-up answers once the password matched. */
export const PersonSessionResponseSchema = z.object({
  ok: z.literal(true),
  /** The person proof to send in {@link PERSON_PROOF_HEADER}. */
  proof: z.string().min(1),
});

/** What a step-up answers once the password matched. */
export type PersonSessionResponse = z.infer<typeof PersonSessionResponseSchema>;

/** The body {@link PERSON_SESSION_PATH} takes. */
export const PersonSessionRequestSchema = z.object({
  /** The owner's password. Never logged or stored. */
  password: z.string().min(1).max(1024),
});

/** The body {@link PERSON_SESSION_PATH} takes. */
export type PersonSessionRequest = z.infer<typeof PersonSessionRequestSchema>;

/** Why a step-up was refused, as `code` on its error body. */
export const PERSON_SESSION_REFUSAL_CODES = [
  'wrong-password',
  'too-many-attempts',
  'no-owner',
  'no-password',
  'not-at-this-computer',
  'not-a-person',
] as const;

/** Why a step-up was refused. */
export type PersonSessionRefusalCode = (typeof PERSON_SESSION_REFUSAL_CODES)[number];
