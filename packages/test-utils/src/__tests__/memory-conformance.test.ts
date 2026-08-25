/**
 * `FakeMemoryProvider` is the reference "passing" backend for the shared
 * MemoryProvider conformance suite — green here proves the suite bakes in no
 * assumptions about files, paths or markdown, so the same assertions must pass
 * against `@dorkos/memory` and against whatever backend comes next.
 *
 * Run three times to cover the capability matrix in both directions: a backend
 * that can search and consolidate, and one that can do neither (the shape the
 * builtin engine ships in, so its refusals are exercised here too rather than
 * only against the one implementation that has them).
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryCapExceededError,
  MemoryMatchError,
  MemoryUnsupportedError,
} from '@dorkos/shared/memory-provider';
import {
  FAKE_MEMORY_CAP_CHARS,
  FakeMemoryProvider,
  type FakeMemoryProviderOpts,
} from '../fake-memory-provider.js';
import { memoryConformance, type UnreadableMemory } from '../memory-conformance.js';

/** Mint scope ids nothing else in this file has used. */
let scopeCounter = 0;

/** A fresh, empty scope — the suite's one required hook. */
function makeRef(): { agentId: string; agentPath: string } {
  scopeCounter += 1;
  return { agentId: `fake-agent-${scopeCounter}`, agentPath: `/fake/agents/${scopeCounter}` };
}

/** Arrange an unreadable memory on a provider the caller keeps hold of. */
function makeUnreadableMemory(opts: FakeMemoryProviderOpts = {}): UnreadableMemory {
  const provider = new FakeMemoryProvider(opts);
  const ref = makeRef();
  provider.setUnreadable(ref.agentId);
  return { provider, ref };
}

// Both capabilities on — the shape a backend with real search would ship.
memoryConformance(() => new FakeMemoryProvider(), {
  name: 'FakeMemoryProvider (search + consolidate) — conformance',
  capChars: FAKE_MEMORY_CAP_CHARS,
  makeRef,
  makeUnreadableMemory: () => makeUnreadableMemory(),
});

// Both capabilities off — the builtin engine's shape, so the typed refusals are
// asserted against a second implementation of them.
memoryConformance(() => new FakeMemoryProvider({ search: false, consolidate: false }), {
  name: 'FakeMemoryProvider (no search, no consolidate) — conformance',
  capChars: FAKE_MEMORY_CAP_CHARS,
  makeRef,
  makeUnreadableMemory: () => makeUnreadableMemory({ search: false, consolidate: false }),
});

// A tighter cap, so the cap assertion is not silently pinned to one number, and
// no unreadable hook at all — the declined case must show up as a named skip.
memoryConformance(() => new FakeMemoryProvider({ capChars: 120 }), {
  name: 'FakeMemoryProvider (tight cap, no unreadable hook) — conformance',
  capChars: 120,
  makeRef,
});

describe('memoryConformance can fail — the properties a broken backend loses', () => {
  // The suite's own discrimination check, in the idiom of
  // `connector-conformance.test.ts`'s null-branch guard: each of these is a
  // property the suite gates, asserted here against a provider that violates it,
  // so "the suite passed" cannot mean "the suite asserted nothing".

  it('a capability declared off that answers anyway would fail the gate', async () => {
    const provider = new FakeMemoryProvider({ search: false });
    const ref = makeRef();
    await provider.write(ref, { action: 'add', text: 'anything' });
    // What the suite demands of an off capability, stated directly.
    await expect(provider.query(ref, { text: 'anything' })).rejects.toBeInstanceOf(
      MemoryUnsupportedError
    );
    // …and what it demands of an on one, so neither branch is vacuous.
    const searching = new FakeMemoryProvider({ search: true });
    const other = makeRef();
    await searching.write(other, { action: 'add', text: 'anything' });
    await expect(searching.query(other, { text: 'anything' })).resolves.toMatchObject({
      hits: [{ text: 'anything' }],
    });
  });

  it('a backend that let two refs share a store would fail the scope case', async () => {
    const provider = new FakeMemoryProvider();
    const alpha = makeRef();
    const beta = makeRef();
    await provider.write(alpha, { action: 'add', text: 'alpha only' });
    expect((await provider.getSnapshot(beta)).status).toBe('absent');
  });

  it('a backend that truncated instead of refusing would fail the cap case', async () => {
    const provider = new FakeMemoryProvider({ capChars: 50 });
    const ref = makeRef();
    await provider.write(ref, { action: 'add', text: 'small' });
    const before = (await provider.getSnapshot(ref)).content;
    await expect(
      provider.write(ref, { action: 'add', text: 'x'.repeat(51) })
    ).rejects.toBeInstanceOf(MemoryCapExceededError);
    expect((await provider.getSnapshot(ref)).content).toBe(before);
  });

  it('a backend that guessed at an ambiguous edit would fail the match case', async () => {
    const provider = new FakeMemoryProvider();
    const ref = makeRef();
    await provider.write(ref, { action: 'add', text: 'ship on Fridays once' });
    await provider.write(ref, { action: 'add', text: 'ship on Fridays twice' });
    await expect(
      provider.write(ref, { action: 'replace', oldText: 'ship on Fridays', text: 'x' })
    ).rejects.toBeInstanceOf(MemoryMatchError);
  });

  it('a backend that reported an unreadable memory as empty would fail the honesty case', async () => {
    const provider = new FakeMemoryProvider();
    const ref = makeRef();
    provider.setUnreadable(ref.agentId);
    const snapshot = await provider.getSnapshot(ref);
    expect(snapshot.status).toBe('error');
    expect(snapshot.status).not.toBe('absent');
  });
});
