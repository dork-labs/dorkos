/**
 * Typed, read-only Fly preflight inventory.
 *
 * @module commands/community-deploy/fly-read
 */
import { z } from 'zod';
import {
  ExternalIdentifierSchema,
  ExternalLabelSchema,
  parseExternalJson,
  requireUniqueExternalIds,
} from './provider-contract.js';
import { runProviderCommand } from './provider-process.js';
import type { FlySessionReadOptions } from './tigris-session.js';

const FlyIdentitySchema = z.object({ email: z.string().email().max(320) }).strict();
const FlyOrganizationsSchema = z.record(ExternalIdentifierSchema, ExternalLabelSchema);
const FlyRegionSchema = z
  .object({
    code: ExternalIdentifierSchema,
    name: ExternalLabelSchema,
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    gateway_available: z.boolean(),
    requires_paid_plan: z.boolean(),
    deprecated: z.boolean(),
  })
  .passthrough();
/**
 * One `fly.App` as flyctl renders it for `apps list --json` and `apps create --json`.
 *
 * flyctl marshals its Go struct without JSON tags, so every field is always present and a field the
 * underlying API call did not fetch arrives as an empty string rather than missing. The two
 * commands fetch different fields (flyctl v0.4.104):
 *
 * - `apps list` reads the Machines API, which reports the organization's slug and name but not its
 *   GraphQL ID, so `Organization.ID` is `""`.
 * - `apps create` reads the app back over GraphQL asking only for the organization's id, slug and
 *   paid plan, so `Organization.Name` is `""`.
 *
 * Only the fields every variant fills are trusted: the app's ID and name, and the organization
 * slug the operator selected. The organization's ID and name are deliberately not read.
 */
export const FlyAppResponseSchema = z
  .object({
    ID: ExternalIdentifierSchema,
    Name: ExternalIdentifierSchema,
    Organization: z.object({ Slug: ExternalIdentifierSchema }).passthrough(),
    Status: z.union([z.literal(''), ExternalLabelSchema]),
  })
  .passthrough();
const FlyOrganizationDetailSchema = z
  .object({ ID: ExternalIdentifierSchema, Slug: ExternalIdentifierSchema })
  .passthrough();
const FlyImageDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const FlyImageComponentSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u);
const FlyMachineSchema = z
  .object({
    id: ExternalIdentifierSchema,
    name: ExternalIdentifierSchema,
    state: ExternalLabelSchema,
    region: ExternalIdentifierSchema,
    image_ref: z
      .object({
        digest: FlyImageDigestSchema,
        registry: ExternalIdentifierSchema,
        repository: FlyImageComponentSchema,
      })
      .passthrough(),
    checks: z
      .array(
        z.object({ name: ExternalIdentifierSchema, status: ExternalLabelSchema }).passthrough()
      )
      .default([]),
  })
  .passthrough();
const FlyReleaseSchema = z
  .object({
    ID: ExternalIdentifierSchema,
    ImageRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,1023}$/u),
    Status: ExternalLabelSchema,
    Stable: z.boolean(),
    Version: z.number().int().positive(),
  })
  .passthrough();
const FlyIpSchema = z
  .object({
    ID: ExternalIdentifierSchema,
    Address: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[0-9a-fA-F:.]+$/u),
    Type: ExternalLabelSchema,
    Region: z.string().max(64),
  })
  .passthrough();

/** Authenticated Fly identity without a session token. */
export interface FlyIdentity {
  /** Account email reported by Fly. */
  email: string;
}

/** Stable Fly organization selection candidate. */
export interface FlyOrganization {
  /** Stable organization slug used by commands. */
  slug: string;
  /** Human-readable organization name. */
  name: string;
}

/** Fly region capability used during read-only planning. */
export interface FlyRegion {
  /** Stable region code. */
  code: string;
  /** Human-readable region name. */
  name: string;
  /** Region latitude. */
  latitude: number;
  /** Region longitude. */
  longitude: number;
  /** Whether the region offers a public gateway. */
  gatewayAvailable: boolean;
  /** Whether Fly marks the region as paid-plan only. */
  requiresPaidPlan: boolean;
  /** Whether Fly has deprecated the region. */
  deprecated: boolean;
}

/** Non-secret Fly app identity and organization binding. */
export interface FlyAppIdentity {
  /** Provider-issued app ID. */
  id: string;
  /** Globally visible app name. */
  name: string;
  /** Stable organization slug the app belongs to. */
  organizationSlug: string;
  /** Provider-reported app status, empty when Fly reports none. */
  status: string;
}

/** Sanitized running Machine identity and health readback. */
export interface FlyMachineIdentity {
  /** Provider-issued Machine ID. */
  id: string;
  /** Provider-issued Machine name. */
  name: string;
  /** Runtime state. */
  state: string;
  /** Fly region code. */
  region: string;
  /** Immutable running image digest. */
  imageDigest: string;
  /** Image repository without credentials. */
  imageRepository: string;
  /** Named health checks without provider output text. */
  checks: Array<{ name: string; status: string }>;
}

/** Sanitized Fly release readback. */
export interface FlyReleaseIdentity {
  /** Provider-issued release ID. */
  id: string;
  /** Image reference selected by the release. */
  imageRef: string;
  /** Release status. */
  status: string;
  /** Whether Fly marks the release stable. */
  stable: boolean;
  /** Monotonic app release version. */
  version: number;
}

/** Public IP assignment without DNS or certificate details. */
export interface FlyIpIdentity {
  /** Provider-issued address ID. */
  id: string;
  /** Assigned IP address. */
  address: string;
  /** Address family or sharing type. */
  type: string;
  /** Region when the address is regional. */
  region: string;
}

