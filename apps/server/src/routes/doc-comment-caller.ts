/**
 * Who is writing a doc comment over HTTP, and whether it is the owner in
 * person (DOR-2983).
 *
 * The author is the rooms' answer (`resolveCaller`), which refuses a revoked
 * agent token. Whether the words count as the owner's REQUEST is a stronger
 * question, and it is answered by the same person bars `lib/caller-authority.ts`
 * keeps for what only a person may do, never by the author alone: with login
 * off, a program on this machine that drops its agent header resolves to the
 * owner's author, and with login on so does one holding the owner's API key.
 *
 * - **Login on:** {@link clearsTheAgentBar}, which requires a browser session
 *   (never an API key) and no agent identity or approval token. This is the
 *   protection.
 * - **Login off:** there is no credential for anyone, so the bar is
 *   {@link requirePersonAtThisComputer}: at this computer, no agent identity,
 *   no approval token and no `Authorization` bearer. That is the DOR-505 gap,
 *   stated plainly: a program on this machine that sends none of those reads
 *   as the person, and only turning on login closes it. {@link isPersonAtTheApp}
 *   is also asked, but its `X-Client-Id` is a marker, not a credential: any
 *   non-empty string passes. It keeps an honest script (one that never
 *   pretends to be a window of the app) from reading as the owner; it stops
 *   nobody who means to.
 *
 * Anything that clears neither is written as itself, and an owner author that
 * is not in person is an outsider: its words are fenced and its wakes held to
 * the runtime's default.
 *
 * @module routes/doc-comment-caller
 */
import type { RequestFacts } from '../http/request-facts.js';
import {
  clearsTheAgentBar,
  isPersonAtTheApp,
  requirePersonAtThisComputer,
} from '../lib/caller-authority.js';
import { credentialGated } from '../services/core/auth/gate-policy.js';
import type { CommentWriter } from '../services/docs/comments/index.js';
import { resolveCaller } from './room-caller.js';

/**
 * Whether a request is the owner, in person, using the app. See the module
 * documentation for the two postures.
 *
 * @param facts - The request's facts.
 */
export function isOwnerInPerson(facts: RequestFacts): boolean {
  if (!clearsTheAgentBar(facts)) return false;
  if (credentialGated(facts)) return true;
  return requirePersonAtThisComputer(facts) === undefined && isPersonAtTheApp(facts);
}

/**
 * The writer a comment request is, from its facts.
 *
 * @param facts - The request's facts.
 * @throws RoomError `AGENT_IDENTITY_UNVERIFIED` for an agent token this
 *   computer cannot verify.
 */
export function docCommentWriterOf(facts: RequestFacts): CommentWriter {
  return { author: resolveCaller(facts), inPerson: isOwnerInPerson(facts) };
}
