import { afterEach, expect, it, vi } from 'vitest';
import { fixture, corpus } from './fixture.js';
import {
  DISTRIBUTION,
  IdentitySchema,
  InspectionFailure,
  LIMITS,
  relativePath,
} from '../records.js';
import { distributionDigest, createFilesInspector } from '../inspector.js';
import { scanJSON } from '../scanner.js';
import { InspectionOwner, type Handle } from '../owner.js';
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const bytes = (s: string) => new TextEncoder().encode(s);
afterEach(() => vi.useRealTimers());
it('actual114 source-byte reader/hash composition returns mock files-only installed, never ready', async () => {
  const h = fixture();
  expect(distributionDigest(corpus)).toBe(DISTRIBUTION);
  const result = await h.inspector.inspectExisting();
  expect(result).toMatchObject({
    state: 'installed',
    cause: null,
    executableSHA256: h.manifest.executableSHA256,
    readiness: { state: 'unavailable' },
  });
  expect(Object.keys(result).sort()).toEqual(
    [
      'arch',
      'cause',
      'chromiumRevision',
      'executableSHA256',
      'observation',
      'pinnedPackageVersion',
      'platform',
      'readiness',
      'schemaVersion',
      'state',
    ].sort()
  );
  expect(h.held).toBeNull();
  expect(h.inspector.custody()).toMatchObject({
    operation: false,
    handle: false,
    retainedBytes: LIMITS.buffer,
  });
});
it('missing requires an unchanged existing root and conclusive pointer absence with no handle', async () => {
  const h = fixture();
  h.roots.cache.delete('current.json');
  expect(await h.inspector.inspectExisting()).toMatchObject({ state: 'missing', cause: null });
  expect(h.calls.every((c) => c.kind === 'observe')).toBe(true);
});
it('unknown root is unverified rather than missing', async () => {
  const h = fixture();
  h.port.observeNamed = async (lease) => ({ lease, value: { state: 'unknown' } });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
});
it('unsupported target performs zero filesystem effects', async () => {
  const h = fixture();
  const other = createFilesInspector({
    cacheRoot: '/mock/cache',
    libraryRoot: '/mock/library',
    platform: 'linux',
    arch: 'x64',
    port: h.port,
    signal: h.controller.signal,
    now: () => 0,
  });
  expect((await other.inspectExisting()).state).toBe('unsupported');
  expect(h.calls).toEqual([]);
});
it.each([
  '{',
  '{"schemaVersion":1,"schemaVersion":1}',
  '{"schemaVersion":1,"\\u0073chemaVersion":1}',
])('malformed or duplicate pointer is invalid: %s', async (text) => {
  const h = fixture();
  h.roots.cache.set('current.json', bytes(text));
  expect((await h.inspector.inspectExisting()).state).toBe('invalid');
});
it.each(['current.json', 'candidates/fixture_installation/manifest.json'])(
  'cap+one and growth beyond stat refuse bounded %s',
  async (path) => {
    const h = fixture();
    const cap = path === 'current.json' ? LIMITS.pointer : LIMITS.manifest;
    h.identity('cache', path);
    h.roots.cache.set(path, new Uint8Array(cap + 1));
    expect((await h.inspector.inspectExisting()).state).toBe('unverified');
    const reads = h.calls.filter((c) => c.kind === 'read' && c.lease.path === path);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.length).toBe(cap + 1);
  }
);
it('malformed UTF8 refuses before record acceptance', async () => {
  const h = fixture();
  h.roots.cache.set('current.json', new Uint8Array([0xc3, 0x28]));
  expect((await h.inspector.inspectExisting()).state).toBe('invalid');
});
it('pinned asset byte mutation cannot produce installed', async () => {
  const h = fixture();
  h.roots.library.set('cli.js', bytes('CHANGED_SOURCE'));
  expect((await h.inspector.inspectExisting()).state).toBe('invalid');
});
it('final raw pointer replacement during executable hashing cannot publish old installed', async () => {
  const h = fixture();
  let replaced = false;
  h.observe((kind, lease) => {
    if (kind === 'read' && lease.path.endsWith('/bin/chromium') && !replaced) {
      replaced = true;
      h.roots.cache.set(
        'current.json',
        bytes(
          '{"schemaVersion":1,"installationId":"fixture_installation","manifestDigest":"' +
            'b'.repeat(64) +
            '"}'
        )
      );
    }
  });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(replaced).toBe(true);
});
it('held identity observations all precede exact closure', async () => {
  const h = fixture();
  expect((await h.inspector.inspectExisting()).state).toBe('installed');
  for (const call of h.calls.filter((c) => c.kind === 'close')) {
    const same = h.calls.filter((c) => c.handle === call.handle);
    expect(same.at(-1)).toBe(call);
    expect(same.filter((c) => c.kind === 'held')).toHaveLength(2);
  }
});
it('wrong close ACK retains handle charge, prevents success and successor acquisition', async () => {
  const h = fixture();
  const close = h.port.close;
  h.port.close = async (l, handle) => {
    const r = await close(l, handle);
    return { ...r, handle: { kind: 'file', token: {} } as Handle };
  };
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.inspector.custody().handle).toBe(true);
  const count = h.calls.length;
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.calls).toHaveLength(count);
});
it('reentrant observations share exact promise with no successor work', async () => {
  const h = fixture();
  let nested: ReturnType<typeof h.inspector.inspectExisting> | undefined;
  h.observe(() => {
    nested ??= h.inspector.inspectExisting();
  });
  const first = h.inspector.inspectExisting();
  expect(nested).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(await first).toMatchObject({ state: 'installed' });
});
it('pending read stays charged until settlement then exact cleanup; abort never publishes late', async () => {
  const h = fixture();
  let ack!: (v: Awaited<ReturnType<typeof h.port.readInto>>) => void;
  const read = h.port.readInto;
  let saved: Awaited<ReturnType<typeof read>>;
  h.port.readInto = async (...args) => {
    saved = await read(...args);
    return new Promise((r) => {
      ack = r;
    });
  };
  const result = h.inspector.inspectExisting();
  await tick();
  expect(h.inspector.inspectExisting()).toBe(result);
  expect(h.inspector.custody()).toMatchObject({ operation: true, handle: true });
  h.controller.abort();
  expect((await result).state).toBe('unverified');
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(0);
  ack(saved!);
  await tick();
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
  expect(h.inspector.custody()).toMatchObject({ operation: false, handle: false, retired: true });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
});
it('late open has preregistered custody and closes once without reopening after timeout', async () => {
  vi.useFakeTimers();
  const h = fixture();
  const open = h.port.openRegular;
  let ack!: (v: Awaited<ReturnType<typeof open>>) => void;
  let saved: Awaited<ReturnType<typeof open>>;
  h.port.openRegular = async (...args) => {
    saved = await open(...args);
    return new Promise((r) => {
      ack = r;
    });
  };
  const first = h.inspector.inspectExisting();
  await tick();
  await vi.advanceTimersByTimeAsync(5000);
  expect((await first).state).toBe('unverified');
  expect(h.inspector.custody().operation).toBe(true);
  ack(saved!);
  await tick();
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
});
it('clock regression during observation refuses before open', async () => {
  const h = fixture();
  h.setClock(10);
  h.observe(() => h.setClock(9));
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.calls.some((c) => c.kind === 'open')).toBe(false);
});
it('already-aborted parent has zero operations', async () => {
  const h = fixture();
  h.controller.abort();
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.calls).toEqual([]);
});
it('entry cap never silently truncates an oversized directory', async () => {
  const h = fixture();
  for (let i = 0; i < 257; i++) h.roots.library.set('extra' + i, new Uint8Array());
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.calls.filter((c) => c.kind === 'next')).toHaveLength(257);
});
it('bounded scanner enforces depth/member exact limits and escaped duplicates', () => {
  expect(scanJSON(bytes('['.repeat(16) + '0' + ']'.repeat(16)))).toBeDefined();
  expect(() => scanJSON(bytes('['.repeat(17) + '0' + ']'.repeat(17)))).toThrow();
  expect(scanJSON(bytes(JSON.stringify(Array(256).fill(0))))).toHaveLength(256);
  expect(() => scanJSON(bytes(JSON.stringify(Array(257).fill(0))))).toThrow();
  expect(() => scanJSON(bytes('{"a":1,"\\u0061":2}'))).toThrow();
});
it('identity decimal bounds and relative paths refuse traversal/aliases', () => {
  const h = fixture();
  const id = h.identity('cache', '')!;
  expect(IdentitySchema.safeParse({ ...id, inode: '18446744073709551615' }).success).toBe(true);
  for (const inode of ['01', '-0', '18446744073709551616'])
    expect(IdentitySchema.safeParse({ ...id, inode }).success).toBe(false);
  for (const path of ['/a', '../a', 'a//b', 'a\\b', 'C:a', 'a/./b'])
    expect(relativePath.safeParse(path).success).toBe(false);
});
it('exact pointer/manifest byte caps are observable positives', async () => {
  const h = fixture();
  const path = 'candidates/fixture_installation/manifest.json';
  const manifest = bytes(
    new TextDecoder().decode(h.roots.cache.get(path)!).padEnd(LIMITS.manifest, ' ')
  );
  h.roots.cache.set(path, manifest);
  const pointer = h.encode({
    schemaVersion: 1,
    installationId: h.manifest.installationId,
    manifestDigest: h.hash(manifest),
  });
  h.roots.cache.set(
    'current.json',
    bytes(new TextDecoder().decode(pointer).padEnd(LIMITS.pointer, ' '))
  );
  expect((await h.inspector.inspectExisting()).state).toBe('installed');
});
it.each(['observe', 'held', 'next', 'close'] as const)(
  'pending %s blocks every successor effect until exact settlement',
  async (kind) => {
    const h = fixture();
    let acknowledge!: () => void;
    let entered = false;
    const gate = new Promise<void>((r) => {
      acknowledge = r;
    });
    const method =
      kind === 'observe'
        ? 'observeNamed'
        : kind === 'held'
          ? 'observeHeld'
          : kind === 'next'
            ? 'nextEntry'
            : 'close';
    const original = h.port[method].bind(h.port);
    // Each overload is wrapped as a trusted test port; the source still sees its exact fixed signature.
    Object.assign(h.port, {
      [method]: async (...args: Parameters<typeof original>) => {
        const value = await (original as (...args: unknown[]) => Promise<unknown>)(...args);
        if (!entered) {
          entered = true;
          await gate;
        }
        return value;
      },
    });
    const first = h.inspector.inspectExisting();
    for (let i = 0; i < 20 && !entered; i++) await tick();
    expect(entered).toBe(true);
    const count = h.calls.length;
    for (let i = 0; i < 50; i++) expect(h.inspector.inspectExisting()).toBe(first);
    h.controller.abort();
    expect((await first).state).toBe('unverified');
    expect(h.calls).toHaveLength(count);
    expect(h.inspector.custody().operation).toBe(true);
    acknowledge();
    await tick();
    expect((await h.inspector.inspectExisting()).state).toBe('unverified');
    expect(h.inspector.custody().operation).toBe(false);
  }
);
it('reentrant close cannot release held charge before its exact ACK', async () => {
  const h = fixture();
  const original = h.port.close;
  let heldBefore = false,
    nested: ReturnType<typeof h.inspector.inspectExisting> | undefined;
  h.port.close = async (...args) => {
    heldBefore = h.inspector.custody().handle;
    expect(h.inspector.custody().operation).toBe(true);
    nested = h.inspector.inspectExisting();
    return original(...args);
  };
  const first = h.inspector.inspectExisting();
  expect((await first).state).toBe('installed');
  expect(nested).toBe(first);
  expect(heldBefore).toBe(true);
});
it('wrong read lease refuses without decoding and closes only its registered handle', async () => {
  const h = fixture();
  const original = h.port.readInto;
  h.port.readInto = async (...args) => ({ ...(await original(...args)), lease: { ...args[0] } });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  await tick();
  expect(h.calls.filter((c) => c.kind === 'read')).toHaveLength(1);
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
});
it('short or zero read cannot certify the observed complete file', async () => {
  const h = fixture();
  h.port.readInto = async (lease, handle) => ({ lease, handle, value: 0 });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
});
it('partial reads advance exact offsets and still measure the actual114 byte corpus', async () => {
  const h = fixture();
  const original = h.port.readInto;
  h.port.readInto = (l, handle, b, offset, length) =>
    original(l, handle, b, offset, Math.min(length, 7000));
  expect((await h.inspector.inspectExisting()).state).toBe('installed');
});
it.each(['named', 'held', 'parent'] as const)(
  'observed %s replacement refuses publication',
  async (kind) => {
    const h = fixture();
    let changed = false;
    h.observe((call, lease) => {
      if (call === 'read' && !changed) {
        changed = true;
        const path = kind === 'parent' ? '' : lease.path;
        const id = h.identity('cache', path)!;
        h.identities.set('cache:' + path, { ...id, inode: '9999' });
      }
    });
    expect((await h.inspector.inspectExisting()).state).toBe('unverified');
    expect(changed).toBe(true);
  }
);
it('unknown close retains quarantine even after its operation settles', async () => {
  const h = fixture();
  h.port.close = async (lease, handle) => ({ lease, handle, value: 'unknown' });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.inspector.custody()).toMatchObject({ operation: false, handle: true });
});
it('retained byte allocation cap includes the reusable buffer and refuses cap+one', () => {
  const h = fixture();
  const owner = new InspectionOwner(h.port, () => 0, h.controller.signal, {
    cache: '/mock/cache',
    library: '/mock/library',
  });
  owner.begin();
  try {
    const b = owner.allocate(65536);
    expect(owner.custody().retainedBytes).toBe(131072);
    expect(() => owner.allocate(1)).toThrow();
    owner.release(b);
    expect(owner.custody().retainedBytes).toBe(65536);
  } finally {
    owner.finish();
  }
});
it('duplicate entry and nonregular library types are refused before traversal', async () => {
  const h = fixture();
  h.port.nextEntry = async (lease, handle) => ({
    lease,
    handle,
    value: { name: 'socket', type: 'other' },
  });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  const other = fixture();
  other.port.nextEntry = async (lease, handle) => ({
    lease,
    handle,
    value: { name: 'same', type: 'file' },
  });
  expect((await other.inspector.inspectExisting()).state).toBe('invalid');
});
it('deep directory and overlong entry cannot silently disappear from the census', async () => {
  const h = fixture();
  h.roots.library.clear();
  h.roots.library.set(Array(17).fill('d').join('/') + '/file', bytes('x'));
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  const other = fixture();
  other.port.nextEntry = async (lease, handle) => ({
    lease,
    handle,
    value: { name: 'x'.repeat(1025), type: 'file' },
  });
  expect((await other.inspector.inspectExisting()).state).toBe('unverified');
});
it('clock-triggered parent cancellation cannot admit an operation after observation', async () => {
  const h = fixture();
  let n = 0;
  const other = createFilesInspector({
    cacheRoot: '/mock/cache',
    libraryRoot: '/mock/library',
    platform: 'darwin',
    arch: 'arm64',
    signal: h.controller.signal,
    port: h.port,
    now: () => {
      if (++n === 2) h.controller.abort();
      return 0;
    },
  });
  expect((await other.inspectExisting()).state).toBe('unverified');
  expect(h.calls).toEqual([]);
});
it('closed handle/token reuse cannot supply successor custody', async () => {
  const h = fixture();
  const original = h.port.openRegular;
  let old: Handle | undefined;
  h.port.openRegular = async (...args) => {
    const reply = await original(...args);
    if (!old) {
      old = reply.value;
      return reply;
    }
    return { ...reply, value: old };
  };
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.inspector.custody().handle).toBe(true);
});
it('complete canonical executable path bounds are validated before file effects', async () => {
  const h = fixture();
  const other = createFilesInspector({
    cacheRoot: '/' + 'x'.repeat(4095),
    libraryRoot: '/mock/library',
    platform: 'darwin',
    arch: 'arm64',
    signal: h.controller.signal,
    port: h.port,
    now: () => 0,
  });
  expect((await other.inspectExisting()).state).toBe('unverified');
  expect(h.calls.every((c) => c.lease.path === '')).toBe(true);
});

