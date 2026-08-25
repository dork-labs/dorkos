/**
 * What the memory registry does when a backend misbehaves.
 *
 * The invariant every case here defends: **memory never takes down a turn.** A
 * provider that throws is benched for the process, `builtin` takes over, and one
 * warning says so — one, not one per turn, because a backend that throws on
 * every read would otherwise bury the log.
 *
 * Two things are asserted that a weaker test would leave out, and both were
 * chosen because their absence lets a broken registry pass:
 *
 * - **The CALL COUNT on the benched provider.** Asserting only "no error
 *   surfaced" passes for a registry that swallows the throw and retries the
 *   broken backend for ever.
 * - **The warning count across several calls.** Asserting "a warning was logged"
 *   passes for a registry that logs one per turn.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MemoryCapExceededError,
  MemoryMatchError,
  MemoryUnsupportedError,
  type AgentMemoryRef,
  type MemoryProvider,
} from '@dorkos/shared/memory-provider';
import { FakeMemoryProvider } from '@dorkos/test-utils/fake-memory-provider';

vi.mock('../../core/config-manager.js', () => ({
  configManager: { getDot: vi.fn() },
}));

import { configManager } from '../../core/config-manager.js';
import { logger } from '../../../lib/logger.js';
import {
  MEMORY_PROVIDER_UNAVAILABLE_INFO,
  getMemoryProvider,
  isMemoryProviderBenched,
  registerMemoryProvider,
  resetMemoryProvider,
} from '../registry.js';

/** The id every custom backend in this file registers under. */
const CUSTOM = 'acme-memory';

let warn: ReturnType<typeof vi.spyOn>;
let scopes: string[] = [];

/** A real agent directory, so the builtin fallback has somewhere to write. */
async function makeRef(): Promise<AgentMemoryRef> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorkos-memory-registry-'));
  scopes.push(dir);
  return { agentId: path.basename(dir), agentPath: dir };
}

/** Point `memory.provider` at an id. */
function configure(id: string): void {
  vi.mocked(configManager.getDot).mockImplementation((key: string) =>
    key === 'memory.provider' ? id : undefined
  );
}

/**
 * A provider that faults on every call, counting how often it is asked.
 *
 * @param err - What it throws. Defaults to a plain fault, which is what benches.
 */
function throwingProvider(err: unknown = new TypeError('acme backend exploded')): MemoryProvider & {
  calls: () => number;
} {
  let calls = 0;
  const fail = (): never => {
    calls += 1;
    throw err;
  };
  return {
    info: { id: CUSTOM, capabilities: { search: true, consolidate: true } },
    getSnapshot: fail,
    write: fail,
    query: fail,
    forget: fail,
    consolidate: fail,
    calls: () => calls,
  };
}

beforeEach(() => {
  resetMemoryProvider();
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  configure(BUILTIN_MEMORY_PROVIDER_ID);
});

afterEach(async () => {
  resetMemoryProvider();
  warn.mockRestore();
  vi.mocked(configManager.getDot).mockReset();
  await Promise.all(scopes.map((dir) => rm(dir, { recursive: true, force: true })));
  scopes = [];
});

describe('the default posture', () => {
  it('serves memory from builtin when nothing else is configured', async () => {
    const ref = await makeRef();
    await getMemoryProvider().write(ref, { action: 'add', text: 'ships on Fridays' });

    expect(getMemoryProvider().info.id).toBe(BUILTIN_MEMORY_PROVIDER_ID);
    expect((await getMemoryProvider().getSnapshot(ref)).content).toContain('ships on Fridays');
    expect(warn).not.toHaveBeenCalled();
  });

  it('never benches a healthy custom provider, however much it is used', async () => {
    const healthy = new FakeMemoryProvider({ id: CUSTOM });
    registerMemoryProvider(CUSTOM, () => healthy);
    configure(CUSTOM);
    const ref = await makeRef();

    for (let i = 0; i < 5; i += 1) {
      await getMemoryProvider().write(ref, { action: 'add', text: `note ${i}` });
      await getMemoryProvider().getSnapshot(ref);
    }

    expect(isMemoryProviderBenched(CUSTOM)).toBe(false);
    expect(getMemoryProvider().info.id).toBe(CUSTOM);
    expect(warn).not.toHaveBeenCalled();
    // The custom backend really served: nothing reached the builtin file.
    expect((await getMemoryProvider().getSnapshot(ref)).content).toContain('note 4');
  });
});

