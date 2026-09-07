/**
 * `shared/lib`'s barrel does not load a Transport (DOR-1809).
 *
 * **What this pins, and why it is a load test rather than a source scan.** The
 * two Transport implementations were on the barrel until DOR-1809, so
 * `import { cn } from '@/layers/shared/lib'` — the spelling half the app used —
 * evaluated `HttpTransport`, its ~30 per-domain method factories, the SSE
 * parser and the durable websocket client on the way to merging two class
 * names. Batch 15 (DOR-1761) removed 45 of those imports and added a lint rule
 * against new ones, but the rule only reaches `shared/`, and a lint rule cannot
 * see the second hop: `query-persister` asked `instanceof HttpTransport` and
 * pulled the whole seam back in through a barrel line that mentions no
 * transport at all. Only the module graph shows that, so only the module graph
 * is asserted here.
 *
 * **The mechanism.** Every file under `transport/`, `direct/` and
 * `direct-transport.ts` is enumerated from disk and given a `vi.doMock` factory
 * that records the module and answers with an inert namespace. A factory runs
 * when — and only when — something actually imports the module, so after a
 * fresh `import('../index')` the recorded list IS the barrel's reach into
 * transport land. Nothing is hard-coded: a method factory added tomorrow is
 * enumerated tomorrow, and it is recorded whether it is reached through
 * `transport/index.ts` or deep-imported past it.
 *
 * The second test is the control. It imports two modules that DO hold a
 * transport, one from each enumerated root, and fails if the detector records
 * nothing — so a broken walk, or a mock spelling vitest no longer resolves,
 * reddens instead of passing green having watched nothing. That is not
 * hypothetical: the first draft of this file spelled the mocks relative to
 * `lib/` rather than to itself, and every mock silently failed to attach.
 *
 * @module shared/lib/__tests__/barrel-transport-isolation
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** `apps/client/src/layers/shared/lib` — the barrel's own directory. */
const LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every module a Transport is built from, as specifiers relative to this file.
 *
 * Read off disk rather than listed, so the guard cannot go stale behind a new
 * method factory. `__tests__` is skipped: a spec importing the transport is the
 * point of a spec, not a leak.
 *
 * @param dir - Directory to walk, absolute.
 */
function transportModules(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === '__tests__') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      found.push(`../${relative(LIB_DIR, full).split(sep).join('/')}`);
    }
  };
  walk(dir);
  return found;
}

/**
 * The transport surface, spelled the way an import inside `lib/` spells it.
 *
 * Both implementations, not just the HTTP one: `DirectTransport` was on the
 * barrel too, and its `direct/` factories are the same shape of cost for a
 * surface that will never be embedded in Obsidian.
 */
const TRANSPORT_MODULES = [
  ...transportModules(join(LIB_DIR, 'transport')),
  ...transportModules(join(LIB_DIR, 'direct')),
  '../direct-transport.ts',
];

/**
 * What a recorded transport module answers with.
 *
 * Deliberately NOT `importOriginal()`: handing back the real module makes the
 * control case evaluate the whole HTTP stack through the mock machinery, which
 * turned this file into a 20-second test. Nothing here calls into a transport —
 * the subject is which modules load, not what they do — so an inert namespace
 * is enough, and any name read off it is a class that exists and does nothing.
 */
const STUB: Record<string, unknown> = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : class Stub {}),
  }
);

/** Modules whose factory ran during the import under test, in load order. */
let loaded: string[] = [];

beforeEach(() => {
  loaded = [];
  vi.resetModules();
  for (const specifier of TRANSPORT_MODULES) {
    vi.doMock(specifier, () => {
      loaded.push(specifier);
      return STUB;
    });
  }
});

afterEach(() => {
  for (const specifier of TRANSPORT_MODULES) vi.doUnmock(specifier);
  vi.resetModules();
});

describe('shared/lib barrel ↔ transport isolation', () => {
  it('enumerates the transport surface it is guarding', () => {
    // A floor, not an exact count — the point is that the walk found the real
    // directory and not an empty one. Both implementations are named because a
    // typo in either path would otherwise leave half the guard watching nothing.
    expect(TRANSPORT_MODULES.length).toBeGreaterThan(30);
    expect(TRANSPORT_MODULES).toContain('../transport/http-transport.ts');
    expect(TRANSPORT_MODULES).toContain('../transport/ws-connection.ts');
    expect(TRANSPORT_MODULES).toContain('../direct-transport.ts');
  });

  it('loads no transport module when the barrel is imported', async () => {
    const barrel = await import('../index');

    expect(loaded).toEqual([]);

    // And it is still a barrel. The assertion above would also hold for one
    // emptied by accident, so this is the "and it still works" half: a value
    // from a module that used to sit two lines from the transport re-exports,
    // and the key/allow-list half the split moved out of `query-persister`.
    expect(typeof barrel.cn).toBe('function');
    expect(typeof barrel.clearBootCache).toBe('function');
    expect(barrel.BOOT_CACHE_KEY_PREFIX).toBe('dorkos:rq:');
  });

  it('records both Transports when something really does load one', async () => {
    // The control, and the reason to trust the emptiness above. These two
    // modules DO hold a transport — `query-persister` refuses to persist for
    // anything but `HttpTransport`, and `direct-transport` is the Obsidian one
    // — so both must be recorded. One entry from each enumerated root, because
    // a mock spelling that stopped resolving would otherwise leave half the
    // guard passing green having watched nothing.
    await import('../query-persister');
    await import('../direct-transport');

    expect(loaded).toContain('../transport/index.ts');
    expect(loaded).toContain('../direct-transport.ts');
  });
});
