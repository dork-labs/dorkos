/**
 * Who a spin-off reports to, past account moves on either side (spec
 * `spin-off-chats` §5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  SessionStartedByStore,
  setSessionStartedByStore,
} from '../../origin/session-started-by-store.js';
import { reportTargetOf } from '../chat-message-wiring.js';

let store: SessionStartedByStore;
let clock = 0;
const start = (sessionId: string, from: string, over: Record<string, unknown> = {}) =>
  store.insert({
    sessionId,
    kind: 'chat',
    extensionId: null,
    startedBySessionId: from,
    originExtensionId: null,
    reason: null,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0, clock++)).toISOString(),
    ...over,
  });

beforeEach(() => {
  store = new SessionStartedByStore(createTestDb());
  setSessionStartedByStore(store);
});
afterEach(() => setSessionStartedByStore(undefined));

describe('reportTargetOf', () => {
  it('is the chat that started it', () => {
    start('child', 'parent');
    expect(reportTargetOf('child')).toEqual({ parentSessionId: 'parent' });
  });

  it('is nobody for a chat nobody started, an extension start, or reportBack off', () => {
    expect(reportTargetOf('stranger')).toBeNull();
    store.insert({
      sessionId: 'ext',
      kind: 'extension',
      extensionId: 'flow',
      startedBySessionId: null,
      originExtensionId: 'flow',
      reason: null,
      createdAt: '2026-10-09T12:00:00.000Z',
    });
    expect(reportTargetOf('ext')).toBeNull();
    start('quiet', 'parent', { reportBack: false });
    expect(reportTargetOf('quiet')).toBeNull();
  });

  it('reports for the chat a carried chat replaced, to that chat’s starter', () => {
    start('child', 'parent');
    // The child hit its limit and was carried to account B.
    start('child-on-b', 'child', { carried: true });
    expect(reportTargetOf('child-on-b')).toEqual({ parentSessionId: 'parent' });
  });

  it('reports to where the parent was carried, not to the chat on the exhausted account', () => {
    start('child', 'parent');
    start('parent-on-b', 'parent', { carried: true });
    expect(reportTargetOf('child')).toEqual({ parentSessionId: 'parent-on-b' });
  });
});
