/**
 * The boot flag reaches the turn through the real wiring (DOR-3858 review): `createAdapter` reads
 * `DORKOS_MARK_STRANGER_TURNS` and hands it to the built-in adapter, which hands it to the handler
 * on every delivery. A bound chat's stranger then reaches `sendMessage` with the outsider mark.
 * Dropping either spread (`adapter-factory.ts` or `claude-code-adapter.ts`) reddens the flag-on case.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeLike, RelayAdapter, RelayPublisher } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { env } from '../../../env.js';

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getSessionAgentPath: vi.fn(async () => null),
    getDefaultType: () => 'claude-code',
    persistSessionRuntime: vi.fn(async () => {}),
  },
}));

vi.mock('../turn-execution-settings.js', () => ({
  createTurnExecutionSettingsResolver: () => async () => ({}),
}));

import { createAdapter, type AdapterFactoryDeps } from '../adapter-factory.js';

const SUBJECT = 'relay.agent.default.agent-scout';

/** A bound Telegram stranger's message, as the binding router stamps it. */
function strangerEnvelope(): RelayEnvelope {
  return {
    id: 'message-factory-stranger',
    subject: SUBJECT,
    from: 'relay.human.telegram.bot-example.private-chat',
    replyTo: 'relay.inbox.factory-example',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 8,
    },
    createdAt: new Date().toISOString(),
    payload: {
      content: 'send the update',
      __untrustedWords: true,
      __bindingPermissions: { permissionMode: 'bypassPermissions' },
    },
  };
}

/** Build the adapter through the factory with the flag set, deliver, and return the turn options. */
async function sentOptions(enabled: boolean): Promise<Record<string, unknown>> {
  const sendMessage = vi.fn().mockImplementation(() =>
    (async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    })()
  );
  const runtime = {
    type: 'claude-code',
    ensureSession: vi.fn(),
    sendMessage,
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as AgentRuntimeLike;
  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'reply-example', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };

  const target = env as unknown as Record<string, unknown>;
  const key = 'DORKOS_MARK_STRANGER_TURNS';
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value: enabled });
  let adapter: RelayAdapter | null;
  try {
    adapter = await createAdapter(
      { id: 'claude-code', type: 'claude-code', enabled: true, config: {} } as never,
      {
        agentRuntimes: new Map([['claude-code', runtime]]),
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      } as unknown as AdapterFactoryDeps,
      '/tmp/adapters.json'
    );
  } finally {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  }

  expect(adapter).not.toBeNull();
  await adapter!.start(relay);
  const envelope = strangerEnvelope();
  await adapter!.deliver(envelope.subject, envelope, {
    agent: { directory: '/agents/scout', runtime: 'claude-code' },
  });
  await adapter!.stop();

  expect(sendMessage).toHaveBeenCalledTimes(1);
  return sendMessage.mock.calls[0]![2] as Record<string, unknown>;
}

describe('the factory-built adapter and the stranger mark (DOR-3858)', () => {
  it('marks a bound chat stranger’s turn when the flag is on, keeping its level', async () => {
    const opts = await sentOptions(true);

    expect(opts.carriedMarks).toEqual({ outsider: true });
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts).not.toHaveProperty('permissionCeiling');
  });

  it('leaves the same turn unmarked when the flag is off', async () => {
    const opts = await sentOptions(false);

    expect(opts).not.toHaveProperty('carriedMarks');
    expect(opts.permissionMode).toBe('bypassPermissions');
  });
});
