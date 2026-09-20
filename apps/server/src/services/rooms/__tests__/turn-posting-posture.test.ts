/**
 * What a room turn says out loud when the session about to take it has no way
 * to post (spec `tool-only-room-replies` §A2).
 *
 * **This file is about a diagnostic, and that is the whole point of it.** The
 * question used to resolve a REPLY MODE — a session that could not reach the
 * posting tool had its narration posted for it instead — and the honest cost of
 * removing that second delivery is that a wiring gap now looks exactly like an
 * agent exercising judgment. One warn line is what closes the gap, so the line
 * is what is pinned here: which states produce one, and which deliberately do
 * not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { warnIfTurnCannotPost } from '../room-turn-runner.js';

/** A runtime that answers the capability question however a test says. */
function runtimeThat(
  carriesRoomTools: ((session: { cwd: string; sessionId: string }) => Promise<boolean>) | undefined
): Pick<AgentRuntime, 'carriesRoomTools'> {
  return carriesRoomTools === undefined ? {} : { carriesRoomTools };
}

/** Ask about one session, with the given runtime. */
async function ask(runtime: Pick<AgentRuntime, 'carriesRoomTools'>): Promise<void> {
  return warnIfTurnCannotPost({ runtime, cwd: '/agents/ana', sessionId: 'session-1' });
}

describe('warnIfTurnCannotPost', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('says nothing when the session carries the room tools', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await ask(runtimeThat(async () => true));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, naming the reason, when the runtime says the session carries none', async () => {
    // The state an operator has to be able to find: a codex or opencode session
    // in a directory the injection gate did not recognise — a worktree, most
    // often — has no posting verb, so its turn can only end in silence.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await ask(runtimeThat(async () => false));
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0]!;
    expect(message).toContain('no way to post');
    expect(context).toMatchObject({
      sessionId: 'session-1',
      cwd: '/agents/ana',
      reason: expect.stringContaining('does not carry the DorkOS room tools'),
    });
  });

  it('warns when the question throws, because an unanswerable question is not an answer', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await ask(runtimeThat(() => Promise.reject(new Error('the sidecar is not up'))));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ error: 'the sidecar is not up' });
  });

  it('says nothing for a runtime that does not answer the question at all', async () => {
    // "Not implemented" is not a claim that the tools are missing, and warning
    // on every such turn would bury the one line that means something. Every
    // scripted runner in this suite is in exactly this state.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await ask(runtimeThat(undefined));
    expect(warn).not.toHaveBeenCalled();
  });

  it('never refuses the turn, whatever the answer is', async () => {
    // The behaviour this file is the counterpart to: the turn runs either way.
    // It resolves rather than throwing, for every shape above.
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(ask(runtimeThat(async () => false))).resolves.toBeUndefined();
    await expect(
      ask(runtimeThat(() => Promise.reject(new Error('the sidecar is not up'))))
    ).resolves.toBeUndefined();
  });

  it('passes the session it is asking about, not just the directory', async () => {
    // Test-mode answers per SESSION, while the two production runtimes answer
    // per DIRECTORY. Both are handed both.
    const seen: Array<{ cwd: string; sessionId: string }> = [];
    await ask(
      runtimeThat(async (session) => {
        seen.push(session);
        return true;
      })
    );
    expect(seen).toEqual([{ cwd: '/agents/ana', sessionId: 'session-1' }]);
  });
});