// Method observation is external work: cancellation must precede the captured IO entry.
for (const [method, kind] of [
  ['observeNamed', 'observe'],
  ['openRegular', 'open'],
  ['openDirectory', 'directory'],
  ['observeHeld', 'held'],
  ['readInto', 'read'],
  ['nextEntry', 'next'],
] as const) {
  it(`stable ${method} getter preserves receiver and installed traversal`, async () => {
    const h = fixture();
    const original = h.port[method];
    let captures = 0,
      entries = 0;
    Object.defineProperty(h.port, method, {
      get() {
        captures++;
        return function (this: typeof h.port, ...args: unknown[]) {
          entries++;
          expect(this).toBe(h.port);
          return Reflect.apply(original, this, args);
        };
      },
    });
    expect((await h.inspector.inspectExisting()).state).toBe('installed');
    expect(captures).toBe(entries);
    expect(entries).toBeGreaterThan(0);
    expect(h.calls.filter((c) => c.kind === kind).length).toBe(entries);
    expect(h.held).toBe(null);
  });
  for (const transition of ['abort', 'deadline', 'clock-failure'] as const) {
    it(`${method} ${transition} during capture refuses ordinary IO and preserves cleanup`, async () => {
      const h = fixture();
      const original = h.port[method];
      let captures = 0;
      Object.defineProperty(h.port, method, {
        get() {
          captures++;
          if (transition === 'abort') h.controller.abort();
          else h.setClock(transition === 'deadline' ? 5000 : NaN);
          return original;
        },
      });
      expect((await h.inspector.inspectExisting()).state).toBe('unverified');
      for (let n = 0; n < 20; n++) await Promise.resolve();
      expect(captures).toBe(1);
      expect(h.calls.filter((c) => c.kind === kind)).toHaveLength(0);
      expect(h.held).toBe(null);
      const calls = h.calls.length;
      expect((await h.inspector.inspectExisting()).state).toBe('unverified');
      expect(h.calls).toHaveLength(calls);
      expect(h.inspector.custody().operation).toBe(false);
      expect(h.inspector.custody().retired).toBe(true);
      // A rejected opening retains uncertainty rather than refunding unknown custody.
      if (method === 'openRegular' || method === 'openDirectory')
        expect(h.inspector.custody().handle).toBe(true);
      else expect(h.inspector.custody().handle).toBe(false);
    });
  }
}
it('close getter retirement still permits one exact owned cleanup with its receiver', async () => {
  const h = fixture();
  const original = h.port.close;
  let captures = 0,
    entries = 0;
  Object.defineProperty(h.port, 'close', {
    get() {
      captures++;
      h.controller.abort();
      return function (this: typeof h.port, ...args: unknown[]) {
        entries++;
        expect(this).toBe(h.port);
        return Reflect.apply(original, this, args);
      };
    },
  });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(captures).toBe(1);
  expect(entries).toBe(1);
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
  expect(h.held).toBe(null);
  expect(h.inspector.custody().handle).toBe(false);
});
it('method capture reentrant inspection coalesces instead of dispatching peer IO', async () => {
  const h = fixture();
  const original = h.port.observeNamed;
  let captured: Promise<unknown> | undefined;
  Object.defineProperty(h.port, 'observeNamed', {
    get() {
      captured = h.inspector.inspectExisting();
      return original;
    },
  });
  const active = h.inspector.inspectExisting();
  expect(captured).toBe(active);
  expect((await active).state).toBe('installed');
  expect(h.held).toBe(null);
});

