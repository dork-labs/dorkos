import { describe, it, expect, vi } from 'vitest';
import { FrameLifetimeController } from '../frame-lifetime';
import { createBoundDocPort } from '../bound-doc-port';
import { DocBirthProjection, DocPublisherRegistry } from '../doc-projection';
import { fixture, birth, replay } from './fixtures';
describe('host-issued frame lifetime', () => {
  it('requires actual host load and refuses fabricated bindings or omitted ports', () => {
    const f = fixture();
    const c = new FrameLifetimeController();
    const observed = c.observeHostContext(f.context)!;
    expect(() => c.bindDoc(observed, birth, 'session')).toThrow();
    expect(() => createBoundDocPort(f.controller, { ...f.binding }, f.ports)).toThrow();
    expect(() =>
      createBoundDocPort(f.controller, f.binding, { ...f.ports, inspect: undefined } as never)
    ).toThrow();
  });
  it('clears before cleanup, catches each sibling and refuses reentrant establishment', () => {
    const f = fixture(),
      seen: unknown[] = [];
    f.controller.ownDoc(f.binding, () => {
      seen.push(f.controller.getCurrent());
      seen.push(f.controller.observeHostContext(f.context));
      throw new Error('cleanup');
    });
    f.controller.own(f.loaded, () => seen.push('devtools'));
    f.controller.subscribe(() => seen.push('subscriber'));
    f.controller.retire();
    expect(seen).toEqual(['devtools', null, null, 'subscriber']);
    expect(f.bound.current()).toBe(false);
  });
  it('missing legacy birth closes only Doc while generic frame stays loaded', () => {
    const f = fixture(),
      doc = vi.fn(),
      dev = vi.fn();
    f.controller.ownDoc(f.binding, doc);
    f.controller.own(f.loaded, dev);
    expect(() => f.controller.bindDoc(f.loaded, undefined, 'session')).toThrow();
    expect(doc).toHaveBeenCalledOnce();
    expect(dev).not.toHaveBeenCalled();
    expect(f.controller.getCurrent()).toBe(f.loaded);
    expect(f.bound.current()).toBe(false);
  });
  it.each(['resolvedSource', 'logicalUrl', 'reloadKey', 'sessionId', 'transportOwner', 'frame'])(
    'retires on host %s replacement despite WindowProxy reuse',
    (field) => {
      const f = fixture();
      const value = field === 'transportOwner' ? {} : field === 'frame' ? null : 'changed';
      const next = f.controller.observeHostContext({ ...f.context, [field]: value } as never);
      expect(f.bound.current()).toBe(false);
      expect(next?.loaded).toBe(false);
      expect(next?.token).toBeGreaterThan(f.loaded.token);
    }
  );
  it('actual repeated load is a fresh observation, page retirement cannot reestablish', () => {
    const f = fixture();
    const next = f.controller.observeLoaded(f.loaded)!;
    expect(next.frame).toBe(f.frame);
    expect(next.token).toBeGreaterThan(f.loaded.token);
    expect(f.bound.current()).toBe(false);
    expect(f.controller.observeLoaded(f.loaded)).toBeNull();
  });
  it('captures functions and owner immutably; submit and inspect retain original generation', async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    f.ports.owner = {};
    f.ports.submit = vi.fn(async () => ({ kind: 'terminal' as const }));
    await f.bound.submit({ id: 'original', bytes: 'original' }, signal);
    await f.bound.inspect('original', signal);
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.ports.inspect).toHaveBeenCalledWith(
      'original',
      { expectedGeneration: birth.generation },
      signal
    );
  });
});
describe('owner/slot and birth projection', () => {
  it.each(['session-generator', 'session-manager', 'room'] as const)(
    'retires stale %s callback and refuses forged owner capability',
    (slot) => {
      const owner = {},
        registry = new DocPublisherRegistry(owner, () => true),
        old = registry.capture(slot),
        current = registry.capture(slot),
        receive = vi.fn();
      expect(registry.publish(old, receive)).toBe(false);
      expect(registry.publish({ ...current }, receive)).toBe(false);
      expect(registry.publish(current, receive)).toBe(true);
      registry.retire(current);
      expect(registry.publish(current, receive)).toBe(false);
      expect(receive).toHaveBeenCalledOnce();
    }
  );
  it('drops all slots under transport replacement', () => {
    let current = true;
    const p = new DocPublisherRegistry({}, () => current),
      token = p.capture('room');
    current = false;
    expect(
      p.publish(token, () => {
        throw new Error('effect');
      })
    ).toBe(false);
    expect(() => p.capture('unknown' as never)).toThrow();
  });
  it('old100 to new1 resets state and refuses delayed repair/old snapshots', () => {
    const p = new DocBirthProjection({}, () => true, 'session'),
      old = p.requestReplay();
    expect(p.installReplay(old, birth, replay())).toBe(true);
    const delayed = p.requestReplay(),
      fresh = p.requestReplay(),
      next = { ...birth, generation: 'b'.repeat(64), physicalOpenedAt: '2026-10-02T00:00:02Z' };
    expect(p.installReplay(fresh, next, replay(1, 1))).toBe(true);
    expect(p.getCurrent().replay?.highWatermark).toBe(1);
    expect(p.getCurrent().replay?.stateRev).toBe(1);
    expect(p.installReplay(delayed, birth, replay(101))).toBe(false);
    expect(p.installReplay(p.requestReplay(), birth, replay(102))).toBe(false);
    expect(p.getCurrent().birth).toEqual(next);
  });
  it('freezes state and replaces same-birth authoritative reset without owning drafts', () => {
    const p = new DocBirthProjection({}, () => true, 'session'),
      draft = { text: 'keep' };
    p.installReplay(p.requestReplay(), birth, replay());
    expect(() => {
      p.getCurrent().replay!.state.text = 'mutate';
    }).toThrow();
    p.installReplay(p.requestReplay(), birth, replay(1, 1));
    expect(p.getCurrent().replay?.stateRev).toBe(1);
    expect(draft).toEqual({ text: 'keep' });
  });
  it('legacy snapshot and wrong scope disable Doc, current rekey repairs same birth', () => {
    const p = new DocBirthProjection({}, () => true, 'session');
    p.installReplay(p.requestReplay(), birth, replay());
    const old = p.requestReplay();
    p.rebindScope('canonical');
    expect(p.installReplay(old, birth, replay())).toBe(false);
    expect(p.getCurrent().available).toBe(false);
    expect(p.installReplay(p.requestReplay(), birth, replay())).toBe(true);
    expect(p.getCurrent().birth).toEqual(birth);
    expect(p.installReplay(p.requestReplay(), undefined, replay())).toBe(false);
    expect(p.getCurrent().available).toBe(false);
  });
  it('unknown live birth cannot establish and sequence dedup is birth-local', () => {
    const p = new DocBirthProjection({}, () => true, 'session');
    p.installReplay(p.requestReplay(), birth, replay(1, 1));
    const frame = {
      type: 'canvas_event',
      scope: 'session',
      documentId: 'doc',
      docSeq: 2,
      event: {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'save',
        payload: {},
        direction: 'upstream',
        receivedAt: '2026-10-02T00:00:00Z',
      },
    };
    expect(p.applyLive(birth, frame)).toBe(true);
    expect(p.applyLive(birth, frame)).toBe(false);
    expect(p.applyLive({ ...birth, generation: 'b'.repeat(64) }, { ...frame, docSeq: 3 })).toBe(
      false
    );
    expect(p.getCurrent().available).toBe(false);
  });
});
it('raw legacy DTO getter is never invoked while Doc closes', () => {
  const f = fixture();
  let calls = 0;
  const raw = { ...birth };
  Object.defineProperty(raw, 'generation', {
    enumerable: true,
    get() {
      calls++;
      return birth.generation;
    },
  });
  expect(() => f.controller.bindDoc(f.loaded, raw, 'session')).toThrow();
  expect(calls).toBe(0);
  expect(f.bound.current()).toBe(false);
  expect(f.controller.getCurrent()).toBe(f.loaded);
});
it('reentrant Doc-only cleanup cannot install a new binding', () => {
  const f = fixture();
  let rejected = false;
  f.controller.ownDoc(f.binding, () => {
    try {
      f.controller.bindDoc(f.loaded, birth, 'session');
    } catch {
      rejected = true;
    }
  });
  f.controller.disableDoc();
  expect(rejected).toBe(true);
  expect(f.bound.current()).toBe(false);
});
it('retired birth history is bounded and terminal exhaustion cannot reopen the old projection', () => {
  const p = new DocBirthProjection({}, () => true, 'session');
  for (let n = 0; n <= 100; n++) {
    const changed = { ...birth, generation: n.toString(16).padStart(64, '0') };
    expect(p.installReplay(p.requestReplay(), changed, replay(1, 1))).toBe(true);
  }
  expect(
    p.installReplay(p.requestReplay(), { ...birth, generation: 'f'.repeat(64) }, replay(1, 1))
  ).toBe(false);
  expect(p.installReplay(p.requestReplay(), birth, replay(1, 1))).toBe(false);
  expect(p.getCurrent().available).toBe(false);
});
it('thenable and throwing owner checks cannot acquire publisher or replay authority', () => {
  for (const check of [
    () => Promise.resolve(true),
    () => {
      throw new Error('owner');
    },
  ]) {
    const p = new DocPublisherRegistry({}, check as never),
      token = p.capture('room');
    expect(
      p.publish(token, () => {
        throw new Error('effect');
      })
    ).toBe(false);
    const projection = new DocBirthProjection({}, check as never, 'session');
    expect(projection.installReplay(projection.requestReplay(), birth, replay())).toBe(false);
    expect(projection.getCurrent().available).toBe(false);
    expect(() => fixture({ isCurrentOwner: check as never })).toThrow();
  }
});
it('legal retained replay larger than queue budget installs under its separate projection bound', () => {
  const p = new DocBirthProjection({}, () => true, 'session');
  const events = Array.from({ length: 200 }, (_, n) => ({
    type: 'canvas_event',
    scope: 'session',
    documentId: 'doc',
    docSeq: n + 1,
    event: {
      id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
      type: 'save',
      payload: { text: 'x'.repeat(8192) },
      direction: 'upstream',
      receivedAt: '2026-10-02T00:00:00Z',
    },
  }));
  const response = { ...replay(200, 1), events };
  expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeGreaterThan(1_048_576);
  expect(p.installReplay(p.requestReplay(), birth, response)).toBe(true);
  expect(p.getCurrent().replay?.events).toHaveLength(200);
});
describe('owner callbacks cannot authorize retired captures', () => {
  it('bound current rechecks its exact issued binding after owner callback retirement', () => {
    const cleanup: { retire?: () => void } = {};
    const f = fixture({
      isCurrentOwner: () => {
        cleanup.retire?.();
        return true;
      },
    });
    cleanup.retire = () => f.controller.retire();
    expect(f.bound.current()).toBe(false);
    expect(f.controller.getCurrent()).toBeNull();
  });
  it.each(['session-generator', 'session-manager', 'room'] as const)(
    'post-owner guard refuses %s token replaced during check',
    (slot) => {
      const p: DocPublisherRegistry = new DocPublisherRegistry({}, () => {
        p.capture(slot);
        return true;
      });
      const token = p.capture(slot),
        receive = vi.fn();
      expect(p.publish(token, receive)).toBe(false);
      expect(receive).not.toHaveBeenCalled();
    }
  );
  it.each(['retire', 'request'] as const)(
    'replay request cannot install after owner callback %s',
    (action) => {
      const p: DocBirthProjection = new DocBirthProjection(
        {},
        () => {
          if (action === 'retire') p.retire();
          else p.requestReplay();
          return true;
        },
        'session'
      );
      const token = p.requestReplay();
      expect(p.installReplay(token, birth, replay())).toBe(false);
      expect(p.getCurrent().birth).toBeNull();
    }
  );
  it('snapshot reflects owner callback retirement before claiming availability', () => {
    let retire = false;
    const p: DocBirthProjection = new DocBirthProjection(
      {},
      () => {
        if (retire) p.retire();
        return true;
      },
      'session'
    );
    expect(p.installReplay(p.requestReplay(), birth, replay())).toBe(true);
    retire = true;
    expect(p.getCurrent()).toEqual({ birth: null, replay: null, available: false });
  });
});

