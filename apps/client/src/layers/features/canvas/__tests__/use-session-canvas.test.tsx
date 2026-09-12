/**
 * @vitest-environment jsdom
 */
/**
 * The one-time import that carries a canvas out of `localStorage` and up to the
 * server (spec `canvas-agent-seat` §1.5), and the retirement it completes.
 *
 * This is a migration that runs on people's machines, and its two failure modes
 * are the ones worth every assertion here: importing TWICE, which would
 * duplicate every `json` and `widget` document, and deleting the local copy
 * before the writes landed — which would destroy the only copy of somebody's
 * canvas.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Deleting the entry before awaiting the writes reddens the failed-POST test.
 * - Dropping the emptiness check reddens the already-filled test, and would
 *   re-seed a table another device had already imported.
 * - Importing before the id is canonical reddens the pre-rekey test, and would
 *   write rows into a scope about to be renamed.
 *
 * @module features/canvas/tests/use-session-canvas
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionCanvas, resetSessionCanvasImport } from '../model/use-session-canvas';

const LEGACY_KEY = 'dorkos-canvas-sessions';
const SESSION = 'sess-canonical';

const transport = createMockTransport();

/** Render the hook inside a provider, as the app does. */
function wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={transport}>{children}</TransportProvider>;
}

/** Seed the retired `localStorage` map with one session's canvas. */
function seedLegacy(sessionId: string, documents: { content: unknown; openedAt: number }[]): void {
  localStorage.setItem(
    LEGACY_KEY,
    JSON.stringify({ [sessionId]: { open: true, documents, accessedAt: 5 } })
  );
}

const A = { content: { type: 'file', sourcePath: '/src/a.ts' }, openedAt: 1 };
const B = { content: { type: 'file', sourcePath: '/src/b.ts' }, openedAt: 2 };

