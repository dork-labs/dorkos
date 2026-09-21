import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOwnerHandoffPrerequisites } from '../runtime/default-owner.js';

const roots: string[] = [];

async function executableDirectory(names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-owner-handoff-'));
  roots.push(root);
  await Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o755);
    })
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Community owner handoff prerequisites', () => {
  it.each([
    ['darwin', ['pbcopy', 'open']],
    ['linux', ['wl-copy', 'xdg-open']],
    ['win32', ['clip.exe', 'cmd.exe']],
  ] as const)('accepts the complete %s handoff tool pair', async (system, commands) => {
    await expect(
      assertOwnerHandoffPrerequisites(await executableDirectory(commands), system)
    ).resolves.toBeUndefined();
  });

  it('rejects a headless Linux host before provider writes with safe setup guidance', async () => {
    const path = await executableDirectory(['xdg-open']);
    await expect(assertOwnerHandoffPrerequisites(path, 'linux')).rejects.toThrow(
      'Owner handoff needs wl-copy before setup can create resources'
    );
  });
});
