import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import {
  confirmCommunityAuthority,
  invalidateCommunityAuthority,
  type ConfirmedCommunityAuthority,
} from '@/layers/shared/lib';
import {
  communityDraftKey,
  EMPTY_COMMUNITY_DRAFT,
  useCommunityDraftStore,
  type CommunityDraftAddress,
} from '../model/community-drafts';
import { endCommunityConnection, eraseCommunityOwnerState } from '../model/community-lifecycle';

/** Owner 1's composer in Community `a`, room `general` — the base every case varies. */
function at(over: Partial<CommunityDraftAddress> = {}): CommunityDraftAddress {
  return { ownerKey: 'owner-1', epoch: 1, ref: 'a', generation: 0, roomId: 'general', ...over };
}

function write(address: CommunityDraftAddress, text: string) {
  useCommunityDraftStore.getState().write(address, { text, files: [] });
}

function read(address: CommunityDraftAddress): string {
  return useCommunityDraftStore.getState().drafts[communityDraftKey(address)]?.text ?? '';
}

afterEach(() => {
  useCommunityDraftStore.getState().discardAll();
  invalidateCommunityAuthority();
});

describe('Community draft store', () => {
  it('gives the same draft back only at the exact address it was written under', () => {
    write(at(), 'half a plan');
    expect(read(at())).toBe('half a plan');

    // Each part of the address alone keeps the draft out of reach.
    for (const other of [
      at({ ownerKey: 'owner-2' }),
      at({ epoch: 2 }),
      at({ ref: 'b' }),
      at({ generation: 1 }),
      at({ roomId: 'random' }),
      at({ threadId: 'root-1' }),
    ])
      expect(read(other)).toBe('');
  });

  it('keeps two Communities that share a room id apart', () => {
    write(at({ ref: 'a' }), 'for Alpha');
    write(at({ ref: 'b' }), 'for Beta');
    expect(read(at({ ref: 'a' }))).toBe('for Alpha');
    expect(read(at({ ref: 'b' }))).toBe('for Beta');
  });

  it('keeps a thread reply apart from the channel draft in the same room', () => {
    write(at(), 'to the channel');
    write(at({ threadId: 'root-1' }), 'to the thread');
    expect(read(at())).toBe('to the channel');
    expect(read(at({ threadId: 'root-1' }))).toBe('to the thread');
  });

  it('holds staged files with the text', () => {
    const file = new File(['x'], 'notes.txt');
    useCommunityDraftStore.getState().write(at(), { text: '', files: [{ id: 'f1', file }] });
    expect(useCommunityDraftStore.getState().take(at())).toEqual({
      text: '',
      files: [{ id: 'f1', file }],
    });
  });

  it('forgets an address once its draft is emptied', () => {
    write(at(), 'typed');
    write(at(), '');
    expect(useCommunityDraftStore.getState().drafts).toEqual({});
  });

  it('take reads and clears in one step, so a second take finds nothing', () => {
    write(at(), 'send me once');
    const store = useCommunityDraftStore.getState();
    expect(store.take(at()).text).toBe('send me once');
    expect(store.take(at())).toBe(EMPTY_COMMUNITY_DRAFT);
  });

  it('discardCommunity erases one owner’s drafts for one Community and nothing else', () => {
    write(at(), 'Alpha channel');
    write(at({ threadId: 'root-1' }), 'Alpha thread');
    write(at({ ref: 'b' }), 'Beta');
    write(at({ ownerKey: 'owner-2' }), 'owner 2 in Alpha');

    useCommunityDraftStore.getState().discardCommunity('owner-1', 'a');

    expect(read(at())).toBe('');
    expect(read(at({ threadId: 'root-1' }))).toBe('');
    expect(read(at({ ref: 'b' }))).toBe('Beta');
    expect(read(at({ ownerKey: 'owner-2' }))).toBe('owner 2 in Alpha');
  });
});

describe('Community draft lifetime', () => {
  function confirmed(owner = 'owner-1'): ConfirmedCommunityAuthority {
    const next = invalidateCommunityAuthority();
    confirmCommunityAuthority(next.epoch, owner);
    return { epoch: next.epoch, ownerKey: owner };
  }

  it('erases a Community’s drafts when its connection is revoked, leaving other Communities', async () => {
    const authority = confirmed();
    const here = at({ ownerKey: authority.ownerKey, epoch: authority.epoch });
    write(here, 'Alpha draft');
    write({ ...here, ref: 'b' }, 'Beta draft');

    await endCommunityConnection(new QueryClient(), authority, 'a', 'revoked');

    expect(read(here)).toBe('');
    expect(read({ ...here, ref: 'b' })).toBe('Beta draft');
  });

  it('erases every Community draft with the rest of the owner’s state on sign-out or owner change', () => {
    write(at(), 'Alpha draft');
    write(at({ ref: 'b' }), 'Beta draft');
    eraseCommunityOwnerState(new QueryClient());
    expect(useCommunityDraftStore.getState().drafts).toEqual({});
  });
});
