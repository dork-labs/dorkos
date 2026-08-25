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
  type AgentMemoryRef,
  type MemoryHits,
  type MemorySelector,
  type MemorySnapshot,
  type MemoryWriteOp,
  type MemoryWriteResult,
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

/**
 * A backend that funnels every ref into one store — the scope violation.
 *
 * Every violator below is a real, complete `MemoryProvider` that breaks exactly
 * one of the suite's promises, so the checks in the next describe block have
 * something that genuinely fails to run against. An earlier version of that
 * block asserted the same properties against a HEALTHY fake, which proved only
 * that the fake was healthy — it could not have caught a suite that asserted
 * nothing.
 */
class LeakyFake extends FakeMemoryProvider {
  /** Flatten any ref onto one shared scope. */
  private static flat(ref: AgentMemoryRef): AgentMemoryRef {
    return { ...ref, agentId: 'every-agent-shares-this' };
  }

  override getSnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot> {
    return super.getSnapshot(LeakyFake.flat(ref));
  }

  override write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
    return super.write(LeakyFake.flat(ref), op);
  }

  override forget(ref: AgentMemoryRef, selector: MemorySelector): Promise<void> {
    return super.forget(LeakyFake.flat(ref), selector);
  }
}

/** A backend that declares `search: false` and then answers anyway — the silent no-op. */
class SilentSearchFake extends FakeMemoryProvider {
  /** Build a fake whose declared capability and behavior disagree. */
  constructor() {
    super({ search: false });
  }

  override query(_ref: AgentMemoryRef, _query: { text: string }): Promise<MemoryHits> {
    // "Nothing found" and "I cannot search" are the same sentence to a model.
    // This is the failure `MemoryUnsupportedError` exists to keep apart.
    return Promise.resolve({ hits: [] });
  }
}

/** A backend that trims a write to fit instead of refusing it — the silent truncation. */
class TruncatingFake extends FakeMemoryProvider {
  override async write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
    try {
      return await super.write(ref, op);
    } catch (err) {
      if (!(err instanceof MemoryCapExceededError)) throw err;
      const kept = (await this.getSnapshot(ref)).content;
      const trimmed = `${kept}${'action' in op && 'text' in op ? op.text : ''}`.slice(
        0,
        err.maxChars
      );
      this.seed(ref.agentId, trimmed);
      return { created: false, chars: trimmed.length, bytes: Buffer.byteLength(trimmed, 'utf8') };
    }
  }
}

/** A backend that picks the first match when the caller named two — the guess. */
class GuessingFake extends FakeMemoryProvider {
  override async write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
    try {
      return await super.write(ref, op);
    } catch (err) {
      if (!(err instanceof MemoryMatchError) || err.kind !== 'ambiguous') throw err;
      const current = (await this.getSnapshot(ref)).content;
      const guessed = current.replace(op.action === 'replace' ? op.oldText : '', '');
      this.seed(ref.agentId, guessed);
      return { created: false, chars: guessed.length, bytes: Buffer.byteLength(guessed, 'utf8') };
    }
  }
}

/** A backend that reports an unreadable memory as an empty one — the amnesia. */
class AmnesiacFake extends FakeMemoryProvider {
  override async getSnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot> {
    const snapshot = await super.getSnapshot(ref);
    if (snapshot.status !== 'error') return snapshot;
    return { status: 'absent', content: '', bytes: 0, truncated: false };
  }
}

/**
 * Assert that a check the suite makes FAILS against this backend.
 *
 * The check passed in is the suite's own assertion, copied from
 * `memory-conformance.ts`. Running it against a violator and demanding that it
 * throws is what "the suite reds against this backend" means mechanically — so
 * a suite that stopped asserting the property would fail HERE, in the file whose
 * job is to notice.
 *
 * @param check - The suite's assertion, applied to the violating backend.
 * @param hint - What the suite promises, for the failure message.
 */
async function expectSuiteCaseToRed(check: () => Promise<void>, hint: string): Promise<void> {
  await expect(check(), `the suite no longer asserts: ${hint}`).rejects.toThrowError();
}

describe('memoryConformance can fail — its own cases, run against violators', () => {
  it('the capability gate reds against a backend that answers a capability it declared off', async () => {
    const provider = new SilentSearchFake();
    const ref = makeRef();
    await provider.write(ref, { action: 'add', text: 'anything' });

    await expectSuiteCaseToRed(async () => {
      await expect(provider.query(ref, { text: 'anything' })).rejects.toBeInstanceOf(
        MemoryUnsupportedError
      );
    }, 'a capability that is off refuses with the typed error');
  });

  it('the scope case reds against a backend that funnels every ref into one store', async () => {
    const provider = new LeakyFake();
    const alpha = makeRef();
    const beta = makeRef();
    await provider.write(alpha, { action: 'add', text: 'alpha only' });

    await expectSuiteCaseToRed(async () => {
      expect((await provider.getSnapshot(beta)).status).toBe('absent');
    }, 'two refs never read each other');
  });

  it('the cap case reds against a backend that truncates instead of refusing', async () => {
    const provider = new TruncatingFake({ capChars: 50 });
    const ref = makeRef();
    await provider.write(ref, { action: 'add', text: 'small' });

    await expectSuiteCaseToRed(async () => {
      await expect(
        provider.write(ref, { action: 'add', text: 'x'.repeat(51) })
      ).rejects.toBeInstanceOf(MemoryCapExceededError);
    }, 'a write past the cap is refused, never trimmed to fit');
  });

  it('the match case reds against a backend that guesses at an ambiguous edit', async () => {
    const provider = new GuessingFake();
    const ref = makeRef();
    await provider.write(ref, { action: 'add', text: 'ship on Fridays once' });
    await provider.write(ref, { action: 'add', text: 'ship on Fridays twice' });

    await expectSuiteCaseToRed(async () => {
      await expect(
        provider.write(ref, { action: 'replace', oldText: 'ship on Fridays', text: 'x' })
      ).rejects.toMatchObject({ name: 'MemoryMatchError', kind: 'ambiguous' });
    }, 'text that matches twice is refused rather than guessed at');
  });

  it('the honesty case reds against a backend that reports an unreadable memory as empty', async () => {
    const provider = new AmnesiacFake();
    const ref = makeRef();
    provider.setUnreadable(ref.agentId);

    await expectSuiteCaseToRed(async () => {
      expect((await provider.getSnapshot(ref)).status).toBe('error');
    }, "a failed read reports 'error', never 'absent'");
  });
});
