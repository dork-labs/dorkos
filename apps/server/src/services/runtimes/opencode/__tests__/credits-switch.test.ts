/**
 * A turn that arrives while OpenCode is waiting to switch between its own
 * sign-in and DorkOS credits (ADR 261002-221210): refused with the plain
 * sentence, and nothing sent or started.
 */
import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { OpenCodeSwitchPendingError } from '../credits-sidecar.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';

describe('a turn while OpenCode waits to switch sides', () => {
  it('is refused in words, and sends nothing', async () => {
    const promptAsync = vi.fn();
    const create = vi.fn();
    const client = { session: { promptAsync, create } };
    const provider: OpenCodeClientProvider = {
      getClient: vi.fn(async () => client as never),
      peekClient: () => null,
      prepareTurn: async () => {
        throw new OpenCodeSwitchPendingError('own', 'credits');
      },
      setBusyProbe: vi.fn(),
      turnSettled: vi.fn(async () => {}),
    };
    const runtime = new OpenCodeRuntime({ provider });
    expect(provider.setBusyProbe).toHaveBeenCalledOnce();
    runtime.ensureSession('s1', { permissionMode: 'default', cwd: '/repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const createdBefore = create.mock.calls.length;
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage('s1', 'hello', { cwd: '/repo' })) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: 'error',
        data: {
          message:
            "OpenCode is still finishing a reply on your own sign-in, so it can't move to DorkOS credits yet and nothing was sent. Send this again once that reply is done.",
          code: 'runtime_switch_pending',
          category: 'execution_error',
        },
      },
    ]);
    // Nothing was sent, and the refused turn created nothing either.
    expect(promptAsync).not.toHaveBeenCalled();
    expect(create.mock.calls.length).toBe(createdBefore);
    expect(runtime.hasRunningTurns()).toBe(false);
  });
});
