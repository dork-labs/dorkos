/**
 * A link inside the folder (npm's `.bin`) is digested by its text; one that
 * points outside, or by an absolute path, still means no digest (DOR-3068).
 *
 * @module services/marketplace/lib/__tests__/install-digest-links
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forgetFolderDigest, installFolderDigest, isLinkInside } from '../install-digest.js';

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'digest-links-')));
  root = path.join(tmp, 'ext');
  await fs.mkdir(path.join(root, 'node_modules', 'tool', 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.ts'), 'export function activate() {}');
  await fs.writeFile(
    path.join(root, 'node_modules', 'tool', 'bin', 'tool.js'),
    '#!/usr/bin/env node'
  );
});
afterEach(async () => {
  forgetFolderDigest(root);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function digestOf(): Promise<string> {
  forgetFolderDigest(root);
  const found = await installFolderDigest(root);
  if (found.kind !== 'digest') throw new Error(found.kind);
  return found.digest;
}

describe('links in a digested folder', () => {
  it('digests an npm .bin link that stays inside the folder, by its text', async () => {
    const without = await digestOf();
    await fs.symlink('../tool/bin/tool.js', path.join(root, 'node_modules', '.bin', 'tool'));
    const withLink = await digestOf();
    expect(withLink).not.toBe(without);

    // Repointing the link is a change, though no file's bytes changed.
    await fs.rm(path.join(root, 'node_modules', '.bin', 'tool'));
    await fs.symlink('../../index.ts', path.join(root, 'node_modules', '.bin', 'tool'));
    expect(await digestOf()).not.toBe(withLink);
  });

  it('refuses a link that leaves the folder, or names an absolute path', async () => {
    await fs.writeFile(path.join(tmp, 'evil.js'), 'steal()');
    await fs.symlink('../../../evil.js', path.join(root, 'node_modules', '.bin', 'evil'));
    forgetFolderDigest(root);
    expect((await installFolderDigest(root)).kind).toBe('linked');

    await fs.rm(path.join(root, 'node_modules', '.bin', 'evil'));
    await fs.symlink(path.join(root, 'index.ts'), path.join(root, 'node_modules', '.bin', 'abs'));
    forgetFolderDigest(root);
    expect((await installFolderDigest(root)).kind).toBe('linked');
  });

  it('judges a link’s text against the folder that holds it', () => {
    expect(isLinkInside('/r', '/r/node_modules/.bin', '../tool/bin/x.js')).toBe(true);
    expect(isLinkInside('/r', '/r/a', '../../outside')).toBe(false);
    expect(isLinkInside('/r', '/r/a', '/r/a/b')).toBe(false);
  });
});
