/**
 * Unit tests for the contiguous port-block allocator — the structural guarantee
 * that replaces branch-name hashing: blocks never overlap, so collisions are
 * impossible.
 */
import { describe, it, expect } from 'vitest';
import { lowestFreeBlock, PortAllocator } from '../port-allocator.js';

describe('lowestFreeBlock', () => {
  it('returns the pool base when nothing is allocated', () => {
    expect(lowestFreeBlock([], 4250, 10)).toBe(4250);
  });

  it('skips taken bases and returns the lowest free block', () => {
    expect(lowestFreeBlock([4250, 4260], 4250, 10)).toBe(4270);
  });

  it('fills a hole left by a released block', () => {
    // 4260 was released → it is the lowest free block again.
    expect(lowestFreeBlock([4250, 4270], 4250, 10)).toBe(4260);
  });

  it('throws when the pool is exhausted', () => {
    // A tiny ceiling-bounded pool: only one block fits near the 65535 ceiling.
    expect(() => lowestFreeBlock([65530], 65530, 10)).toThrow(/exhausted/);
  });
});

describe('PortAllocator', () => {
  it('allocates disjoint blocks as the cache grows', () => {
    const bases: number[] = [];
    const allocator = new PortAllocator({ portBase: 4250, portBlockSize: 10 }, () => bases);

    const first = allocator.allocate();
    bases.push(first);
    const second = allocator.allocate();
    bases.push(second);

    expect(first).toBe(4250);
    expect(second).toBe(4260);
    expect(Math.abs(first - second)).toBeGreaterThanOrEqual(10);
  });

  it('derives the three named ports at fixed offsets', () => {
    const allocator = new PortAllocator({ portBase: 4250, portBlockSize: 10 }, () => []);
    expect(allocator.ports(4250)).toEqual({ DORKOS_PORT: 4250, VITE_PORT: 4251, SITE_PORT: 4252 });
  });
});
