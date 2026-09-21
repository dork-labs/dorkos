/** Pure owner-qualified Community navigation preference operations. @module community-navigation */
import {
  CommunityNavigationDestinationSchema,
  CommunityNavigationPrefsSchema,
  type CommunityNavigationDestination,
  type CommunityNavigationOwnerPrefs,
  type CommunityNavigationPrefs,
} from './config-schema.js';
import { CommunityRefSchema } from './community-adapter.js';
import { z } from 'zod';

const MAX_OWNERS = 16;
const MAX_DESTINATIONS = 100;
const MAX_ATTENTION_COUNT = 999;

/** Presentation identity that never grants access or exposes a remote storage URL. */
export const CommunityNavigationIconSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('installation') }),
  z.strictObject({ kind: z.literal('community'), ref: CommunityRefSchema }),
]);

/** The local installation is always the first navigation destination. */
export const InstallationNavigationDescriptorSchema = z.strictObject({
  kind: z.literal('installation'),
  key: z.literal('installation'),
  label: z.string().trim().min(1).max(120),
  icon: z.strictObject({ kind: z.literal('installation') }),
});

/** One owner-authorized Community destination with independent state axes. */
export const CommunityNavigationDescriptorSchema = z
  .strictObject({
    kind: z.literal('community'),
    key: z.string().min(1),
    ref: CommunityRefSchema,
    remoteCommunityId: z.uuid(),
    label: z.string().trim().min(1).max(120),
    icon: z.strictObject({ kind: z.literal('community'), ref: CommunityRefSchema }),
    pinnedOrigin: z.url(),
    membershipState: z.enum([
      'pending',
      'active',
      'archived',
      'suspended',
      'deletion-pending',
      'removed',
    ]),
    connectionState: z.enum(['pending', 'connected', 'reconnect-required', 'disconnected']),
    availability: z.enum(['online', 'offline', 'unknown']),
    unreadCount: z.number().int().min(0).max(MAX_ATTENTION_COUNT),
    mentionCount: z.number().int().min(0).max(MAX_ATTENTION_COUNT),
  })
  .superRefine((descriptor, context) => {
    if (descriptor.key !== `community:${descriptor.ref}`) {
      context.addIssue({
        code: 'custom',
        path: ['key'],
        message: 'Community navigation key must be derived from its local connection ref',
      });
    }
    if (descriptor.icon.kind !== 'community' || descriptor.icon.ref !== descriptor.ref) {
      context.addIssue({
        code: 'custom',
        path: ['icon'],
        message: 'Community icon identity must be qualified by the same local connection ref',
      });
    }
    if (descriptor.mentionCount > descriptor.unreadCount) {
      context.addIssue({
        code: 'custom',
        path: ['mentionCount'],
        message: 'Mention count must be a subset of unread count',
      });
    }
  });

/** Browser-safe destination list returned only inside the authenticated owner boundary. */
export const CommunityNavigationDescriptorListSchema = z
  .strictObject({
    installation: InstallationNavigationDescriptorSchema,
    communities: z.array(CommunityNavigationDescriptorSchema).max(100),
  })
  .superRefine(({ communities }, context) => {
    if (new Set(communities.map(({ key }) => key)).size !== communities.length) {
      context.addIssue({
        code: 'custom',
        path: ['communities'],
        message: 'Community navigation destinations must have distinct local keys',
      });
    }
    if (
      new Set(
        communities.map(
          ({ remoteCommunityId, pinnedOrigin }) => `${pinnedOrigin}:${remoteCommunityId}`
        )
      ).size !== communities.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['communities'],
        message: 'A remote community may appear only once per pinned host',
      });
    }
  });

/** Presentation-only navigation identity. */
export type CommunityNavigationIcon = z.infer<typeof CommunityNavigationIconSchema>;
/** Local installation destination. */
export type InstallationNavigationDescriptor = z.infer<
  typeof InstallationNavigationDescriptorSchema
>;
/** Owner-authorized Community destination and bounded aggregate attention. */
export type CommunityNavigationDescriptor = z.infer<typeof CommunityNavigationDescriptorSchema>;
/** Complete browser-safe navigation descriptor response. */
export type CommunityNavigationDescriptorList = z.infer<
  typeof CommunityNavigationDescriptorListSchema
>;

/** Browser-safe preference state for the authenticated local owner. */
export const CommunityNavigationStateSchema = z.strictObject({
  ownerKey: z.string().trim().min(1).max(200),
  order: z.array(CommunityRefSchema).max(100),
  destinations: z.array(CommunityNavigationDestinationSchema).max(100),
});

