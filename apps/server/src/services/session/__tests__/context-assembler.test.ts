import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/git-status.js', () => ({
  getGitStatus: vi.fn(),
}));

import { assembleAdditionalContext } from '../context-assembler.js';
import { getGitStatus } from '../../core/git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';
import type { UiState } from '@dorkos/shared/types';

const mockedGetGitStatus = vi.mocked(getGitStatus);

function makeGitStatus(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
    detached: false,
    tracking: 'origin/main',
    ...overrides,
  };
}

const SAMPLE_UI_STATE: UiState = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: true, relay: false },
  sidebar: { open: true, activeTab: 'sessions' },
  agent: { id: 'agent-1', cwd: '/proj' },
};

describe('assembleAdditionalContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
  });

  it('merges git_status, ui_state, and queue_note when client signals present', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { uiState: SAMPLE_UI_STATE, queued: true },
      nativeContext: [],
    });

    const git = bag.find((e) => e.kind === 'git_status');
    expect(git).toBeDefined();
    expect(git!.kind === 'git_status' && git!.data.isRepo).toBe(true);
    expect(git!.kind === 'git_status' && git!.data.branch).toBe('main');

    const ui = bag.find((e) => e.kind === 'ui_state');
    expect(ui).toBeDefined();
    expect(ui!.kind === 'ui_state' && ui!.data).toEqual(SAMPLE_UI_STATE);

    const queue = bag.find((e) => e.kind === 'queue_note');
    expect(queue).toBeDefined();
    expect(queue!.kind === 'queue_note' && queue!.data.composedDuringPrevTurn).toBe(true);
  });

  it('omits git_status when the runtime declares it native, keeping ui_state/queue_note', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { uiState: SAMPLE_UI_STATE, queued: true },
      nativeContext: ['git_status'],
    });

    expect(bag.find((e) => e.kind === 'git_status')).toBeUndefined();
    expect(bag.find((e) => e.kind === 'ui_state')).toBeDefined();
    expect(bag.find((e) => e.kind === 'queue_note')).toBeDefined();
  });

  it('yields git_status { isRepo: false } when getGitStatus returns an error', async () => {
    mockedGetGitStatus.mockResolvedValue({ error: 'not_git_repo' as const });
    const bag = await assembleAdditionalContext({ cwd: '/not-a-repo', nativeContext: [] });

    const git = bag.find((e) => e.kind === 'git_status');
    expect(git).toBeDefined();
    expect(git!.kind === 'git_status' && git!.data).toEqual({ isRepo: false });
  });

  it('omits ui_state and queue_note when no client signals are supplied', async () => {
    const bag = await assembleAdditionalContext({ cwd: '/proj', nativeContext: [] });
    expect(bag.find((e) => e.kind === 'ui_state')).toBeUndefined();
    expect(bag.find((e) => e.kind === 'queue_note')).toBeUndefined();
    expect(bag.find((e) => e.kind === 'git_status')).toBeDefined();
  });

  it('does NOT emit queue_note when queued is false', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { queued: false },
      nativeContext: [],
    });
    expect(bag.find((e) => e.kind === 'queue_note')).toBeUndefined();
  });

  it('returns { isRepo: false } when getGitStatus throws', async () => {
    mockedGetGitStatus.mockRejectedValue(new Error('git missing'));
    const bag = await assembleAdditionalContext({ cwd: '/proj', nativeContext: [] });
    const git = bag.find((e) => e.kind === 'git_status');
    expect(git!.kind === 'git_status' && git!.data).toEqual({ isRepo: false });
  });

  it('never emits an env entry (env flows via systemPrompt.append, G2)', async () => {
    const bag = await assembleAdditionalContext({
      cwd: '/proj',
      clientContext: { uiState: SAMPLE_UI_STATE, queued: true },
      nativeContext: [],
    });
    expect(bag.find((e) => e.kind === 'env')).toBeUndefined();
  });
});
