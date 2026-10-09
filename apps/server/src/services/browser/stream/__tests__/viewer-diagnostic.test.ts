import { describe, expect, it } from 'vitest';
import { createBrowserViewerDiagnostic } from '../viewer-diagnostic.js';

describe('bounded original viewer failure diagnostic', () => {
  it.each([undefined, null, false, 0, ''])(
    'retains falsy primary %s before throwing diagnostic callbacks',
    (cause) => {
      const diagnostic: ReturnType<typeof createBrowserViewerDiagnostic> =
        createBrowserViewerDiagnostic(() => {
          expect(diagnostic.originalFailure()).toEqual({ value: cause });
          throw new Error('logger unavailable');
        });
      expect(diagnostic.failure('issue.auth', cause)).toBe(cause);
      diagnostic.failure('publication.pixels', new Error('secondary'));
      expect(diagnostic.originalFailure()?.value).toBe(cause);
    }
  );
  it('never examines opaque original errors or emits request/cause data, and caps emission', () => {
    const cause = new Proxy(
      {},
      {
        get() {
          throw new Error('secret getter read');
        },
        ownKeys() {
          throw new Error('secret keys read');
        },
        getPrototypeOf() {
          throw new Error('prototype read');
        },
      }
    );
    const rows: unknown[] = [];
    const diagnostic = createBrowserViewerDiagnostic((row) => rows.push(row));
    expect(diagnostic.failure('issue.current.registry', cause)).toBe(cause);
    for (let i = 0; i < 100; i++) diagnostic.note('issue.current.binding');
    expect(rows).toHaveLength(16);
    expect(rows[0]).toEqual({ stage: 'issue.current.registry', ordinal: 1 });
    expect(
      rows.every(
        (row) =>
          Object.keys(row as object)
            .sort()
            .join(',') === 'ordinal,stage'
      )
    ).toBe(true);
    expect(diagnostic.originalFailure()?.value).toBe(cause);
  });
  it('cannot replace the first cause through reentrant diagnostic work', () => {
    const primary = new Error('original native read failed');
    const secondary = new Error('reentrant reader failed');
    const diagnostic: ReturnType<typeof createBrowserViewerDiagnostic> =
      createBrowserViewerDiagnostic(() => {
        if (diagnostic.originalFailure()?.value === primary)
          diagnostic.failure('publication.auth', secondary);
      });
    expect(diagnostic.failure('issue.current.binding', primary)).toBe(primary);
    expect(diagnostic.originalFailure()?.value).toBe(primary);
  });
});
