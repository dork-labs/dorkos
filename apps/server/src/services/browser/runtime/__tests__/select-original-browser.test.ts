import { createBrowserViewerDiagnostic } from '../../stream/viewer-diagnostic.js';
import { expect, it, vi } from 'vitest';
import { selectOriginalBrowserIdentity } from '../select-original-browser.js';

it('does not enter unrelated live binding or custody while selecting the actual birth', () => {
  const unrelated = {
    identity: () => ({ browserId: 'other', browserGeneration: 1 }),
    current: vi.fn(() => {
      throw new Error('unrelated native custody must not enter');
    }),
    binding: vi.fn(() => {
      throw undefined;
    }),
  };
  const selected = {
    identity: () => ({ browserId: 'selected', browserGeneration: 2 }),
    current: vi.fn(() => true),
    binding: vi.fn(() => {
      throw false;
    }),
  };
  const originals = [unrelated, selected];
  expect(
    selectOriginalBrowserIdentity(
      originals,
      { browserId: 'selected', browserGeneration: 2 },
      () => true
    )
  ).toBe(selected);
  expect(unrelated.current).not.toHaveBeenCalled();
  expect(unrelated.binding).not.toHaveBeenCalled();
  expect(selected.binding).not.toHaveBeenCalled();
  expect(selected.current).toHaveBeenCalledOnce();
});
it('refuses stale generations and duplicate original identities without entering custody', () => {
  const original = {
    identity: () => ({ browserId: 'selected', browserGeneration: 2 }),
    current: vi.fn(() => true),
  };
  expect(
    selectOriginalBrowserIdentity(
      [original],
      { browserId: 'selected', browserGeneration: 1 },
      () => true
    )
  ).toBeUndefined();
  expect(
    selectOriginalBrowserIdentity(
      [original, { ...original }],
      { browserId: 'selected', browserGeneration: 2 },
      () => true
    )
  ).toBeUndefined();
  expect(original.current).not.toHaveBeenCalled();
});
it('refuses the selected original losing custody or reentrantly closing mode admission', () => {
  let admitted = true;
  const original = {
    identity: () => ({ browserId: 'selected', browserGeneration: 2 }),
    current: vi.fn(() => false),
  };
  const binding = { browserId: 'selected', browserGeneration: 2 };
  expect(selectOriginalBrowserIdentity([original], binding, () => admitted)).toBeUndefined();
  original.current.mockImplementation(() => {
    admitted = false;
    return true;
  });
  expect(selectOriginalBrowserIdentity([original], binding, () => admitted)).toBeUndefined();
  expect(original.current).toHaveBeenCalledTimes(2);
});
it.each([false, undefined])(
  'preserves the selected original unexpected custody fault %s',
  (cause) => {
    const original = {
      identity: () => ({ browserId: 'selected', browserGeneration: 2 }),
      current: () => {
        throw cause;
      },
    };
    let thrown: { value: unknown } | undefined;
    try {
      selectOriginalBrowserIdentity(
        [original],
        { browserId: 'selected', browserGeneration: 2 },
        () => true
      );
    } catch (value) {
      thrown = { value };
    }
    expect(thrown).toEqual({ value: cause });
  }
);

it('labels only the actual selector refusal without extra original custody calls', () => {
  const rows: string[] = [];
  const diagnostic = createBrowserViewerDiagnostic(({ stage }) => {
    rows.push(stage);
  });
  const binding = { browserId: 'selected', browserGeneration: 2 };
  const original = { identity: () => binding, current: vi.fn(() => false) };
  expect(selectOriginalBrowserIdentity([], binding, () => true, diagnostic)).toBeUndefined();
  expect(
    selectOriginalBrowserIdentity([original, original], binding, () => true, diagnostic)
  ).toBeUndefined();
  expect(original.current).not.toHaveBeenCalled();
  expect(
    selectOriginalBrowserIdentity([original], binding, () => false, diagnostic)
  ).toBeUndefined();
  expect(
    selectOriginalBrowserIdentity([original], binding, () => true, diagnostic)
  ).toBeUndefined();
  expect(original.current).toHaveBeenCalledOnce();
  expect(rows).toEqual([
    'selection.absent',
    'selection.multiple',
    'selection.mode-before',
    'selection.current',
  ]);
});
it.each([false, undefined])(
  'retains original selector fault %s when the bounded logger also fails',
  (cause) => {
    const diagnostic = createBrowserViewerDiagnostic(() => {
      throw new Error('DIAGNOSTIC_ONLY');
    });
    const binding = { browserId: 'selected', browserGeneration: 2 };
    const original = {
      identity: () => binding,
      current: () => {
        throw cause;
      },
    };
    let first: { value: unknown } | undefined;
    try {
      selectOriginalBrowserIdentity([original], binding, () => true, diagnostic);
    } catch (value) {
      first = { value };
    }
    expect(first).toEqual({ value: cause });
    expect(diagnostic.originalFailure()).toEqual({ value: cause });
  }
);
