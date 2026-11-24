import { afterEach, expect, it, vi } from 'vitest';
import { fixture, corpus } from './fixture.js';
import { DISTRIBUTION, IdentitySchema, LIMITS, relativePath } from '../records.js';
import { distributionDigest, createFilesInspector } from '../inspector.js';
import { scanJSON } from '../scanner.js';
import { InspectionOwner } from '../owner.js';
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const bytes = (s: string) => new TextEncoder().encode(s);
afterEach(() => vi.useRealTimers());
it('actual116 source-byte reader/hash composition returns mock files-only installed, never ready', async () => {
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
it('wrong read lease refuses without decoding and closes only its registered handle', async () => {
  const h = fixture();
  const original = h.port.readInto;
  h.port.readInto = async (...args) => ({ ...(await original(...args)), lease: { ...args[0] } });
  expect((await h.inspector.inspectExisting()).state).toBe('unverified');
  await tick();
  expect(h.calls.filter((c) => c.kind === 'read')).toHaveLength(1);
  expect(h.calls.filter((c) => c.kind === 'close')).toHaveLength(1);
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
