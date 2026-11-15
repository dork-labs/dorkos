/**
 * Pin suite for `release-checks/chromium-age.ts`, the release check that keeps the Agent browser's
 * fallback Chromium within 30 days of stable (DOR-3876). Every source is canned: the suite never
 * reads the network, and never depends on today's real pin or schedule.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  dashSchedule,
  runChromiumAge,
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

  it('refuses a stable milestone whose schedule says it reaches stable later', async () => {
    const canned = sources('157.0.1.1', 158, { 158: '2026-12-25T00:00:00Z' });
    await expect(measureChromiumAge(canned, NOW)).rejects.toThrow(/reaches stable later/);
  });

  it('fails closed when the schedule cannot be read', async () => {
    await expect(measureChromiumAge(sources('157.0.1.1', 158), NOW)).rejects.toThrow(
      /no date for 158/
    );
  });
});

/** A schedule reader whose Chromium Dash answers are canned by URL path. */
function dash(releases: unknown, schedules: Record<number, unknown> = {}) {
  return dashSchedule(async (url) => {
    if (url.includes('/fetch_releases')) return releases;
    const milestone = Number(new URL(url).searchParams.get('mstone'));
    return schedules[milestone];
  });
}

// Every way the feed could be wrong must throw (exit 2), never read as fewer days behind.
describe('dashSchedule', () => {
  it('reads the newest stable milestone', async () => {
    expect(await dash([{ milestone: 157 }, { milestone: 158 }]).stableMilestone()).toBe(158);
  });

  it.each([
    ['not a list', { milestone: 158 }],
    ['an empty list', []],
    ['an entry with no milestone', [{ milestone: 158 }, {}]],
    ['a milestone given as text', [{ milestone: '159' }, { milestone: 158 }]],
    ['a null entry', [null, { milestone: 158 }]],
  ])('refuses a release feed that is %s', async (_label, releases) => {
    await expect(dash(releases).stableMilestone()).rejects.toThrow();
  });

  it('counts from the earlier of early stable and stable', async () => {
    const schedule = {
      mstones: [
        { mstone: 158, early_stable: '2026-11-04T00:00:00', stable_date: '2026-11-17T00:00:00' },
      ],
    };
    expect(await dash([], { 158: schedule }).firstStableDate(158)).toEqual(
      new Date('2026-11-04T00:00:00Z')
    );
  });

  it('uses the stable date when there is no early stable', async () => {
    const schedule = { mstones: [{ mstone: 158, stable_date: '2026-11-17T00:00:00' }] };
    expect(await dash([], { 158: schedule }).firstStableDate(158)).toEqual(
      new Date('2026-11-17T00:00:00Z')
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', { mstones: [] }],
    ['for another milestone', { mstones: [{ mstone: 159, stable_date: '2026-12-15T00:00:00' }] }],
    ['without dates', { mstones: [{ mstone: 158 }] }],
    [
      'with an unreadable early stable date',
      { mstones: [{ mstone: 158, early_stable: 'soon', stable_date: '2026-11-17T00:00:00' }] },
    ],
    [
      'with a date in another format',
      { mstones: [{ mstone: 158, stable_date: '2026-11-17T00:00:00+05:00' }] },
    ],
  ])('refuses a schedule that is %s', async (_label, schedule) => {
    await expect(dash([], { 158: schedule }).firstStableDate(158)).rejects.toThrow();
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

// Security's read (#dorkos, Nov 12): no Chromium Dash answer may make the release check pass.
// Each case runs the whole check and must exit 2 (couldn't measure), never 0.
describe('runChromiumAge exit codes', () => {
  const quiet = { log: () => undefined, error: () => undefined };
  const RELEASES = [{ milestone: 158 }];
  const SCHEDULE = { mstones: [{ mstone: 158, early_stable: '2026-11-04T00:00:00' }] };

  /** The whole check, with the pin and each Chromium Dash answer canned. */
  function run(pin: string, releases: () => unknown, schedule: () => unknown) {
    const getJson = async (url: string) =>
      url.includes('/fetch_releases') ? releases() : schedule();
    return runChromiumAge({ pinned: () => pin, ...dashSchedule(getJson) }, NOW, quiet);
  }

  it('exits 0 when the pin is within the limit', async () => {
    expect(
      await run(
        '158.0.1.1',
        () => RELEASES,
        () => SCHEDULE
      )
    ).toBe(0);
  });

  it('exits 1 when the pin is over the limit', async () => {
    expect(
      await run(
        '157.0.1.1',
        () => RELEASES,
        () => SCHEDULE
      )
    ).toBe(1);
  });

  it.each([
    ['bad JSON from the release feed', () => JSON.parse('<html>busy</html>'), () => SCHEDULE],
    ['bad JSON from the schedule', () => RELEASES, () => JSON.parse('{"mstones": [')],
    ['an empty release feed', () => [], () => SCHEDULE],
    ['an empty schedule', () => RELEASES, () => ({ mstones: [] })],
    ['a schedule with no stable entry', () => RELEASES, () => ({ mstones: [{ mstone: 158 }] })],
    [
      'a schedule for another milestone',
      () => RELEASES,
      () => ({ mstones: [{ mstone: 157, stable_date: '2026-12-15T00:00:00' }] }),
    ],
  ])('exits 2, never 0, on %s', async (_label, releases, schedule) => {
    expect(await run('157.0.1.1', releases, schedule)).toBe(2);
  });

  it.each(['157', '157.0-beta', 'latest', ''])(
    'exits 2, never 0, on a pinned version it cannot parse (%j)',
    async (pin) => {
      const sources = {
        pinned: () => readPinnedVersion(`export const LOCAL_MANAGED_CHROMIUM_VERSION = '${pin}';`),
        ...dashSchedule(async (url: string) =>
          url.includes('/fetch_releases') ? RELEASES : SCHEDULE
        ),
      };
      expect(await runChromiumAge(sources, NOW, quiet)).toBe(2);
    }
  );
});
