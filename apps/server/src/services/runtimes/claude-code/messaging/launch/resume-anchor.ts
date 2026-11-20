/**
 * The resume point a launch hands the CLI (`resumeSessionAt`), and what to do
 * when the CLI cannot find it (DOR-4590).
 *
 * A launch resumes at the last main-thread answer DorkOS saw
 * (`AgentSession.lastAssistantUuid`, kept by each turn's stream and read by
 * `launch-resolver.ts`). The CLI
 * walks its conversation back from the newest message, so an answer that is no
 * longer on that path, because a summary replaced it or the CLI dropped the
 * branch it was on, is not found, and the CLI exits while booting with
 * `No message found with message.uuid of: <uuid>`. Nothing about the
 * conversation is wrong: only DorkOS's pointer into it is stale.
 *
 * Both launch paths drop the pointer when that happens, so the next launch
 * resumes the conversation plainly: the per-message path retries at once
 * (`message-sender.ts`), and the warm-process path on its next relaunch
 * (`persistent-dispatch.ts`). Before the second did this, every relaunch named
 * the same missing message, and the chat failed every turn until DorkOS stopped
 * restarting it.
 *
 * @module services/runtimes/claude-code/messaging/launch/resume-anchor
 */
import { logger } from '../../../../../lib/logger.js';
import type { AgentSession } from '../../agent-types.js';

/**
 * Whether an error is the CLI failing to find the resume point it was handed.
 * Matches the thrown error and the SDK's "returned an error result" wrapping of it.
 *
 * @param err - What the launch threw or the process died with.
 */
export function isAnchorNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /no message found with message\.uuid/i.test(err.message);
}

/**
 * Forget the resume point when the CLI could not find it, so the next launch
 * resumes the conversation without one. Any other error leaves it alone.
 *
 * @param session - The session whose next launch would name the point.
 * @param err - What the process died with.
 * @param sessionId - For the log line.
 * @returns Whether the resume point was dropped.
 */
export function dropMissingResumeAnchor(
  session: Pick<AgentSession, 'lastAssistantUuid'>,
  err: unknown,
  sessionId: string
): boolean {
  if (session.lastAssistantUuid === undefined || !isAnchorNotFound(err)) return false;
  logger.warn('[resume-anchor] the CLI could not find the resume point; the next launch skips it', {
    session: sessionId,
    anchor: session.lastAssistantUuid,
  });
  session.lastAssistantUuid = undefined;
  return true;
}
