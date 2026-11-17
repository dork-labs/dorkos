import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { MessageQueueStore, toQueuedMessage } from '../message-queue-store.js';

describe('a paused row’s composer restoration verdict', () => {
  it.each([
    ['web-window', false, true],
    ['web-window', true, false],
    ['heartbeat', false, false],
    ['todos', false, false],
    ['extension:flow', false, false],
  ] as const)('%s with heldToDefault=%s restores=%s', (clientId, heldToDefault, allowed) => {
    const store = new MessageQueueStore(createTestDb());
    const row = store.enqueue({
      sessionId: 'demo',
      clientId,
      content: 'Keep these words',
      heldToDefault,
    });
    const view = toQueuedMessage(row) as ReturnType<typeof toQueuedMessage> & {
      canRestoreToComposer?: boolean;
    };
    expect(view.canRestoreToComposer === true).toBe(allowed);
    expect(view).not.toHaveProperty('heldToDefault');
  });
});
