import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import type { CDPSession, Browser } from 'playwright-core';
import { ownFixtureSession } from './fixture-session-custody.js';

it.each(['exact', 'wrong', 'absent'] as const)(
  'rejected detach needs the exact original public close event (%s)',
  async (mode) => {
    const original = new EventEmitter();
    Object.assign(original, {
      detach: async () => {
        throw new Error('TARGET_CLOSED');
      },
    });
    const owner = ownFixtureSession(original as unknown as CDPSession);
    if (mode !== 'absent') original.emit('close', mode === 'exact' ? original : new EventEmitter());
    expect(await owner.close()).toEqual({
      observed: mode === 'exact',
      detached: false,
      originalCloseObserved: mode === 'exact',
    });
    expect(owner.close()).toBe(owner.close());
  }
);
it('successful detach without its original close observation stays unverified', async () => {
  const original = new EventEmitter();
  Object.assign(original, { detach: async () => {} });
  expect(await ownFixtureSession(original as unknown as CDPSession).close()).toEqual({
    observed: false,
    detached: true,
    originalCloseObserved: false,
  });
});
it.each(['exact', 'wrong'] as const)(
  'whole connection return needs its original Browser event (%s)',
  async (mode) => {
    const session = new EventEmitter(),
      browser = new EventEmitter();
    Object.assign(session, {
      detach: async () => {
        throw new Error('TARGET_CLOSED');
      },
    });
    const owner = ownFixtureSession(
      session as unknown as CDPSession,
      browser as unknown as Browser
    );
    browser.emit('disconnected', mode === 'exact' ? browser : new EventEmitter());
    expect(await owner.close()).toMatchObject({
      observed: mode === 'exact',
      detached: false,
      originalCloseObserved: false,
    });
  }
);
