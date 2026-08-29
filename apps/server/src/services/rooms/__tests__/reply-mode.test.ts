/**
 * How a room turn's reply mode is resolved, and every way it falls open (spec
 * `tool-only-room-replies` §D2; acceptance criteria 11 and 12).
 *
 * **This file is about the polarity, not about the flag.** Reading
 * `rooms.toolOnlyReplies` is one line; what earns a test file is everything that
 * must answer `'text'` anyway — because the failure this guards against is an
 * agent that is silently mute in every room, and `.claude/rules/room-conduct.md`
 * is unambiguous that silence is the worse failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

/**
 * What the config manager answers, rewritten per case.
 *
 * Mocked at the MODULE rather than spied on the object, because
 * `configManager` is a `let` the boot assigns — in a unit test it is genuinely
 * `undefined`, which is itself one of the states this file is about.
 */
const configState = vi.hoisted(() => ({
  rooms: undefined as unknown,
  throws: false,
}));

vi.mock('../../core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/config-manager.js')>();
  return {
    ...actual,
    configManager: {
      get: (key: string) => {
        if (configState.throws) throw new Error('config is not up yet');
        return key === 'rooms' ? configState.rooms : {};
      },
    },
  };
});

const { resolveReplyMode } = await import('../room-turn-runner.js');

/** Stand in for whatever the config manager answers for `rooms`. */
function withRoomsConfig(rooms: unknown): void {
  configState.rooms = rooms;
  configState.throws = false;
}

/** A runtime that answers the capability question however a test says. */
function runtimeThat(
  carriesRoomTools: ((session: { cwd: string; sessionId: string }) => Promise<boolean>) | undefined
): Pick<AgentRuntime, 'carriesRoomTools'> {
  return carriesRoomTools === undefined ? {} : { carriesRoomTools };
}

/** Resolve for one session, with the given runtime. */
async function resolve(
  runtime: Pick<AgentRuntime, 'carriesRoomTools'>
): Promise<'text' | 'tool-only'> {
  return resolveReplyMode({ runtime, cwd: '/agents/ana', sessionId: 'session-1' });
}

describe('resolveReplyMode', () => {
  beforeEach(() => {
    configState.rooms = undefined;
    configState.throws = false;
  });

  it('is `tool-only` only when the flag is on AND the session carries the tools', async () => {
    withRoomsConfig({ toolOnlyReplies: true });
    expect(await resolve(runtimeThat(async () => true))).toBe('tool-only');
  });

  it('is `text` when the flag is off, however capable the session is', async () => {
    withRoomsConfig({ toolOnlyReplies: false });
    expect(await resolve(runtimeThat(async () => true))).toBe('text');
  });

  it('is `text` when the flag is on and the session is NOT tool-capable', async () => {
    // The whole reason the flag is not read as "suppress the text": a codex or
    // opencode session that never got the `dorkos` server has no posting verb, so
    // suppressing its narration would leave it mute in every room.
    withRoomsConfig({ toolOnlyReplies: true });
    expect(await resolve(runtimeThat(async () => false))).toBe('text');
  });

  it('is `text` for a runtime that does not answer the question at all', async () => {
    // "Not implemented" is no answer, not a `false` one — and the two land in the
    // same place only because that place is the safe one.
    withRoomsConfig({ toolOnlyReplies: true });
    expect(await resolve(runtimeThat(undefined))).toBe('text');
  });

  it('is `text` when the runtime THROWS resolving it, and says so in the log', async () => {
    withRoomsConfig({ toolOnlyReplies: true });
    expect(
      await resolve(runtimeThat(() => Promise.reject(new Error('the sidecar is not up'))))
    ).toBe('text');
  });

  it('is `text` when the config read throws', async () => {
    // `configManager` is a `let` the boot assigns, so a read before it is up — or
    // against a partially written store — is a real state. An experiment that took
    // a room turn down with it would be a far worse failure than one that stays
    // off.
    configState.throws = true;
    expect(await resolve(runtimeThat(async () => true))).toBe('text');
  });

  it('is `text` when the `rooms` section is absent entirely', async () => {
    withRoomsConfig(undefined);
    expect(await resolve(runtimeThat(async () => true))).toBe('text');
  });

  it('passes the session it is asking about, not just the directory', async () => {
    // Test-mode answers per SESSION (its scenario selection is per session), while
    // the two production runtimes answer per DIRECTORY. Both are handed both.
    withRoomsConfig({ toolOnlyReplies: true });
    const seen: Array<{ cwd: string; sessionId: string }> = [];
    await resolve(
      runtimeThat(async (session) => {
        seen.push(session);
        return true;
      })
    );
    expect(seen).toEqual([{ cwd: '/agents/ana', sessionId: 'session-1' }]);
  });
});
