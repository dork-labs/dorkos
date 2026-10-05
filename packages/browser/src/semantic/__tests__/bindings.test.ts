/** Proposed portable identity controls; ordinary objects are not DOM acquisition evidence. */
import { describe, expect, it } from 'vitest';
import {
  createPrivateSemanticBindings,
  createSuppliedSemanticGenerationCell,
  publishSuppliedSemanticGeneration,
  type PrivateSemanticGeneration,
  type SuppliedPrivateSemanticBinding,
} from '../bindings.js';

function harness() {
  let generation: PrivateSemanticGeneration = {
    browserId: 'browser',
    browserGeneration: 0,
    tabId: 'tab',
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
    treeRevision: 0,
  };
  let time = 0;
  let onRead: (() => void) | undefined;
  let onClock: (() => void) | undefined;
  const cell = createSuppliedSemanticGenerationCell(generation);
  const owner = createPrivateSemanticBindings(
    cell,
    () => {
      onRead?.();
      return generation;
    },
    () => {
      onClock?.();
      return time;
    }
  );
  const input: SuppliedPrivateSemanticBinding = {
    object: {},
    frameDocument: {},
    frameId: 'frame',
    frameNavigationGeneration: 0,
    fingerprint: 'sanitized:button:Same label',
  };
  return {
    owner,
    input,
    advance: (next: number) => {
      time = next;
    },
    change: (patch: Partial<PrivateSemanticGeneration>) => {
      generation = { ...generation, ...patch };
      if (!publishSuppliedSemanticGeneration(cell, generation))
        throw Error('Expected fixture-local publication');
    },
    reenterRead: (callback: () => void) => {
      onRead = callback;
    },
    reenterClock: (callback: () => void) => {
      onClock = callback;
    },
  };
}
function retained(h: ReturnType<typeof harness>, input = h.input) {
  const result = h.owner.retain(input);
  if (!result.ok) throw Error(`Expected private fixture retention, got ${result.reason}`);
  return result.value;
}

