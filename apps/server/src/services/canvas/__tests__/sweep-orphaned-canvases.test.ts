import { describe, it, expect, vi } from 'vitest';
import { sweepOrphanedCanvases, type OrphanSweepListing } from '../sweep-orphaned-canvases.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ error: String(err) }),
}));

// The health timer listed every session in the default folder every five
// minutes for a sweep that nearly always had nothing to do (DOR-2905).

/** A canvas with `marks` sessions marked gone, whose sweep deletes one document. */
function fakeCanvas(marks: number) {
  return {
    orphanMarkCount: vi.fn(() => marks),
    sweepOrphanedCanvasDocuments: vi.fn((_listing: OrphanSweepListing | null) => 1),
  };
}
const listing: OrphanSweepListing = {
  sessions: [{ id: 's1', runtime: 'claude-code' }],
  degradedRuntimes: [],
};

describe('sweepOrphanedCanvases', () => {
  it('lists nothing when no session is marked gone', async () => {
    const canvas = fakeCanvas(0);
    const list = vi.fn(async () => listing);

    expect(await sweepOrphanedCanvases(canvas, list)).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(canvas.sweepOrphanedCanvasDocuments).not.toHaveBeenCalled();
  });

  it('lists and sweeps while a session is marked', async () => {
    const canvas = fakeCanvas(2);
    const list = vi.fn(async () => listing);

    expect(await sweepOrphanedCanvases(canvas, list)).toBe(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(canvas.sweepOrphanedCanvasDocuments).toHaveBeenCalledWith(listing);
  });

  it('tells the sweep the listing failed, so it deletes nothing', async () => {
    const canvas = fakeCanvas(1);
    await sweepOrphanedCanvases(canvas, async () => {
      throw new Error('sidecar down');
    });
    expect(canvas.sweepOrphanedCanvasDocuments).toHaveBeenCalledWith(null);
  });

  it('settles a sweep that throws instead of rejecting', async () => {
    const canvas = fakeCanvas(1);
    canvas.sweepOrphanedCanvasDocuments.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    await expect(sweepOrphanedCanvases(canvas, async () => listing)).resolves.toBe(1);
    expect(canvas.sweepOrphanedCanvasDocuments).toHaveBeenLastCalledWith(null);
  });

  it('does nothing before the canvas service exists', async () => {
    const list = vi.fn(async () => listing);
    expect(await sweepOrphanedCanvases(undefined, list)).toBe(0);
    expect(list).not.toHaveBeenCalled();
  });
});
