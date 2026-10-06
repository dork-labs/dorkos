import { expect, it, onTestFinished, vi } from 'vitest';
import type { BrowserRecord } from '../lifecycle/records.js';
import { closeRecord } from '../lifecycle/close.js';
import { composeInput } from '../lifecycle/input-owner.js';
import { configuration, tabFixture } from './parent-fixture.js';

// Original receiver doubles establish partial-acquisition close ordering, not native absence.
it.each(['context', 'controller'] as const)(
  'enters original %s close while original detach is held for an unlaunched partial journal',
  async (receiver) => {
    const h = tabFixture(),
      r = h.record,
      c = configuration();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originals: { ready?: Promise<unknown>; close?: Promise<unknown> } = {};
    let closed = false;
    onTestFinished(async () => {
      closed = true;
      release();
      const results = await Promise.allSettled([
        held,
        ...(originals.ready ? [originals.ready] : []),
      ]);
      originals.close ??= closeRecord(c, r);
      results.push(...(await Promise.allSettled([originals.close])));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    h.session.detach.mockImplementation(() => {
      entered();
      return held;
    });
    originals.ready = composeInput(c, r, h.tab).readiness;
    await originals.ready;
    if (closed) throw new Error('FIXTURE_ADMISSION_CLOSED');
    r.launchEntered = false;
    const nativeClose = vi.fn(async () => {});
    if (receiver === 'context')
      r.context = { close: nativeClose } as unknown as NonNullable<BrowserRecord['context']>;
    else {
      r.context = undefined;
      r.controllerBrowser = { close: nativeClose } as unknown as NonNullable<
        BrowserRecord['controllerBrowser']
      >;
    }
    const prepareClose = vi.fn(async () => {
      throw new Error('UNLAUNCHED_PRECLOSE_MUST_NOT_ENTER');
    });
    const stop = vi.fn(async (_endBrowser?: boolean) => 'campaign-closed' as const);
    r.journal = {
      binding: {
        journalId: 'partial',
        browserId: r.browserId,
        browserGeneration: r.browserGeneration,
        reservationNonce: 'partial-nonce',
        manager: r.manager,
        runtimeIdentityDigest: 'a'.repeat(64),
        profile: { kind: 'ephemeral' },
        bootScope: { kind: 'unknown', cause: 'boot-unknown' },
      },
      attributeRoot: async () => {},
      prepareClose,
      stop,
      historyGapped: () => false,
      custody: () => ({ pending: false, uncertain: false }),
    };
    originals.close = closeRecord(c, r);
    await entering;
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(prepareClose).not.toHaveBeenCalled();
    let returned = false;
    void originals.close.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      }
    );
    await Promise.resolve();
    expect(returned).toBe(false);
    release();
    expect(await originals.close).toEqual({ cleanup: 'observed' });
    expect(stop).toHaveBeenCalledWith(false);
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(prepareClose).not.toHaveBeenCalled();
  }
);
