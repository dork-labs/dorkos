/**
 * Which chats still have background work running (DOR-2065): the computer
 * side's half of the running-chats read. It reads only the projectors on this
 * computer, so `get_session_count` can ask it during a turn; the read a person
 * or an agent sees, filtered by who may see each chat, is
 * `session/chat-messages/screen/running-chats.ts` on the space side (spec
 * `computer-side-starts-alone` §5.12).
 *
 * @module services/session/running-chats/background-work
 */
import path from 'node:path';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import { listProjectorStatuses } from '../session-state-projector.js';

/** A live chat as the sources report it. */
export interface LiveProjector {
  sessionId: string;
  cwd?: string | undefined;
  status: SessionStatus;
}

/**
 * Whether background work a session started is still running (DOR-2065): the
 * one server answer the running read and `get_session_count` share.
 *
 * Read from the session's projected running list alone — helpers, shells,
 * Monitors and other tasks the runtime reported, the same list the strip draws.
 * Not from `AgentRuntime.holdsBackgroundWork`, which is also true for a timer
 * the agent set (`/loop`, a scheduled wake) or a report still owed: a chat
 * waiting on a timer has nothing running, so it is not `background`.
 *
 * `true` while anything is counted; otherwise absent, never `false`, because
 * not every runtime reports its background work.
 *
 * @param _sessionId - The session (kept for the sources signature)
 * @param status - Its projected status
 */
export function backgroundWorkOf(_sessionId: string, status: SessionStatus): true | undefined {
  return (status.runningSubagentCount ?? 0) > 0 ? true : undefined;
}

/**
 * How many chats working in `folder` still have background work running, by
 * {@link backgroundWorkOf}: the number `get_session_count` reports beside its
 * total (DOR-2065). The same chats that total counts — the ones whose folder
 * is exactly `folder` — so it can never exceed it for a nested agent's work.
 *
 * @param folder - The agent's folder
 * @param statuses - Every live projector, replaced in tests
 */
export function countBackgroundWorkIn(
  folder: string,
  statuses: () => LiveProjector[] = listProjectorStatuses
): number {
  const target = path.resolve(folder);
  return statuses().filter(
    (entry) =>
      entry.cwd !== undefined &&
      path.resolve(entry.cwd) === target &&
      backgroundWorkOf(entry.sessionId, entry.status) === true
  ).length;
}
