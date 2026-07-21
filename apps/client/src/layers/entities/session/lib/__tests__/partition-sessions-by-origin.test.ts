import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import type { SessionOrigin } from '@dorkos/shared/types';
import { partitionSessionsByOrigin } from '../partition-sessions-by-origin';

describe('partitionSessionsByOrigin', () => {
  it('returns both buckets empty for an empty input', () => {
    expect(partitionSessionsByOrigin([])).toEqual({ conversations: [], automated: [] });
  });

  it('puts every session into conversations when all are user-origin', () => {
    const sessions = [
      createMockSession({ id: 'a' }),
      createMockSession({ id: 'b', origin: 'user' }),
    ];
    const result = partitionSessionsByOrigin(sessions);
    expect(result.conversations.map((s) => s.id)).toEqual(['a', 'b']);
    expect(result.automated).toEqual([]);
  });

  it('splits a mixed list, preserving relative order within each bucket', () => {
    const sessions = [
      createMockSession({ id: '1', origin: 'agent' }),
      createMockSession({ id: '2' }),
      createMockSession({ id: '3', origin: 'task' }),
      createMockSession({ id: '4', origin: 'user' }),
      createMockSession({ id: '5', origin: 'channel' }),
    ];
    const result = partitionSessionsByOrigin(sessions);
    expect(result.conversations.map((s) => s.id)).toEqual(['2', '4']);
    expect(result.automated.map((s) => s.id)).toEqual(['1', '3', '5']);
  });

  it('treats an absent origin the same as origin="user"', () => {
    const undefinedOrigin = createMockSession({ id: 'no-origin' });
    const explicitUser = createMockSession({ id: 'explicit-user', origin: 'user' });
    const result = partitionSessionsByOrigin([undefinedOrigin, explicitUser]);
    expect(result.conversations).toEqual([undefinedOrigin, explicitUser]);
    expect(result.automated).toEqual([]);
  });

  it.each(['agent', 'channel', 'task', 'external'] as const satisfies readonly SessionOrigin[])(
    'buckets origin=%s into automated',
    (origin) => {
      const session = createMockSession({ id: 'x', origin });
      const result = partitionSessionsByOrigin([session]);
      expect(result.automated).toEqual([session]);
      expect(result.conversations).toEqual([]);
    }
  );
});
