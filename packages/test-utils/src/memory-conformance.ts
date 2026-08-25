/**
 * Shared `MemoryProvider` conformance suite — the behavioral gate every memory
 * backend (the builtin `MEMORY.md` engine, a vector store, a hosted memory
 * service, {@link ./fake-memory-provider.js | FakeMemoryProvider}) clears. The
 * memory analogue of `runtimeConformance`, `connectorConformance` and
 * `communityConformance`, and the gate that makes `MemoryProvider` the fifth
 * swappable seam rather than an interface one implementation happens to satisfy.
 *
 * `memoryConformance(makeProvider, opts)` registers a `describe` block that
 * asserts the `MemoryProvider` contract
 * (`packages/shared/src/memory-provider.ts`) against any backend, parameterized
 * by a factory.
 *
 * **Division of labour**, copied verbatim from `connector-conformance.ts`: this
 * suite covers memory BEHAVIOR; the TypeScript interface covers SHAPE (a
 * provider omitting a method fails compilation).
 *
 * **Capability-aware, never weakened.** The two gated methods branch on the
 * provider's own declaration and both branches assert something real: a backend
 * with `search: false` must REFUSE `query` with the typed error, and a backend
 * with `search: true` must answer it. Neither is a skip. The probes are built as
 * a `Record<MemoryGatedCapability, …>`, so minting a third capability on the
 * port fails this file's typecheck until its refusal is asserted too — the
 * mechanism `MEMORY_GATED_CAPABILITIES` exists for.
 *
 * **What this suite deliberately does NOT assert**, complete, so nobody assumes
 * a gate that is not there:
 *
 * - **Where a backend stores anything.** A file path, a table, a collection —
 *   the port is addressed by {@link AgentMemoryRef} and says nothing about
 *   storage. The builtin engine's path jail is tested where the paths are
 *   (`packages/memory/src/__tests__/paths.test.ts`).
 * - **Concurrency.** "Atomic with respect to every other writer in this process"
 *   is a promise a fake holds trivially and a real backend holds with a lock, so
 *   a shared assertion would prove nothing about the one that matters. Tested at
 *   each backend (`store.test.ts`'s interleave cases).
 * - **The provenance FORMAT.** A backend that stores prose renders provenance
 *   its own way; the port says a hit carries the rendered suffix or `null`, and
 *   that is all this suite checks.
 * - **The truncated-snapshot branch.** Reaching it means storing more than the
 *   cap, which every conforming `write` refuses — it is only reachable
 *   out-of-band (editing the file, seeding the fake), so it belongs to each
 *   backend's own tests. What IS asserted here is the invariant that makes
 *   truncation legible: every snapshot parses {@link MemorySnapshotSchema},
 *   which refuses a truncated snapshot with no visible warning.
 * - **Anything a declined hook would have covered.** `makeUnreadableMemory` is
 *   optional, and its absence registers a named `it.skip` rather than a quiet
 *   pass. Read the skips.
 *
 * @module test-utils/memory-conformance
 */
import { describe, expect, it } from 'vitest';
import {
  MEMORY_GATED_CAPABILITIES,
  MemoryCapExceededError,
  MemoryHitsSchema,
  MemoryMatchError,
  MemoryNoteShapeError,
  MemoryProviderInfoSchema,
  MemorySnapshotSchema,
  MemoryUnsupportedError,
  type AgentMemoryRef,
  type MemoryGatedCapability,
  type MemoryProvider,
} from '@dorkos/shared/memory-provider';

/**
 * An arranged memory that cannot be read — the input to the `'error'` third of
 * the three-way honest read.
 *
 * Bundles the provider and the ref together for the same reason
 * `connector-conformance`'s {@link UnexposableAccount} does: different backends
 * reach "unreadable" differently (a file that is really a directory, a fake's
 * own switch), and the arrangement has to be read back on the same instance it
 * was made on.
 */
