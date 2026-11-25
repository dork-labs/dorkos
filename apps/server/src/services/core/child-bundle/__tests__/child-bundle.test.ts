/** Development child caches never supply executable bytes from a previous server unchecked. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { unpackedPath } from '../child-bundle.js';

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

describe('unpackedPath', () => {
  // Purpose: a path inside app.asar maps to its unpacked twin when it exists
  // (the permission model grants real files, not archive entries)...
  it('maps into app.asar.unpacked when the twin exists', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'asar-'));
    try {
      const twin = path.join(root, 'app.asar.unpacked', 'dist', 'server', 'x.cjs');
      await mkdir(path.dirname(twin), { recursive: true });
      await writeFile(twin, '');
      expect(unpackedPath(path.join(root, 'app.asar', 'dist', 'server', 'x.cjs'))).toBe(twin);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // ...and only then.
  it('leaves paths alone when no unpacked twin exists', () => {
    expect(unpackedPath('/Applications/X.app/Contents/Resources/app.asar/dist/server/x.cjs')).toBe(
      '/Applications/X.app/Contents/Resources/app.asar/dist/server/x.cjs'
    );
    expect(unpackedPath('/tmp/not-asar/x.cjs')).toBe('/tmp/not-asar/x.cjs');
  });
});
