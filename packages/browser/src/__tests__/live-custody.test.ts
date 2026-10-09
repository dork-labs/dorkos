import { expect, it, vi } from 'vitest';
import {
  bindOrdinaryRecord,
  createBrowserLifetime,
  installRetirementDriver,
} from '../lifecycle/ownership.js';
import { currentAuthorityCustody, readAuthorityCustodyRefusal } from '../lifecycle/live-custody.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import type { InputOwnerSlot } from '../lifecycle/input-owner.js';

function fixture() {
  const lifetime = createBrowserLifetime('browser', 0);
  const page = {};
  const tab = { page, binding: { tabId: 'tab' }, stopped: false } as unknown as TabRecord;
  const known = vi.fn(() => true);
  const slot = {
    tab,
    page,
    ready: true,
    constructing: false,
    uncertain: false,
    closePending: false,
    handle: { isCustodyKnown: known },
    registeredTarget: { page },
  } as unknown as InputOwnerSlot;
  const record = {
    browserId: 'browser',
    browserGeneration: 0,
    lifetime,
    status: 'running',
    context: {},
    proxy: {},
    directory: {},
    dataRoot: {},
    root: {},
    launchEntered: true,
    rootAttributed: true,
    tabs: new Map([['tab', tab]]),
  } as unknown as BrowserRecord;
  const records = new Map([[record.browserId, record]]);
  expect(bindOrdinaryRecord(record, records)).toBe(true);
  expect(installRetirementDriver(record, () => {})).toBe(true);
  lifetime.inputs.set(tab, slot);
  const current = () => records.get(record.browserId) === record && record.browserGeneration === 0;
  return {
    record,
    records,
    lifetime,
    tab,
    slot,
    known,
    observe: () => currentAuthorityCustody(record, current),
  };
}

it('permits known ordinary input while refusing sticky uncertainty and cleanup', () => {
  const f = fixture();
  expect(f.observe()).toBe(true);
  f.slot.uncertain = true;
  expect(f.observe()).toBe(false);
  f.slot.uncertain = false;
  f.known.mockReturnValue(false);
  expect(f.observe()).toBe(false);
  f.known.mockReturnValue(true);
  f.slot.closePending = true;
  expect(f.observe()).toBe(false);
});
it('refuses opening, retired and replaced original records', () => {
  const f = fixture();
  f.record.status = 'opening';
  expect(f.observe()).toBe(false);
  f.record.status = 'running';
  f.records.set(f.record.browserId, { ...f.record });
  expect(f.observe()).toBe(false);
  f.records.set(f.record.browserId, f.record);
  f.lifetime.requestRetirement('authorityRevoked');
  expect(f.observe()).toBe(false);
});
it('rechecks canonical custody after an original producer callback reenters', () => {
  const f = fixture();
  f.known.mockImplementation(() => {
    f.lifetime.inputs.delete(f.tab);
    return true;
  });
  expect(f.observe()).toBe(false);
});
it('requires active exact observers and refuses historical gaps or returned supervision', () => {
  const f = fixture();
  const historyGapped = vi.fn(() => false);
  f.record.journal = {
    custody: () => ({ pending: true, uncertain: false }),
    historyGapped,
  } as unknown as NonNullable<BrowserRecord['journal']>;
  const custody = vi.fn(() => ({ pending: true, uncertain: false }));
  f.record.supervisor = { custody } as unknown as NonNullable<BrowserRecord['supervisor']>;
  expect(f.observe()).toBe(true);
  historyGapped.mockReturnValue(true);
  expect(f.observe()).toBe(false);
  historyGapped.mockReturnValue(false);
  custody.mockReturnValue({ pending: false, uncertain: false });
  expect(f.observe()).toBe(false);
});
it('fails closed when the original input producer has no custody predicate or throws', () => {
  const f = fixture();
  f.slot.handle = {} as InputOwnerSlot['handle'];
  expect(f.observe()).toBe(false);
  f.slot.handle = {
    isCustodyKnown: () => {
      throw new Error('unknown');
    },
  } as unknown as NonNullable<InputOwnerSlot['handle']>;
  expect(f.observe()).toBe(false);
});

it('keeps original authority through a known reset while input admission remains fenced', () => {
  const f = fixture();
  f.slot.resetPromise = new Promise(() => {});
  expect(f.observe()).toBe(true);
  f.known.mockReturnValue(false);
  expect(f.observe()).toBe(false);
  f.known.mockReturnValue(true);
  f.slot.uncertain = true;
  expect(f.observe()).toBe(false);
  f.slot.uncertain = false;
  f.lifetime.requestRetirement('cleanupFailure');
  expect(f.observe()).toBe(false);
});
it('rechecks original custody when reset starts during the producer observation', () => {
  const f = fixture();
  f.known.mockImplementation(() => {
    f.slot.resetPromise ??= new Promise(() => {});
    return true;
  });
  expect(f.observe()).toBe(true);
  f.known.mockImplementation(() => {
    f.slot.uncertain = true;
    return true;
  });
  expect(f.observe()).toBe(false);
});

it('records only the actual fixed custody cause and clears it after a fresh positive observation', () => {
  const f = fixture();
  f.slot.uncertain = true;
  expect(f.observe()).toBe(false);
  expect(readAuthorityCustodyRefusal(f.record)).toBe('slot');
  f.slot.uncertain = false;
  f.known.mockReturnValue(false);
  expect(f.observe()).toBe(false);
  expect(readAuthorityCustodyRefusal(f.record)).toBe('transport');
  f.known.mockReturnValue(true);
  expect(f.observe()).toBe(true);
  expect(readAuthorityCustodyRefusal(f.record)).toBeUndefined();
});
it.each([false, undefined])(
  'does not inspect a falsy producer failure %s or heal its failed decision',
  (cause) => {
    const f = fixture();
    f.known.mockImplementation(() => {
      throw cause;
    });
    expect(f.observe()).toBe(false);
    expect(readAuthorityCustodyRefusal(f.record)).toBe('exception');
    expect(f.known).toHaveBeenCalledOnce();
    expect(readAuthorityCustodyRefusal(f.record)).toBe('exception');
    expect(f.known).toHaveBeenCalledOnce();
  }
);
it('distinguishes original observer loss from post-producer membership loss', () => {
  const f = fixture();
  f.record.supervisor = {
    custody: () => ({ pending: true, uncertain: true }),
  } as unknown as NonNullable<BrowserRecord['supervisor']>;
  expect(f.observe()).toBe(false);
  expect(readAuthorityCustodyRefusal(f.record)).toBe('supervisor');
  f.record.supervisor = undefined;
  f.known.mockImplementation(() => {
    f.lifetime.inputs.delete(f.tab);
    return true;
  });
  expect(f.observe()).toBe(false);
  expect(readAuthorityCustodyRefusal(f.record)).toBe('reentrant');
});
