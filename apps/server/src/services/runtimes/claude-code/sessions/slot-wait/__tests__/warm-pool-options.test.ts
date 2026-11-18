import { describe, it, expect } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';

import { waitsBehindReclaimGrace, warmPoolOptions } from '../warm-pool-options.js';

describe('waitsBehindReclaimGrace (DOR-4498)', () => {
  // Purpose: only work KNOWN to be an agent's waits behind a busy lane's grace.
  it.each([
    ['another agent', { turnStarter: 'agent' }],
    ['a chat_send from an agent', { turnStarter: 'agent-message' }],
    ['a burst of room posts', { turnStarter: 'room-messages' }],
    ['a stranger', { turnStarter: 'outside-message' }],
    ['a webhook', { turnStarter: 'webhook' }],
    ['an agent post in a room', { roomTurn: { turnStarter: 'agent' } }],
    ['a scheduled task', { contextPlace: 'task' }],
    ['a heartbeat', { contextPlace: 'heartbeat' }],
  ] as const)('waits for %s', (_label, opts) => {
    expect(waitsBehindReclaimGrace(opts as MessageOpts)).toBe(true);
  });

  // Purpose: a person, or a turn nothing marks as an agent's, never waits. The
  // app's own message route sets no starter, and a direct Telegram or Slack
  // turn carries only `unattendedApprovals`, so both land here.
  it.each([
    ['a person in the app', { turnStarter: 'person' }],
    ['a person on Telegram', { turnStarter: 'telegram' }],
    ['a person on Slack', { turnStarter: 'slack' }],
    ['the owner in a room', { roomTurn: { turnStarter: 'person' } }],
    ['a starter DorkOS could not place', { turnStarter: 'unknown' }],
    ['the app message route (no starter)', {}],
    ['a chat binding turn', { unattendedApprovals: true }],
    ['no options at all', undefined],
  ] as const)('does not wait for %s', (_label, opts) => {
    expect(waitsBehindReclaimGrace(opts as MessageOpts | undefined)).toBe(false);
  });
});

describe('warmPoolOptions', () => {
  // Purpose: the closures read the turn that is opening NOW, not the one the
  // session was first warmed for.
  it('reads the opening turn at call time', () => {
    const bundle: { slotWait?: { notify: () => void; personTurn: boolean } } = {};
    const options = warmPoolOptions(bundle);
    let told = 0;

    expect(options.skipReclaimGrace()).toBe(false);
    bundle.slotWait = { notify: () => (told += 1), personTurn: true };
    expect(options.skipReclaimGrace()).toBe(true);
    options.onWaitingForSlot();
    expect(told).toBe(1);
  });
});