for (const [method, kind] of [
  ['observeNamed', 'observe'],
  ['openRegular', 'open'],
  ['openDirectory', 'directory'],
  ['observeHeld', 'held'],
  ['readInto', 'read'],
  ['nextEntry', 'next'],
] as const) {
  it(`${method} getter throw retains owned cleanup and unknown opening custody`, async () => {
    const h = fixture();
    let captures = 0;
    Object.defineProperty(h.port, method, {
      get() {
        captures++;
        throw Error('PRIVATE_METHOD_CAPTURE_SECRET');
      },
    });
    const result = await h.inspector.inspectExisting();
    for (let n = 0; n < 20; n++) await Promise.resolve();
    expect(result.state).toBe('unverified');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_METHOD_CAPTURE_SECRET');
    expect(captures).toBe(1);
    expect(h.calls.filter((c) => c.kind === kind)).toHaveLength(0);
    expect(h.held).toBe(null);
    expect(h.inspector.custody().operation).toBe(false);
    expect(h.inspector.custody().retired).toBe(true);
    expect(h.inspector.custody().handle).toBe(
      method === 'openRegular' || method === 'openDirectory'
    );
  });
}
it('throwing owned close getter preserves the exact handle charge without another capture', async () => {
  const h = fixture();
  let captures = 0;
  Object.defineProperty(h.port, 'close', {
    get() {
      captures++;
      throw Error('PRIVATE_CLOSE_CAPTURE_SECRET');
    },
  });
  const result = await h.inspector.inspectExisting();
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(result.state).toBe('unverified');
  expect(captures).toBe(1);
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(0);
  expect(h.held).not.toBe(null);
  expect(h.inspector.custody()).toMatchObject({ operation: false, handle: true, retired: true });
  const calls = h.calls.length;
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  expect(h.calls).toHaveLength(calls);
  expect(captures).toBe(1);
});