/** Move one connected Community by one position in the owner's saved order. */
export const CommunityNavigationMoveRequestSchema = z.strictObject({
  ref: CommunityRefSchema,
  direction: z.enum(['up', 'down']),
});

/** Persist one already-authorized qualified destination. */
export const CommunityNavigationRememberRequestSchema = CommunityNavigationDestinationSchema;

/** Resolve a remembered destination only after the server reauthorizes it. */
export const CommunityNavigationResolveResponseSchema = z.strictObject({
  destination: CommunityNavigationDestinationSchema.nullable(),
});

/** Browser-safe owner-scoped preference state. */
export type CommunityNavigationState = z.infer<typeof CommunityNavigationStateSchema>;
/** One relative reorder operation. */
export type CommunityNavigationMoveRequest = z.infer<typeof CommunityNavigationMoveRequestSchema>;

/** Keep saved refs in manual order, then append newly authorized refs deterministically. */
export function reconcileCommunityOrder(
  saved: readonly string[],
  authorized: readonly string[]
): string[] {
  const allowed = new Set(authorized);
  const seen = new Set<string>();
  const retained: string[] = [];
  for (const ref of saved) {
    if (!allowed.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    retained.push(ref);
  }
  const appended = [...allowed].filter((ref) => !seen.has(ref)).sort((a, b) => a.localeCompare(b));
  return [...retained, ...appended];
}

/** Return only the exact owner's preferences; an owner switch starts empty. */
export function communityNavigationForOwner(
  prefs: CommunityNavigationPrefs,
  ownerKey: string
): CommunityNavigationOwnerPrefs {
  return (
    prefs.owners.find((owner) => owner.ownerKey === ownerKey) ?? {
      ownerKey,
      order: [],
      destinations: [],
    }
  );
}

/** Replace one owner's preferences without disturbing writes for any other owner. */
export function updateCommunityNavigationOwner(
  prefs: CommunityNavigationPrefs,
  ownerKey: string,
  update: (current: CommunityNavigationOwnerPrefs) => CommunityNavigationOwnerPrefs
): CommunityNavigationPrefs {
  const current = communityNavigationForOwner(prefs, ownerKey);
  const nextOwner = update(current);
  const others = prefs.owners.filter((owner) => owner.ownerKey !== ownerKey);
  return CommunityNavigationPrefsSchema.parse({
    version: 1,
    owners: [...others, nextOwner].slice(-MAX_OWNERS),
  });
}

/** Store the latest destination for one ref, bounded and qualified by owner and Community. */
export function rememberCommunityDestination(
  prefs: CommunityNavigationPrefs,
  ownerKey: string,
  destination: CommunityNavigationDestination
): CommunityNavigationPrefs {
  return updateCommunityNavigationOwner(prefs, ownerKey, (owner) => ({
    ...owner,
    destinations: [
      ...owner.destinations.filter((saved) => saved.ref !== destination.ref),
      destination,
    ].slice(-MAX_DESTINATIONS),
  }));
}

/** Prune refs after an authoritative refresh without touching another owner's namespace. */
export function reconcileCommunityNavigationOwner(
  prefs: CommunityNavigationPrefs,
  ownerKey: string,
  authorizedRefs: readonly string[]
): CommunityNavigationPrefs {
  const allowed = new Set(authorizedRefs);
  return updateCommunityNavigationOwner(prefs, ownerKey, (owner) => ({
    ...owner,
    order: reconcileCommunityOrder(owner.order, authorizedRefs),
    destinations: owner.destinations.filter((destination) => allowed.has(destination.ref)),
  }));
}

/** Move one authorized ref without replacing a concurrent writer's full order. */
export function moveCommunityInOrder(
  prefs: CommunityNavigationPrefs,
  ownerKey: string,
  ref: string,
  direction: 'up' | 'down',
  authorizedRefs: readonly string[]
): CommunityNavigationPrefs {
  const reconciled = reconcileCommunityNavigationOwner(prefs, ownerKey, authorizedRefs);
  return updateCommunityNavigationOwner(reconciled, ownerKey, (owner) => {
    const order = [...owner.order];
    const index = order.indexOf(ref);
    if (index < 0) return owner;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) return owner;
    [order[index], order[target]] = [order[target]!, order[index]!];
    return { ...owner, order };
  });
}
