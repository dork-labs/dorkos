import { expect, it } from 'vitest';
import {
  createBrowserLifetime,
  bindOrdinaryRecord,
  finishRetirement,
} from '../lifecycle/ownership.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import { createDarwinGenerationReturnOwner } from '../runtime/darwin-generation-return.js';

function fixture() {
  const lifetime = createBrowserLifetime('browser', 0);
  const record = {
    browserId: 'browser',
    browserGeneration: 0,
    manager: { pid: 7, birth: 'manager' },
    reservation: { nonce: 'actual-reservation' },
    lifetime,
    status: 'running',
    tabs: new Map(),
  } as unknown as BrowserRecord;
  const records = new Map([[record.browserId, record]]);
  expect(bindOrdinaryRecord(record, records)).toBe(true);
  const owner = createDarwinGenerationReturnOwner(records, record, 'a'.repeat(64));
  const finish = (uncertain = false) => {
    record.status = uncertain ? 'uncertain' : 'stopped';
    finishRetirement(
      record,
      lifetime.ordinary.retirement,
      { state: 'settled', coverage: 'closed', pending: false, uncertainty: [] },
      uncertain
        ? { cleanup: 'unverified', reason: 'observationUnavailable' }
        : { cleanup: 'observed' }
    );
  };
  return { record, records, owner, finish };
}
it('issues from the original retirement and consumes only its exact bound token once', async () => {
  const f = fixture();
  f.finish();
  const token = await f.owner.completion;
  expect(token).not.toBeNull();
  expect(f.owner.consume({ ...token }, f.owner.binding)).toBe(false);
  expect(f.owner.consume(token, { ...f.owner.binding, reservationNonce: 'other' })).toBe(false);
  expect(f.owner.consume(token, f.owner.binding)).toBe(true);
  expect(f.owner.consume(token, f.owner.binding)).toBe(false);
});
it('refuses uncertainty and newer canonical records', async () => {
  const uncertain = fixture();
  uncertain.finish(true);
  expect(await uncertain.owner.completion).toBeNull();
  const newer = fixture();
  newer.finish();
  const token = await newer.owner.completion;
  newer.records.set(newer.record.browserId, { ...newer.record, browserGeneration: 1 });
  expect(newer.owner.consume(token, newer.owner.binding)).toBe(false);
});

it('refuses an accessor binding before it can reenter one-use consumption', async () => {
  const f = fixture();
  f.finish();
  const token = await f.owner.completion;
  let calls = 0;
  const expected = {
    ...f.owner.binding,
    get browserId() {
      calls++;
      expect(f.owner.consume(token, f.owner.binding)).toBe(true);
      return f.owner.binding.browserId;
    },
  };
  expect(f.owner.consume(token, expected)).toBe(false);
  expect(calls).toBe(0);
  expect(f.owner.consume(token, f.owner.binding)).toBe(true);
});

it('refuses proxy bindings and nested manager accessors without invoking their traps', async () => {
  const f = fixture();
  f.finish();
  const token = await f.owner.completion;
  let calls = 0;
  const proxy = new Proxy(f.owner.binding, {
    getOwnPropertyDescriptor() {
      calls++;
      throw new Error('binding trap');
    },
  });
  expect(f.owner.consume(token, proxy)).toBe(false);
  expect(
    f.owner.consume(token, {
      ...f.owner.binding,
      manager: {
        pid: f.owner.binding.manager.pid,
        get birth() {
          calls++;
          return f.owner.binding.manager.birth;
        },
      },
    })
  ).toBe(false);
  expect(calls).toBe(0);
  expect(
    f.owner.consume(token, { ...f.owner.binding, manager: { ...f.owner.binding.manager } })
  ).toBe(true);
});
