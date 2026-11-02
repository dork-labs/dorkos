import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  approved: vi.fn(),
  refused: vi.fn(),
  previous: vi.fn(),
  manifest: vi.fn(),
  defaults: vi.fn(),
  profile: vi.fn(),
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: mocks.manifest }));
vi.mock('../../services/tasks/scheduled-run-power.js', () => ({
  capabilitiesForTaskRuntime: mocks.profile,
}));
vi.mock('../../services/session/resolution/resolve-session-defaults.js', () => ({
  readAgentExecutionDefaults: mocks.defaults,
}));
vi.mock('../../services/runtimes/claude-code/folder-settings/agent-folder-allows.js', () => ({
  readFolderAllowList: mocks.list,
}));
vi.mock('../../services/runtimes/claude-code/folder-settings/folder-allow-consent.js', () => ({
  isFolderAllowListApproved: mocks.approved,
  isFolderAllowListRefused: mocks.refused,
  lastApprovedRules: mocks.previous,
}));
import { withTaskFolderRules } from '../task-approval-rules.js';

const rule = 'Bash(pnpm check:watchdog)';
const task = { status: 'pending_approval', agentId: 'watchdog', runtime: null } as Task;
const mesh = { getProjectPath: () => '/fixtures/watchdog' } as unknown as MeshCore;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.defaults.mockResolvedValue({ runtime: 'claude-code' });
  mocks.profile.mockReturnValue({ type: 'claude-code' });
  mocks.manifest.mockResolvedValue({ workspace: { mode: 'home' } });
  mocks.list.mockResolvedValue({ rules: [rule], dropped: [], hash: 'hash' });
});

describe('task folder-rule preview', () => {
  it('shows only the exact separately approved list as applied', async () => {
    mocks.approved.mockReturnValue(true);
    expect((await withTaskFolderRules(task, mesh)).folderRules).toEqual({
      status: 'approved',
      applied: [rule],
      pending: [],
    });
    expect(mocks.approved).toHaveBeenCalledWith({
      agentId: 'watchdog',
      home: '/fixtures/watchdog',
      rules: [rule],
    });
  });
  it('shows an unapproved or changed list as pending, never applied', async () => {
    expect((await withTaskFolderRules(task, mesh)).folderRules).toEqual({
      status: 'waiting',
      applied: [],
      pending: [rule],
    });
    mocks.previous.mockReturnValue(['Bash(other-command)']);
    expect((await withTaskFolderRules(task, mesh)).folderRules?.applied).toEqual([]);
  });
  it('matches the launch’s narrowing rule without writing consent on a read', async () => {
    mocks.previous.mockReturnValue([rule, 'Bash(other-command)']);
    expect((await withTaskFolderRules(task, mesh)).folderRules?.applied).toEqual([rule]);
    mocks.refused.mockReturnValue(true);
    expect((await withTaskFolderRules(task, mesh)).folderRules?.applied).toEqual([]);
  });
  it('does not claim folder rules apply on a managed desk or an unknown placement', async () => {
    mocks.manifest.mockResolvedValue({ workspace: { mode: 'managed' } });
    expect((await withTaskFolderRules(task, mesh)).folderRules?.status).toBe('unavailable');
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it('does not attach Claude rules to another runtime or to a task with no agent', async () => {
    mocks.profile.mockReturnValue({ type: 'codex' });
    expect((await withTaskFolderRules(task, mesh)).folderRules?.applied).toEqual([]);
    expect((await withTaskFolderRules({ ...task, agentId: null }, mesh)).folderRules?.status).toBe(
      'none'
    );
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
