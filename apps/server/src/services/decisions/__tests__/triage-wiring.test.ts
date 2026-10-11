/**
 * The server's own credits triage reads the real switches (spec `heartbeats`
 * §6.3): the person's choice in config, `DORKOS_CLOUD_CREDITS` through
 * `credits-availability`, the link, the held token and the recommended model.
 * The cloud modules are mocked and `fetch` refuses, so nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  choice: null as boolean | null,
  killed: false,
  linked: true,
  served: ['openaiChat'] as string[],
}));

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: () => ({ enabled: true, triageOnCredits: state.choice }) },
}));
vi.mock('../../core/cloud/credits-availability.js', () => ({
  creditsKilled: () => state.killed,
  creditsCanBeHad: () => !state.killed && state.linked,
}));
vi.mock('../../core/cloud/credits-inference.js', () => ({
  heldCreditsToken: () => ({
    token: 'dk-test',
    endpoints: { openaiChat: 'https://credits.test/v1' },
    served: state.served,
  }),
}));
vi.mock('../../core/cloud/credits-models.js', () => ({
  creditsModelsFor: async () => [
    { id: 'big-1', recommendedOn: [] },
    { id: 'small-1', recommendedOn: ['openaiChat'] },
  ],
}));

import { startHeartbeatTriage, stopHeartbeatTriage } from '../triage-wiring.js';
import { triageBeat } from '../heartbeat-triage.js';
import { COMMITS } from './triage-fakes.js';

beforeEach(() => {
  Object.assign(state, { choice: null, killed: false, linked: true, served: ['openaiChat'] });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
});

afterEach(() => {
  stopHeartbeatTriage();
  vi.restoreAllMocks();
});

describe('startHeartbeatTriage', () => {
  it('builds no bridge until the person said yes', async () => {
    const triage = startHeartbeatTriage();
    expect(await triage.bridge()).toBeUndefined();
    state.choice = false;
    expect(await triage.bridge()).toBeUndefined();
  });

  it('builds the bridge on the recommended chat model once they did', async () => {
    state.choice = true;
    const bridge = await startHeartbeatTriage().bridge();
    expect(bridge?.model.id).toBe('dorkos-credits:small-1');
  });

  it('never with the kill switch on, whatever the person chose', async () => {
    state.choice = true;
    state.killed = true;
    const triage = startHeartbeatTriage();
    expect(await triage.bridge()).toBeUndefined();
    expect(await triage.source()).toEqual({ runsOn: 'runtime', reason: 'switched-off' });
  });

  it('hands triageBeat its credits bridge, and a failed request is a turn', async () => {
    state.choice = true;
    startHeartbeatTriage();
    const outcome = await triageBeat([COMMITS], {
      agentName: 'Juno',
      checklist: null,
      rules: 'undecided',
    });
    expect(outcome.source).toBe('credits');
    expect(outcome.decision).toBe('turn');
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
