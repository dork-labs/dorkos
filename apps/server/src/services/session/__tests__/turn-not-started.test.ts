/**
 * A turn the runtime refuses before the agent sees the message settles
 * `failed`, with the runtime's words, so nothing it carried is reported
 * delivered (DOR-2994). Through the real session launch and dispatcher on a
 * `FakeAgentRuntime`: the refusal is an `error` + `done` pair, never a throw,
 * which is exactly the shape that used to read as a turn that ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

import { runtimeRegistry } from '../../core/runtime-registry.js';
import { dispatchSessionMessage } from '../launch/launch-session.js';
import { onDispatchLifecycle, type DispatchLifecycleEvent } from '../message-dispatcher.js';
import { turnNotStarted } from '../launch/turn-not-started.js';

const SESSION = '00000000-0000-4000-8000-0000000000d2';
const REFUSAL = 'Too many chats are holding an agent open right now (the limit is 12).';

let home: string;
let runtime: FakeAgentRuntime;
let settled: DispatchLifecycleEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'turn-not-started-'));
  runtime = new FakeAgentRuntime('fake-refusal');
  runtimeRegistry.setDb(createTestDb());
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('fake-refusal');
  settled = [];
  unsubscribe = onDispatchLifecycle((event) => {
    if (event.phase === 'settled') settled.push(event);
  });
});

afterEach(async () => {
  unsubscribe();
  await rm(home, { recursive: true, force: true });
});

/** Send one chat message; resolves with how its turn settled. */
function send(content: string): Promise<'ok' | 'failed'> {
  return new Promise((resolve, reject) => {
    const mesh = { listWithPaths: () => [{ id: 'agent-juno', name: 'juno', projectPath: home }] };
    dispatchSessionMessage({
      sessionId: SESSION,
      origin: { kind: 'chat-message' },
      request: { content, agentPath: home },
      clientId: 'chat:sender',
      meshCore: mesh as never,
      roomSessionPlace: undefined,
      onSettled: resolve,
    }).catch(reject);
  });
}

describe('a turn the runtime refused before the agent saw it', () => {
  it('settles failed, and says why on the settled event', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield* turnNotStarted(SESSION, REFUSAL, 'cannot warm session: 12 warm sessions already');
      },
    ]);

    expect(await send('hello')).toBe('failed');
    expect(settled).toEqual([expect.objectContaining({ outcome: 'failed', reason: REFUSAL })]);
  });

  it('still settles ok for a turn that ran and then hit an error', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'Working on it' } } as StreamEvent;
        yield { type: 'error', data: { message: 'The model is overloaded.' } } as StreamEvent;
        yield { type: 'done', data: { sessionId: SESSION } } as StreamEvent;
      },
    ]);

    expect(await send('hello')).toBe('ok');
    expect(settled[0]).not.toHaveProperty('reason');
  });
});
