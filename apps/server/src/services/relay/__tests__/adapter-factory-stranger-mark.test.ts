/**
 * The boot flag reaches the turn through the real wiring (DOR-3858 review): `createAdapter` reads
 * `DORKOS_MARK_STRANGER_TURNS` and hands it to the built-in adapter, which hands it to the handler
 * on every delivery. A bound chat's stranger then reaches the runtime's `sendMessage` with the
 * outsider mark, through the turn port (T13). Dropping either spread (`adapter-factory.ts` or
 * `claude-code-adapter.ts`) reddens the flag-on case.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AgentRuntimeLike, RelayAdapter, RelayPublisher } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { env } from '../../../env.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { createAdapter, type AdapterFactoryDeps } from '../adapter-factory.js';
import { installRelayPort, uninstallRelayPort } from './relay-port-harness.js';

const AGENT_ID = '01JRZ7SC0VTAGENT0000000000';
const SUBJECT = `relay.agent.default.${AGENT_ID}`;

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

let scout: string;
let runtime: FakeAgentRuntime;

beforeEach(async () => {
  const port = await installRelayPort();
  scout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stranger-scout-')));
  port.standAgent(scout, AGENT_ID);
  runtime = new FakeAgentRuntime('claude-code').withScenarios([
    async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    },
  ]);
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('claude-code');
});

afterEach(() => {
  uninstallRelayPort();
  fs.rmSync(scout, { recursive: true, force: true });
});

/**
 * Build the adapter through the factory, deliver, and return the turn options. Leave `enabled` out
 * to build with this boot's parsed flag, untouched.
 */
async function sentOptions(enabled?: boolean): Promise<Record<string, unknown>> {
  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'reply-example', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };

  const target = env as unknown as Record<string, unknown>;
  const key = 'DORKOS_MARK_STRANGER_TURNS';
  const previous = Object.getOwnPropertyDescriptor(target, key);
  if (enabled !== undefined) {
    Object.defineProperty(target, key, { configurable: true, enumerable: true, value: enabled });
  }
  let adapter: RelayAdapter | null;
  try {
    adapter = await createAdapter(
      { id: 'claude-code', type: 'claude-code', enabled: true, config: {} } as never,
      {
        agentRuntimes: new Map([['claude-code', runtime as unknown as AgentRuntimeLike]]),
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
    agent: { directory: scout, runtime: 'claude-code' },
  });
  await adapter!.stop();

  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  return runtime.sendMessage.mock.calls[0]![2] as Record<string, unknown>;
}

describe('the factory-built adapter and the stranger mark (DOR-3858)', () => {
  // DOR-4453: with nothing set, a bound chat stranger's turn is marked.
  it('marks a bound chat stranger’s turn by default', async () => {
    const opts = await sentOptions();

    expect(env.DORKOS_MARK_STRANGER_TURNS).toBe(true);
    expect(opts.carriedMarks).toEqual({ outsider: true });
    expect(opts.permissionMode).toBe('bypassPermissions');
  });

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
