/**
 * Pin suite for `release-checks/chromium-age.ts`, the release check that keeps the Agent browser's
 * fallback Chromium within 30 days of stable (DOR-3876). Every source is canned: the suite never
 * reads the network, and never depends on today's real pin or schedule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAX_DAYS_BEHIND,
  measureChromiumAge,
  readPinnedVersion,
  type ChromiumAgeSources,
} from '../chromium-age.ts';

const NOW = new Date('2026-12-20T12:00:00Z');

/** Canned sources: a pin, a stable milestone, and first-stable dates by milestone. */
function sources(
  pinned: string,
  stable: number,
  dates: Record<number, string> = {}
): ChromiumAgeSources & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    pinned: () => pinned,
    stableMilestone: async () => stable,
    async firstStableDate(milestone) {
      asked.push(milestone);
      const date = dates[milestone];
      if (!date) throw new Error(`no date for ${milestone}`);
      return new Date(date);
    },
  };
}

describe('measureChromiumAge', () => {
  it('passes a pin on today’s stable milestone without reading any date', async () => {
    const canned = sources('158.0.8127.37', 158);
    expect(await measureChromiumAge(canned, NOW)).toMatchObject({ daysBehind: 0, ok: true });
    expect(canned.asked).toEqual([]);
  });

  it('passes a pin ahead of stable, as Playwright alphas are', async () => {
    expect(await measureChromiumAge(sources('159.0.1.2', 158), NOW)).toMatchObject({
      daysBehind: 0,
      ok: true,
    });
  });

  it('counts from the day the NEXT milestone reached stable, not the newest one', async () => {
    const canned = sources('157.0.8103.15', 159, {
      158: '2026-11-04T00:00:00Z',
      159: '2026-12-15T00:00:00Z',
    });
    const age = await measureChromiumAge(canned, NOW);
    expect(canned.asked).toEqual([158]);
    expect(age).toMatchObject({ pinned: '157.0.8103.15', stableMilestone: 159, daysBehind: 46 });
    expect(age.ok).toBe(false);
  });

  it('passes on exactly the limit and fails one day past it', async () => {
    const at = sources('157.0.1.1', 158, { 158: '2026-11-20T00:00:00Z' });
    expect(await measureChromiumAge(at, NOW)).toMatchObject({
      daysBehind: MAX_DAYS_BEHIND,
      ok: true,
    });
    const past = sources('157.0.1.1', 158, { 158: '2026-11-19T00:00:00Z' });
    expect(await measureChromiumAge(past, NOW)).toMatchObject({
      daysBehind: MAX_DAYS_BEHIND + 1,
      ok: false,
    });
  });

  it('treats a stable date still in the future as 0 days behind', async () => {
    const canned = sources('157.0.1.1', 158, { 158: '2026-12-25T00:00:00Z' });
    expect(await measureChromiumAge(canned, NOW)).toMatchObject({ daysBehind: 0, ok: true });
  });

  it('fails closed when the schedule cannot be read', async () => {
    await expect(measureChromiumAge(sources('157.0.1.1', 158), NOW)).rejects.toThrow(
      /no date for 158/
    );
  });
});

describe('readPinnedVersion', () => {
  it('reads the pin from the real backend source', () => {
    const file = fileURLToPath(
      new URL(
        '../../../apps/server/src/services/session/local-browser/playwright-backend.ts',
        import.meta.url
      )
    );
    expect(readPinnedVersion(readFileSync(file, 'utf8'))).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('refuses a source with no pin rather than guessing', () => {
    expect(() => readPinnedVersion('export const OTHER = 1;')).toThrow(/No LOCAL_MANAGED/);
  });
});
