import { installArtifact } from '../artifact-installer.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LimaComputerBackend } from '../lima-backend.js';
import { runBounded } from '../subprocess.js';
import { privateDirectory } from '../private-storage.js';
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'darwin',
  arch: () => 'arm64',
}));
vi.mock('../artifact-installer.js', () => ({
  installArtifact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../subprocess.js', () => ({ runBounded: vi.fn() }));

let root: string;
let identity: { id: string; instanceName: string };
let phase: 'Running' | 'Stopped';
beforeEach(async () => {
  vi.clearAllMocks();
  root = await realpath(await mkdtemp(join(await realpath('/tmp'), 'c-')));
  identity = { id: randomUUID(), instanceName: '' };
  identity.instanceName = 'computer';
  phase = 'Stopped';
  vi.mocked(runBounded).mockImplementation(async (_executable, argv) => {
    if (argv[0] === 'create') {
      const instance = join(root, 'lima', identity.instanceName);
      await mkdir(instance);
      await writeFile(join(instance, 'lima.yaml'), await readFile(join(root, 'computer.yaml')));
    }
    if (argv[0] === 'start') phase = 'Running';
    if (argv[0] === 'stop') phase = 'Stopped';
    if (argv.includes('/usr/local/sbin/dorkos-computer-credentials'))
      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          desktopPassword: 'd'.repeat(64),
          opencodePassword: 'e'.repeat(64),
        }),
      };
    return {
      exitCode: 0,
      stderr: '',
      stdout:
        argv[0] === 'list'
          ? JSON.stringify({
              name: identity.instanceName,
              dir: join(root, 'lima', identity.instanceName),
              status: phase,
            })
          : '',
    };
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('managed persistent computer', () => {
  it('powers off an exactly owned guest after graceful shutdown loses SSH', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    await backend.create(identity, 1);
    const original = vi.mocked(runBounded).getMockImplementation()!;
    vi.mocked(runBounded).mockImplementation(async (executable, argv, options) => {
      if (argv[0] === 'stop' && !argv.includes('--force')) throw new Error('SSH deadline');
      return original(executable, argv, options);
    });
    expect(await backend.stop(identity, 2)).toEqual({ phase: 'stopped', generation: 2 });
    expect(vi.mocked(runBounded).mock.calls.some(([, argv]) => argv.includes('--force'))).toBe(
      true
    );
  });
  it('refuses power-off when configuration changes during graceful shutdown', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    await backend.create(identity, 1);
    const original = vi.mocked(runBounded).getMockImplementation()!;
    vi.mocked(runBounded).mockImplementation(async (executable, argv, options) => {
      if (argv[0] === 'stop') {
        await writeFile(join(root, 'lima/computer/lima.yaml'), 'foreign configuration');
        throw new Error('SSH deadline');
      }
      return original(executable, argv, options);
    });
    expect(await backend.stop(identity, 2)).toEqual({ phase: 'uncertain', generation: 2 });
    expect(vi.mocked(runBounded).mock.calls.some(([, argv]) => argv.includes('--force'))).toBe(
      false
    );
  });
  it('refuses storage exceeding the host socket limit before provisioning', () => {
    expect(() => new LimaComputerBackend({ storageRoot: '/Users/' + 'x'.repeat(104) })).toThrow(
      'socket limit'
    );
  });
  it('retains the disk and credentials across stop and backend restart', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    expect(await backend.create(identity, 1)).toEqual({ phase: 'running', generation: 1 });
    await backend.start(identity, 2);
    const endpoints = await backend.endpoints(identity);
    const disk = join(root, 'lima', identity.instanceName, 'diffdisk');
    await writeFile(disk, 'persistent project');
    expect(await backend.stop(identity, 3)).toEqual({ phase: 'stopped', generation: 3 });
    const restarted = new LimaComputerBackend({ storageRoot: root });
    await restarted.start(identity, 4);
    expect(await restarted.endpoints(identity)).toEqual(endpoints);
    expect(await readFile(disk, 'utf8')).toBe('persistent project');
  });
  it('rejects stale operations and foreign identities before subprocess admission', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    await backend.create(identity, 1);
    await expect(backend.start(identity, 1)).rejects.toThrow('Stale');
    await expect(backend.start({ ...identity, instanceName: 'default' }, 2)).rejects.toThrow(
      'Foreign'
    );
    expect(vi.mocked(runBounded).mock.calls.some(([, argv]) => argv.includes('default'))).toBe(
      false
    );
  });
  it('refuses changed ownership configuration without deleting anything', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    await backend.create(identity, 1);
    await writeFile(join(root, 'lima', identity.instanceName, 'lima.yaml'), 'mounts: ["~"]');
    expect((await backend.start(identity, 2)).phase).toBe('uncertain');
    expect(await readFile(join(root, 'lima', identity.instanceName, 'lima.yaml'), 'utf8')).toBe(
      'mounts: ["~"]'
    );
  });
  it('distinguishes failure before ownership from an unknown existing instance', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    vi.mocked(installArtifact).mockRejectedValueOnce(new Error('download unavailable'));
    await expect(backend.create(identity, 1)).rejects.toThrow('download unavailable');
    expect(await backend.status(identity)).toEqual({ phase: 'missing', generation: 0 });
    await mkdir(join(root, 'lima', identity.instanceName), { recursive: true });
    expect(await backend.status(identity)).toEqual({ phase: 'uncertain', generation: 0 });
    expect(runBounded).not.toHaveBeenCalled();
  });

  it('retains unknown existing instances and never creates replacements', async () => {
    await mkdir(join(root, 'lima', identity.instanceName), { recursive: true });
    const backend = new LimaComputerBackend({ storageRoot: root });
    expect((await backend.create(identity, 1)).phase).toBe('uncertain');
    expect(vi.mocked(runBounded).mock.calls.some(([, argv]) => argv[0] === 'create')).toBe(false);
  });
  it('uses exact Lima home, minimal host environment and non-root argv execution', async () => {
    const backend = new LimaComputerBackend({ storageRoot: root });
    await backend.create(identity, 1);
    await backend.start(identity, 2);
    await backend.exec(identity, {
      argv: ['/bin/echo', '$(touch /host)'],
      cwd: '/home/agent/project',
    });
    const call = vi
      .mocked(runBounded)
      .mock.calls.find(([, argv]) => argv[0] === 'shell' && argv.includes('-C'));
    expect(call?.[1]).toContain('$(touch /host)');
    expect(call?.[1]).toEqual(
      expect.arrayContaining(['sudo', '-n', '-u', 'agent', '-i', '-C', '/home/agent/project'])
    );
    expect(call?.[2].env.LIMA_HOME).toBe(join(root, 'lima'));
    expect(call?.[2].env.SSH_AUTH_SOCK).toBeUndefined();
    expect(call?.[2].env.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it('rejects a symlink storage ancestor', async () => {
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(root, 'link'));
    await expect(privateDirectory(join(root, 'link', 'computer'))).rejects.toThrow('Unsafe');
  });
});