/** One app's non-secret runtime inventory used to prove deployment state. */
export interface FlyRuntimeInventory {
  /** Every Machine returned for the exact app. */
  machines: FlyMachineIdentity[];
  /** Every release returned for the exact app. */
  releases: FlyReleaseIdentity[];
  /** Every public IP assignment returned for the exact app. */
  addresses: FlyIpIdentity[];
}

/** Read the authenticated Fly account through the pinned JSON command. */
export async function readFlyIdentity(options: FlySessionReadOptions): Promise<FlyIdentity> {
  return (
    await runProviderCommand({
      ...options,
      args: ['auth', 'whoami', '--json'],
      parse: (stdout) => FlyIdentitySchema.parse(parseExternalJson(stdout)),
    })
  ).value;
}

/** Read every selectable Fly organization with both stable slug and display name. */
export async function readFlyOrganizations(
  options: FlySessionReadOptions
): Promise<FlyOrganization[]> {
  const organizations = (
    await runProviderCommand({
      ...options,
      args: ['orgs', 'list', '--json'],
      parse: (stdout) => FlyOrganizationsSchema.parse(parseExternalJson(stdout)),
    })
  ).value;
  return Object.entries(organizations)
    .map(([slug, name]) => ({ slug, name }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Read Fly regions and their authoritative capability flags. */
export async function readFlyRegions(options: FlySessionReadOptions): Promise<FlyRegion[]> {
  const regions = (
    await runProviderCommand({
      ...options,
      args: ['platform', 'regions', '--json'],
      parse: (stdout) => {
        const parsed = z.array(FlyRegionSchema).parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed, (region) => region.code);
        return parsed;
      },
    })
  ).value;
  return regions.map((region) => ({
    code: region.code,
    name: region.name,
    latitude: region.latitude,
    longitude: region.longitude,
    gatewayAvailable: region.gateway_available,
    requiresPaidPlan: region.requires_paid_plan,
    deprecated: region.deprecated,
  }));
}

/** Map one parsed flyctl app to the identity the launcher keeps. */
export function toFlyAppIdentity(app: z.infer<typeof FlyAppResponseSchema>): FlyAppIdentity {
  return {
    id: app.ID,
    name: app.Name,
    organizationSlug: app.Organization.Slug,
    status: app.Status,
  };
}

/** Read Fly apps in one explicitly selected organization. */
export async function readFlyApps(
  options: FlySessionReadOptions,
  organizationSlug: string
): Promise<FlyAppIdentity[]> {
  const slug = ExternalIdentifierSchema.parse(organizationSlug);
  const apps = (
    await runProviderCommand({
      ...options,
      args: ['apps', 'list', '--org', slug, '--json'],
      parse: (stdout) => {
        const parsed = z.array(FlyAppResponseSchema).parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed, (app) => app.ID);
        if (parsed.some((app) => app.Organization.Slug !== slug)) {
          throw new Error('ORGANIZATION_BINDING_MISMATCH');
        }
        return parsed;
      },
    })
  ).value;
  return apps.map(toFlyAppIdentity);
}

/**
 * Resolve the GraphQL ID of one explicitly selected organization.
 *
 * Fly's add-on creation takes the organization's ID, not its slug, and `apps list` no longer
 * reports that ID, so it is read from `orgs show` and bound back to the selected slug.
 */
export async function readFlyOrganizationId(
  options: FlySessionReadOptions,
  organizationSlug: string
): Promise<string> {
  const slug = ExternalIdentifierSchema.parse(organizationSlug);
  return (
    await runProviderCommand({
      ...options,
      args: ['orgs', 'show', slug, '--json'],
      parse: (stdout) => {
        const parsed = FlyOrganizationDetailSchema.parse(parseExternalJson(stdout));
        if (parsed.Slug !== slug) throw new Error('ORGANIZATION_BINDING_MISMATCH');
        return parsed.ID;
      },
    })
  ).value;
}

/** Read exact Machine, release, and public-address state for one verified app. */
export async function readFlyRuntimeInventory(
  options: FlySessionReadOptions,
  appName: string
): Promise<FlyRuntimeInventory> {
  const app = ExternalIdentifierSchema.parse(appName);
  const [machines, releases, addresses] = await Promise.all([
    runProviderCommand({
      ...options,
      args: ['machine', 'list', '--app', app, '--json'],
      parse: (stdout) => {
        const parsed = z.array(FlyMachineSchema).parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed, (machine) => machine.id);
        return parsed;
      },
    }),
    runProviderCommand({
      ...options,
      args: ['releases', '--app', app, '--json'],
      parse: (stdout) => {
        const parsed = z.array(FlyReleaseSchema).parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed, (release) => release.ID);
        if (new Set(parsed.map((release) => release.Version)).size !== parsed.length) {
          throw new Error('DUPLICATE_RELEASE_VERSION');
        }
        return parsed;
      },
    }),
    runProviderCommand({
      ...options,
      args: ['ips', 'list', '--app', app, '--json'],
      parse: (stdout) => {
        const parsed = z.array(FlyIpSchema).parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed, (address) => address.ID);
        return parsed;
      },
    }),
  ]);
  return {
    machines: machines.value.map((machine) => ({
      id: machine.id,
      name: machine.name,
      state: machine.state,
      region: machine.region,
      imageDigest: machine.image_ref.digest,
      imageRepository: `${machine.image_ref.registry}/${machine.image_ref.repository}`,
      checks: machine.checks.map(({ name, status }) => ({ name, status })),
    })),
    releases: releases.value.map((release) => ({
      id: release.ID,
      imageRef: release.ImageRef,
      status: release.Status,
      stable: release.Stable,
      version: release.Version,
    })),
    addresses: addresses.value.map((address) => ({
      id: address.ID,
      address: address.Address,
      type: address.Type,
      region: address.Region,
    })),
  };
}
