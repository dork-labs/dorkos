import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  confirmCommunityAuthority,
  getCommunityAuthority,
  invalidateCommunityAuthority,
  registerCommunityAuthorityCleanup,
} from '../community-authority-state';

beforeEach(() => {
  invalidateCommunityAuthority();
});

describe('Community authority generation', () => {
  it('refuses a bootstrap response after its epoch was invalidated', () => {
    const first = getCommunityAuthority();
    invalidateCommunityAuthority();

    expect(confirmCommunityAuthority(first.epoch, 'owner-a')).toBe(false);
    expect(getCommunityAuthority().ownerKey).toBeNull();
  });

  it('cannot replace a confirmed owner inside one epoch', () => {
    const { epoch } = getCommunityAuthority();
    expect(confirmCommunityAuthority(epoch, 'owner-a')).toBe(true);
    expect(confirmCommunityAuthority(epoch, 'owner-b')).toBe(false);
    expect(getCommunityAuthority()).toEqual({ epoch, ownerKey: 'owner-a' });
  });

  it('clears authority before invoking protected-state cleanup', () => {
    const { epoch } = getCommunityAuthority();
    confirmCommunityAuthority(epoch, 'owner-a');
    const cleanup = vi.fn(() => expect(getCommunityAuthority().ownerKey).toBeNull());
    const unregister = registerCommunityAuthorityCleanup(cleanup);

    invalidateCommunityAuthority();

    expect(cleanup).toHaveBeenCalledOnce();
    unregister();
  });
});
