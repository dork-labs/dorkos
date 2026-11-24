// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { FrameLifetimeController } from '../frame-lifetime';
import { createBoundDocPort } from '../bound-doc-port';
import { DocBirthProjection, DocPublisherRegistry } from '../doc-projection';
import { fixture, birth, replay } from './fixtures';

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
