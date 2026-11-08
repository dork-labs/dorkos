import { describe, expect, it, vi } from 'vitest';
import { loadWithProtectedProfile } from '../profile-load.js';
import type { CodexJsonRpcClient } from '../json-rpc-client.js';

const params = {
  cwd: '/probe',
  approvalPolicy: 'never' as const,
  approvalsReviewer: 'user' as const,
  permissions: 'dorkos-files-read-only',
  config: {},
};

describe('the binary acknowledges file protection', () => {
  it.each([undefined, null, { id: ':danger-full-access' }])(
    'refuses an absent or different profile: %j',
    async (activePermissionProfile) => {
      const client = {
        request: vi.fn(async () => ({ thread: { id: 'thread' }, activePermissionProfile })),
      } as unknown as CodexJsonRpcClient;
      await expect(loadWithProtectedProfile(client, 'thread/start', params)).rejects.toThrow(
        'did not confirm'
      );
    }
  );

  it('accepts exactly the profile requested', async () => {
    const result = {
      thread: { id: 'thread' },
      activePermissionProfile: { id: params.permissions },
    };
    const client = { request: vi.fn(async () => result) } as unknown as CodexJsonRpcClient;
    expect(await loadWithProtectedProfile(client, 'thread/start', params)).toBe(result);
  });
});
