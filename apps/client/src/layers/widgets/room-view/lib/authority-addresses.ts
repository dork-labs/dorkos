import type { CommunityContentAuthority } from '@/layers/entities/community';

/**
 * The keys a space room's surface files its local state under: the owner generation, and the
 * whole read context. State filed under one is dropped once the owner or the access changes.
 *
 * @param authority - The current content authority, or `null` while it is unresolved.
 */
export function authorityAddresses(authority: CommunityContentAuthority | null): {
  ownerAddress: string;
  contextAddress: string;
} {
  if (!authority) return { ownerAddress: '', contextAddress: '' };
  return {
    ownerAddress: JSON.stringify([authority.ownerKey, authority.epoch]),
    contextAddress: JSON.stringify([
      authority.ownerKey,
      authority.epoch,
      authority.route.epoch,
      authority.accessFingerprint,
    ]),
  };
}
