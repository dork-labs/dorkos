/**
 * Loading the instance-key module moves the agent computer's key out of
 * `process.env` and into its process-wide slot, so no child process started
 * afterwards inherits it (DOR-2940 part 9).
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => 'agent-computer' }));

const KEY = 'computer-key-from-the-environment';
const SLOT = Symbol.for('dorkos.env.agentComputerInstanceKey');
const slot = globalThis as typeof globalThis & { [SLOT]?: string };

afterEach(() => {
  vi.unstubAllEnvs();
  delete slot[SLOT];
});

describe('loading the instance-key module', () => {
  it('moves the key out of the environment and into the slot', async () => {
    delete slot[SLOT];
    vi.stubEnv('DORKOS_AGENT_COMPUTER_INSTANCE_KEY', KEY);
    vi.resetModules();
    const { agentComputerInstanceKey } = await import('../instance-key.js');

    expect('DORKOS_AGENT_COMPUTER_INSTANCE_KEY' in process.env).toBe(false);
    expect(slot[SLOT]).toBe(KEY);
    expect(agentComputerInstanceKey()).toBe(KEY);
  });

  it('keeps a key another reader already moved into the slot', async () => {
    slot[SLOT] = KEY;
    vi.resetModules();
    const { agentComputerInstanceKey } = await import('../instance-key.js');
    expect(agentComputerInstanceKey()).toBe(KEY);
  });
});
