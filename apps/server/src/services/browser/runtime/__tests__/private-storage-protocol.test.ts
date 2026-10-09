import { expect, it, onTestFinished } from 'vitest';
import {
  OriginalStorageReportSchema,
  createOriginalStorageOrigin,
  requireOriginalStorage,
  requireOriginalClean,
  requireOriginalMutationSequence,
  type OriginalStorageReport,
} from './private-storage-origin.fixture.js';
import { joinOriginalPublicNativeReturn } from './public-native-return.js';
const report = (subject: 'A' | 'B' = 'A', round = 3, mutation = 0): OriginalStorageReport => ({
  subject,
  round,
  pageId: 'page-' + subject,
  mutation,
  checkpoint: 0,
  visibleMarker: subject + ': ' + mutation,
  cookie: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  localStorage: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  indexedDB: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  serviceWorker: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  cacheStorage: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  httpCache: subject === 'A' ? 1 : 2,
  sessionCookie: null,
  sessionStorage: null,
});
it('accepts exact durable values at all three restart boundaries and refuses each lost store separately', () => {
  for (const round of [1, 2, 3])
    for (const subject of ['A', 'B'] as const) {
      const actual = OriginalStorageReportSchema.parse(report(subject, round));
      const expected = {
        subject,
        round,
        pageId: 'page-' + subject,
        httpCache: subject === 'A' ? 1 : 2,
        mutation: 0,
      };
      expect(() => requireOriginalStorage(actual, expected)).not.toThrow();
      for (const key of [
        'cookie',
        'localStorage',
        'indexedDB',
        'serviceWorker',
        'cacheStorage',
      ] as const)
        expect(() => requireOriginalStorage({ ...actual, [key]: null }, expected)).toThrow(
          'STORAGE_ORIGINAL_DURABLE_VALUES_REQUIRED'
        );
    }
});
it('clean mode refuses seeded stores and a reused durable HTTP cache value', () => {
  const clean: OriginalStorageReport = {
    ...report(),
    subject: 'clean',
    round: 0,
    pageId: 'clean-page',
    visibleMarker: 'clean: 0',
    cookie: null,
    localStorage: null,
    indexedDB: null,
    serviceWorker: null,
    cacheStorage: null,
    httpCache: 3,
  };
  expect(() => requireOriginalClean(clean, 'clean-page', [1, 2])).not.toThrow();
  for (const key of [
    'cookie',
    'localStorage',
    'indexedDB',
    'serviceWorker',
    'cacheStorage',
    'sessionCookie',
    'sessionStorage',
  ] as const)
    expect(() =>
      requireOriginalClean({ ...clean, [key]: 'fixture-alpha' }, 'clean-page', [1, 2])
    ).toThrow('STORAGE_ORIGINAL_CLEAN_REQUIRED');
  expect(() => requireOriginalClean({ ...clean, httpCache: 1 }, 'clean-page', [1, 2])).toThrow(
    'STORAGE_ORIGINAL_CLEAN_REQUIRED'
  );
});
it('counts exactly100 original mutations for each independent Page and rejects gaps, duplicates or a substituted Page', () => {
  const rows = (['A', 'B'] as const).flatMap((subject) =>
    Array.from({ length: 100 }, (_, i) => report(subject, 3, i + 1))
  );
  expect(requireOriginalMutationSequence(rows, 'A', 'page-A')).toHaveLength(100);
  expect(requireOriginalMutationSequence(rows, 'B', 'page-B')).toHaveLength(100);
  expect(() => requireOriginalMutationSequence(rows.slice(1), 'A', 'page-A')).toThrow(
    'STORAGE_ORIGINAL_100_MUTATIONS_REQUIRED'
  );
  expect(() => requireOriginalMutationSequence([rows[0]!, ...rows], 'A', 'page-A')).toThrow(
    'STORAGE_ORIGINAL_100_MUTATIONS_REQUIRED'
  );
  expect(() => requireOriginalMutationSequence(rows, 'A', 'page-B')).toThrow(
    'STORAGE_ORIGINAL_100_MUTATIONS_REQUIRED'
  );
});
it.each([false, undefined])(
  'a first original body failure %s still joins shutdown and physical observations without being replaced',
  async (value) => {
    const sequence: string[] = [];
    await expect(
      joinOriginalPublicNativeReturn({
        body: Promise.reject(value),
        async close() {
          sequence.push('original-close');
          throw new Error('later-close');
        },
        async observe() {
          sequence.push('original-observe');
        },
      })
    ).rejects.toBe(value);
    expect(sequence).toEqual(['original-close', 'original-observe']);
  }
);

it.each(['ready', 'checkpoint', 'mutate100', 'mutateClean'] as const)(
  'original round cancellation joins held %s observation without closing the next round origin',
  async (operation) => {
    const outer = new AbortController(),
      round = new AbortController();
    const origin = await createOriginalStorageOrigin(outer.signal);
    onTestFinished(() => origin.close());
    const cause = new Error('original-round-cli-failure');
    const waiting =
      operation === 'ready'
        ? origin.ready('A', 0, 'held-page', round.signal)
        : operation === 'checkpoint'
          ? origin.checkpoint('A', 0, 'held-page', 1, round.signal)
          : operation === 'mutate100'
            ? origin.mutate100('A', 'held-page', round.signal)
            : origin.mutateClean('held-page', round.signal);
    void waiting.catch(() => {});
    round.abort(cause);
    await expect(waiting).rejects.toBe(cause);
    expect(outer.signal.aborted).toBe(false);
    origin.assertCurrent();
    // Actual local HTTP receiver + next original wait, not native browser qualification.
    const next = report('A', 1),
      nextRound = new AbortController();
    const reading = origin.ready('A', 1, next.pageId, nextRound.signal);
    const sent = await fetch(origin.origin + '/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    expect(sent.status).toBe(200);
    await sent.arrayBuffer();
    await expect(reading).resolves.toEqual(next);
    await origin.close();
  }
);
