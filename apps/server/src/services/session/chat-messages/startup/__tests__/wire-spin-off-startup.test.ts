import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { MessageQueueStore, setMessageQueueStore } from '../../../message-queue-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  rekeyProjector,
} from '../../../session-state-projector.js';
import { getSpinOffStartup, SPIN_OFF_START_TIMEOUT_MS } from '../spin-off-startup.js';
import { startupFailureReason, wireSpinOffStartup } from '../wire-spin-off-startup.js';

let stop: () => void;
let report: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  report = vi.fn().mockResolvedValue(undefined);
  stop = wireSpinOffStartup({ onNeverStarted: report });
});
afterEach(() => {
  stop();
  disposeProjector('startup-request');
  disposeProjector('startup-canonical');
  setMessageQueueStore(undefined);
  vi.useRealTimers();
});

describe('startup monitoring in production wiring', () => {
  it('reports the durable first message still waiting in the queue', async () => {
    const queue = new MessageQueueStore(createTestDb());
    setMessageQueueStore(queue);
    queue.enqueue({ sessionId: 'startup-request', content: 'Made-up task', clientId: 'test' });
    getSpinOffStartup()!.watch('startup-request', '/demo/agent');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'startup-request',
      'The first message is still queued.',
      {}
    );
  });

  it('reports the observed runtime error instead of guessing why it did not start', async () => {
    getSpinOffStartup()!.watch('startup-request', '/demo/agent');
    getOrCreateProjector('startup-request').ingest({
      type: 'error',
      message: 'Runtime unavailable.',
    });
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(report).toHaveBeenCalledExactlyOnceWith('startup-request', 'Runtime unavailable.', {});
  });

  it('keeps the first deadline and diagnostic across a real projector rename', async () => {
    getSpinOffStartup()!.watch('startup-request', '/demo/agent');
    const projector = getOrCreateProjector('startup-request');
    projector.ingest({ type: 'error', message: 'Account unavailable.' });
    await vi.advanceTimersByTimeAsync(1000);
    rekeyProjector('startup-request', 'startup-canonical');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 1000);
    expect(report).toHaveBeenCalledExactlyOnceWith('startup-canonical', 'Account unavailable.', {});
    expect(getSpinOffStartup()!.failureOf('startup-canonical')).toBe('Account unavailable.');
  });

  it('uses an honest fallback when no runtime or queue diagnostic exists', () => {
    expect(startupFailureReason('unknown')).toBe(
      'The runtime did not start its first turn within five minutes.'
    );
  });
});
