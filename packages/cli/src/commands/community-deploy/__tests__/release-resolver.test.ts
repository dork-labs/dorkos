/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import type {
  CommunityReleaseSource,
  CompatibleCommunityRelease,
  TrustedReleaseIdentity,
} from '../release-resolver.js';
import { resolveExactCommunityRelease } from '../release-resolver.js';

const trusted: TrustedReleaseIdentity = {
  repository: 'dork-labs/dorkos',
  workflowRef: '.github/workflows/publish-community.yml',
  sourceRef: 'refs/tags/v0.76.0',
};
const manifest: CompatibleCommunityRelease = {
  dorkosVersion: '0.76.0',
  image: {
    repository: 'ghcr.io/dork-labs/dorkos-community',
    digest: `sha256:${'a'.repeat(64)}`,
    platforms: [
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ],
  },
  provenance: {
    repository: trusted.repository,
    workflowRef: `${trusted.repository}/${trusted.workflowRef}@${trusted.sourceRef}`,
  },
  configSchemaVersion: 1,
  migrationCompatibilityId: `sha256:${'b'.repeat(64)}`,
  minimumFlyctlVersion: '0.4.104',
  minimumNeonCliVersion: '5.0.0',
};

function source(overrides: Partial<CommunityReleaseSource> = {}): CommunityReleaseSource {
  return {
    readExactManifest: vi.fn(async () => Buffer.from(JSON.stringify(manifest))),
    verifyManifest: vi.fn(async () => trusted),
    verifyImage: vi.fn(async () => trusted),
    ...overrides,
  };
}

const parse = (bytes: Uint8Array) =>
  JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease;

describe('exact Community release resolution', () => {
  it('binds the requested version and both attestations to one trusted identity', async () => {
    const boundary = source();
    await expect(resolveExactCommunityRelease('0.76.0', trusted, boundary, parse)).resolves.toEqual(
      manifest
    );
    expect(boundary.readExactManifest).toHaveBeenCalledWith('0.76.0');
    expect(boundary.verifyImage).toHaveBeenCalledWith(
      manifest.image.repository,
      manifest.image.digest,
      trusted
    );
  });

  it('rejects a relative workflow path in manifest provenance', async () => {
    const relativeProvenance = {
      ...manifest,
      provenance: { ...manifest.provenance, workflowRef: trusted.workflowRef },
    };
    await expect(
      resolveExactCommunityRelease(
        '0.76.0',
        trusted,
        source({
          readExactManifest: async () => Buffer.from(JSON.stringify(relativeProvenance)),
        }),
        parse
      )
    ).rejects.toMatchObject({ code: 'COMMUNITY_RELEASE_PROVENANCE_MISMATCH' });
  });

  it('rejects an asset filename whose attested body names another version', async () => {
    const mismatched = { ...manifest, dorkosVersion: '0.75.1' };
    await expect(
      resolveExactCommunityRelease(
        '0.76.0',
        trusted,
        source({
          readExactManifest: async () => Buffer.from(JSON.stringify(mismatched)),
        }),
        parse
      )
    ).rejects.toMatchObject({ code: 'COMMUNITY_RELEASE_VERSION_MISMATCH' });
  });

  it.each([
    ['0.76', trusted],
    ['01.76.0', { ...trusted, sourceRef: 'refs/tags/v01.76.0' }],
    ['0.76.0', { ...trusted, sourceRef: 'refs/tags/v0.75.1' }],
    ['0.76.0', { ...trusted, workflowRef: '../publish-community.yml' }],
  ])(
    'rejects invalid requested release policy before reading assets',
    async (version, identity) => {
      const boundary = source();
      await expect(
        resolveExactCommunityRelease(version, identity, boundary, parse)
      ).rejects.toMatchObject({ code: 'COMMUNITY_RELEASE_INVALID' });
      expect(boundary.readExactManifest).not.toHaveBeenCalled();
    }
  );

  it.each(['repository', 'workflowRef', 'sourceRef'] as const)(
    'rejects a mismatched %s for either attestation',
    async (field) => {
      const wrong = { ...trusted, [field]: 'wrong' };
      await expect(
        resolveExactCommunityRelease(
          '0.76.0',
          trusted,
          source({ verifyManifest: async () => wrong }),
          parse
        )
      ).rejects.toMatchObject({ code: 'COMMUNITY_RELEASE_PROVENANCE_MISMATCH' });
      await expect(
        resolveExactCommunityRelease(
          '0.76.0',
          trusted,
          source({ verifyImage: async () => wrong }),
          parse
        )
      ).rejects.toMatchObject({ code: 'COMMUNITY_RELEASE_PROVENANCE_MISMATCH' });
    }
  );

  it('returns a stable not-ready failure without fallback or unsafe provider text', async () => {
    const canary = 'CANARY_RELEASE_PROVIDER_BODY';
    const boundary = source({
      readExactManifest: vi.fn(async () => {
        throw new Error(canary);
      }),
    });
    await expect(
      resolveExactCommunityRelease('0.76.0', trusted, boundary, parse)
    ).rejects.toMatchObject({
      code: 'COMMUNITY_RELEASE_NOT_READY',
      message: expect.not.stringContaining(canary),
    });
    expect(boundary.verifyManifest).not.toHaveBeenCalled();
    expect(boundary.verifyImage).not.toHaveBeenCalled();
  });
});
