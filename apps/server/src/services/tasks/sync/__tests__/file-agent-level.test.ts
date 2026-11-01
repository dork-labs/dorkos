/**
 * What a schedule file's agent lets it have (DOR-3425): the agent's level, on the
 * runtime it runs on, or nothing at all.
 *
 * @module services/tasks/sync/__tests__/file-agent-level
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';

const launch = vi.hoisted(() => vi.fn());
const capabilities = vi.hoisted(() => vi.fn());

vi.mock('../../../session/resolution/agent-launch-level.js', () => ({
  resolveAgentLaunchLevel: launch,
}));
vi.mock('../../../session/resolution/resolve-session-defaults.js', () => ({
  readAgentExecutionDefaults: async () => ({ runtime: 'claude-code' }),
}));
vi.mock('../../scheduled-run-power.js', () => ({ capabilitiesForTaskRuntime: capabilities }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { fileAgentLevel } = await import('../file-agent-level.js');

const ROOT = { agentId: 'agent-1', projectPath: '/home/u/agent' };

describe('fileAgentLevel', () => {
  beforeEach(() => {
    launch.mockReset();
    capabilities.mockReset();
    capabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
  });

  it('gives an agent at Full a bypass', async () => {
    launch.mockResolvedValue({ stop: 'autonomy', mode: 'bypassPermissions' });
    expect(await fileAgentLevel(ROOT, null)).toEqual({
      bypassAs: 'bypassPermissions',
      full: true,
    });
  });

  it('gives an agent at Ask its own Ask', async () => {
    launch.mockResolvedValue({ stop: 'ask', mode: 'default' });
    expect(await fileAgentLevel(ROOT, null)).toEqual({ bypassAs: 'default', full: false });
  });

  it('answers in the runtime’s own mode ids', async () => {
    capabilities.mockReturnValue(CODEX_CAPABILITIES);
    const full = CODEX_CAPABILITIES.permissionModes.values.find(
      (mode) => mode.asks === 'never' && mode.reach === 'everything'
    )!;
    launch.mockResolvedValue({ stop: 'autonomy', mode: full.id });
    expect(await fileAgentLevel(ROOT, 'codex')).toEqual({ bypassAs: full.id, full: true });
  });

  it('has nothing to give a root no agent owns', async () => {
    expect(await fileAgentLevel({}, null)).toBeNull();
    expect(await fileAgentLevel({ projectPath: '/somewhere' }, null)).toBeNull();
    expect(launch).not.toHaveBeenCalled();
  });

  it('has nothing to give when nothing set a level, or it cannot be read', async () => {
    launch.mockResolvedValue({ stop: null, mode: undefined });
    expect(await fileAgentLevel(ROOT, null)).toBeNull();

    launch.mockRejectedValue(new Error('manifest unreadable'));
    expect(await fileAgentLevel(ROOT, null)).toBeNull();
  });

  it('has nothing to give on a runtime that is not registered', async () => {
    capabilities.mockReturnValue(undefined);
    expect(await fileAgentLevel(ROOT, 'gone')).toBeNull();
  });
});
