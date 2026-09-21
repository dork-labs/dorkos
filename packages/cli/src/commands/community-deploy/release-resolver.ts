/**
 * Exact-version, attestation-bound Community release resolution seam.
 *
 * @module commands/community-deploy/release-resolver
 */

/** Trusted release identity supplied by launcher policy. */
export interface TrustedReleaseIdentity {
  /** Expected GitHub repository, such as `dork-labs/dorkos`. */
  repository: string;
  /** Expected release workflow path in that repository. */
  workflowRef: string;
  /** Exact version tag source ref. */
  sourceRef: string;
}

/** Attestation identity returned only after cryptographic verification. */
export type VerifiedAttestationIdentity = TrustedReleaseIdentity;

/** Minimal compatible release fields consumed by launch planning. */
export interface CompatibleCommunityRelease {
  /** Exact DorkOS version represented by the manifest. */
  dorkosVersion: string;
  /** Immutable Community image selection. */
  image: {
    /** Expected Community image repository. */
    repository: string;
    /** Immutable OCI digest. */
    digest: string;
    /** Published image platforms. */
    platforms: Array<{ os: string; architecture: string }>;
  };
  /** Release workflow identity embedded by the generator. */
  provenance: {
    /** Source repository embedded in the manifest. */
    repository: string;
    /** Workflow ref embedded in the manifest. */
    workflowRef: string;
  };
  /** Configuration schema understood by the release. */
  configSchemaVersion: number;
  /** Migration corpus compatibility fingerprint. */
  migrationCompatibilityId: string;
  /** Minimum Fly CLI version required by this release. */
  minimumFlyctlVersion: string;
  /** Minimum Neon CLI version required by this release. */
  minimumNeonCliVersion: string;
}

/** Read and verify exact release assets without selecting a fallback. */
export interface CommunityReleaseSource {
  /** Read the manifest asset for exactly the requested version. */
  readExactManifest(version: string): Promise<Uint8Array>;
  /** Verify the manifest bytes and return their trusted signing identity. */
  verifyManifest(
    bytes: Uint8Array,
    trusted: TrustedReleaseIdentity
  ): Promise<VerifiedAttestationIdentity>;
  /** Verify the selected immutable image against the same trusted identity. */
  verifyImage(
    repository: string,
    digest: string,
    trusted: TrustedReleaseIdentity
  ): Promise<VerifiedAttestationIdentity>;
}

/** Stable, non-provider-write release resolution error. */
export class CommunityReleaseResolutionError extends Error {
  /** Safe failure code for CLI output and launch journals. */
  readonly code:
    | 'COMMUNITY_RELEASE_NOT_READY'
    | 'COMMUNITY_RELEASE_INVALID'
    | 'COMMUNITY_RELEASE_VERSION_MISMATCH'
    | 'COMMUNITY_RELEASE_PROVENANCE_MISMATCH';

  /** Create a secret-free release-resolution failure. */
  constructor(code: CommunityReleaseResolutionError['code']) {
    super(`Community release resolution failed (${code})`);
    this.name = 'CommunityReleaseResolutionError';
    this.code = code;
  }
}

function sameIdentity(actual: TrustedReleaseIdentity, expected: TrustedReleaseIdentity): boolean {
  return (
    actual.repository === expected.repository &&
    actual.workflowRef === expected.workflowRef &&
    actual.sourceRef === expected.sourceRef
  );
}

/**
 * Resolve exactly one requested release after manifest and image verification.
 *
 * @param version - Exact requested DorkOS version; no fallback is permitted.
 * @param trusted - Expected repository, workflow, and version tag identity.
 * @param source - Asset and attestation boundary.
 * @param parse - Compatible manifest parser supplied by the shared release contract.
 * @returns Parsed non-secret release fields safe to enter an immutable plan.
 */
export async function resolveExactCommunityRelease(
  version: string,
  trusted: TrustedReleaseIdentity,
  source: CommunityReleaseSource,
  parse: (bytes: Uint8Array) => CompatibleCommunityRelease
): Promise<CompatibleCommunityRelease> {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      version
    ) ||
    trusted.sourceRef !== `refs/tags/v${version}` ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(trusted.repository) ||
    !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u.test(trusted.workflowRef)
  ) {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_INVALID');
  }
  let bytes: Uint8Array;
  try {
    bytes = await source.readExactManifest(version);
  } catch {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_NOT_READY');
  }
  let manifestIdentity: VerifiedAttestationIdentity;
  try {
    manifestIdentity = await source.verifyManifest(bytes, trusted);
  } catch {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_PROVENANCE_MISMATCH');
  }
  if (!sameIdentity(manifestIdentity, trusted)) {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_PROVENANCE_MISMATCH');
  }
  let manifest: CompatibleCommunityRelease;
  try {
    manifest = parse(bytes);
  } catch {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_INVALID');
  }
  if (manifest.dorkosVersion !== version) {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_VERSION_MISMATCH');
  }
  const expectedManifestWorkflowRef = `${trusted.repository}/${trusted.workflowRef}@${trusted.sourceRef}`;
  if (
    manifest.provenance.repository !== trusted.repository ||
    manifest.provenance.workflowRef !== expectedManifestWorkflowRef
  ) {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_PROVENANCE_MISMATCH');
  }
  let imageIdentity: VerifiedAttestationIdentity;
  try {
    imageIdentity = await source.verifyImage(
      manifest.image.repository,
      manifest.image.digest,
      trusted
    );
  } catch {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_PROVENANCE_MISMATCH');
  }
  if (!sameIdentity(imageIdentity, trusted)) {
    throw new CommunityReleaseResolutionError('COMMUNITY_RELEASE_PROVENANCE_MISMATCH');
  }
  return manifest;
}