// These fixed boundaries were calibrated on frozen3e9: do not recalibrate onto the new guard.
function publicationFixture(missing: boolean, transition?: 'abort' | 'deadline') {
  const h = fixture();
  if (missing) h.roots.cache.delete('current.json');
  let checks = 0,
    scheduled = 0,
    clock = 0;
  const inspector = createFilesInspector({
    cacheRoot: '/mock/cache',
    libraryRoot: '/mock/library',
    platform: 'darwin',
    arch: 'arm64',
    signal: h.controller.signal,
    port: h.port,
    now: () => {
      if (++checks === (missing ? 16 : 9835) && transition) {
        scheduled++;
        queueMicrotask(() => {
          if (transition === 'abort') h.controller.abort();
          else clock = LIMITS.deadlineMs;
        });
      }
      return clock;
    },
  });
  return { h, inspector, scheduled: () => scheduled };
}
for (const missing of [false, true]) {
  it(`stable ${missing ? 'missing' : 'installed'} publication remains conclusive`, async () => {
    const f = publicationFixture(missing);
    expect((await f.inspector.inspectExisting()).state).toBe(missing ? 'missing' : 'installed');
    expect(f.scheduled()).toBe(0);
    expect(f.h.held).toBe(null);
    expect(f.inspector.custody()).toMatchObject({
      operation: false,
      handle: false,
      retired: false,
    });
  });
  for (const transition of ['abort', 'deadline'] as const) {
    it(`${transition} queued at frozen ${missing ? 'missing' : 'installed'} boundary refuses publication`, async () => {
      const f = publicationFixture(missing, transition);
      const result = await f.inspector.inspectExisting();
      expect(f.scheduled()).toBe(1);
      expect(result.state).toBe('unverified');
      expect(f.inspector.custody()).toMatchObject({
        operation: false,
        handle: false,
        retired: true,
      });
      expect(f.h.held).toBe(null);
    });
  }
}
for (const method of ['openRegular', 'openDirectory'] as const) {
  for (const field of ['lease', 'value', 'token', 'kind'] as const) {
    it(`${method} throwing reply ${field} retains unknown opening custody`, async () => {
      const h = fixture();
      const original = h.port[method];
      let reached = 0;
      h.port[method] = async (...args) => {
        const reply = await original(...args);
        Object.defineProperty(field === 'lease' || field === 'value' ? reply : reply.value, field, {
          get() {
            reached++;
            throw Error('PRIVATE_OPEN_REPLY_SECRET');
          },
        });
        return reply;
      };
      const result = await h.inspector.inspectExisting();
      await tick();
      expect(reached).toBe(1);
      expect(result.state).toBe('unverified');
      expect(JSON.stringify(result)).not.toContain('PRIVATE_OPEN_REPLY_SECRET');
      expect(h.held).not.toBe(null);
      expect(h.inspector.custody()).toMatchObject({
        operation: false,
        handle: true,
        retired: true,
      });
      const calls = h.calls.length;
      expect((await h.inspector.inspectExisting()).state).toBe('unverified');
      expect(h.calls).toHaveLength(calls);
    });
  }
  it(`${method} stable reply fields support actual exact close`, async () => {
    const h = fixture();
    const original = h.port[method];
    let entries = 0;
    h.port[method] = async (...args) => {
      const reply = await original(...args);
      entries++;
      for (const field of ['token', 'kind'] as const) {
        const value = reply.value[field];
        Object.defineProperty(reply.value, field, { get: () => value });
      }
      const value = reply.value,
        lease = reply.lease;
      Object.defineProperty(reply, 'value', { get: () => value });
      Object.defineProperty(reply, 'lease', { get: () => lease });
      return reply;
    };
    expect((await h.inspector.inspectExisting()).state).toBe('installed');
    expect(entries).toBeGreaterThan(0);
    expect(h.held).toBe(null);
    expect(h.inspector.custody()).toMatchObject({
      operation: false,
      handle: false,
      retired: false,
    });
  });
  it(`${method} valid returned lease retirement preserves exact cleanup`, async () => {
    const h = fixture();
    const original = h.port[method];
    let reached = 0;
    h.port[method] = async (...args) => {
      const reply = await original(...args),
        lease = reply.lease;
      Object.defineProperty(reply, 'lease', {
        get() {
          reached++;
          h.controller.abort();
          return lease;
        },
      });
      return reply;
    };
    expect((await h.inspector.inspectExisting()).state).toBe('unverified');
    await tick();
    expect(reached).toBe(1);
    const opening = [...h.calls]
      .reverse()
      .find((c) => c.kind === (method === 'openRegular' ? 'open' : 'directory'))!;
    const closes = h.calls.filter(
      (c) =>
        c.kind === 'close' &&
        c.lease.root === opening.lease.root &&
        c.lease.path === opening.lease.path
    );
    expect(closes).toHaveLength(1);
    expect(h.held).toBe(null);
    expect(h.inspector.custody()).toMatchObject({ operation: false, handle: false, retired: true });
  });
}