describe('bound native call abort boundary', () => {
  it.each(['submit', 'inspect'] as const)(
    '%s refuses signal abortion inside the final owner predicate',
    (method) => {
      const f = fixture(),
        abort = new AbortController(),
        reason = new Error('queue retired');
      let abortOnCheck = false;
      const submit = vi.fn(async () => ({ kind: 'uncertain' as const }));
      const inspect = vi.fn(async () => ({ kind: 'unknown' as const }));
      const bound = createBoundDocPort(f.controller, f.binding, {
        ...f.ports,
        submit,
        inspect,
        isCurrentOwner: () => {
          if (abortOnCheck) abort.abort(reason);
          return true;
        },
      });
      abortOnCheck = true;
      expect(() =>
        method === 'submit'
          ? bound.submit({ id: 'original', bytes: 'original' }, abort.signal)
          : bound.inspect('original', abort.signal)
      ).toThrow(reason);
      expect(f.controller.isCurrent(f.binding)).toBe(true);
      expect(abort.signal.aborted).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      f.controller.retire();
    }
  );
  it.each(['submit', 'inspect'] as const)(
    '%s refuses an already-aborted native signal',
    (method) => {
      const f = fixture(),
        abort = new AbortController();
      abort.abort();
      expect(() =>
        method === 'submit'
          ? f.bound.submit({ id: 'original', bytes: 'original' }, abort.signal)
          : f.bound.inspect('original', abort.signal)
      ).toThrow();
      expect(f.ports.submit).not.toHaveBeenCalled();
      expect(f.ports.inspect).not.toHaveBeenCalled();
      expect(f.controller.isCurrent(f.binding)).toBe(true);
      f.controller.retire();
    }
  );
});

