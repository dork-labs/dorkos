import { describe, expect, it } from 'vitest';
import { buildCommunityPreflight, CommunityPreflightError } from '../preflight.js';

const release = {
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
    repository: 'dork-labs/dorkos',
    workflowRef: 'dork-labs/dorkos/.github/workflows/publish-community.yml@refs/tags/v0.76.0',
  },
  configSchemaVersion: 1,
  migrationCompatibilityId: `sha256:${'b'.repeat(64)}`,
  minimumFlyctlVersion: '0.4.104',
  minimumNeonCliVersion: '5.0.0',
};

const selection = {
  flyOrganization: 'dork-labs',
  flyRegion: 'ord',
  appName: 'dorkos-community-test',
  machineSize: 'shared-cpu-1x',
  neonOrganization: 'org-dorian',
  neonRegion: 'aws-us-east-2',
  neonProjectName: 'dorkos-community-test',
  bucketName: 'dorkos-community-test',
};

const inventory = {
  flyOrganizations: [{ slug: 'dork-labs', name: 'Dork Labs' }],
  flyRegions: [
    {
      code: 'ord',
      name: 'Chicago',
      latitude: 41.8,
      longitude: -87.6,
      gatewayAvailable: true,
      requiresPaidPlan: false,
      deprecated: false,
    },
  ],
  flyApps: [],
  neonOrganizations: [{ id: 'org-dorian', name: 'Dorian' }],
  neonRegions: [
    {
      id: 'aws-us-east-2',
      name: 'AWS US East 2',
      isDefault: false,
      latitude: 40.4,
      longitude: -82.9,
    },
  ],
  neonProjects: [],
};

describe('Community deployment preflight', () => {
  it('constructs a stable explicit plan without inferring billing or quota readiness', () => {
    const first = buildCommunityPreflight(release, selection, inventory);
    const second = buildCommunityPreflight(release, selection, inventory);

    expect(first.planHash).toBe(second.planHash);
    expect(first.plan.fly).toMatchObject({ organizationId: 'dork-labs', region: 'ord' });
    expect(first.plan.neon).toMatchObject({
      organizationId: 'org-dorian',
      region: 'aws-us-east-2',
    });
    expect(first.readiness).toEqual([
      { id: 'fly-app-name', status: 'unknown' },
      { id: 'fly-role', status: 'unknown' },
      { id: 'fly-billing', status: 'unknown' },
      { id: 'fly-quota', status: 'unknown' },
      { id: 'neon-role', status: 'unknown' },
      { id: 'neon-billing', status: 'unknown' },
      { id: 'neon-quota', status: 'unknown' },
    ]);
  });

  it('selects the deployment Linux platform independently of the operator host', () => {
    expect(() =>
      buildCommunityPreflight(
        {
          ...release,
          image: { ...release.image, platforms: [{ os: 'linux', architecture: 'arm64' }] },
        },
        selection,
        inventory
      )
    ).toThrowError(new CommunityPreflightError('RELEASE_PLATFORM_UNSUPPORTED'));
  });

  it('rejects collisions and unavailable region inventory before consent', () => {
    expect(() =>
      buildCommunityPreflight(release, selection, {
        ...inventory,
        flyApps: [
          {
            id: 'app-foreign',
            name: selection.appName,
            organizationSlug: 'dork-labs',
            status: 'deployed',
          },
        ],
      })
    ).toThrowError(new CommunityPreflightError('FLY_APP_NAME_UNAVAILABLE'));

    expect(() =>
      buildCommunityPreflight(release, selection, {
        ...inventory,
        flyRegions: [{ ...inventory.flyRegions[0]!, deprecated: true }],
      })
    ).toThrowError(new CommunityPreflightError('FLY_REGION_UNAVAILABLE'));
  });

  it('allows only exact journaled resource identities to explain resume collisions', () => {
    const existingInventory = {
      ...inventory,
      flyApps: [
        {
          id: 'app-recorded',
          name: selection.appName,
          organizationId: 'org-id',
          organizationSlug: 'dork-labs',
          organizationName: 'Dork Labs',
          status: 'running',
        },
      ],
      neonProjects: [
        {
          id: 'project-recorded',
          organizationId: 'org-dorian',
          name: selection.neonProjectName,
          regionId: 'aws-us-east-2',
          postgresVersion: 17,
        },
      ],
    };
    expect(() =>
      buildCommunityPreflight(release, selection, existingInventory, {
        flyAppId: 'app-recorded',
        neonProjectId: 'project-recorded',
      })
    ).not.toThrow();
    expect(() =>
      buildCommunityPreflight(release, selection, existingInventory, {
        flyAppId: 'app-foreign',
        neonProjectId: 'project-recorded',
      })
    ).toThrowError(new CommunityPreflightError('FLY_APP_NAME_UNAVAILABLE'));
  });
});