for (const mode of ['stable', 'ordinary-throw', 'changed-state'] as const) {
  it(`identity observation fixed status ${mode}`, async () => {
    const h = fixture(),
      observe = h.port.observeNamed;
    let gets = 0;
    h.port.observeNamed = async (...args) => {
      const reply = await observe(...args);
      if (mode !== 'stable' && reply.value.state === 'present') {
        const identity = { ...reply.value.identity };
        Object.defineProperty(identity, 'inode', {
          get() {
            gets++;
            if (mode === 'ordinary-throw') throw Error('PRIVATE_IDENTITY_SECRET');
            const failure = new InspectionFailure('unverified');
            Object.defineProperty(failure, 'state', { value: 'PRIVATE_IDENTITY_SECRET' });
            throw failure;
          },
        });
        return { ...reply, value: { state: 'present', identity } };
      }
      return reply;
    };
    const result = await h.inspector.inspectExisting();
    expect(gets).toBe(mode === 'stable' ? 0 : 1);
    expect(result.state).toBe(mode === 'stable' ? 'installed' : 'unverified');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_IDENTITY_SECRET');
    expect(h.inspector.custody()).toMatchObject({ operation: false, handle: false });
  });
}

for (const mode of [
  'getter-invalid',
  'getter-secret',
  'getter-throws',
  'malformed',
  'missing',
  'inherited',
  'reflection-throws',
  'invalid',
  'unverified',
] as const) {
  it(`exception classification closed own-data ${mode}`, async () => {
    const h = fixture(),
      observe = h.port.observeNamed;
    let identityGets = 0,
      stateGets = 0,
      coercions = 0;
    const failure = new InspectionFailure(mode === 'invalid' ? 'invalid' : 'unverified');
    if (mode.startsWith('getter-'))
      Object.defineProperty(failure, 'state', {
        get() {
          stateGets++;
          if (mode === 'getter-throws') throw Error('PRIVATE_STATE_SECRET');
          return mode === 'getter-invalid' ? 'invalid' : 'PRIVATE_STATE_SECRET';
        },
      });
    if (mode === 'malformed')
      Object.defineProperty(failure, 'state', {
        value: {
          toString() {
            coercions++;
            return 'invalid';
          },
        },
      });
    if (mode === 'missing' || mode === 'inherited') {
      Reflect.deleteProperty(failure, 'state');
      if (mode === 'inherited')
        Object.setPrototypeOf(
          failure,
          Object.create(InspectionFailure.prototype, { state: { value: 'invalid' } })
        );
    }
    const thrown =
      mode === 'reflection-throws'
        ? new Proxy(failure, {
            getOwnPropertyDescriptor() {
              throw Error('PRIVATE_REFLECTION_SECRET');
            },
          })
        : failure;
    h.port.observeNamed = async (...args) => {
      const reply = await observe(...args);
      if (reply.value.state !== 'present') return reply;
      const identity = { ...reply.value.identity };
      Object.defineProperty(identity, 'inode', {
        get() {
          identityGets++;
          throw thrown;
        },
      });
      return { ...reply, value: { state: 'present', identity } };
    };
    const result = await h.inspector.inspectExisting();
    expect(identityGets).toBe(1);
    expect(stateGets).toBe(0);
    expect(coercions).toBe(0);
    expect(result.state).toBe(mode === 'invalid' ? 'invalid' : 'unverified');
    expect(result.cause).toBe(
      mode === 'invalid' ? 'INSTALLATION_INVALID' : 'VERIFICATION_UNAVAILABLE'
    );
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(h.inspector.custody()).toMatchObject({ operation: false, handle: false });
    expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  });
}
it('malformed pointer remains a legitimate invalid refusal', async () => {
  const h = fixture();
  h.roots.cache.set('current.json', h.encode({ schemaVersion: 1 }));
  expect(await h.inspector.inspectExisting()).toMatchObject({
    state: 'invalid',
    cause: 'INSTALLATION_INVALID',
  });
  expect(h.held).toBeNull();
});
