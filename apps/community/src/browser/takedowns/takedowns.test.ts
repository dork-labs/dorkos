import { describe, expect, it } from 'vitest';
import { CommunityAdminTakedownEvidenceStateSchema } from '@dorkos/shared/community-admin-wire';
import {
  authorBannerText,
  defaultNotify,
  EVIDENCE_WORDING,
  hostTargetLabel,
  readSeenTakedowns,
  rememberSeenTakedown,
  TAKEDOWN_CATEGORIES,
  type TakedownNotice,
} from './takedowns.js';

const community = '0b6c1a52-7e1f-4d0e-9a53-3c1e2b7f9d10';

/** A Storage stand-in: a Map, or one that refuses every call as a locked-down browser does. */
function memoryStorage(refuse = false): () => Storage {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => {
      if (refuse) throw new Error('blocked');
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error('blocked');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  return () => storage;
}

const notice: TakedownNotice = {
  id: '5f2d7c34-1a9b-4b8e-8c21-6e0a4d3b2f77',
  targetKind: 'entry',
  entryId: '9c1e4a70-2b3d-4f5e-8a6b-7c8d9e0f1a2b',
  attachmentId: null,
  channelId: null,
  category: 'legal_order',
  reference: 'CASE-1',
  createdAt: '2026-09-24T10:00:00.000Z',
  yours: true,
};

describe('takedown helpers', () => {
  // Purpose: fails if the "tell them" box starts checked for child safety (tipping off a suspect)
  // or unchecked for any other reason (withholding a statement of reasons by accident).
  it('tells the owner and author by default for every reason but child safety', () => {
    expect(
      Object.fromEntries(TAKEDOWN_CATEGORIES.map(({ value }) => [value, defaultNotify(value)]))
    ).toEqual({
      illegal_content: true,
      child_safety: false,
      legal_order: true,
      terms_violation: true,
    });
  });

  // Purpose: fails if an evidence state the server can send has no wording, or a wording drifts.
  it('words every evidence state the server can report', () => {
    expect(Object.keys(EVIDENCE_WORDING).sort()).toEqual(
      [...CommunityAdminTakedownEvidenceStateSchema.options].sort()
    );
    expect(EVIDENCE_WORDING.held_on_primary).toBe('Kept on this server until you release it');
    expect(EVIDENCE_WORDING.retrying).toBe('Couldn’t save the copy yet; retrying');
  });

  // Purpose: fails if the host list stops naming the ID the host acted on.
  it('names each target by kind and ID', () => {
    expect(hostTargetLabel({ kind: 'entry', entryId: notice.entryId! })).toBe(
      `Message ${notice.entryId}`
    );
    expect(hostTargetLabel({ kind: 'attachment', attachmentId: notice.id, entryId: null })).toBe(
      `File ${notice.id}`
    );
    expect(hostTargetLabel({ kind: 'icon' })).toBe('Community icon');
  });

  // Purpose: fails if the banner loses the reason sentence or calls a file a message.
  it('says what was removed and why in the author banner', () => {
    expect(authorBannerText(notice)).toMatch(
      /^The host removed one of your messages on .+\. The host received a legal order to remove it\.$/u
    );
    expect(authorBannerText({ ...notice, targetKind: 'attachment' })).toContain(
      'one of your files'
    );
    expect(authorBannerText({ ...notice, targetKind: 'icon' })).toContain(
      'removed the community icon on'
    );
  });

  // Purpose: fails if a dismissal is forgotten, leaks into another community or to another
  // member sharing this browser, or a blocked or corrupted store throws instead of showing the
  // banner again.
  it('remembers dismissed banners per community and member, and survives bad storage', () => {
    const storage = memoryStorage();
    rememberSeenTakedown(community, 'mia', 'a', storage);
    rememberSeenTakedown(community, 'mia', 'b', storage);
    expect([...readSeenTakedowns(community, 'mia', storage)]).toEqual(['a', 'b']);
    expect(readSeenTakedowns('another', 'mia', storage).size).toBe(0);
    expect(readSeenTakedowns(community, 'ada', storage).size).toBe(0);
    storage().setItem(`communityTakedownsSeen:${community}:mia`, '{not json');
    expect(readSeenTakedowns(community, 'mia', storage).size).toBe(0);
    const blocked = memoryStorage(true);
    expect(() => rememberSeenTakedown(community, 'mia', 'a', blocked)).not.toThrow();
    expect(readSeenTakedowns(community, 'mia', blocked).size).toBe(0);
  });
});