describe('useSessionCanvas — the one-time import', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSessionCanvasImport();
    vi.mocked(transport.listSessionCanvas).mockResolvedValue([]);
    vi.mocked(transport.openSessionCanvasDocument).mockResolvedValue(
      {} as Awaited<ReturnType<typeof transport.openSessionCanvasDocument>>
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs every document, oldest first, and only then deletes the local entry', async () => {
    seedLegacy(SESSION, [B, A]);
    renderHook(() => useSessionCanvas(SESSION), { wrapper });

    await waitFor(() => {
      expect(transport.openSessionCanvasDocument).toHaveBeenCalledTimes(2);
    });
    // Oldest first, so the tab order the person left is the order they get back.
    expect(vi.mocked(transport.openSessionCanvasDocument).mock.calls.map((c) => c[1])).toEqual([
      A.content,
      B.content,
    ]);
    await waitFor(() => {
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
  });

  it('runs ONCE: a second mount of the same session POSTs nothing', async () => {
    seedLegacy(SESSION, [A]);
    const first = renderHook(() => useSessionCanvas(SESSION), { wrapper });
    await waitFor(() => {
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
    first.unmount();

    vi.mocked(transport.openSessionCanvasDocument).mockClear();
    renderHook(() => useSessionCanvas(SESSION), { wrapper });
    await waitFor(() => {
      expect(transport.listSessionCanvas).toHaveBeenCalled();
    });
    expect(transport.openSessionCanvasDocument).not.toHaveBeenCalled();
  });

  it('POSTs nothing when the table is already filled, and still deletes the entry', async () => {
    // Another device imported first, or this session's own agent put something
    // there. The emptiness check is what makes the import idempotent across
    // devices; re-seeding here would double everything.
    seedLegacy(SESSION, [A, B]);
    vi.mocked(transport.listSessionCanvas).mockResolvedValue([
      {} as Awaited<ReturnType<typeof transport.listSessionCanvas>>[number],
    ]);
    renderHook(() => useSessionCanvas(SESSION), { wrapper });

    await waitFor(() => {
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
    expect(transport.openSessionCanvasDocument).not.toHaveBeenCalled();
  });

  it('POSTs nothing and deletes nothing while the id is still the pre-rekey one', async () => {
    // A brand-new session streams under the request UUID the client minted and
    // is renamed mid-first-turn. Writing under it would put rows into a scope
    // about to be renamed — and deleting the local entry then would destroy the
    // only copy if those writes had not landed.
    seedLegacy(SESSION, [A]);
    renderHook(() => useSessionCanvas(SESSION, { canonical: false }), { wrapper });

    await Promise.resolve();
    expect(transport.listSessionCanvas).not.toHaveBeenCalled();
    expect(transport.openSessionCanvasDocument).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it('imports once the id BECOMES canonical, on the same session', async () => {
    // The rekey redirect moves the route to the canonical id, which re-runs the
    // hook. The order of the two facts does not matter: whichever arrives
    // second is what releases the import.
    seedLegacy(SESSION, [A]);
    const { rerender } = renderHook(
      ({ canonical }: { canonical: boolean }) => useSessionCanvas(SESSION, { canonical }),
      { wrapper, initialProps: { canonical: false } }
    );
    expect(transport.openSessionCanvasDocument).not.toHaveBeenCalled();

    rerender({ canonical: true });
    await waitFor(() => {
      expect(transport.openSessionCanvasDocument).toHaveBeenCalledTimes(1);
    });
  });

  it('KEEPS the entry when a POST fails, and retries on the next hydrate', async () => {
    // The half with no way back if it is wrong: a table half written and the
    // local copy gone. The retry is safe because the emptiness check sees what
    // the first attempt did land.
    seedLegacy(SESSION, [A, B]);
    vi.mocked(transport.openSessionCanvasDocument).mockRejectedValueOnce(new Error('offline'));
    const first = renderHook(() => useSessionCanvas(SESSION), { wrapper });

    await waitFor(() => {
      expect(transport.openSessionCanvasDocument).toHaveBeenCalled();
    });
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
    first.unmount();

    // The next hydrate tries again and, this time, finishes.
    renderHook(() => useSessionCanvas(SESSION), { wrapper });
    await waitFor(() => {
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });
  });

  it('leaves a session with no entry alone', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ 'some-other-session': { documents: [] } }));
    renderHook(() => useSessionCanvas(SESSION), { wrapper });
    await Promise.resolve();
    expect(transport.openSessionCanvasDocument).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  /**
   * The sweep, which really sweeps (DOR-2006 review nit).
   *
   * It used to drop entries past the retired store's own 50-session window —
   * a window that store enforced on every write, so the map was never above it
   * and the sweep returned immediately, for ever. It goes by age now.
   */
  describe('the sweep of entries nobody will reopen', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('drops an entry nothing has touched in months', async () => {
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({
          'long-forgotten': { documents: [], accessedAt: Date.now() - 90 * DAY },
          'last-week': { documents: [], accessedAt: Date.now() - 7 * DAY },
        })
      );
      renderHook(() => useSessionCanvas(SESSION), { wrapper });
      await Promise.resolve();

      const map = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}') as Record<string, unknown>;
      expect(Object.keys(map)).toEqual(['last-week']);
    });

    it('keeps an undated entry, because a guess cannot be undone', async () => {
      // The single-document shape, from before the retired store timestamped
      // anything. It goes when its own session is next opened and imported.
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({ ancient: { content: { type: 'file', sourcePath: '/src/a.ts' } } })
      );
      renderHook(() => useSessionCanvas(SESSION), { wrapper });
      await Promise.resolve();

      expect(Object.keys(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}'))).toEqual([
        'ancient',
      ]);
    });

    it('never runs for a session that HAS an entry — the import owns that one', async () => {
      // Its own age is irrelevant: a stale-looking entry for the session on
      // screen is imported, not swept, and deleted only once its documents have
      // landed on the server.
      localStorage.setItem(
        LEGACY_KEY,
        JSON.stringify({ [SESSION]: { documents: [A], accessedAt: Date.now() - 90 * DAY } })
      );
      renderHook(() => useSessionCanvas(SESSION), { wrapper });

      await waitFor(() => {
        expect(transport.openSessionCanvasDocument).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('the retirement', () => {
  it('leaves no reader of the retired canvas key outside the importer', () => {
    // A retirement that left a caller behind would keep one browser writing a
    // private copy of a table the server owns — which is the divergence this
    // whole phase removes, reappearing in one file.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const clientSrc = path.resolve(here, '../../../..');
    const hits = execFileSync(
      'grep',
      ['-rl', '-e', LEGACY_KEY, '-e', 'writeCanvasSession', '-e', 'readCanvasSession', clientSrc],
      { encoding: 'utf-8' }
    )
      .split('\n')
      .filter(Boolean)
      .map((file) => path.relative(clientSrc, file))
      .sort();

    expect(hits).toEqual([
      // The importer, and this test.
      'layers/features/canvas/__tests__/use-session-canvas.test.tsx',
      'layers/features/canvas/model/use-session-canvas.ts',
      // The appearance reset's own test, which seeds the key to prove that
      // narrow reset does NOT touch it. It reads no canvas state.
      'layers/features/settings/__tests__/AppearanceResetAction.test.tsx',
      // The resets suite, which asserts the key SURVIVES both of them — it is a
      // migration payload holding documents that may exist nowhere else yet,
      // not a preference a clean slate may take.
      'layers/shared/model/app-store/__tests__/app-store-resets.test.ts',
      // One comment, in `resetAllSettings`, saying why the key is deliberately
      // NOT swept there any more: it is a migration payload now, and the
      // importer is the only thing that may delete it.
      'layers/shared/model/app-store/app-store.ts',
    ]);
  });

  it('leaves no persisted canvas shape on the store helpers', async () => {
    const helpers = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../shared/model/app-store/app-store-helpers.ts'
      ),
      'utf-8'
    );
    expect(helpers).not.toContain('CanvasSessionEntry');
    expect(helpers).not.toContain('PersistedCanvasDocument');
  });
});
