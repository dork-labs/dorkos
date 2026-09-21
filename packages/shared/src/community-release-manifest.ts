/**
 * Signed release contract for the independently deployed Community service.
 *
 * The JSON document is a claim until both its file attestation and the OCI
 * image attestation have been verified against the expected repository and
 * release workflow. Callers must not reach a provider write before that check.
 *
 * @module community-release-manifest
 */
import { z } from 'zod';

/** Current machine-readable Community release manifest format. */
export const COMMUNITY_RELEASE_MANIFEST_FORMAT_VERSION = 1 as const;

/** Dedicated immutable image repository used by the Community release lane. */
export const COMMUNITY_IMAGE_REPOSITORY = 'ghcr.io/dork-labs/dorkos-community' as const;

/** Repository that is allowed to attest Community releases. */
export const COMMUNITY_RELEASE_REPOSITORY = 'dork-labs/dorkos' as const;

/** Workflow that is allowed to attest Community releases. */
export const COMMUNITY_RELEASE_WORKFLOW =
  'dork-labs/dorkos/.github/workflows/publish-community.yml' as const;

/** Configuration contract understood by the first guided launcher. */
export const COMMUNITY_CONFIG_SCHEMA_VERSION = 1 as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

/** One platform present in the published multi-platform OCI index. */
export const CommunityReleasePlatformSchema = z
  .object({
    os: z.literal('linux'),
    architecture: z.enum(['amd64', 'arm64']),
  })
  .strict();

/** Signed, machine-readable mapping from a DorkOS version to one OCI digest. */
export const CommunityReleaseManifestSchema = z
  .object({
    formatVersion: z.literal(COMMUNITY_RELEASE_MANIFEST_FORMAT_VERSION),
    dorkosVersion: VersionSchema,
    image: z
      .object({
        repository: z.literal(COMMUNITY_IMAGE_REPOSITORY),
        digest: DigestSchema,
        platforms: z.array(CommunityReleasePlatformSchema).min(1),
      })
      .strict(),
    configSchemaVersion: z.literal(COMMUNITY_CONFIG_SCHEMA_VERSION),
    migrationCompatibilityId: DigestSchema,
    minimumFlyctlVersion: VersionSchema,
    minimumNeonCliVersion: VersionSchema,
    provenance: z
      .object({
        repository: z.literal(COMMUNITY_RELEASE_REPOSITORY),
        workflowRef: z.string().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const expectedWorkflowRef = `${COMMUNITY_RELEASE_WORKFLOW}@refs/tags/v${manifest.dorkosVersion}`;
    if (manifest.provenance.workflowRef !== expectedWorkflowRef) {
      context.addIssue({
        code: 'custom',
        path: ['provenance', 'workflowRef'],
        message: `Expected ${expectedWorkflowRef}`,
      });
    }
    const uniquePlatforms = new Set(
      manifest.image.platforms.map(({ os, architecture }) => `${os}/${architecture}`)
    );
    if (uniquePlatforms.size !== manifest.image.platforms.length) {
      context.addIssue({
        code: 'custom',
        path: ['image', 'platforms'],
        message: 'Platforms must be unique',
      });
    }
  });

/** Parsed Community release manifest. */
export type CommunityReleaseManifest = z.infer<typeof CommunityReleaseManifestSchema>;

/** Inputs supplied by the release workflow after inspecting the pushed OCI index. */
export interface CreateCommunityReleaseManifestInput {
  /** Version taken from the immutable `v*` tag. */
  dorkosVersion: string;
  /** Multi-platform index digest returned by Buildx. */
  digest: string;
  /** Platforms read back from that exact index digest. */
  platforms: Array<{ os: string; architecture: string }>;
  /** SHA-256 fingerprint derived from this tag's sorted production migrations. */
  migrationCompatibilityId: string;
  /** GitHub's exact caller workflow ref for the tag run. */
  workflowRef: string;
  /** Lowest flyctl version exercised by provider fixtures. */
  minimumFlyctlVersion: string;
  /** Lowest Neon CLI version exercised by provider fixtures. */
  minimumNeonCliVersion: string;
}

/**
 * Build the release document from registry readback, refusing a partial index.
 *
 * @param input - Tag, digest, workflow identity, tool floors, and inspected platforms.
 * @returns A strict, deterministically ordered release manifest.
 */
export function createCommunityReleaseManifest(
  input: CreateCommunityReleaseManifestInput
): CommunityReleaseManifest {
  const platforms = input.platforms
    .map(({ os, architecture }) => ({ os, architecture }))
    .sort((left, right) =>
      `${left.os}/${left.architecture}`.localeCompare(`${right.os}/${right.architecture}`)
    );
  const keys = new Set(platforms.map(({ os, architecture }) => `${os}/${architecture}`));
  for (const required of ['linux/amd64', 'linux/arm64']) {
    if (!keys.has(required)) {
      throw new Error(`Community OCI index is missing required platform ${required}`);
    }
  }
  if (keys.size !== 2 || platforms.length !== 2) {
    throw new Error('Community OCI index must contain exactly linux/amd64 and linux/arm64');
  }
  return CommunityReleaseManifestSchema.parse({
    formatVersion: COMMUNITY_RELEASE_MANIFEST_FORMAT_VERSION,
    dorkosVersion: input.dorkosVersion,
    image: {
      repository: COMMUNITY_IMAGE_REPOSITORY,
      digest: input.digest,
      platforms,
    },
    configSchemaVersion: COMMUNITY_CONFIG_SCHEMA_VERSION,
    migrationCompatibilityId: input.migrationCompatibilityId,
    minimumFlyctlVersion: input.minimumFlyctlVersion,
    minimumNeonCliVersion: input.minimumNeonCliVersion,
    provenance: {
      repository: COMMUNITY_RELEASE_REPOSITORY,
      workflowRef: input.workflowRef,
    },
  });
}

/** Compatibility requirements known before provider preflight begins. */
export interface CommunityReleaseRequirements {
  /** OCI platform selected for the target machine, independent of the operator host. */
  platform: { os: 'linux'; architecture: 'amd64' | 'arm64' };
  /** Configuration schema the launcher can render. */
  configSchemaVersion: number;
  /** Exact migration behavior the launcher has allow-listed. */
  migrationCompatibilityId: string;
}

/**
 * Parse a manifest and refuse incompatible release metadata.
 *
 * Cryptographic attestation verification happens before this function. Its
 * job is to make the compatibility half fail closed after provenance has been
 * established.
 *
 * @param input - Untrusted parsed JSON from the attested manifest file.
 * @param requirements - Target-machine and launcher compatibility requirements.
 * @returns The strict, compatible manifest.
 */
export function parseCompatibleCommunityReleaseManifest(
  input: unknown,
  requirements: CommunityReleaseRequirements
): CommunityReleaseManifest {
  const manifest = CommunityReleaseManifestSchema.parse(input);
  const hasPlatform = manifest.image.platforms.some(
    (platform) =>
      platform.os === requirements.platform.os &&
      platform.architecture === requirements.platform.architecture
  );
  if (!hasPlatform) {
    throw new Error(
      `Community release ${manifest.dorkosVersion} does not include ${requirements.platform.os}/${requirements.platform.architecture}`
    );
  }
  if (manifest.configSchemaVersion !== requirements.configSchemaVersion) {
    throw new Error('Community release configuration schema is incompatible');
  }
  if (manifest.migrationCompatibilityId !== requirements.migrationCompatibilityId) {
    throw new Error('Community release migration contract is incompatible');
  }
  return manifest;
}
