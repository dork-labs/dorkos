import { mkdtemp, mkdir, rename, symlink, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filesystemMutationRootProbe, sameMutationRoot } from '../mutation-roots.js';
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mutation-roots-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('filesystemMutationRootProbe', () => {
  it('records genuine canonical directory inode and complete ancestor identity', async () => {
    const root = await fixture();
    const tree = path.join(root, 'tree');
    await mkdir(tree);
    const result = await filesystemMutationRootProbe.resolve({ directory: tree });
    const info = await stat(tree, { bigint: true });
    expect(result.physicalKey).toBe(`${info.dev}:${info.ino}`);
    expect(result.ancestorPhysicalKeys).toContain(
      `${(await stat(root, { bigint: true })).dev}:${(await stat(root, { bigint: true })).ino}`
    );
    expect(
      sameMutationRoot(result, await filesystemMutationRootProbe.resolve({ directory: tree }))
    ).toBe(true);
    expect(Object.isFrozen(result.ancestorPhysicalKeys)).toBe(true);
  });
  it('never silently rebinds an authorized root after pathname retarget', async () => {
    const root = await fixture();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const alias = path.join(root, 'alias');
    await Promise.all([mkdir(first), mkdir(second)]);
    await symlink(first, alias);
    const original = await filesystemMutationRootProbe.resolve({ directory: alias });
    await rm(alias);
    await symlink(second, alias);
    expect(
      sameMutationRoot(original, await filesystemMutationRootProbe.resolve({ directory: alias }))
    ).toBe(false);
    await rename(second, `${second}-old`);
    await mkdir(second);
    expect(
      sameMutationRoot(original, await filesystemMutationRootProbe.resolve({ directory: second }))
    ).toBe(false);
  });
  it('refuses relative, missing and non-directory roots', async () => {
    const root = await fixture();
    const file = path.join(root, 'file');
    await writeFile(file, 'text');
    await expect(
      filesystemMutationRootProbe.resolve({ directory: './relative' })
    ).rejects.toMatchObject({ code: 'invalid-root' });
    await expect(filesystemMutationRootProbe.resolve({ directory: file })).rejects.toMatchObject({
      code: 'invalid-root',
    });
    await expect(
      filesystemMutationRootProbe.resolve({ directory: path.join(root, 'absent') })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