it('captured exact-binding cleanup cannot retire the newer binding after Doc-only renewal', () => {
  const f = fixture();
  const old = f.binding;
  f.controller.disableDoc();
  const newer = f.controller.bindDoc(f.loaded, birth, old.scope);
  f.controller.retireDoc(old);
  expect(f.controller.isCurrent(newer)).toBe(true);
  f.controller.retireDoc(newer);
  expect(f.controller.isCurrent(newer)).toBe(false);
});

it.each(['same-birth', 'different-birth', 'throw-after-winner'] as const)(
  'last bind getter cannot reuse or retire nested load (%s)',
  (kind) => {
    const f = fixture();
    f.controller.disableDoc();
    let winner: ReturnType<FrameLifetimeController['bindDoc']> | undefined;
    let loaded: ReturnType<FrameLifetimeController['observeLoaded']> = null;
    Object.defineProperty(f.frame, 'postMessage', {
      configurable: true,
      get() {
        Object.defineProperty(f.frame, 'postMessage', { configurable: true, value: vi.fn() });
        const observed = f.controller.observeHostContext({ ...f.context, reloadKey: 'nested' })!;
        loaded = f.controller.observeLoaded(observed);
        winner = f.controller.bindDoc(
          loaded!,
          kind === 'different-birth' ? { ...birth, generation: 'b'.repeat(64) } : birth,
          'session'
        );
        if (kind === 'throw-after-winner') throw new Error('getter failed after nested winner');
        return vi.fn();
      },
    });
    expect(() => f.controller.bindDoc(f.loaded, birth, 'session')).toThrow();
    expect(winner).toBeDefined();
    expect(f.controller.isCurrent(winner!)).toBe(true);
    expect(f.controller.getCurrent()).toBe(loaded);
    f.controller.retire();
  }
);