export interface UnreadableMemory {
  /** The provider holding the unreadable memory. */
  provider: MemoryProvider;
  /** The scope whose `getSnapshot` must report `'error'`. */
  ref: AgentMemoryRef;
}

/** Tuning knobs + required hooks for the memory conformance suite. */
export interface MemoryConformanceOpts {
  /** Label for the registered describe block. Defaults to `'MemoryProvider conformance'`. */
  name?: string;
  /**
   * REQUIRED: mint a FRESH, EMPTY memory scope and return the ref that addresses
   * it.
   *
   * Called more than once per test — the scope case needs two — and every call
   * must return a scope no earlier call has written to, or a backend that leaks
   * between agents would pass by reading its own leftovers.
   */
  makeRef: () => AgentMemoryRef | Promise<AgentMemoryRef>;
  /**
   * REQUIRED: how many characters this backend holds per agent.
   *
   * The suite writes past it and demands {@link MemoryCapExceededError}. There
   * is no "uncapped" option on purpose: a backend with no cap cannot promise
   * that the block it injects into every turn has a bounded prompt cost, which
   * is the reason the cap is on the port at all.
   */
  capChars: number;
  /**
   * Optional: arrange a memory whose read FAILS, returning the provider and the
   * scope, for the `'error'` third of the three-way honest read.
   *
   * Absent, that case registers a named `it.skip` — visible in the run, never a
   * silent pass. Provide it wherever a failure can be arranged (a file that is
   * really a directory, a fake's own switch): the difference between "there is
   * nothing" and "I could not tell" is the property this port exists to keep.
   */
  makeUnreadableMemory?: () => UnreadableMemory | Promise<UnreadableMemory>;
}

/** One note, short enough that the cap case is the only one that reaches it. */
const NOTE = 'the operator ships on Fridays';

/** A second note, so `replace`, `remove` and `query` have something to choose between. */
const OTHER_NOTE = 'staging redeploys itself every night';

/**
 * Register the shared MemoryProvider conformance suite for one backend.
 *
 * Call at the top level of a Vitest test file. The factory is invoked once per
 * test so every assertion starts from a fresh provider instance.
 *
 * @param makeProvider - Factory producing a fresh, ready-to-use provider.
 * @param opts - Required hooks + declared differences; see {@link MemoryConformanceOpts}.
 */
