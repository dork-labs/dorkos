import { describe, expect, it, vi } from 'vitest';
import { formatCommunityPreflight, runCommunityDeploy } from '../command.js';
import type { CommunityDeployDependencies, CommunityDeployRequest } from '../command.js';

const request: CommunityDeployRequest = {
  version: '0.76.0',
  dryRun: false,
  selection: {
    flyOrganization: 'dork-labs',
    flyRegion: 'ord',
    appName: 'dorkos-community-test',
    machineSize: 'shared-cpu-1x',
    neonOrganization: 'org-dorian',
    neonRegion: 'aws-us-east-2',
    neonProjectName: 'dorkos-community-test',
    bucketName: 'dorkos-community-test',
  },
};

const release = {
  dorkosVersion: '0.76.0',
  image: {
    repository: 'ghcr.io/dork-labs/dorkos-community',
    digest: `sha256:${'a'.repeat(64)}`,
    platforms: [{ os: 'linux', architecture: 'amd64' }],
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

function dependencies(): CommunityDeployDependencies {
  return {
    resolveRelease: vi.fn().mockResolvedValue(release),
    readPreflight: vi.fn().mockResolvedValue({
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
    }),
    renderPreflight: vi.fn(),
    consent: vi.fn(),
    execute: vi.fn(),
  };
}

describe('Community deploy command orchestration', () => {
  it('uses the same release and read-only planning path for dry runs, then stops', async () => {
    const boundary = dependencies();
    const result = await runCommunityDeploy({ ...request, dryRun: true }, boundary);

    expect(boundary.resolveRelease).toHaveBeenCalledWith('0.76.0');
    expect(boundary.readPreflight).toHaveBeenCalledWith(request.selection);
    expect(boundary.renderPreflight).toHaveBeenCalledWith(result);
    expect(boundary.consent).not.toHaveBeenCalled();
    expect(boundary.execute).not.toHaveBeenCalled();
  });

  it('renders before exact consent and execution', async () => {
    const calls: string[] = [];
    const boundary = dependencies();
    vi.mocked(boundary.renderPreflight).mockImplementation(() => calls.push('render'));
    vi.mocked(boundary.consent).mockImplementation(async () => {
      calls.push('consent');
    });
    vi.mocked(boundary.execute).mockImplementation(async () => {
      calls.push('execute');
    });

    await runCommunityDeploy(request, boundary);
    expect(calls).toEqual(['render', 'consent', 'execute']);
    expect(boundary.consent).toHaveBeenCalledWith('dorkos-community-test');
  });

  it('renders identities, topology, unknown checks, and only a shortened digest', async () => {
    const result = await runCommunityDeploy({ ...request, dryRun: true }, dependencies());
    const output = formatCommunityPreflight(result);

    expect(output).toContain('Dork Labs [dork-labs]');
    expect(output).toContain('Dorian [org-dorian]');
    expect(output).toContain('one shared-cpu-1x Machine');
    expect(output).toContain('fly-billing: unknown');
    expect(output).toContain('creating resources may add charges');
    expect(output).toContain('https://fly.io/docs/about/pricing/');
    expect(output).toContain('https://neon.com/pricing');
    expect(output).toContain('Resources are retained');
    expect(output).not.toContain(release.image.digest);
    expect(output).not.toContain('postgresql://');
  });
});