describe('quarantine', () => {
  it('benches a throwing provider on its FIRST fault and never calls it again', async () => {
    const broken = throwingProvider();
    registerMemoryProvider(CUSTOM, () => broken);
    configure(CUSTOM);
    const ref = await makeRef();

    // Six turns' worth of reads and writes against a backend that throws on
    // every one of them.
    for (let i = 0; i < 3; i += 1) {
      await getMemoryProvider().getSnapshot(ref);
      await getMemoryProvider().write(ref, { action: 'add', text: `note ${i}` });
    }

    expect(isMemoryProviderBenched(CUSTOM)).toBe(true);
    // THE assertion. One call, not six: a registry that swallowed the throw and
    // retried for ever would report zero errors and read exactly like this one.
    expect(broken.calls()).toBe(1);
  });

  it('logs exactly ONE warning across many failing calls, and names the fallback', async () => {
    registerMemoryProvider(CUSTOM, () => throwingProvider());
    configure(CUSTOM);
    const ref = await makeRef();

    for (let i = 0; i < 4; i += 1) await getMemoryProvider().getSnapshot(ref);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.join(' ');
    expect(line).toContain(CUSTOM);
    expect(line).toContain(BUILTIN_MEMORY_PROVIDER_ID);
  });

  it('completes the turn from builtin — the read answers and the write lands', async () => {
    registerMemoryProvider(CUSTOM, () => throwingProvider());
    configure(CUSTOM);
    const ref = await makeRef();

    // The call that faults still has to answer the turn that asked for it.
    const result = await getMemoryProvider().write(ref, { action: 'add', text: 'ships Fridays' });
    expect(result.created).toBe(true);

    const snapshot = await getMemoryProvider().getSnapshot(ref);
    expect(snapshot.status).toBe('present');
    expect(snapshot.content).toContain('ships Fridays');
    // And the fallback is what `info` reports once the choice is benched.
    expect(getMemoryProvider().info.id).toBe(BUILTIN_MEMORY_PROVIDER_ID);
  });

  it('benches a provider whose FACTORY throws — the bench-check is not a way in', async () => {
    // The construction path is the one place a fault could escape before any
    // port method is called. It must be caught in exactly the same way.
    registerMemoryProvider(CUSTOM, () => {
      throw new Error('cannot reach the acme service');
    });
    configure(CUSTOM);
    const ref = await makeRef();

    const snapshot = await getMemoryProvider().getSnapshot(ref);
    expect(snapshot.status).toBe('absent');
    expect(isMemoryProviderBenched(CUSTOM)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("benches a provider whose `info` getter throws, and answers with builtin's", () => {
    const provider = throwingProvider();
    Object.defineProperty(provider, 'info', {
      get(): never {
        throw new Error('info exploded');
      },
    });
    registerMemoryProvider(CUSTOM, () => provider);
    configure(CUSTOM);

    expect(getMemoryProvider().info.id).toBe(BUILTIN_MEMORY_PROVIDER_ID);
    expect(isMemoryProviderBenched(CUSTOM)).toBe(true);
  });

  it('warns once about an id nothing registered, then serves from builtin', async () => {
    configure('never-registered');
    const ref = await makeRef();

    for (let i = 0; i < 3; i += 1) await getMemoryProvider().getSnapshot(ref);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain(BUILTIN_MEMORY_PROVIDER_ID);
    await getMemoryProvider().write(ref, { action: 'add', text: 'still works' });
    expect((await getMemoryProvider().getSnapshot(ref)).content).toContain('still works');
  });
});

describe('what is NOT a fault', () => {
  it.each([
    ['MemoryUnsupportedError', new MemoryUnsupportedError(CUSTOM, 'search', 'query')],
    ['MemoryMatchError', new MemoryMatchError('not-found', 'nothing', [])],
    ['MemoryCapExceededError', new MemoryCapExceededError(10, 20, 15)],
  ])('passes a %s straight through without benching anybody', async (_name, err) => {
    const refusing = throwingProvider(err);
    registerMemoryProvider(CUSTOM, () => refusing);
    configure(CUSTOM);
    const ref = await makeRef();

    await expect(getMemoryProvider().write(ref, { action: 'add', text: 'x' })).rejects.toBe(err);
    await expect(getMemoryProvider().write(ref, { action: 'add', text: 'y' })).rejects.toBe(err);

    // Still serving, still called, nothing logged. A registry that benched a
    // provider for refusing a bad edit would bench every healthy backend within
    // a day of shipping.
    expect(isMemoryProviderBenched(CUSTOM)).toBe(false);
    expect(refusing.calls()).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a malformed ref without benching anybody', async () => {
    const healthy = new FakeMemoryProvider({ id: CUSTOM });
    const spy = vi.spyOn(healthy, 'getSnapshot');
    registerMemoryProvider(CUSTOM, () => healthy);
    configure(CUSTOM);

    // A caller bug, refused identically whichever backend is installed. Benching
    // a healthy provider over somebody else's mistake is the failure this guards.
    const snapshot = await getMemoryProvider().getSnapshot({ agentId: '', agentPath: '' });
    expect(snapshot.status).toBe('error');
    expect(isMemoryProviderBenched(CUSTOM)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('when the fallback fails too', () => {
  /** Replace builtin with a backend that throws, which only a test can do. */
  function breakBuiltin(): MemoryProvider & { calls: () => number } {
    const broken = throwingProvider(new Error('the disk is on fire'));
    registerMemoryProvider(BUILTIN_MEMORY_PROVIDER_ID, () => broken);
    return broken;
  }

  it('degrades to NO memory rather than to an exception on the way into a turn', async () => {
    breakBuiltin();
    const ref = await makeRef();

    // The whole invariant, in one assertion: the read answers, it answers
    // honestly ('error', never 'absent' — absence would invite an agent to write
    // over notes it could not see), and the turn carries on.
    const snapshot = await getMemoryProvider().getSnapshot(ref);
    expect(snapshot.status).toBe('error');
    expect(snapshot.content).toBe('');
    expect(snapshot.error).toBeTruthy();
  });

  it('tells the caller a write did not happen, rather than pretending it did', async () => {
    breakBuiltin();
    const ref = await makeRef();
    await expect(getMemoryProvider().write(ref, { action: 'add', text: 'x' })).rejects.toThrow(
      'the disk is on fire'
    );
  });

  it('says so once, however many turns run', async () => {
    breakBuiltin();
    const ref = await makeRef();

    for (let i = 0; i < 4; i += 1) await getMemoryProvider().getSnapshot(ref);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is never benched — the fallback keeps being tried, since nothing is behind it', async () => {
    const broken = breakBuiltin();
    const ref = await makeRef();

    for (let i = 0; i < 3; i += 1) await getMemoryProvider().getSnapshot(ref);

    expect(isMemoryProviderBenched(BUILTIN_MEMORY_PROVIDER_ID)).toBe(false);
    // Called every time, unlike a benched custom provider: a transient disk
    // problem must be able to recover on its own.
    expect(broken.calls()).toBe(3);
  });

  it('reports an honest info when nothing at all can serve', () => {
    registerMemoryProvider(BUILTIN_MEMORY_PROVIDER_ID, () => {
      throw new Error('cannot build builtin');
    });
    expect(getMemoryProvider().info).toEqual(MEMORY_PROVIDER_UNAVAILABLE_INFO);
  });

  it('falls through both a benched custom provider AND a broken builtin', async () => {
    registerMemoryProvider(CUSTOM, () => throwingProvider());
    configure(CUSTOM);
    breakBuiltin();
    const ref = await makeRef();

    const snapshot = await getMemoryProvider().getSnapshot(ref);
    expect(snapshot.status).toBe('error');
    // Two distinct failures, so two lines — one each, still never one per turn.
    await getMemoryProvider().getSnapshot(ref);
    await getMemoryProvider().getSnapshot(ref);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
