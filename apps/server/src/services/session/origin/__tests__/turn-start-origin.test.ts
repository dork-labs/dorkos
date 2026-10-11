/**
 * Who started the turn running in a chat is decided when that turn STARTS, not
 * when its message was posted (PR 3 review round 2, B1): through the real
 * session launch and dispatcher on a `FakeAgentRuntime`, a person's message
 * queued behind a stranger's running turn must not make that turn read as the
 * person's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TurnOrigin } from '../turn-origin.js';

vi.mock('../../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/boundary.js')>()),
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { dispatchSessionMessage } from '../../launch/launch-session.js';
import { resetOutsiderTurns, turnStartedByOutsider } from '../outsider-turns.js';

const SESSION = '00000000-0000-4000-8000-0000000000c1';

let home: string;
let runtime: FakeAgentRuntime;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'turn-origin-'));
  runtime = new FakeAgentRuntime('fake-origin');
  runtimeRegistry.setDb(createTestDb());
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('fake-origin');
});

afterEach(async () => {
  resetOutsiderTurns();
  await rm(home, { recursive: true, force: true });
});

/** Send one message to the chat, as `origin`; resolves when its turn ends. */
function send(origin: TurnOrigin, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mesh = { listWithPaths: () => [{ id: 'agent-juno', name: 'juno', projectPath: home }] };
    dispatchSessionMessage({
      sessionId: SESSION,
      origin,
      request: { content, agentPath: home },
      clientId: `client-${content}`,
      meshCore: mesh as never,
      roomSessionPlace: undefined,
      onSettled: resolve,
    }).catch(reject);
  });
}

describe('the turn origin', () => {
  it("keeps a stranger's running turn a stranger's while a person's message waits behind it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = vi.fn();
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        started();
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const strangers = send({ kind: 'outside-sender' }, 'from outside');
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(turnStartedByOutsider(SESSION)).toBe(true);

    const persons = send({ kind: 'interactive' }, 'from the person');
    // Give the second send every chance to bind while the first turn runs.
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(turnStartedByOutsider(SESSION)).toBe(true);

    release();
    await strangers;
    await persons;
    expect(turnStartedByOutsider(SESSION)).toBe(false);
  });
});
