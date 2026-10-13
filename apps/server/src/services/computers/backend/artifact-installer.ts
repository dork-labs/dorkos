import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm, lstat } from 'node:fs/promises';
import type { PinnedArtifact } from './types.js';

/** Download a pinned artifact into private storage, publishing only verified bytes. */
export async function installArtifact(artifact: PinnedArtifact, target: string): Promise<void> {
  if (!/^https:\/\//.test(artifact.url) || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    throw new Error('Unpinned computer artifact');
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > artifact.maxBytes)
      throw new Error('Unsafe artifact path');
    const existing = await open(target, 'r');
    try {
      const digest = createHash('sha256');
      for await (const chunk of existing.createReadStream({ autoClose: false }))
        digest.update(chunk);
      if (digest.digest('hex') === artifact.sha256) return;
      throw new Error('Installed artifact digest mismatch');
    } finally {
      await existing.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.partial`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    const response = await fetchHttps(artifact.url);
    if (!response.ok || !response.body) throw new Error('Computer artifact download failed');
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > artifact.maxBytes) throw new Error('Computer artifact exceeds size limit');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (hash.digest('hex') !== artifact.sha256)
      throw new Error('Computer artifact digest mismatch');
    await file.sync();
    await file.close();
    await rename(temporary, target);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

async function fetchHttps(
  url: string,
  remaining = 5,
  signal = AbortSignal.timeout(600_000)
): Promise<Response> {
  if (new URL(url).protocol !== 'https:') throw new Error('Artifact redirect requires HTTPS');
  const response = await fetch(url, { signal, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || remaining === 0) throw new Error('Artifact redirect limit exceeded');
    return fetchHttps(new URL(location, url).href, remaining - 1, signal);
  }
  return response;
}