describe('private exact-object semantic reference custody', () => {
  it.each([1999, 2000] as const)(
    'uses a final post-observer clock at%s against the original end2000',
    (finalTime) => {
      const h = harness(),
        ref = retained(h);
      h.advance(1999);
      let reads = 0;
      h.reenterRead(() => {
        if (++reads === 2) h.advance(finalTime);
      });
      const resolved = h.owner.resolve(ref, h.input);
      let effects = 0;
      if (resolved.ok) effects++;
      expect(reads).toBe(2);
      if (finalTime === 2000) {
        expect(resolved).toEqual({ ok: false, reason: 'expired' });
        expect(effects).toBe(0);
        expect(h.owner.retainedCount()).toBe(0);
      } else {
        expect(resolved).toEqual({ ok: true, value: h.input.object });
        expect(effects).toBe(1);
      }
    }
  );

  it('does not renew a retain deadline when the final observer crosses its original end', () => {
    const h = harness();
    let reads = 0;
    h.reenterRead(() => {
      if (++reads === 2) h.advance(2000);
    });
    expect(h.owner.retain(h.input)).toEqual({ ok: false, reason: 'expired' });
    expect(reads).toBe(2);
    expect(h.owner.retainedCount()).toBe(0);
  });

  it.each(['publish', 'invalidate', 'retire'] as const)(
    'rejects final-clock%s after earlier observers are healthy',
    (transition) => {
      const h = harness(),
        ref = retained(h);
      let clocks = 0;
      h.reenterClock(() => {
        if (++clocks !== 2) return;
        if (transition === 'publish') h.change({ treeRevision: 1 });
        else if (transition === 'invalidate') h.owner.invalidateCurrent();
        else h.owner.retire();
      });
      expect(h.owner.resolve(ref, h.input)).toEqual({
        ok: false,
        reason: transition === 'retire' ? 'terminal' : 'stale',
      });
      expect(clocks).toBe(2);
      expect(h.owner.retainedCount()).toBe(0);
    }
  );

  it('refuses a structural cell forgery without claiming native provenance for genuine-local cells', () => {
    const h = harness();
    const forged = createPrivateSemanticBindings(
      { suppliedGenerationCell: true },
      () => null,
      () => 0
    );
    expect(forged.retain(h.input)).toEqual({ ok: false, reason: 'invalidObservation' });
  });

  it('a stale outer final-clock continuation preserves a newly published nested cohort', () => {
    const h = harness(),
      old = retained(h);
    let clocks = 0;
    let fresh: ReturnType<typeof retained> | undefined;
    h.reenterClock(() => {
      if (++clocks !== 2) return;
      h.reenterClock(() => {});
      h.change({ treeRevision: 1 });
      fresh = retained(h);
    });
    expect(h.owner.resolve(old, h.input)).toEqual({ ok: false, reason: 'stale' });
    expect(h.owner.retainedCount()).toBe(1);
    if (!fresh) throw Error('Expected genuine-local nested retention');
    expect(h.owner.resolve(fresh, h.input).ok).toBe(true);
  });

  it('a supplied generation publication cycle never revives an old cell-revision ref', () => {
    const h = harness(),
      old = retained(h);
    h.change({ treeRevision: 1 });
    h.change({ treeRevision: 0 });
    expect(h.owner.resolve(old, h.input)).toEqual({ ok: false, reason: 'stale' });
    expect(h.owner.retainedCount()).toBe(0);
    expect(h.owner.resolve(retained(h), h.input).ok).toBe(true);
  });

  it('healthy supplied exact-object resolution works; an identical replacement never adopts its ref', () => {
    const h = harness(),
      old = retained(h);
    expect(h.owner.retainedCount()).toBe(1);
    expect(h.owner.resolve(old, h.input)).toEqual({ ok: true, value: h.input.object });
    const replacement = { ...h.input, object: {} };
    let replacementEffects = 0;
    const result = h.owner.resolve(old, replacement);
    if (result.ok && result.value === replacement.object) replacementEffects++;
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(replacementEffects).toBe(0);
    expect(h.owner.retainedCount()).toBe(0);
    const fresh = retained(h, replacement);
    const healthy = h.owner.resolve(fresh, replacement);
    if (healthy.ok && healthy.value === replacement.object) replacementEffects++;
    expect(replacementEffects).toBe(1);
  });

  it.each(['frameDocument', 'frameId', 'frameNavigationGeneration', 'fingerprint'] as const)(
    'refuses changed exact private %s with a paired fresh binding',
    (field) => {
      const h = harness(),
        ref = retained(h);
      const candidate = {
        ...h.input,
        [field]:
          field === 'frameDocument'
            ? {}
            : field === 'frameNavigationGeneration'
              ? 1
              : 'replacement',
      };
      expect(h.owner.resolve(ref, candidate)).toEqual({ ok: false, reason: 'stale' });
      const fresh = retained(h, candidate);
      expect(h.owner.resolve(fresh, candidate).ok).toBe(true);
    }
  );

  it.each([
    'browserId',
    'browserGeneration',
    'tabId',
    'navigationGeneration',
    'viewportVersion',
    'epoch',
    'inputGeneration',
    'treeRevision',
  ] as const)('refuses old %s and clears old revision custody before fresh admission', (field) => {
    const h = harness(),
      ref = retained(h);
    h.change({ [field]: field.endsWith('Id') ? 'replacement' : 1 });
    expect(h.owner.resolve(ref, h.input)).toEqual({ ok: false, reason: 'stale' });
    expect(h.owner.retainedCount()).toBe(0);
    const fresh = retained(h);
    expect(h.owner.resolve(fresh, h.input).ok).toBe(true);
  });

  it('isolates the2000 current-ref counter without a public snapshot byte preflight', () => {
    const h = harness();
    for (let index = 0; index < 1999; index++) retained(h, { ...h.input, object: {} });
    expect(h.owner.retainedCount()).toBe(1999);
    retained(h, { ...h.input, object: {} });
    expect(h.owner.retainedCount()).toBe(2000);
    expect(h.owner.retain({ ...h.input, object: {} })).toEqual({ ok: false, reason: 'capacity' });
    expect(h.owner.retainedCount()).toBe(2000);
    h.owner.invalidateCurrent();
    expect(h.owner.retainedCount()).toBe(0);
    retained(h);
    expect(h.owner.retainedCount()).toBe(1);
  });

  it('expires refs at2000ms without renewal from wall timestamps or repeated reads', () => {
    const h = harness(),
      ref = retained(h);
    h.advance(1999);
    expect(h.owner.resolve(ref, h.input).ok).toBe(true);
    h.advance(2000);
    expect(h.owner.resolve(ref, h.input)).toEqual({ ok: false, reason: 'expired' });
    expect(h.owner.retainedCount()).toBe(0);
    const fresh = retained(h);
    expect(h.owner.resolve(fresh, h.input).ok).toBe(true);
    h.advance(1990);
    expect(h.owner.resolve(fresh, h.input)).toEqual({ ok: false, reason: 'invalidObservation' });
  });

  it('dirty/reset replaces the reference set while retirement never permits this owner to resume', () => {
    const h = harness(),
      ref = retained(h);
    h.owner.invalidateCurrent();
    expect(h.owner.resolve(ref, h.input)).toEqual({ ok: false, reason: 'stale' });
    const fresh = retained(h);
    h.owner.retire();
    expect(h.owner.retainedCount()).toBe(0);
    expect(h.owner.resolve(fresh, h.input)).toEqual({ ok: false, reason: 'terminal' });
    expect(h.owner.retain(h.input)).toEqual({ ok: false, reason: 'terminal' });
    h.owner.invalidateCurrent();
    expect(h.owner.retain(h.input)).toEqual({ ok: false, reason: 'terminal' });
    const successor = harness();
    expect(successor.owner.resolve(retained(successor), successor.input).ok).toBe(true);
  });

  it.each(['read', 'clock'] as const)(
    'cannot retain late work after reentrant retirement at %s',
    (site) => {
      const h = harness();
      const callback = () => h.owner.retire();
      if (site === 'read') h.reenterRead(callback);
      else h.reenterClock(callback);
      expect(h.owner.retain(h.input)).toEqual({ ok: false, reason: 'terminal' });
      expect(h.owner.retainedCount()).toBe(0);
    }
  );

  it('cannot adopt a generation changed during the clock observation', () => {
    const h = harness();
    h.reenterClock(() => h.change({ treeRevision: 1 }));
    expect(h.owner.retain(h.input)).toEqual({ ok: false, reason: 'stale' });
    expect(h.owner.retainedCount()).toBe(0);
  });

  it('refuses structural reference forgery and another private owner', () => {
    const a = harness(),
      b = harness(),
      ref = retained(a);
    expect(a.owner.resolve({ privateReference: true }, a.input)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(b.owner.resolve(ref, a.input)).toEqual({ ok: false, reason: 'stale' });
  });
});
