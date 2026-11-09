import { describe, expect, it } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  appAccessibleName,
  appState,
  buildAppCatalog,
  matchesAppSearch,
  pinnedApps,
  type AppCatalogInput,
} from '../lib/app-catalog';

/** One extension record, running and allowed unless told otherwise. */
function ext(id: string, name: string, overrides: Partial<ExtensionRecordPublic> = {}) {
  return {
    id,
    manifest: { id, name, version: '1.0.0' },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    ...overrides,
  } as ExtensionRecordPublic;
}

/** One listed page. */
function page(extensionId: string, path: string, title: string) {
  return { id: `${extensionId}:${path}`, extensionId, path, title };
}

/** A catalog input with nothing in it. */
function input(overrides: Partial<AppCatalogInput> = {}): AppCatalogInput {
  return {
    extensions: [],
    failed: false,
    waitingIds: new Set(),
    pages: [],
    badges: {},
    known: {},
    pins: [],
    ...overrides,
  };
}

describe('appState', () => {
  it.each([
    ['ok', ext('a', 'A'), false],
    ['held', ext('a', 'A'), true],
    ['held', ext('a', 'A', { approvedToRun: false }), false],
    ['error', ext('a', 'A', { status: 'activate_error' }), false],
    ['error', ext('a', 'A', { status: 'compile_error' }), false],
    ['off', ext('a', 'A', { status: 'disabled' }), true],
  ] as const)('reads %s', (expected, record, waiting) => {
    expect(appState(record, waiting)).toBe(expected);
  });

  it('never holds a core extension for a missing yes: it ships with DorkOS', () => {
    expect(appState(ext('a', 'A', { origin: 'core', approvedToRun: false }), false)).toBe('ok');
  });
});

describe('buildAppCatalog', () => {
  it('is never "no apps" when the list could not be read', () => {
    expect(buildAppCatalog(input({ failed: true, extensions: [ext('a', 'A')] }))).toEqual({
      status: 'failed',
      apps: [],
    });
    expect(buildAppCatalog(input({ extensions: undefined })).status).toBe('loading');
  });

  it('lists only extensions that add a page, A–Z by name', () => {
    const catalog = buildAppCatalog(
      input({
        extensions: [ext('z', 'Zeta'), ext('a', 'alpha'), ext('tools', 'Tools only')],
        pages: [page('z', '', 'Zeta home'), page('a', '', 'Alpha home')],
        clientStates: { tools: 'ready' },
      })
    );
    expect(catalog.apps.map((app) => app.name)).toEqual(['alpha', 'Zeta']);
  });

  it('shows discovered apps before pages register, including failed first loads', () => {
    const records = [ext('garden', 'Garden'), ext('pond', 'Pond')];
    expect(buildAppCatalog(input({ extensions: records })).apps.map((app) => app.state)).toEqual([
      'starting',
      'starting',
    ]);
    expect(
      buildAppCatalog(
        input({
          extensions: records,
          clientStates: { garden: 'starting', pond: 'error' },
        })
      ).apps.map((app) => [app.id, app.state])
    ).toEqual([
      ['garden', 'starting'],
      ['pond', 'error'],
    ]);
  });

  it('opens an app on its home page, else its first listed page', () => {
    const catalog = buildAppCatalog(
      input({
        extensions: [ext('a', 'A'), ext('b', 'B')],
        pages: [page('a', 'board', 'Board'), page('a', '', 'Home'), page('b', 'today', 'Today')],
      })
    );
    expect(catalog.apps.map((app) => [app.id, app.path, app.pageId])).toEqual([
      ['a', '', 'a:'],
      ['b', 'today', 'b:today'],
    ]);
  });

  it('keeps a held app it has seen before, though it registers nothing now', () => {
    const catalog = buildAppCatalog(
      input({
        extensions: [ext('radar', 'Release Radar')],
        waitingIds: new Set(['radar']),
        known: { radar: { name: 'Release Radar', path: 'feed' } },
      })
    );
    expect(catalog.apps).toEqual([
      expect.objectContaining({ id: 'radar', state: 'held', path: 'feed', pageId: null }),
    ]);
  });

  it('keeps a pinned app it has never seen, so a pin never vanishes', () => {
    const catalog = buildAppCatalog(
      input({ extensions: [ext('board', 'Board', { status: 'activate_error' })], pins: ['board'] })
    );
    expect(catalog.apps.map((app) => [app.id, app.state])).toEqual([['board', 'error']]);
  });

  it('drops an uninstalled app, and never draws one Settings alone can explain', () => {
    const catalog = buildAppCatalog(
      input({
        extensions: [
          ext('bad', 'Bad', { status: 'invalid' }),
          ext('new', 'New', { status: 'incompatible' }),
        ],
        known: { gone: { name: 'Gone', path: '' }, bad: { name: 'Bad', path: '' } },
        pins: ['new'],
      })
    );
    expect(catalog.apps).toEqual([]);
  });

  it('carries the app’s own count and live line from its page badge', () => {
    const catalog = buildAppCatalog(
      input({
        extensions: [ext('ts', 'Timesheet')],
        pages: [page('ts', '', 'Timesheet')],
        badges: { 'ts:': { count: 2, sentence: ' 2 entries to check ' } },
      })
    );
    expect(catalog.apps[0]).toEqual(
      expect.objectContaining({ count: 2, line: '2 entries to check' })
    );
  });
});

describe('pinnedApps', () => {
  it('keeps pin order, skips gone pins, and leaves off apps out', () => {
    const { apps } = buildAppCatalog(
      input({
        extensions: [ext('a', 'A'), ext('b', 'B'), ext('c', 'C', { status: 'disabled' })],
        pages: [page('a', '', 'A'), page('b', '', 'B')],
        pins: ['b', 'gone', 'c', 'a'],
      })
    );
    expect(pinnedApps(apps, ['b', 'gone', 'c', 'a']).map((app) => app.id)).toEqual(['b', 'a']);
  });
});

describe('matchesAppSearch and appAccessibleName', () => {
  const [app] = buildAppCatalog(
    input({
      extensions: [
        ext('n', 'Meeting Notes', {
          manifest: { id: 'n', name: 'Meeting Notes', version: '1.0.0', purpose: 'keeps minutes' },
        }),
      ],
      pages: [page('n', '', 'Notes')],
    })
  ).apps;

  it('finds an app by its name or its summary, which it never shows', () => {
    expect(matchesAppSearch(app!, 'meeting')).toBe(true);
    expect(matchesAppSearch(app!, 'MINUTES')).toBe(true);
    expect(matchesAppSearch(app!, 'board')).toBe(false);
    expect(matchesAppSearch(app!, '  ')).toBe(true);
  });

  it('says the state in the name a screen reader hears', () => {
    expect(appAccessibleName({ ...app!, state: 'held' })).toBe('Meeting Notes, needs your OK');
    expect(appAccessibleName({ ...app!, state: 'error' })).toBe(
      'Meeting Notes, not working. Try again'
    );
    expect(appAccessibleName({ ...app!, count: 2 })).toBe('Meeting Notes, 2 waiting');
    expect(appAccessibleName(app!)).toBe('Meeting Notes');
  });
});
