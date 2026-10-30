import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

vi.mock('../../../session/launch/launch-session.js', () => ({
  agentLaunchMaxLive: () => 14,
}));

import { describeCapacity } from '../describe-capacity.js';

describe('describeCapacity', () => {
  it('reports the cap, the load and the free disk', async () => {
    const capacity = await describeCapacity(os.tmpdir());
    expect(capacity.maxAgentChats).toBe(14);
    expect(capacity.freeDiskBytes).toBeGreaterThan(0);
    expect(capacity.loadAverage).toBeGreaterThanOrEqual(0);
  });

  it('answers null for a disk it cannot read, rather than failing the config read', async () => {
    const capacity = await describeCapacity('/no/such/folder/anywhere');
    expect(capacity.freeDiskBytes).toBeNull();
  });
});
