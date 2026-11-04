/** The same registration seam covers every runtime; no native process or model. */
import { describe, expect, it, vi } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { activeTurnStarterOf, recordTurnStarters } from '../active-turn-starter.js';

it.each(['claude-code', 'codex', 'opencode', 'doe', 'sample-future-runtime'])(
  'the registration seam tracks %s sends',
  async (type) => {
    const seen: (string | undefined)[] = [];
    const runtime = new FakeAgentRuntime(type);
    runtime.sendMessage = vi.fn().mockImplementation(async function* (id: string) {
      seen.push(activeTurnStarterOf(id));
      yield { type: 'done', data: {} } as StreamEvent;
    });
    const registry = new RuntimeRegistry();
    registry.setDb(createTestDb());
    registry.register(runtime);
    const registered = registry.get(type);
    for await (const _ of registered.sendMessage('sample', 'Read the sample list.', {
      turnStarter: 'telegram',
    })) {
      /* consume */
    }
    expect(activeTurnStarterOf('sample')).toBeUndefined();
    for await (const _ of registered.sendMessage('sample', 'Read it again.')) {
      /* consume */
    }
    expect(seen).toEqual(['a Telegram message', 'something DorkOS couldn’t identify']);
    expect(activeTurnStarterOf('sample')).toBeUndefined();
  }
);

describe('the display decorator', () => {
  it.each(['sendMessage', 'executeCommandIntent'] as const)(
    'preserves %s arguments and native call timing',
    async (method) => {
      const runtime = new FakeAgentRuntime();
      const call = vi.fn().mockImplementation(() =>
        (async function* () {
          expect(activeTurnStarterOf('sample')).toBe('a Slack message');
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      );
      if (method === 'sendMessage') runtime.sendMessage.mockImplementation(call);
      else runtime.executeCommandIntent.mockImplementation(call);
      const wrapped = recordTurnStarters(runtime);
      const opts: MessageOpts = {
        turnStarter: 'slack',
        permissionMode: 'plan',
        permissionCeiling: 'runtime-default',
      };
      const stream = wrapped[method]('sample', 'compact', opts);
      expect(call).toHaveBeenCalledOnce();
      expect(call.mock.calls[0]).toEqual(['sample', 'compact', opts]);
      expect(call.mock.calls[0]?.[2]).toBe(opts);
      for await (const _ of stream) {
        /* consume */
      }
      expect(activeTurnStarterOf('sample')).toBeUndefined();
    }
  );
});

it('reads the room marker on the same send without using room text', async () => {
  const runtime = new FakeAgentRuntime();
  runtime.sendMessage = vi.fn().mockImplementation(async function* (id: string) {
    expect(activeTurnStarterOf(id)).toBe('a Slack message');
    yield { type: 'done', data: {} } as StreamEvent;
  });
  const wrapped = recordTurnStarters(runtime);
  for await (const _ of wrapped.sendMessage('sample', 'Started by you', {
    roomTurn: {
      roomId: 'sample-room',
      authorId: 'sample-agent',
      turnId: 'sample-turn',
      turnStarter: 'slack',
    },
  })) {
    /* consume */
  }
  expect(activeTurnStarterOf('sample')).toBeUndefined();
});
