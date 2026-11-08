/** Development child caches never supply executable bytes from a previous server unchecked. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';

it('replaces an overwritten dev bundle left by an earlier server process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'child-bundle-'));
  try {
    await writeFile(path.join(root, 'source.cjs'), 'console.log("trusted fixture");');
    const options = {
      fileName: 'child.cjs',
      sources: ['source.cjs'],
      moduleUrl: pathToFileURL(path.join(root, 'entry.js')).href,
      devCacheDir: path.join(root, 'cache'),
      description: 'The fixture child',
    };
    const first = await import('../child-bundle.js');
    const file = await first.resolveChildBundle(options);
    const trusted = await readFile(file, 'utf8');
    await writeFile(file, 'throw new Error("untrusted cached file");');
    // A new server has no in-memory expected hash or resolved bundle promise.
    vi.resetModules();
    const next = await import('../child-bundle.js');
    expect(await next.resolveChildBundle(options)).toBe(file);
    expect(await readFile(file, 'utf8')).toBe(trusted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
