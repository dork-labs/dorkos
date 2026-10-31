/** Path trust reads the level on the agent's own runtime, not the server's default (DOR-3440). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAtFullNow } from '../path-trust-edits.js';

const defaults = vi.hoisted(() => ({ runtime: undefined as string | undefined }));
const launchLevel = vi.hoisted(() => vi.fn());

vi.mock('../../../session/resolution/resolve-session-defaults.js', () => ({
  readAgentExecutionDefaults: async () => defaults,
}));
vi.mock('../../../session/resolution/agent-launch-level.js', () => ({
  resolveAgentLaunchLevel: launchLevel,
}));
vi.mock('../../../core/runtime-registry.js', () => {
  const modes = (full: string) => ({
    permissionModes: {
      default: 'ask',
      values: [
        { id: 'ask', asks: 'always', reach: 'edit' },
        { id: full, asks: 'never', reach: 'everything' },
      ],
    },
  });
  return {
    runtimeRegistry: {
      getDefaultType: () => 'claude-code',
      getAllCapabilities: () => ({ 'claude-code': modes('bypass'), codex: modes('danger') }),
    },
  };
});

describe('agentAtFullNow', () => {
  beforeEach(() => {
    defaults.runtime = undefined;
  });

  it('reads the mode against the agent’s own runtime', async () => {
    defaults.runtime = 'codex';
    launchLevel.mockResolvedValue({ mode: 'danger' });
    expect(await agentAtFullNow('/a')).toBe(true);
    // The same mode id means nothing on the server's default runtime.
    defaults.runtime = undefined;
    expect(await agentAtFullNow('/a')).toBe(false);
  });

  it('an unknown runtime, or a level the runtime cannot name, is not Full', async () => {
    defaults.runtime = 'gone';
    launchLevel.mockResolvedValue({ mode: 'bypass' });
    expect(await agentAtFullNow('/a')).toBe(false);
    defaults.runtime = undefined;
    launchLevel.mockResolvedValue({ mode: undefined });
    expect(await agentAtFullNow('/a')).toBe(false);
  });
});
