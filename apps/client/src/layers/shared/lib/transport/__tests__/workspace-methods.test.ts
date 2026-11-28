import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceMethods } from '../workspace-methods';
import { answer, firstRequest } from './request-stub';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWorkspaceMethods', () => {
  it('scans checkouts with a bodyless GET', async () => {
    const fetchMock = answer({ worktrees: [] });
    await expect(createWorkspaceMethods('/api').scanWorktrees()).resolves.toEqual({
      worktrees: [],
    });
    expect(firstRequest(fetchMock)).toEqual({
      url: '/api/workspaces/disk-checkouts',
      method: 'GET',
      body: undefined,
    });
  });
});
