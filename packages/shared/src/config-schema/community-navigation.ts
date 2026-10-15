/**
 * Local Community navigation preferences: the remembered destinations and ordering, per local owner.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/community-navigation
 */
import { z } from 'zod';
import { CommunityNavigationRefSchema } from '../spaces-settings.js';

/** One canonical route inside the local DorkOS installation. */
export const CommunityInstallationPathSchema = z.enum([
  '/',
  '/activity',
  '/team',
  '/session',
  '/tasks',
  '/channels',
  '/workspaces',
  '/connections',
  '/marketplace',
  '/marketplace/sources',
  '/feedback-requests',
]);
const CommunityInstallationSearchScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const CommunityInstallationSearchValueSchema = z.union([
  CommunityInstallationSearchScalarSchema,
  z.array(CommunityInstallationSearchScalarSchema).max(100),
]);

/** Route-validated local destination; Community authority is never persisted here. */
export const CommunityInstallationDestinationSchema = z
  .strictObject({
    path: CommunityInstallationPathSchema,
    search: z.record(z.string(), CommunityInstallationSearchValueSchema).default({}),
  })
  .superRefine(({ search }, context) => {
    if ('community' in search)
      context.addIssue({
        code: 'custom',
        path: ['search'],
        message: 'A local installation destination cannot select Community authority',
      });
    if (JSON.stringify(search).length > 4096)
      context.addIssue({
        code: 'custom',
        path: ['search'],
        message: 'Local installation search state is too large',
      });
  });

/** One bounded, owner-qualified Community destination remembered by the local app. */
export const CommunityNavigationDestinationSchema = z.object({
  ref: CommunityNavigationRefSchema,
  roomId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256).nullable().default(null),
  scrollAnchorEntryId: z.string().min(1).max(256).nullable().default(null),
});

/** One local owner's Community ordering and last authorized destinations. */
export const CommunityNavigationOwnerPrefsSchema = z.object({
  ownerKey: z.string().min(1).max(256),
  installationDestination: CommunityInstallationDestinationSchema.default({
    path: '/',
    search: {},
  }),
  order: z
    .array(CommunityNavigationRefSchema)
    .max(100)
    .default(() => []),
  destinations: z
    .array(CommunityNavigationDestinationSchema)
    .max(100)
    .default(() => []),
});

/** Versioned local Community navigation preferences, bounded across former owners. */
export const CommunityNavigationPrefsSchema = z.object({
  version: z.literal(1).default(1),
  owners: z
    .array(CommunityNavigationOwnerPrefsSchema)
    .max(16)
    .default(() => []),
});
/** One remembered Community destination. */
export type CommunityNavigationDestination = z.infer<typeof CommunityNavigationDestinationSchema>;
/** Canonical local route remembered separately from remote Community destinations. */
export type CommunityInstallationPath = z.infer<typeof CommunityInstallationPathSchema>;
/** Canonical local destination remembered separately from remote Community destinations. */
export type CommunityInstallationDestination = z.infer<
  typeof CommunityInstallationDestinationSchema
>;
/** Navigation preferences belonging to one local owner. */
export type CommunityNavigationOwnerPrefs = z.infer<typeof CommunityNavigationOwnerPrefsSchema>;
/** Versioned Community navigation preferences persisted in user config. */
export type CommunityNavigationPrefs = z.infer<typeof CommunityNavigationPrefsSchema>;
