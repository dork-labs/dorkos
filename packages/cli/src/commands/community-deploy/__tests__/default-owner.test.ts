import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertOwnerHandoffPrerequisites,
  confirmOwnerClipboardWrite,
  tryOpenOwnerOrigin,
} from '../runtime/default-owner.js';

const roots: string[] = [];
const servers: Server[] = [];

async function executableDirectory(names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-owner-handoff-'));
  roots.push(root);
  await Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      await writeFile(path, '#!/bin/sh\n/bin/cat > "$0.stdin"\n');
      await chmod(path, 0o755);
    })
  );
  return root;
}

async function failingExecutableDirectory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-owner-handoff-'));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, '#!/bin/sh\nexit 1\n');
  await chmod(path, 0o755);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Community owner handoff prerequisites', () => {
  it.each([
    ['darwin', ['pbcopy']],
    ['win32', ['clip.exe']],
  ] as const)('accepts a working, non-printing %s clipboard probe', async (system, commands) => {
    const path = await executableDirectory(commands);
    await expect(assertOwnerHandoffPrerequisites({ PATH: path }, system)).resolves.toBeUndefined();
  });

  it('exercises the exact clipboard writer only after explicit local confirmation', async () => {
    const path = await executableDirectory(['pbcopy']);
    const confirm = vi.fn().mockResolvedValue('COPY TEST');
    await expect(
      confirmOwnerClipboardWrite({ PATH: path }, 'darwin', confirm)
    ).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledOnce();
    expect(await readFile(join(path, 'pbcopy.stdin'), 'utf8')).toBe(
      'DorkOS clipboard capability check'
    );
  });

  it('passes cancellation into the local confirmation before any clipboard write', async () => {
    const path = await failingExecutableDirectory('pbcopy');
    const controller = new AbortController();
    const confirm = vi.fn(async (_question: string, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw signal?.reason;
    });
    await expect(
      confirmOwnerClipboardWrite({ PATH: path }, 'darwin', confirm, controller.signal)
    ).rejects.toBe(controller.signal.reason);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('rejects a broken clipboard writer before provider resources exist', async () => {
    const path = await failingExecutableDirectory('pbcopy');
    await expect(
      confirmOwnerClipboardWrite({ PATH: path }, 'darwin', async () => 'COPY TEST')
    ).rejects.toThrow('No new provider write occurred');
  });

  it('does not invoke the clipboard writer when local confirmation is refused', async () => {
    const path = await failingExecutableDirectory('pbcopy');
    await expect(
      confirmOwnerClipboardWrite({ PATH: path }, 'darwin', async () => 'no')
    ).rejects.toThrow('cancelled before any provider write');
  });

  it('accepts Linux only when the selected Wayland session socket is live', async () => {
    const path = await executableDirectory(['wl-copy']);
    const socket = join(path, 'wayland-0');
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await expect(
      assertOwnerHandoffPrerequisites(
        { PATH: path, XDG_RUNTIME_DIR: path, WAYLAND_DISPLAY: 'wayland-0' },
        'linux'
      )
    ).resolves.toBeUndefined();
  });

  it('rejects an installed clipboard tool without a live desktop session before writes', async () => {
    const path = await executableDirectory(['wl-copy']);
    await expect(
      assertOwnerHandoffPrerequisites(
        { PATH: path, XDG_RUNTIME_DIR: path, WAYLAND_DISPLAY: 'wayland-0' },
        'linux'
      )
    ).rejects.toThrow(
      'Owner handoff needs an active Wayland clipboard session before setup can create resources'
    );
  });

  it('treats browser opening as optional because the non-secret URL can be opened manually', async () => {
    const path = await failingExecutableDirectory('open');
    await expect(
      tryOpenOwnerOrigin('https://community.example', { PATH: path }, 'darwin')
    ).resolves.toBe(false);
  });
});
