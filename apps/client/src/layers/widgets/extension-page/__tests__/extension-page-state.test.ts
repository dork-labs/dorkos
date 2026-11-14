import { describe, expect, it } from 'vitest';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { ExtensionPageAtPath } from '@/layers/shared/model';
import { extensionPageState } from '../model/extension-page-state';

function record(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'garden',
    manifest: { clientApiVersion: 2, id: 'garden', name: 'Garden', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    ...overrides,
  };
}

/** The address `/x/garden` with no page registered for it. */
const NO_MATCH: ExtensionPageAtPath = { extensionId: 'garden', subpath: '', match: null };

describe('extensionPageState', () => {
  it('waits while the app’s own bundle is still starting, even once the first load ended (A, C3)', () => {
    expect(extensionPageState(NO_MATCH, [record()], true, false, 'starting')).toEqual({
      kind: 'loading',
    });
  });

  it('says the app is not working once its bundle failed or timed out (B)', () => {
    expect(extensionPageState(NO_MATCH, [record()], true, false, 'error')).toEqual({
      kind: 'not-working',
      id: 'garden',
      name: 'Garden',
    });
  });

  it('says the page is missing only after the app finished loading without it', () => {
    expect(extensionPageState(NO_MATCH, [record()], true, false, 'ready')).toEqual({
      kind: 'no-page',
      name: 'Garden',
    });
  });

  it('keeps “not allowed to run yet” for an app waiting on a person, whatever its old load says (C2)', () => {
    // Its files changed mid-load: the earlier attempt never finished, so the
    // browser half still reads "starting". The approval answer wins.
    const held = [record({ approvedToRun: false })];
    expect(extensionPageState(NO_MATCH, held, true, false, 'starting')).toEqual({
      kind: 'not-allowed',
      name: 'Garden',
    });
    expect(extensionPageState(NO_MATCH, held, true, false, 'error')).toEqual({
      kind: 'not-allowed',
      name: 'Garden',
    });
  });

  it('waits before the first load and while a reload settles', () => {
    expect(extensionPageState(NO_MATCH, [], false)).toEqual({ kind: 'loading' });
    expect(extensionPageState(NO_MATCH, [record()], true, true, 'error')).toEqual({
      kind: 'loading',
    });
  });
});
