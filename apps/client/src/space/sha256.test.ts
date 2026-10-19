import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256OfFile } from './sha256.js';

const node = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('Sha256', () => {
  // Purpose: the browser hashes an export in slices; its digest must be exactly the one the
  // server compares, at every padding boundary and whatever the slice size.
  it('matches Node for every length around the block boundaries', () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const bytes = randomBytes(length);
      expect(new Sha256().update(bytes).hex()).toBe(node(bytes));
    }
  });

  it('gives the same digest however the bytes are sliced', async () => {
    const bytes = randomBytes(300_001);
    const progress: number[] = [];
    expect(await sha256OfFile(new Blob([bytes]), (f) => progress.push(f), 7_777)).toBe(node(bytes));
    expect(progress.at(-1)).toBe(1);
  });
});