it('a newer claim of the same genuine binding survives the old once-only release', () => {
  const f = fixture();
  const old = f.controller.acquireDoc(f.loaded, birth, f.binding.scope);
  const newer = f.controller.acquireDoc(f.loaded, birth, f.binding.scope);
  expect(newer.binding).toBe(old.binding);
  old.release();
  old.release();
  expect(f.controller.isCurrent(newer.binding)).toBe(true);
  newer.release();
  expect(f.controller.isCurrent(newer.binding)).toBe(false);
});
it('release closes only its exact captured binding after a different binding wins', () => {
  const f = fixture();
  const old = f.controller.acquireDoc(f.loaded, birth, f.binding.scope);
  f.controller.disableDoc();
  const newer = f.controller.acquireDoc(f.loaded, birth, f.binding.scope);
  expect(newer.binding).not.toBe(old.binding);
  old.release();
  expect(f.controller.isCurrent(newer.binding)).toBe(true);
  newer.release();
});
it('same-observation nested binding from postMessage getter is not returned to outer claimant', () => {
  const f = fixture();
  f.controller.disableDoc();
  let winner: ReturnType<FrameLifetimeController['acquireDoc']> | undefined;
  Object.defineProperty(f.frame, 'postMessage', {
    configurable: true,
    get() {
      Object.defineProperty(f.frame, 'postMessage', { configurable: true, value: vi.fn() });
      winner = f.controller.acquireDoc(f.loaded, birth, f.binding.scope);
      return vi.fn();
    },
  });
  expect(() => f.controller.acquireDoc(f.loaded, birth, f.binding.scope)).toThrow();
  expect(winner).toBeDefined();
  expect(f.controller.isCurrent(winner!.binding)).toBe(true);
  winner!.release();
});

