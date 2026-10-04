import { expect, it, vi } from 'vitest';
import type { BrowserBinding } from '../../contracts.js';
import { parseBrowserId, parseTabId } from '../../ids.js';
import { createBrowserStopGate } from '../../lifecycle/stop.js';

import {
  createOwnedFixtureInput as createTabInput,
  settleFixtureRetirement,
  type FixtureInputPorts as InputPorts,
} from '../../__tests__/parent-fixture.js';

function fixture(reentry: 'publish' | 'release' | 'none') {
  let binding: BrowserBinding = {
    browserId: parseBrowserId('browser_subject_A_000000000000000'),
    browserGeneration: 0,
    tabId: parseTabId('canonical_tab_A_00000000000000000'),
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  };
  let published = 0,
    releases = 0,
    reentered = false;
  let nested: ReturnType<ReturnType<typeof createTabInput>['reset']> | null = null;
  const reenter = () => {
    if (!reentered) {
      reentered = true;
      nested = input.reset();
    }
  };
  const ports: InputPorts = {
    readBinding: () => binding,
    publishResetBinding: (next) => {
      binding = next;
      published++;
      if (reentry === 'publish') reenter();
    },
    authorize: async () => 'allowed',
    stopGate: createBrowserStopGate(binding.browserId, binding.browserGeneration),
    native: {
      dispatch: vi.fn(async (step) => {
        if (step.kind === 'mouseUp') {
          releases++;
          if (reentry === 'release') reenter();
        }
      }),
      cancelComposition: async () => {},
      cancelDrag: async () => {},
    },
  };
  const input = createTabInput(ports, () => binding);
  return {
    input,
    ports,
    get binding() {
      return binding;
    },
    get published() {
      return published;
    },
    get releases() {
      return releases;
    },
    get nested() {
      return nested;
    },
    down: () =>
      input.submit({
        kind: 'input',
        requestId: 'request_subject_A_00000000000000',
        binding: { ...binding },
        steps: [{ kind: 'mouseDown', button: 'left' }],
      }),
  };
}
it.each(['publish', 'release'] as const)(
  'one-shot %s callback reentry shares one preinstalled reset handle and epoch',
  async (mode) => {
    const h = fixture(mode);
    expect((await h.down()).outcome).toBe('completed');
    const outer = h.input.reset();
    const results = await Promise.all([outer, h.nested]);
    expect(h.published, 'REENTRANT_RESET_REPUBLISHED').toBe(1);
    expect(h.binding.epoch).toBe(1);
    expect(h.binding.inputGeneration).toBe(1);
    expect(h.nested).toBe(outer);
    expect(results.map((result) => result?.status)).toEqual(['ready', 'ready']);
    expect(h.releases).toBe(1);
  }
);
it('same-target concurrent reset calls share the in-progress handle without serializing valid cleanup', async () => {
  const h = fixture('none');
  expect((await h.down()).outcome).toBe('completed');
  let release!: () => void;
  h.ports.native.dispatch = async () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const first = h.input.reset();
  const second = h.input.reset();
  expect(second).toBe(first);
  expect(h.published).toBe(1);
  release();
  expect((await first).status).toBe('ready');
});
it('observation callback reentry shares the handle before any publication', async () => {
  const h = fixture('none');
  expect((await h.down()).outcome).toBe('completed');
  let nested: ReturnType<typeof h.input.reset> | null = null;
  let entered = false;
  h.ports.readBinding = () => {
    if (!entered) {
      entered = true;
      nested = h.input.reset();
    }
    return h.binding;
  };
  const outer = h.input.reset();
  expect(nested).toBe(outer);
  expect((await outer).status).toBe('ready');
  expect(h.published).toBe(1);
  expect(h.releases).toBe(1);
});
it.each(['cancelComposition', 'cancelDrag'] as const)(
  '%s callback reentry does not create another cleanup or epoch',
  async (method) => {
    const h = fixture('none');
    expect((await h.down()).outcome).toBe('completed');
    let nested: ReturnType<typeof h.input.reset> | null = null,
      entered = false;
    h.ports.native[method] = async () => {
      if (!entered) {
        entered = true;
        nested = h.input.reset();
      }
    };
    const outer = h.input.reset();
    expect(nested).toBe(outer);
    expect((await outer).status).toBe('ready');
    expect(h.published).toBe(1);
    expect(h.releases).toBe(1);
  }
);
it('publication error after one-shot reentry stops readiness but permits exact parent-owned held release', async () => {
  const h = fixture('none');
  expect((await h.down()).outcome).toBe('completed');
  let nested: ReturnType<typeof h.input.reset> | null = null;
  h.ports.publishResetBinding = () => {
    nested = h.input.reset();
    throw Error('INTENDED_PUBLICATION_FAULT');
  };
  const outer = h.input.reset();
  expect(nested).toBe(outer);
  expect((await outer).status).toBe('stopped');
  expect(h.published).toBe(0);
  expect(h.binding.epoch).toBe(0);
  await settleFixtureRetirement(h.input);
  expect(h.releases).toBe(1);
  expect(h.ports.native.dispatch).toHaveBeenCalledTimes(2);
  expect((await h.input.reset()).status).toBe('stopped');
});
it.each(['missing', 'throw', 'stop'] as const)(
  'uncertain %s observation settles the shared stopped handle and attempts zero cleanup',
  async (mode) => {
    const h = fixture('none');
    expect((await h.down()).outcome).toBe('completed');
    let nested: ReturnType<typeof h.input.reset> | null = null,
      entered = false;
    h.ports.readBinding = () => {
      if (!entered) {
        entered = true;
        nested = h.input.reset();
      }
      if (mode === 'missing') return null;
      if (mode === 'throw') throw Error('INTENDED_OBSERVATION_FAULT');
      h.ports.stopGate.stop();
      return h.binding;
    };
    const outer = h.input.reset();
    expect(nested).toBe(outer);
    expect((await outer).status).toBe('stopped');
    expect(h.published).toBe(0);
    expect(h.releases).toBe(0);
  }
);
it('completed reset handle clears so a later independent reset advances exactly once', async () => {
  const h = fixture('none');
  expect((await h.down()).outcome).toBe('completed');
  const first = h.input.reset();
  expect((await first).status).toBe('ready');
  const later = h.input.reset();
  expect(later).not.toBe(first);
  expect((await later).status).toBe('ready');
  expect(h.binding.epoch).toBe(2);
  expect(h.binding.inputGeneration).toBe(2);
  expect(h.published).toBe(2);
  expect(h.releases).toBe(1);
});
