/**
 * The front door of a person's DorkOS in the cloud, and what a hub owes it.
 *
 * The rules pinned here are the ones both sides build against and a later
 * change could widen quietly: the front door's own path prefix, how long a hub
 * stays awake, the short list of paths a caller without the owner's sign-in
 * may reach, the front door's cookie names, the three refusals, and a health
 * field an older hub leaves out.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FRONT_DOOR_COOKIE,
  FRONT_DOOR_COOKIE_NAMES,
  FRONT_DOOR_NONCE_COOKIE,
  FRONT_DOOR_RESERVED_PATH_PREFIX,
  FRONT_DOOR_UNSIGNED_PATHS,
  FRONT_DOOR_WAKE_PATH,
  HUB_AWAKE_AFTER_LAST_REQUEST_SECONDS,
  HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR,
  HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE,
  HUB_FAILED_EXIT_RESTARTS_MAX,
  HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS,
  HUB_WAKE_STARTS_PER_HOUR,
  HUB_WAKE_STARTS_PER_MINUTE,
  HubHealthSchema,
  ProblemCodeSchema,
  ProblemSchema,
  REMOTE_REFUSED_PATHS,
} from '../index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

/** Read one source file of this package as text. */
function srcText(rel: string): string {
  return readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8');
}

/** The path an entry names, whichever kind it is. */
function entryPath(entry: (typeof FRONT_DOOR_UNSIGNED_PATHS)[number]): string {
  return 'exact' in entry ? entry.exact : entry.prefix;
}

describe('the front door`s own paths', () => {
  it('reserves one lower-case prefix, ending in a slash, that never reaches the hub', () => {
    expect(FRONT_DOOR_RESERVED_PATH_PREFIX).toBe('/_dorkos/front-door/');
    expect(FRONT_DOOR_RESERVED_PATH_PREFIX).toBe(FRONT_DOOR_RESERVED_PATH_PREFIX.toLowerCase());
  });

  it('puts the space`s wake under that prefix, so a hub can never serve it', () => {
    expect(FRONT_DOOR_WAKE_PATH).toBe('/_dorkos/front-door/wake');
    expect(FRONT_DOOR_WAKE_PATH.startsWith(FRONT_DOOR_RESERVED_PATH_PREFIX)).toBe(true);
  });
});

describe('how long a hub stays awake', () => {
  it('is at least a minute after the last request it served', () => {
    expect(HUB_AWAKE_AFTER_LAST_REQUEST_SECONDS).toBe(60);
  });

  it('is named beside the sleep rule, so the floor reads next to what may end a wake', () => {
    const text = srcText('hub-wake.ts');
    expect(text).toContain('**What wakes it.**');
    const sleepRule = text.split('**What wakes it.**')[0];
    expect(sleepRule).toContain('HUB_AWAKE_AFTER_LAST_REQUEST_SECONDS');
    expect(sleepRule).toContain('never while a request is in flight');
  });
});

describe('how often each wake may start a hub', () => {
  it('pins the interval for the next-wake time and a space`s wake at five minutes', () => {
    expect(HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS).toBe(300);
  });

  it('pins the per-reason start caps at one a minute and 30 an hour', () => {
    expect(HUB_WAKE_STARTS_PER_MINUTE).toBe(1);
    expect(HUB_WAKE_STARTS_PER_HOUR).toBe(30);
  });

  it('gives a page read the same cap as the other reasons, not a looser one', () => {
    expect(HUB_CONTENT_HOST_WAKE_MAX_PER_MINUTE).toBe(HUB_WAKE_STARTS_PER_MINUTE);
    expect(HUB_CONTENT_HOST_WAKE_MAX_PER_HOUR).toBe(HUB_WAKE_STARTS_PER_HOUR);
  });

  it('says the caps count starts, not requests', () => {
    expect(srcText('hub-wake.ts')).toMatch(/caps\s+count\s+\*\*starts\*\*,\s+not\s+requests/);
  });
});

describe('what happens when a hub stops', () => {
  it('starts a failed hub again only a bounded number of times in a row', () => {
    expect(HUB_FAILED_EXIT_RESTARTS_MAX).toBe(3);
  });

  it('no longer leaves the restart after a failure open-ended', () => {
    expect(srcText('agent-computers.ts')).not.toMatch(/may\s+(re)?start\s+the\s+hub\s+again/);
    expect(srcText('agent-computers.ts')).toContain('HUB_FAILED_EXIT_RESTARTS_MAX');
  });
});

