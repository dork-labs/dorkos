/**
 * Whether a tool call comes from a scheduled run (DOR-3703, M7): the run's own
 * chat, a spin-off it started, and a chat whose turn its message started, at
 * any distance.
 *
 * @module services/tasks/agent-mode/__tests__/agent-mode-run-origin
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { logger } from '../../../../lib/logger.js';
import {
  noteRunSession,
  endRunSessions,
  resetActiveRunSessions,
} from '../../session/active-run-sessions.js';
import {
  noteChatTurnStarted,
  noteRoomTurnWakers,
  noteSteeredInto,
  resetChatStartedTurns,
} from '../../../session/chat-messages/chat-started-turns.js';
import {
  liveRunOriginSources,
  startedByScheduledRun,
  turnStarterOf,
  type RunOriginSources,
} from '../agent-mode-run-origin.js';

/** A run's chat, a spin-off it started, and a chat that spin-off messaged. */
function sources(): RunOriginSources {
  const parents: Record<string, string> = { 'ses-spinoff': 'ses-run' };
  const senders: Record<string, string[]> = { 'ses-own': ['ses-spinoff'] };
  return {
    runSessions: (ids) => new Set(ids.filter((id) => id === 'ses-run')),
    startedBy: (id) => parents[id] ?? null,
    turnSenders: (id) => senders[id] ?? [],
  };
}

describe('a turn a scheduled run started (M7)', () => {
  it('counts the run, its session_start spin-off, and a chat a chat_send from it started', () => {
    expect(startedByScheduledRun(['ses-run'], sources())).toBe(true);
    expect(startedByScheduledRun(['ses-spinoff'], sources())).toBe(true);
    expect(startedByScheduledRun(['ses-own'], sources())).toBe(true);
  });

  it('does not count a chat a person started', () => {
    expect(startedByScheduledRun(['ses-person'], sources())).toBe(false);
  });

  it('names who started the turn for the notice', () => {
    const base = { structural: true, marked: false } as const;
    expect(turnStarterOf({ ...base, sessionId: 'ses-x', scheduledRun: true }, sources())).toBe(
      'a scheduled run'
    );
    expect(turnStarterOf({ ...base, sessionId: 'ses-own' }, sources(), () => null)).toBe(
      'a message from another chat'
    );
    expect(
      turnStarterOf({ ...base, sessionId: 'ses-ext' }, sources(), () => ({
        kind: 'extension',
        extensionId: 'mini-apps',
      }))
    ).toBe('the mini-apps extension');
    expect(turnStarterOf({ ...base, sessionId: 'ses-person' }, sources(), () => null)).toBe('you');
  });

  it('fails closed when the store cannot say which chats are scheduled runs', () => {
    const noLookup = liveRunOriginSources({} as never);
    expect(startedByScheduledRun(['ses-person'], noLookup)).toBe(true);
    const throws = liveRunOriginSources({
      resolveTaskOrigins: () => {
        throw new Error('the database is closed');
      },
    } as never);
    expect(startedByScheduledRun(['ses-person'], throws)).toBe(true);
    const answers = liveRunOriginSources({ resolveTaskOrigins: () => new Map() } as never);
    expect(startedByScheduledRun(['ses-person'], answers)).toBe(false);
  });

  describe('a run that is running now, and the hops from it (M-A, Should 3)', () => {
    afterEach(() => {
      resetActiveRunSessions();
      resetChatStartedTurns();
    });
    const live = () => liveRunOriginSources({ resolveTaskOrigins: () => new Map() } as never);

    it('counts a running run’s chat before its row knows it, and not once it ended', () => {
      noteRunSession('run-1', 'ses-run');
      expect(startedByScheduledRun(['ses-run'], live())).toBe(true);
      endRunSessions('run-1');
      expect(startedByScheduledRun(['ses-run'], live())).toBe(false);
    });

    it('still knows a running run’s chat, and lets the run go on, when its row cannot be written', () => {
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const updateRun = vi.fn(() => {
        throw new Error('the database is busy');
      });
      expect(() =>
        noteRunSession('run-1', 'ses-run', undefined, { updateRun } as never)
      ).not.toThrow();
      expect(startedByScheduledRun(['ses-run'], live())).toBe(true);
      expect(updateRun).toHaveBeenCalledTimes(2);
      expect(logged).toHaveBeenCalledOnce();
      logged.mockRestore();
    });

    it('tries a run’s row write once more, and logs nothing when the retry lands', () => {
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const updateRun = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('the database is busy');
        })
        .mockReturnValue(null);
      noteRunSession('run-1', 'ses-run', undefined, { updateRun } as never);
      expect(updateRun).toHaveBeenCalledTimes(2);
      expect(updateRun).toHaveBeenLastCalledWith('run-1', { sessionId: 'ses-run' });
      expect(logged).not.toHaveBeenCalled();
      logged.mockRestore();
    });

    it('counts a chat a running run steered into', () => {
      noteRunSession('run-1', 'ses-run');
      noteSteeredInto('ses-own', ['ses-run']);
      expect(startedByScheduledRun(['ses-own'], live())).toBe(true);
    });

    it('counts run → room post → another agent’s room turn → chat_send to the task’s agent', () => {
      noteRunSession('run-1', 'ses-run');
      noteRoomTurnWakers('ses-other-agent', ['ses-run', null]);
      noteChatTurnStarted('ses-own', Date.now(), [{ fromSessionId: 'ses-other-agent' }]);
      expect(startedByScheduledRun(['ses-own'], live())).toBe(true);
      // A room turn a person's post woke carries nothing.
      noteRoomTurnWakers('ses-person-woke', [null]);
      expect(startedByScheduledRun(['ses-person-woke'], live())).toBe(false);
    });
  });
});
