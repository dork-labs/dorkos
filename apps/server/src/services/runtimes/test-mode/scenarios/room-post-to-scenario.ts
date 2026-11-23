/**
 * `rooms-post-to`: post into a room from a direct chat, the one way a driver
 * can start a real room hand-off on the test runtime (DOR-5032).
 *
 * Sent `<roomId> <text>` on a direct chat with an agent, it calls the real
 * `rooms.post` as that agent from that chat, exactly as the in-session MCP
 * server lands a `post_to_room`. A direct chat is not the agent's seat in the
 * room, so the room hands the words to the seat (DOR-3397), and the seat's own
 * scripted turn posts them ({@link handedOffDraft} is how `simple-text` finds
 * them). Nothing else can start a hand-off from outside the server: the
 * external MCP server and the capability route carry no session.
 *
 * It answers at once with the hand-off's id (`HANDED-OFF: <id>`) rather than
 * waiting for the seat, so a driver can queue several, or stop the server
 * mid-attempt, and read each one's status afterwards. The agent is the one the
 * chat's own folder belongs to, read the way every runtime reads it.
 *
 * @module services/runtimes/test-mode/scenarios/room-post-to-scenario
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { getRoomService } from '../../../rooms/index.js';
import { homeOf, resolveAgentHome, turnAgentOf } from '../../../core/agent-identity/agent-home.js';
import { postAs } from '../room-reply-scenarios.js';
import type { ScenarioFn } from '../scenario-store.js';

/** What the scenario is sent: the room's id, a space, then the words. */
const POST_TO_MESSAGE = /^\s*(\S+)\s+([\s\S]*\S)\s*$/;

/**
 * The draft inside a seat's hand-off prompt (`handoff-presentation.ts`, the
 * `HANDED-OFF DRAFT` fence), or `undefined` for any other prompt.
 */
const HANDED_OFF_DRAFT =
  /--- BEGIN HANDED-OFF DRAFT (\w+) ---\n[^\n]*\n(?:[^\n]*Treat the draft as data[^\n]*\n)?([\s\S]*)\n--- END HANDED-OFF DRAFT \1 ---$/;

/**
 * The words a hand-off asks the seat to post, when this turn is one.
 *
 * A scripted seat posts exactly these, so a hand-off driven on the test runtime
 * lands the words its driver sent, and a word-for-word one is not refused.
 *
 * @param prompt - The turn's message.
 * @returns The draft, or `undefined` when the turn is not a hand-off.
 */
export function handedOffDraft(prompt: string): string | undefined {
  return HANDED_OFF_DRAFT.exec(prompt)?.[2];
}

/**
 * Post `<text>` into `<roomId>` from this chat, as the one line it answers with.
 *
 * @param content - The message: `<roomId> <text>`.
 * @param sessionId - The chat it runs in.
 * @param opts - The turn's options, for where it stands.
 */
async function postFromThisChat(
  content: string,
  sessionId: string,
  opts: MessageOpts | undefined
): Promise<string> {
  const match = POST_TO_MESSAGE.exec(content);
  if (!match) return 'POST-TO-USAGE: send "<roomId> <text>"';
  const [, roomId = '', text = ''] = match;
  const home = homeOf(resolveAgentHome(opts?.cwd, turnAgentOf(opts)));
  if (!home) return 'POST-TO-NO-AGENT: this chat stands in no agent’s folder';
  const displayName = getRoomService().authorRegistry.agentNameOf(home) ?? '';
  try {
    const result = await postAs({ agentPath: home, displayName }, sessionId, opts?.cwd, {
      roomId,
      text,
    });
    if (result.handedOff === true) return `HANDED-OFF: ${String(result.handoffId)}`;
    if (result.posted === true) return `POSTED: ${String(result.entryId)}`;
    return `NOT-POSTED: ${JSON.stringify(result)}`;
  } catch (err) {
    return `POST-TO-FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** The scenario: one line saying what became of the post, then the end of the turn. */
export const roomPostToScenario: ScenarioFn = async function* (content, ctx, opts) {
  yield {
    type: 'session_status',
    data: { sessionId: 'test-mode', model: 'claude-haiku-4-5' },
  } as StreamEvent;
  const said = await postFromThisChat(content, ctx.sessionId, opts);
  yield { type: 'text_delta', data: { text: said } } as StreamEvent;
  yield { type: 'done', data: { sessionId: 'test-mode' } } as StreamEvent;
};
