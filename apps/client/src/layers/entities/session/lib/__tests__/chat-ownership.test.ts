import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import type { SessionOrigin } from '@dorkos/shared/types';
import {
  chatOwnership,
  nonAutomatedSessionIds,
  partitionSessionsByOwnership,
} from '../chat-ownership';

const TOUCHED = '2026-10-08T09:00:00.000Z';

describe('chatOwnership', () => {
  it('a chat a person started is yours', () => {
    expect(chatOwnership(createMockSession({ id: 'a' }))).toBe('yours');
    expect(chatOwnership(createMockSession({ id: 'b', origin: 'user' }))).toBe('yours');
  });

  it.each([
    'agent',
    'channel',
    'task',
    'external',
    'room',
  ] as const satisfies readonly SessionOrigin[])(
    'an untouched origin=%s chat is automated',
    (origin) => {
      expect(chatOwnership(createMockSession({ id: 'x', origin }))).toBe('automated');
    }
  );

  it('a room-born chat you typed in counts as yours', () => {
    // The server restores your own write time on a room chat (D5); a room
    // turn relayed by another agent never sets it.
    const typedIn = createMockSession({ id: 'r', origin: 'room', userLastMessageAt: TOUCHED });
    expect(chatOwnership(typedIn)).toBe('yours');
  });

  it('a room-born chat you opened counts as yours', () => {
    const opened = createMockSession({ id: 'r', origin: 'room', lastTouchedByYouAt: TOUCHED });
    expect(chatOwnership(opened)).toBe('yours');
  });

  it('an untouched chat another chat started is a spin-off', () => {
    const spinOff = createMockSession({
      id: 'h',
      startedBy: { kind: 'chat', sessionId: 'p', title: null, reason: null, permission: null },
    });
    expect(chatOwnership(spinOff)).toBe('spinOff');
    expect(chatOwnership({ ...spinOff, lastTouchedByYouAt: TOUCHED })).toBe('yours');
  });

  it('an untouched extension-started chat is automated even with a user origin', () => {
    const ext = createMockSession({
      id: 'e',
      startedBy: { kind: 'extension', extensionId: 'flow', extensionName: 'Flow', reason: 'r' },
    });
    expect(chatOwnership(ext)).toBe('automated');
  });
});

describe('partitionSessionsByOwnership', () => {
  it('returns every bucket empty for an empty input', () => {
    expect(partitionSessionsByOwnership([])).toEqual({ yours: [], spinOffs: [], automated: [] });
  });

  it('splits a mixed list, preserving relative order within each bucket', () => {
    const sessions = [
      createMockSession({ id: '1', origin: 'agent' }),
      createMockSession({ id: '2' }),
      createMockSession({ id: '3', origin: 'task' }),
      createMockSession({
        id: '4',
        startedBy: { kind: 'chat', sessionId: '2', title: null, reason: null, permission: null },
      }),
      createMockSession({ id: '5', origin: 'room', lastTouchedByYouAt: TOUCHED }),
    ];
    const result = partitionSessionsByOwnership(sessions);
    expect(result.yours.map((s) => s.id)).toEqual(['2', '5']);
    expect(result.spinOffs.map((s) => s.id)).toEqual(['4']);
    expect(result.automated.map((s) => s.id)).toEqual(['1', '3']);
  });
});

describe('nonAutomatedSessionIds', () => {
  it('drops automated chats only; spin-offs and unknown ids stay live', () => {
    const sessions = [
      createMockSession({ id: 'task', origin: 'task' }),
      createMockSession({
        id: 'spinOff',
        startedBy: { kind: 'chat', sessionId: 'mine', title: null, reason: null, permission: null },
      }),
      createMockSession({ id: 'mine' }),
    ];
    expect(nonAutomatedSessionIds(['task', 'spinOff', 'mine', 'unknown'], sessions)).toEqual([
      'spinOff',
      'mine',
      'unknown',
    ]);
  });
});
