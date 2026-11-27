/**
 * What a session stream is asked for, in the computer side's own terms: the
 * chat, the runtime that owns it, its context, where to resume and who reads.
 *
 * The stream itself is served by the space side
 * (`screen/session-stream-delivery.ts`), which adds what only it holds (the
 * chat's documents). The session relay names this shape so it can ask for a
 * stream without reaching across the wall (spec `computer-side-starts-alone`
 * §5.12).
 *
 * @module services/core/streams/session-stream-plan
 */
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import type { ResumeCursor } from '../../../lib/stream-cursor.js';
import type { CallerPrincipal } from '../../../lib/caller-principal.js';

/** Everything the computer side resolves before a session stream can be delivered. */
export interface SessionStreamRequest {
  /** The session being streamed. */
  sessionId: string;
  /** The runtime that owns it. */
  runtime: AgentRuntime;
  /** The boundary-validated cwd plus the effective permission mode. */
  ctx: SessionOpts;
  /** The parsed resume signal, or `undefined` for a cold connect. */
  resume: ResumeCursor | undefined;
  /**
   * Who is reading, so an Ask's detail reaches only a caller entitled to it
   * (spec `ask-entitlement`, review finding 2).
   *
   * **Required, never defaulted.** `askEntitlement` says an agent gets `none` —
   * "the Ask does not exist for this caller" — and the fleet-wide list and the
   * global stream both enforce that. This stream is the third door onto the
   * same detail, and one that defaulted to the operator would be an allow for
   * whatever opens it next. Both transports read the principal from the same
   * request facts.
   */
  principal: CallerPrincipal;
}