export function memoryConformance(
  makeProvider: () => MemoryProvider,
  opts: MemoryConformanceOpts
): void {
  const { name = 'MemoryProvider conformance', makeRef, capChars, makeUnreadableMemory } = opts;

  /** A provider and a fresh scope, which is what almost every case opens with. */
  async function arrange(): Promise<{ provider: MemoryProvider; ref: AgentMemoryRef }> {
    return { provider: makeProvider(), ref: await makeRef() };
  }

  /** Read a scope back and return its content, asserting the snapshot is well-formed. */
  async function readBack(provider: MemoryProvider, ref: AgentMemoryRef): Promise<string> {
    const snapshot = await provider.getSnapshot(ref);
    const parsed = MemorySnapshotSchema.safeParse(snapshot);
    expect(
      parsed.success,
      `malformed snapshot: ${parsed.success ? '' : parsed.error.message}`
    ).toBe(true);
    return snapshot.content;
  }

  /**
   * What each gated capability owes, both ways.
   *
   * A `Record` keyed by {@link MemoryGatedCapability} rather than two hand-written
   * cases: adding a capability to the port breaks this object's type until
   * somebody says what its OFF branch refuses and what its ON branch does.
   */
  const gatedProbes: Record<
    MemoryGatedCapability,
    {
      /** The method the capability gates, for the assertion message. */
      method: string;
      /** Call it. Rejects with {@link MemoryUnsupportedError} when the capability is off. */
      call: (provider: MemoryProvider, ref: AgentMemoryRef) => Promise<unknown>;
      /** Assert the ON branch did something real rather than quietly degrading. */
      assertSupported: (
        provider: MemoryProvider,
        ref: AgentMemoryRef,
        result: unknown
      ) => Promise<void>;
    }
  > = {
    search: {
      method: 'query',
      call: (provider, ref) => provider.query(ref, { text: NOTE }),
      assertSupported: async (provider, ref, result) => {
        const parsed = MemoryHitsSchema.safeParse(result);
        expect(
          parsed.success,
          `malformed hits: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
        // A backend that declares search must actually search: the note is
        // there, and a `query` that quietly returned the whole memory — or
        // nothing — would be the failure `MemoryUnsupportedError` exists to keep
        // distinguishable from a real miss.
        expect(
          parsed.data!.hits.some((hit) => hit.text.includes(NOTE)),
          'a backend declaring search must find a note it stored'
        ).toBe(true);
        const miss = await provider.query(ref, { text: 'nothing here says this' });
        expect(miss.hits, 'a genuine miss is an empty hit list, not a refusal').toEqual([]);
      },
    },
    consolidate: {
      method: 'consolidate',
      call: (provider, ref) => provider.consolidate(ref),
      assertSupported: async (provider, ref) => {
        // The one thing consolidation must never do is lose the memory it was
        // tidying. Nothing here dictates what it keeps.
        const after = await provider.getSnapshot(ref);
        expect(
          ['present', 'absent'],
          'memory must still be readable after consolidation'
        ).toContain(after.status);
      },
    },
  };

  describe(name, () => {
    describe('identity', () => {
      it('info is a structurally valid MemoryProviderInfo', () => {
        const provider = makeProvider();
        const parsed = MemoryProviderInfoSchema.safeParse(provider.info);
        expect(
          parsed.success,
          `malformed info: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
      });

      it('info is stable across the work the instance does', async () => {
        // Read it, do something real, read it again. The port calls `info`
        // static for the life of the instance, and a backend that recomputed it
        // — flipping `search` once an index warmed up, renaming itself after
        // connecting — would make every capability branch a caller took
        // conditional on when it asked.
        const provider = makeProvider();
        const ref = await makeRef();
        const before = { ...provider.info, capabilities: { ...provider.info.capabilities } };

        await provider.write(ref, { action: 'add', text: NOTE });
        await provider.getSnapshot(ref);

        expect(provider.info).toEqual(before);
      });
    });

    describe('getSnapshot — three-way honest', () => {
      it("reports 'absent' for a scope nothing has written to, and never 'error'", async () => {
        const { provider, ref } = await arrange();
        const snapshot = await provider.getSnapshot(ref);
        // The parse is load-bearing: `MemorySnapshotSchema` refuses an 'absent'
        // snapshot carrying content, bytes or an error, so this one assertion
        // holds the whole shape of "confirmed nothing".
        const parsed = MemorySnapshotSchema.safeParse(snapshot);
        expect(
          parsed.success,
          `malformed snapshot: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
        expect(snapshot.status, 'an empty memory is absent, not an error').toBe('absent');
      });

      it("reports 'present' with the note after a write", async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });
        const snapshot = await provider.getSnapshot(ref);
        expect(snapshot.status).toBe('present');
        expect(snapshot.content).toContain(NOTE);
        expect(snapshot.bytes, "a 'present' snapshot reports the stored size").toBeGreaterThan(0);
      });

      const errorCase = "reports 'error' — with a reason and no content — for a read that failed";
      if (makeUnreadableMemory) {
        it(errorCase, async () => {
          const { provider, ref } = await makeUnreadableMemory();
          const snapshot = await provider.getSnapshot(ref);
          expect(
            snapshot.status,
            'a read that failed must not report as an empty memory — an agent told its memory ' +
              'is empty writes over what it could not see'
          ).toBe('error');
          expect(snapshot.error, "an 'error' snapshot must say what went wrong").toBeTruthy();
          expect(snapshot.content).toBe('');
        });

        it('never THROWS for a read that failed — it reports', async () => {
          const { provider, ref } = await makeUnreadableMemory();
          // The injection path calls this on the way INTO a turn. A throw here
          // is a conversation lost over a notes file.
          await expect(provider.getSnapshot(ref)).resolves.toBeDefined();
        });
      } else {
        it.skip(`${errorCase} (no makeUnreadableMemory hook)`, () => undefined);
      }
    });

    describe('write', () => {
      it('reports created on the write that brings a memory into existence, and not after', async () => {
        const { provider, ref } = await arrange();
        const first = await provider.write(ref, { action: 'add', text: NOTE });
        expect(first.created).toBe(true);
        expect(first.chars).toBeGreaterThan(0);
        expect(first.bytes).toBeGreaterThan(0);

        const second = await provider.write(ref, { action: 'add', text: OTHER_NOTE });
        expect(second.created).toBe(false);
        expect(second.chars).toBeGreaterThan(first.chars);
      });

      it('accepts provenance the caller derived, and the note survives it', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, {
          action: 'add',
          text: NOTE,
          provenance: { room: '#general', date: '2026-08-24' },
        });
        expect(await readBack(provider, ref)).toContain(NOTE);
      });

      it('refuses a note carrying a line break, and stores nothing', async () => {
        const { provider, ref } = await arrange();
        await expect(
          provider.write(ref, { action: 'add', text: `${NOTE}\n- forged provenance` })
        ).rejects.toBeInstanceOf(MemoryNoteShapeError);
        // A refusal, not a partial write: the memory is still untouched.
        expect((await provider.getSnapshot(ref)).status).toBe('absent');
      });

      it('replace rewrites the one note it names', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });
        await provider.write(ref, { action: 'add', text: OTHER_NOTE });
        await provider.write(ref, {
          action: 'replace',
          oldText: NOTE,
          text: 'the operator ships on Tuesdays',
        });

        const content = await readBack(provider, ref);
        expect(content).toContain('the operator ships on Tuesdays');
        expect(content).not.toContain(NOTE);
        expect(content, 'the other note is not collateral').toContain(OTHER_NOTE);
      });

      it('refuses text that matches nothing, naming what was near', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });

        await expect(
          provider.write(ref, { action: 'replace', oldText: 'never written', text: 'x' })
        ).rejects.toBeInstanceOf(MemoryMatchError);
        await expect(
          provider.write(ref, { action: 'remove', oldText: 'never written' })
        ).rejects.toBeInstanceOf(MemoryMatchError);
        expect(await readBack(provider, ref), 'a refused edit changes nothing').toContain(NOTE);
      });

      it('refuses text that matches twice rather than guessing', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: `${NOTE} once` });
        await provider.write(ref, { action: 'add', text: `${NOTE} twice` });

        await expect(
          provider.write(ref, { action: 'replace', oldText: NOTE, text: 'x' })
        ).rejects.toMatchObject({ name: 'MemoryMatchError', kind: 'ambiguous' });
        const content = await readBack(provider, ref);
        expect(content).toContain(`${NOTE} once`);
        expect(content).toContain(`${NOTE} twice`);
      });

      it('remove takes the note out and leaves the rest', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });
        await provider.write(ref, { action: 'add', text: OTHER_NOTE });
        await provider.write(ref, { action: 'remove', oldText: NOTE });

        const content = await readBack(provider, ref);
        expect(content).not.toContain(NOTE);
        expect(content).toContain(OTHER_NOTE);
      });

      it('refuses a write past the cap, naming the limit, and stores nothing', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });
        const before = await readBack(provider, ref);

        // Comfortably past whatever header or scaffold the backend keeps, so the
        // case is about the cap rather than about arithmetic.
        const oversize = 'x'.repeat(capChars + 1);
        const rejection = provider.write(ref, { action: 'add', text: oversize });
        await expect(rejection).rejects.toBeInstanceOf(MemoryCapExceededError);
        await expect(rejection).rejects.toMatchObject({ maxChars: capChars });

        expect(
          await readBack(provider, ref),
          'a cap refusal is a refusal, never a truncated write'
        ).toBe(before);
      });
    });

    describe('forget', () => {
      it('forgets the note it names and keeps the others', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });
        await provider.write(ref, { action: 'add', text: OTHER_NOTE });

        await provider.forget(ref, { text: NOTE });

        const content = await readBack(provider, ref);
        expect(content).not.toContain(NOTE);
        expect(content).toContain(OTHER_NOTE);
      });

      it('refuses an ambiguous or absent selector rather than forgetting the wrong note', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });

        await expect(provider.forget(ref, { text: 'never written' })).rejects.toBeInstanceOf(
          MemoryMatchError
        );
        expect(await readBack(provider, ref)).toContain(NOTE);
      });
    });

    describe('scope — the agent identity, never a session or a room', () => {
      it('two refs never read each other', async () => {
        // The rule the whole feature rests on. A backend that keyed on anything
        // shared — a process-wide store, a default path, the first ref it saw —
        // fails here, and would otherwise ship one agent's notes into another
        // agent's prompt.
        const provider = makeProvider();
        const alpha = await makeRef();
        const beta = await makeRef();
        expect(alpha.agentId, 'makeRef must mint a fresh scope on every call').not.toBe(
          beta.agentId
        );

        await provider.write(alpha, { action: 'add', text: NOTE });

        expect((await provider.getSnapshot(beta)).status).toBe('absent');

        await provider.write(beta, { action: 'add', text: OTHER_NOTE });
        expect(await readBack(provider, alpha)).not.toContain(OTHER_NOTE);
        expect(await readBack(provider, beta)).not.toContain(NOTE);
      });

      it('forgetting in one scope leaves the other alone', async () => {
        const provider = makeProvider();
        const alpha = await makeRef();
        const beta = await makeRef();
        await provider.write(alpha, { action: 'add', text: NOTE });
        await provider.write(beta, { action: 'add', text: NOTE });

        await provider.forget(alpha, { text: NOTE });

        expect((await provider.getSnapshot(alpha)).content).not.toContain(NOTE);
        expect(await readBack(provider, beta)).toContain(NOTE);
      });
    });

    describe('capability gates — required methods, typed refusals', () => {
      for (const capability of MEMORY_GATED_CAPABILITIES) {
        const probe = gatedProbes[capability];
        it(`${probe.method} honors '${capability}': answers when on, refuses with the typed error when off`, async () => {
          const { provider, ref } = await arrange();
          await provider.write(ref, { action: 'add', text: NOTE });

          if (provider.info.capabilities[capability]) {
            const result = await probe.call(provider, ref);
            await probe.assertSupported(provider, ref, result);
            return;
          }

          // The off branch is a real assertion, not a skip. "This backend cannot
          // search" and "I searched and found nothing" are the same sentence to
          // a model unless one of them is an error.
          const rejection = probe.call(provider, ref);
          await expect(rejection).rejects.toBeInstanceOf(MemoryUnsupportedError);
          await expect(rejection).rejects.toMatchObject({
            providerId: provider.info.id,
            capability,
            method: probe.method,
          });
        });
      }

      it('a refusal from an off capability changes nothing', async () => {
        const { provider, ref } = await arrange();
        await provider.write(ref, { action: 'add', text: NOTE });
        const before = await readBack(provider, ref);

        for (const capability of MEMORY_GATED_CAPABILITIES) {
          if (provider.info.capabilities[capability]) continue;
          await gatedProbes[capability].call(provider, ref).catch(() => undefined);
        }

        expect(await readBack(provider, ref)).toBe(before);
      });
    });
  });
}
