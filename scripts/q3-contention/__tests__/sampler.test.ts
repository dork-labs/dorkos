import { describe, it, expect } from 'vitest';
import { parseFdProbe, sumProcessTree } from '../sampler.js';

// One `ps -axo pid=,ppid=,rss=` dump: the harness (1) spawned sh (100), which
// spawned the server (200), which spawned two runtime subprocesses (300, 301).
// 900 is an unrelated process that must not be counted.
const TABLE = [
  { pid: 1, ppid: 0, rssKb: 1_000 },
  { pid: 100, ppid: 1, rssKb: 2_000 },
  { pid: 200, ppid: 100, rssKb: 50_000 },
  { pid: 300, ppid: 200, rssKb: 400_000 },
  { pid: 301, ppid: 200, rssKb: 300_000 },
  { pid: 900, ppid: 1, rssKb: 999_000 },
];

describe('sumProcessTree', () => {
  it('sums the root and every descendant, and nothing else', () => {
    const result = sumProcessTree(TABLE, 100);
    expect(result.procCount).toBe(4);
    expect(result.rssTreeKb).toBe(2_000 + 50_000 + 400_000 + 300_000);
    expect(result.rssRootKb).toBe(2_000);
  });

  it('counts a leaf process as a tree of one', () => {
    expect(sumProcessTree(TABLE, 301)).toEqual({
      procCount: 1,
      rssTreeKb: 300_000,
      rssRootKb: 300_000,
    });
  });

  it('reports zero for a pid that has already exited', () => {
    expect(sumProcessTree(TABLE, 4242)).toEqual({
      procCount: 0,
      rssTreeKb: 0,
      rssRootKb: 0,
    });
  });

  it('terminates on a self-parented process instead of looping forever', () => {
    const cyclic = [
      { pid: 10, ppid: 10, rssKb: 5 },
      { pid: 11, ppid: 10, rssKb: 7 },
    ];
    expect(sumProcessTree(cyclic, 10)).toEqual({ procCount: 2, rssTreeKb: 12, rssRootKb: 5 });
  });
});

describe('parseFdProbe', () => {
  it('reads the count and limit off the sysctl output, leading newline and all', () => {
    // `Number('')` is 0, so an unfiltered split would silently report zero fds.
    expect(parseFdProbe('\n23043\n368640\n')).toEqual({ openFiles: 23043, maxFiles: 368640 });
  });

  it('reports -1 when the platform gave nothing back', () => {
    expect(parseFdProbe('')).toEqual({ openFiles: -1, maxFiles: -1 });
  });

  it('reports -1 for a limit the platform omitted', () => {
    expect(parseFdProbe('512\n')).toEqual({ openFiles: 512, maxFiles: -1 });
  });
});
