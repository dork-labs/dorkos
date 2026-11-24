/**
 * Shared builders for the remote community mirror delivery suites (durable writer and worker).
 *
 * @module services/communities/remote/__tests__/community-outbox/fixtures
 */

import type { CommunityRef } from '@dorkos/shared/community-adapter';

import { type CommunityOutboxItem } from '../../community-outbox-store.js';

export const REF = 'remote_outbox' as CommunityRef;
export const NOW = Date.parse('2026-09-16T12:00:00.000Z');

export function outboxItem(overrides: Partial<CommunityOutboxItem> = {}): CommunityOutboxItem {
  return {
    id: 'outbox-1',
    communityRef: REF,
    remoteRoomId: 'general',
    ownerAuthorId: 'owner',
    localEntryId: 'entry-1',
    localParentEntryId: null,
    localAgentId: 'agent-a',
    attachmentIds: '[]',
    idempotencyKey: 'delivery-key',
    state: 'pending',
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(),
    remoteEntryId: null,
    failure: null,
    attempts: 0,
    nextAttemptAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}
