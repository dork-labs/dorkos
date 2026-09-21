import { access, readFile, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createLaunchPlan } from '../plan.js';
import { renderCommunityFlyConfig, withCommunityFlyConfig } from '../fly-config.js';
import { CommunityHealthError, verifyCommunityHealth } from '../health.js';

const plan = createLaunchPlan({
  dorkosVersion: '0.76.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  fly: {
    organizationId: 'dork-labs',
    organizationName: 'Dork Labs',
    appName: 'dorkos-community-test',
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org-dorian',
    organizationName: 'Dorian',
    projectName: 'dorkos-community-test',
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: 'dorkos-community-test', private: true },
});

describe('Community Fly configuration and health', () => {
  it('renders a one-Machine private-storage runtime with no build context or credentials', () => {
    const config = renderCommunityFlyConfig(plan);
    expect(config).toContain('app = "dorkos-community-test"');
    expect(config).toContain('auto_stop_machines = "off"');
    expect(config).toContain('COMMUNITY_STORAGE_DRIVER = "s3"');
    expect(config).toContain('cpus = 1');
    expect(config).not.toContain('[build]');
    expect(config).not.toContain('DATABASE_URL');
  });

  it('keeps the temporary config private and removes it after the deploy callback', async () => {
    let captured = '';
    await withCommunityFlyConfig(plan, async (path) => {
      captured = path;
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, 'utf8')).toContain('internal_port = 6481');
    });
    await expect(access(captured)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires bounded HTTPS success with the exact health shape', async () => {
    const good = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    await expect(
      verifyCommunityHealth('https://dorkos-community-test.fly.dev', {
        timeoutMs: 1_000,
        fetch: good,
      })
    ).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledWith(
      new URL('https://dorkos-community-test.fly.dev/health'),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    await expect(
      verifyCommunityHealth('http://dorkos-community-test.fly.dev', {
        timeoutMs: 1_000,
        fetch: good,
      })
    ).rejects.toBeInstanceOf(CommunityHealthError);
    await expect(
      verifyCommunityHealth('https://dorkos-community-test.fly.dev', {
        timeoutMs: 1_000,
        fetch: vi.fn().mockResolvedValue(new Response('{"status":"starting"}')),
      })
    ).rejects.toBeInstanceOf(CommunityHealthError);
  });

  it('cancels a stalled response body before reporting a timeout', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(
      verifyCommunityHealth('https://dorkos-community-test.fly.dev', {
        timeoutMs: 10,
        fetch: vi.fn().mockResolvedValue(new Response(body)),
      })
    ).rejects.toBeInstanceOf(CommunityHealthError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
