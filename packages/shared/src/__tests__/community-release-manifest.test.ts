import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_CONFIG_SCHEMA_VERSION,
  COMMUNITY_RELEASE_MANIFEST_FORMAT_VERSION,
  createCommunityReleaseManifest,
  parseCompatibleCommunityReleaseManifest,
} from '../community-release-manifest.js';

const migrationCompatibilityId = `sha256:${'b'.repeat(64)}`;

const valid = {
  formatVersion: COMMUNITY_RELEASE_MANIFEST_FORMAT_VERSION,
  dorkosVersion: '0.76.0',
  image: {
    repository: 'ghcr.io/dork-labs/dorkos-community',
    digest: `sha256:${'a'.repeat(64)}`,
    platforms: [
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ],
  },
  configSchemaVersion: COMMUNITY_CONFIG_SCHEMA_VERSION,
  migrationCompatibilityId,
  minimumFlyctlVersion: '0.4.104',
  minimumNeonCliVersion: '5.0.0',
  provenance: {
    repository: 'dork-labs/dorkos',
    workflowRef: 'dork-labs/dorkos/.github/workflows/publish-community.yml@refs/tags/v0.76.0',
  },
};

const requirements = {
  platform: { os: 'linux' as const, architecture: 'amd64' as const },
  configSchemaVersion: COMMUNITY_CONFIG_SCHEMA_VERSION,
  migrationCompatibilityId,
};

describe('CommunityReleaseManifestSchema', () => {
  it('creates a deterministic manifest only from a complete two-platform index', () => {
    const manifest = createCommunityReleaseManifest({
      dorkosVersion: '0.76.0',
      digest: `sha256:${'a'.repeat(64)}`,
      platforms: [
        { os: 'linux', architecture: 'arm64' },
        { os: 'linux', architecture: 'amd64' },
      ],
      migrationCompatibilityId,
      workflowRef: 'dork-labs/dorkos/.github/workflows/publish-community.yml@refs/tags/v0.76.0',
      minimumFlyctlVersion: '0.4.104',
      minimumNeonCliVersion: '5.0.0',
    });
    expect(manifest.image.platforms).toEqual([
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ]);
    expect(() =>
      createCommunityReleaseManifest({
        dorkosVersion: '0.76.0',
        digest: `sha256:${'a'.repeat(64)}`,
        platforms: [{ os: 'linux', architecture: 'amd64' }],
        migrationCompatibilityId,
        workflowRef: 'dork-labs/dorkos/.github/workflows/publish-community.yml@refs/tags/v0.76.0',
        minimumFlyctlVersion: '0.4.104',
        minimumNeonCliVersion: '5.0.0',
      })
    ).toThrow('missing required platform linux/arm64');
  });

  it('accepts one immutable multi-platform digest', () => {
    expect(parseCompatibleCommunityReleaseManifest(valid, requirements)).toEqual(valid);
  });

  it('rejects a tampered or mutable digest', () => {
    expect(() =>
      parseCompatibleCommunityReleaseManifest(
        { ...valid, image: { ...valid.image, digest: 'latest' } },
        requirements
      )
    ).toThrow();
  });

  it('rejects a wrong repository or release workflow identity', () => {
    expect(() =>
      parseCompatibleCommunityReleaseManifest(
        { ...valid, provenance: { ...valid.provenance, repository: 'someone/fork' } },
        requirements
      )
    ).toThrow();
    expect(() =>
      parseCompatibleCommunityReleaseManifest(
        { ...valid, provenance: { ...valid.provenance, workflowRef: 'someone/workflow' } },
        requirements
      )
    ).toThrow();
  });

  it('rejects an unknown format or incompatible configuration contract', () => {
    expect(() =>
      parseCompatibleCommunityReleaseManifest({ ...valid, formatVersion: 2 }, requirements)
    ).toThrow();
    expect(() =>
      parseCompatibleCommunityReleaseManifest(valid, {
        ...requirements,
        configSchemaVersion: 2,
      })
    ).toThrow('configuration schema is incompatible');
    expect(() =>
      parseCompatibleCommunityReleaseManifest(valid, {
        ...requirements,
        migrationCompatibilityId: 'future-contract',
      })
    ).toThrow('migration contract is incompatible');
  });

  it('selects the target machine platform rather than the operator architecture', () => {
    expect(() =>
      parseCompatibleCommunityReleaseManifest(valid, {
        ...requirements,
        platform: { os: 'linux', architecture: 'arm64' },
      })
    ).not.toThrow();
    expect(() =>
      parseCompatibleCommunityReleaseManifest(
        {
          ...valid,
          image: { ...valid.image, platforms: [{ os: 'linux', architecture: 'amd64' }] },
        },
        { ...requirements, platform: { os: 'linux', architecture: 'arm64' } }
      )
    ).toThrow('does not include linux/arm64');
  });
});
