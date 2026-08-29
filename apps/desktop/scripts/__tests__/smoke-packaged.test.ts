import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findRendererHealthFile, rendererPaintFailure } from '../smoke-packaged';

/**
 * The packaged smoke's render gate, tested where it can be: the two pure
 * halves of "did the window this build just installed actually paint?".
 *
 * The launch itself needs a packaged `.app` and a real Electron, so it belongs
 * to `desktop-smoke.yml`. What can be pinned here is the part that decides —
 * because the failure this gate exists for (v0.63.0 launched, served and quit
 * cleanly while showing every user a black window) reads as a *pass* if either
 * half is wrong, and nothing downstream would notice.
 */
describe('the packaged smoke’s render gate', () => {
  const created: string[] = [];

  /** A throwaway home with `contents` at `relativePath`, or an empty one. */
  function home(relativePath?: string, contents?: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-smoke-home-'));
    created.push(dir);
    if (relativePath !== undefined) {
      const full = path.join(dir, relativePath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents ?? '');
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('finding the health file', () => {
    // The real path is `Application Support/@dorkos/desktop/…`, and the app
    // name in it comes from packaging config rather than from this source —
    // hence a search rather than a composed path.
    it('finds it under a two-segment app name', () => {
      const dir = home('Library/Application Support/@dorkos/desktop/renderer-health.json', '{}');

      expect(findRendererHealthFile(dir)).toBe(
        path.join(dir, 'Library/Application Support/@dorkos/desktop/renderer-health.json')
      );
    });

    it('finds it under a single-segment app name', () => {
      const dir = home('Library/Application Support/DorkOS/renderer-health.json', '{}');

      expect(findRendererHealthFile(dir)).not.toBeNull();
    });

    it('answers null while the app has not written one yet', () => {
      expect(findRendererHealthFile(home())).toBeNull();
    });

    it('answers null for a home that does not exist, rather than throwing', () => {
      expect(findRendererHealthFile('/nonexistent-dorkos-smoke-home')).toBeNull();
    });
  });

  describe('deciding whether the window painted', () => {
    const LAUNCHED_AT = Date.UTC(2026, 7, 28, 12, 0, 0);

    /** A health record `offsetMs` from the launch, with `failures` recorded. */
    function record(offsetMs: number, failures = 0): string {
      return JSON.stringify({
        consecutiveFailures: failures,
        updatedAt: new Date(LAUNCHED_AT + offsetMs).toISOString(),
      });
    }

    it('accepts a zeroed record written after the launch', () => {
      expect(rendererPaintFailure(record(5_000), LAUNCHED_AT)).toBeNull();
    });

    // The check that makes the gate mean anything: a stale record left by an
    // earlier run would otherwise pass every launch forever.
    it('rejects a record left behind by an earlier run', () => {
      const failure = rendererPaintFailure(record(-60_000), LAUNCHED_AT);

      expect(failure).toContain('never reported a first paint');
    });

    it('rejects a record showing the supervisor mid-recovery', () => {
      const failure = rendererPaintFailure(record(5_000, 2), LAUNCHED_AT);

      expect(failure).toContain('2 consecutive failure(s)');
    });

    it('rejects a record with no usable timestamp', () => {
      expect(
        rendererPaintFailure(JSON.stringify({ consecutiveFailures: 0 }), LAUNCHED_AT)
      ).toContain('no usable updatedAt');
      expect(rendererPaintFailure('{ truncated', LAUNCHED_AT)).toContain('not readable JSON');
    });

    // The app's clock and this process's are not the same reading, and a
    // sub-second difference is not evidence of anything.
    it('tolerates a record stamped a moment before the launch', () => {
      expect(rendererPaintFailure(record(-500), LAUNCHED_AT)).toBeNull();
    });
  });
});

/**
 * A source assertion, deliberately, and the reason is the same one this file
 * opens with: `launchApp` needs a packaged `.app` and a real Electron, so the
 * environment it builds cannot be exercised here — yet dropping one variable
 * from it fails only in `desktop-smoke.yml`, six minutes and a full package
 * build away, wearing the face of an unrelated hang.
 *
 * Pinned rather than left to CI because this exact line is load-bearing and
 * non-obvious: the app is launched from `release/`, which the install-location
 * guard reads as a wrong home, and its offer is a modal dialog raised before
 * the server starts. Unanswered on a runner, the app never serves
 * `/api/health` and the run dies as a 120s timeout with no output at all.
 */
describe('the packaged smoke’s launch environment', () => {
  const source = readFileSync(new URL('../smoke-packaged.ts', import.meta.url), 'utf-8');

  it('silences the install-location prompt', () => {
    expect(source).toMatch(/DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT:\s*'1'/);
  });

  // Named here too so that removing one of them is a red test rather than a
  // silently half-isolated run against the developer's real ~/.dork.
  it('still isolates the home directory through both resolvers', () => {
    expect(source).toMatch(/HOME:\s*home/);
    expect(source).toMatch(/CFFIXED_USER_HOME:\s*home/);
  });
});