it('captures the original factory receiver and returned operations before later property replacement', async () => {
  const f = fixture();
  const submit = vi.fn(async function (this: object) {
    expect(this).toBe(original);
    return { kind: 'terminal' as const };
  });
  const inspect = vi.fn(async function (this: object) {
    expect(this).toBe(original);
    return { kind: 'unknown' as const };
  });
  const original = { id: 'original', bytes: 'bytes', submit, inspect };
  const factory = vi.fn(function (this: object) {
    expect(this).toBe(f.ports);
    return original;
  });
  f.ports.captureOriginal = factory;
  const bound = createBoundDocPort(f.controller, f.binding, f.ports);
  f.ports.captureOriginal = vi.fn(() => {
    throw new Error('replacement factory');
  });
  const captured = bound.captureOriginal({ id: 'original', bytes: 'bytes' })!;
  original.submit = vi.fn(async () => {
    throw new Error('replacement submit');
  });
  original.inspect = vi.fn(async () => {
    throw new Error('replacement inspect');
  });
  expect(await captured.submit(new AbortController().signal)).toEqual({ kind: 'terminal' });
  expect(await captured.inspect(new AbortController().signal)).toEqual({ kind: 'unknown' });
  expect(factory).toHaveBeenCalledOnce();
  expect(f.ports.captureOriginal).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledOnce();
  expect(inspect).toHaveBeenCalledOnce();
  expect(original.submit).not.toHaveBeenCalled();
  expect(original.inspect).not.toHaveBeenCalled();
});
it.each(['id', 'bytes'] as const)(
  'refuses retirement in original request %s getter before calling its captured factory',
  (field) => {
    const f = fixture();
    const factory = vi.fn(() => null);
    f.ports.captureOriginal = factory;
    const bound = createBoundDocPort(f.controller, f.binding, f.ports);
    const request = { id: 'original', bytes: 'bytes' };
    Object.defineProperty(request, field, {
      get() {
        f.controller.retire();
        return field === 'id' ? 'original' : 'bytes';
      },
    });
    expect(() => bound.captureOriginal(request)).toThrow('retired');
    expect(factory).not.toHaveBeenCalled();
    expect(f.ports.submit).not.toHaveBeenCalled();
  }
);
it.each(['id', 'bytes', 'submit', 'inspect'] as const)(
  'refuses retirement in returned original %s getter without any POST',
  (field) => {
    const f = fixture();
    const original = {
      id: 'original',
      bytes: 'bytes',
      submit: f.ports.submit,
      inspect: f.ports.inspect,
    };
    const value = original[field];
    Object.defineProperty(original, field, {
      get() {
        f.controller.retire();
        return value;
      },
    });
    const factory = vi.fn(() => original);
    f.ports.captureOriginal = factory as never;
    const bound = createBoundDocPort(f.controller, f.binding, f.ports);
    expect(() => bound.captureOriginal({ id: 'original', bytes: 'bytes' })).toThrow('retired');
    expect(factory).toHaveBeenCalledOnce();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.ports.inspect).not.toHaveBeenCalled();
  }
);

it('refuses a captured original factory that retires its genuine loaded binding before return', () => {
  const f = fixture();
  const factory = vi.fn((request: { id: string; bytes: string }) => {
    f.controller.retire();
    return { ...request, submit: vi.fn(), inspect: vi.fn() };
  });
  f.ports.captureOriginal = factory;
  const bound = createBoundDocPort(f.controller, f.binding, f.ports);
  expect(() => bound.captureOriginal({ id: 'original', bytes: 'bytes' })).toThrow('retired');
  expect(factory).toHaveBeenCalledOnce();
  expect(f.ports.submit).not.toHaveBeenCalled();
  expect(f.ports.inspect).not.toHaveBeenCalled();
});
it.each(['id', 'bytes'] as const)(
  'refuses changed returned original %s without any operation',
  (field) => {
    const f = fixture();
    const factory = vi.fn((request: { id: string; bytes: string }) => ({
      ...request,
      [field]: 'changed',
      submit: vi.fn(),
      inspect: vi.fn(),
    }));
    f.ports.captureOriginal = factory;
    const bound = createBoundDocPort(f.controller, f.binding, f.ports);
    expect(bound.captureOriginal({ id: 'original', bytes: 'bytes' })).toBeNull();
    expect(factory).toHaveBeenCalledOnce();
    expect(f.ports.submit).not.toHaveBeenCalled();
    expect(f.ports.inspect).not.toHaveBeenCalled();
  }
);