describe('the paths a caller without the owner`s sign-in may reach', () => {
  it('are exactly a computer`s relay dial and its link, each matched exactly', () => {
    expect(FRONT_DOOR_UNSIGNED_PATHS).toEqual([
      { exact: '/api/relay/computer' },
      { exact: '/api/hub/link' },
    ]);
  });

  it('are lower-case, outside the front door`s prefix, and never a path a remote is refused', () => {
    const refused = REMOTE_REFUSED_PATHS.map((entry) =>
      'exact' in entry ? entry.exact : entry.prefix
    );
    for (const entry of FRONT_DOOR_UNSIGNED_PATHS) {
      const p = entryPath(entry);
      expect(p, p).toBe(p.toLowerCase());
      expect(p.startsWith(FRONT_DOOR_RESERVED_PATH_PREFIX), p).toBe(false);
      expect(
        refused.some((r) => p === r || p.startsWith(r)),
        p
      ).toBe(false);
    }
  });

  it('cannot be widened at run time', () => {
    expect(Object.isFrozen(FRONT_DOOR_UNSIGNED_PATHS)).toBe(true);
    for (const entry of FRONT_DOOR_UNSIGNED_PATHS) expect(Object.isFrozen(entry)).toBe(true);
    expect(() =>
      (FRONT_DOOR_UNSIGNED_PATHS as Array<{ exact: string }>).push({ exact: '/api/sessions' })
    ).toThrow();
  });
});

describe('the front door`s cookies', () => {
  it('are the two host-only names a hub never logs, forwards, relays or shows', () => {
    expect(FRONT_DOOR_COOKIE).toBe('__Host-dorkos-door');
    expect(FRONT_DOOR_NONCE_COOKIE).toBe('__Host-dorkos-door-n');
    expect(FRONT_DOOR_COOKIE_NAMES).toEqual([FRONT_DOOR_COOKIE, FRONT_DOOR_NONCE_COOKIE]);
    expect(Object.isFrozen(FRONT_DOOR_COOKIE_NAMES)).toBe(true);
  });
});

describe('the front door`s refusals', () => {
  it('publishes three codes beside the ones it had', () => {
    for (const code of ['sign_in_required', 'hub_starting_failed', 'hub_unavailable']) {
      expect(ProblemCodeSchema.options, code).toContain(code);
    }
  });

  it('sends sign_in_required as 401 with where to go', () => {
    const problem = ProblemSchema.parse(fixture('problem/front-door-sign-in-required.json'));
    expect(problem.code).toBe('sign_in_required');
    expect(problem.status).toBe(401);
    expect(problem.actionUrl).toMatch(/^https:\/\//);
  });

  it('sends hub_starting_failed and hub_unavailable as 503 with a wait', () => {
    for (const [rel, code] of [
      ['problem/front-door-hub-starting-failed.json', 'hub_starting_failed'],
      ['problem/front-door-hub-unavailable.json', 'hub_unavailable'],
    ] as const) {
      const problem = ProblemSchema.parse(fixture(rel));
      expect(problem.code, rel).toBe(code);
      expect(problem.status, rel).toBe(503);
      expect(problem.retryAfterMs, rel).toBeGreaterThan(0);
    }
  });
});

describe('a hub`s health answer', () => {
  it('round-trips serving and keeps every other field it carries', () => {
    const health = fixture('hubs/health-serving.json');
    const parsed = HubHealthSchema.parse(health);
    expect(parsed.serving).toBe(true);
    expect(parsed).toEqual(health);
    expect(HubHealthSchema.parse({ ...health, serving: false }).serving).toBe(false);
  });

  it('still parses an older hub`s answer, with serving absent, which reads as unknown', () => {
    const older = { status: 'ok', version: '0.141.0', uptime: 30 };
    const parsed = HubHealthSchema.parse(older);
    expect('serving' in parsed).toBe(false);
    expect(parsed).toEqual(older);
  });

  it('refuses a value that is not a boolean, so a string never reads as serving', () => {
    expect(HubHealthSchema.safeParse({ status: 'ok', serving: 'true' }).success).toBe(false);
  });
});
