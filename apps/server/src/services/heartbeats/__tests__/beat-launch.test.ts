/**
 * The real beat launch, through the session launch service, on a
 * `FakeAgentRuntime` (spec `heartbeats` §7.1, §7.2): the beat chat is bound
 * with the `heartbeat` origin, the turn runs on the agent's own runtime, and
 * `onSettled` fires when it ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

import { runtimeRegistry } from '../../core/runtime-registry.js';
import { createBeatTurnLauncher } from '../beat-launch.js';
import { isBeatTurn, registerBeatTurn, resetBeatTurns } from '../beat-turns.js';
import { dispatchSessionMessage } from '../../session/launch/launch-session.js';

let db: Db;
let home: string;
let runtime: FakeAgentRuntime;

beforeEach(async () => {
  db = createTestDb();
  home = await mkdtemp(join(tmpdir(), 'beat-launch-'));
  runtime = new FakeAgentRuntime('fake-beat');
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('fake-beat');
});

afterEach(async () => {
  resetBeatTurns();
  await rm(home, { recursive: true, force: true });
});

describe('createBeatTurnLauncher', () => {
  it('starts the turn on the agent’s runtime, binds the chat as a heartbeat, and settles', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'checked' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const settled = new Promise<string>((resolve) => {
      const mesh = { listWithPaths: () => [{ id: 'agent-juno', name: 'juno', projectPath: home }] };
      void createBeatTurnLauncher(() => mesh as never)
        .launch({
          sessionId: '00000000-0000-4000-8000-0000000000b1',
          messageId: 'beat-message-1',
          agentPath: home,
          runtime: 'fake-beat',
          content: 'This is a heartbeat, not a message from a person.',
          onSettled: resolve,
        })
        .then((result) => expect(result.status).toBe('started'));
    });
    expect(await settled).toBe('ok');
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'This is a heartbeat, not a message from a person.',
      expect.anything()
    );
    const [row] = db.select().from(sessionMetadata).all();
    expect(row).toMatchObject({ runtime: 'fake-beat', launchOrigin: 'heartbeat' });
  });

  it('names the agent’s runtime, so the launch never falls back to the default one', async () => {
    const fallback = new FakeAgentRuntime('fake-default');
    runtimeRegistry.register(fallback);
    runtimeRegistry.setDefault('fake-default');
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const mesh = { listWithPaths: () => [{ id: 'agent-juno', name: 'juno', projectPath: home }] };
    await new Promise<string>((resolve) => {
      void createBeatTurnLauncher(() => mesh as never).launch({
        sessionId: '00000000-0000-4000-8000-0000000000b2',
        messageId: 'beat-message-2',
        agentPath: home,
        runtime: 'fake-beat',
        content: 'A heartbeat.',
        onSettled: resolve,
      });
    });
    expect(runtime.sendMessage).toHaveBeenCalled();
    expect(fallback.sendMessage).not.toHaveBeenCalled();
  });

  it("makes a beat chat's turn somebody's own once a message that is not the beat's arrives", async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    await dispatchSessionMessage({
      sessionId: 'beat-chat',
      origin: { kind: 'interactive' },
      request: { content: 'Actually, skip the invoices today.', agentPath: '/not/an/agent' },
      clientId: 'window-1',
      meshCore: undefined,
      roomSessionPlace: undefined,
    });
    expect(isBeatTurn('beat-chat')).toBe(false);
  });
});
