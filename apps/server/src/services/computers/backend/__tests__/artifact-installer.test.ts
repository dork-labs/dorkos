import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArtifact } from '../artifact-installer.js';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'computer-artifact-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
const bytes = Buffer.from('official archive bytes');
const artifact = {
  url: 'https://official.example/artifact',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  maxBytes: 1024,
};
describe('pinned artifact installation', () => {
  it('publishes verified bytes and re-verifies its cache', async () => {
    const fetcher = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const path = join(root, 'archive');
    await installArtifact(artifact, path);
    await installArtifact(artifact, path);
    expect(await readFile(path)).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched hashes without publishing an archive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unexpected'))
    );
    const path = join(root, 'archive');
    await expect(installArtifact(artifact, path)).rejects.toThrow('digest mismatch');
    await expect(access(path)).rejects.toThrow();
  });
  it('refuses HTTPS downgrade redirects and bounded size overflow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://unsafe.example/archive' },
          })
      )
    );
    await expect(installArtifact(artifact, join(root, 'archive'))).rejects.toThrow('HTTPS');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.alloc(2048)))
    );
    await expect(installArtifact(artifact, join(root, 'archive'))).rejects.toThrow('size limit');
  });
});
