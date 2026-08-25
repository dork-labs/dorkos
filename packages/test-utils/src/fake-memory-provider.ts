/**
 * In-memory {@link MemoryProvider} for tests — the memory analogue of
 * {@link ./fake-connector-provider.js | FakeConnectorProvider} and
 * {@link ./fake-agent-runtime.js | FakeAgentRuntime}. Backs the
 * `memoryConformance` suite and stands in wherever a server test needs a memory
 * backend it can drive, with no filesystem and no persistence.
 *
 * **It is a second implementation, not a wrapper.** It shares no code with
 * `@dorkos/memory` — not the matcher, not the cap check, not the snapshot
 * shaping — which is the whole reason it is worth having: a suite that passes
 * against both is testing the contract, and a suite that passes only against the
 * engine is testing the engine twice. It also declares BOTH capabilities `true`
 * when asked, so the branches the builtin provider can never reach (`query`
 * answering, `consolidate` running) are exercised somewhere.
 *
 * @module test-utils/fake-memory-provider
 */
import {
  MemoryCapExceededError,
  MemoryIOError,
  MemoryMatchError,
  MemoryNoteShapeError,
  MemorySnapshotSchema,
  MemoryUnsupportedError,
  type AgentMemoryRef,
  type MemoryHit,
  type MemoryHits,
  type MemoryProvider,
  type MemoryProviderInfo,
  type MemoryQuery,
  type MemorySelector,
  type MemorySnapshot,
  type MemoryWriteOp,
  type MemoryWriteResult,
} from '@dorkos/shared/memory-provider';

/** Construction options for {@link FakeMemoryProvider}. */
export interface FakeMemoryProviderOpts {
  /** Provider id echoed on `info` and into every refusal. Defaults to `'fake-memory'`. */
  id?: string;
  /** Whether {@link FakeMemoryProvider.query} answers or refuses. Defaults to `true`. */
  search?: boolean;
  /** Whether {@link FakeMemoryProvider.consolidate} runs or refuses. Defaults to `true`. */
  consolidate?: boolean;
  /**
   * How many characters one agent's memory may hold. Small by default so a cap
   * case is a short string rather than a page of filler.
   */
  capChars?: number;
}

/** How many characters this fake keeps per agent unless told otherwise. */
export const FAKE_MEMORY_CAP_CHARS = 400;

/** How many near matches a refusal offers, matching the engine's own generosity. */
const NEAR_MATCH_LIMIT = 3;

/** Every character that ends a line for a reader — the note-shape rule's alphabet. */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

/**
 * A full in-memory {@link MemoryProvider} for Vitest tests.
 *
 * State is a plain `Map` keyed by `ref.agentId`, so two refs are two memories
 * and there is no way for one to read the other — the scope rule the port is
 * built on, held by construction rather than by care.
 *
 * @example
 * ```typescript
 * memoryConformance(() => new FakeMemoryProvider(), {
 *   capChars: FAKE_MEMORY_CAP_CHARS,
 *   makeRef: () => ({ agentId: `agent-${n++}`, agentPath: `/fake/agent-${n}` }),
 * });
 * ```
 */
export class FakeMemoryProvider implements MemoryProvider {
  readonly info: MemoryProviderInfo;

  private readonly _capChars: number;
  private readonly _memories = new Map<string, string>();
  private readonly _unreadable = new Set<string>();

  /**
   * Construct a fake provider with the given capability configuration.
   *
   * @param opts - Capability configuration; see {@link FakeMemoryProviderOpts}.
   */
  constructor(opts: FakeMemoryProviderOpts = {}) {
    this.info = {
      id: opts.id ?? 'fake-memory',
      capabilities: {
        search: opts.search ?? true,
        consolidate: opts.consolidate ?? true,
      },
    };
    this._capChars = opts.capChars ?? FAKE_MEMORY_CAP_CHARS;
  }

  getSnapshot(ref: AgentMemoryRef): Promise<MemorySnapshot> {
    // Never throws, for either of the two states a caller must render rather
    // than abort on. An unreadable memory is reported, not raised.
    if (this._unreadable.has(ref.agentId)) {
      return Promise.resolve(
        MemorySnapshotSchema.parse({
          status: 'error',
          content: '',
          bytes: 0,
          truncated: false,
          error: `fake backend cannot read memory for '${ref.agentId}'`,
        })
      );
    }

    const stored = this._memories.get(ref.agentId);
    if (stored === undefined || stored.trim() === '') {
      return Promise.resolve(
        MemorySnapshotSchema.parse({ status: 'absent', content: '', bytes: 0, truncated: false })
      );
    }

    const truncated = stored.length > this._capChars;
    return Promise.resolve(
      MemorySnapshotSchema.parse({
        status: 'present',
        content: truncated ? stored.slice(0, this._capChars) : stored,
        bytes: Buffer.byteLength(stored, 'utf8'),
        truncated,
        ...(truncated
          ? { warning: 'This memory is bigger than the limit, so only the first part is shown.' }
          : {}),
      })
    );
  }

  write(ref: AgentMemoryRef, op: MemoryWriteOp): Promise<MemoryWriteResult> {
    if (this._unreadable.has(ref.agentId)) {
      return Promise.reject(new MemoryIOError('write', new Error('fake backend is unreadable')));
    }
    if ((op.action === 'add' || op.action === 'replace') && LINE_BREAK.test(op.text)) {
      return Promise.reject(new MemoryNoteShapeError(op.action));
    }

    const before = this._memories.get(ref.agentId);
    const created = before === undefined;
    const current = before ?? '';

    let after: string;
    try {
      after = this._apply(current, op);
    } catch (err) {
      return Promise.reject(err);
    }

    // Checked before anything is stored: a refused write leaves memory exactly
    // as it was, which is what makes every refusal on this port a refusal rather
    // than a partial write.
    if (after.length > this._capChars && after.length > current.length) {
      return Promise.reject(
        new MemoryCapExceededError(current.length, after.length, this._capChars)
      );
    }

    this._memories.set(ref.agentId, after);
    return Promise.resolve({
      created,
      chars: after.length,
      bytes: Buffer.byteLength(after, 'utf8'),
    });
  }

  query(ref: AgentMemoryRef, query: MemoryQuery): Promise<MemoryHits> {
    if (!this.info.capabilities.search) {
      return Promise.reject(
        new MemoryUnsupportedError(this.info.id, 'search', 'query', 'this fake has search off')
      );
    }
    const needle = query.text.toLowerCase();
    const hits: MemoryHit[] = this._notes(ref)
      .filter((line) => line.toLowerCase().includes(needle))
      .slice(0, query.limit ?? Number.MAX_SAFE_INTEGER)
      .map((line) => {
        const match = /\s(\(noted in .+?\))$/.exec(line);
        return {
          text: match ? line.slice(0, line.length - match[0].length) : line,
          provenance: match ? match[1]! : null,
        };
      });
    return Promise.resolve({ hits });
  }

  forget(ref: AgentMemoryRef, selector: MemorySelector): Promise<void> {
    return this.write(ref, { action: 'remove', oldText: selector.text }).then(() => undefined);
  }

  consolidate(ref: AgentMemoryRef): Promise<void> {
    if (!this.info.capabilities.consolidate) {
      return Promise.reject(
        new MemoryUnsupportedError(
          this.info.id,
          'consolidate',
          'consolidate',
          'this fake has consolidate off'
        )
      );
    }
    // Deduplicate, which is the smallest honest thing "rewrite this into a
    // shorter equivalent" can mean. It must leave the memory readable, which is
    // the property the suite checks.
    const unique = [...new Set(this._notes(ref))];
    if (unique.length > 0) this._memories.set(ref.agentId, `${unique.join('\n')}\n`);
    return Promise.resolve();
  }

  /**
   * Force a memory into the unreadable state — the test hook that drives
   * `getSnapshot`'s `'error'` branch and `write`'s {@link MemoryIOError}.
   *
   * @param agentId - Whose memory becomes unreadable.
   */
  setUnreadable(agentId: string): void {
    this._unreadable.add(agentId);
  }

  /**
   * Put content into a memory directly, past the cap check.
   *
   * The only way to reach the truncated-snapshot branch, exactly as editing the
   * file on disk is the only way to reach it on the builtin provider.
   *
   * @param agentId - Whose memory to seed.
   * @param content - What it holds.
   */
  seed(agentId: string, content: string): void {
    this._memories.set(agentId, content);
  }

  /** The notes currently held for a ref, one per line, blank lines dropped. */
  private _notes(ref: AgentMemoryRef): string[] {
    return (this._memories.get(ref.agentId) ?? '').split('\n').filter((line) => line.trim() !== '');
  }

  /**
   * Apply one op to a memory's text.
   *
   * @param content - The memory as it stands.
   * @param op - The change.
   */
  private _apply(content: string, op: MemoryWriteOp): string {
    if (op.action === 'add') {
      const suffix = op.provenance
        ? ` (noted in ${op.provenance.room ?? 'a direct chat'}, ${op.provenance.date})`
        : '';
      return `${content}${op.text}${suffix}\n`;
    }

    const at = this._locate(content, op.oldText);
    if (op.action === 'replace') {
      return content.slice(0, at) + op.text + content.slice(at + op.oldText.length);
    }
    // `remove` takes the whole line the match sits on, so forgetting a note does
    // not leave the shell of one behind.
    const start = content.lastIndexOf('\n', at) + 1;
    const lineEnd = content.indexOf('\n', at + op.oldText.length);
    const end = lineEnd === -1 ? content.length : lineEnd + 1;
    return content.slice(0, start) + content.slice(end);
  }

  /**
   * Find the one place `needle` names, or refuse.
   *
   * @param content - The memory as it stands.
   * @param needle - The text the caller quoted.
   * @throws {MemoryMatchError} When it matches twice or not at all.
   */
  private _locate(content: string, needle: string): number {
    const first = content.indexOf(needle);
    if (first === -1) {
      throw new MemoryMatchError('not-found', needle, this._near(content));
    }
    if (content.indexOf(needle, first + 1) !== -1) {
      throw new MemoryMatchError('ambiguous', needle, this._near(content));
    }
    return first;
  }

  /** A few lines to offer back with a refusal, so a caller can quote better. */
  private _near(content: string): string[] {
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, NEAR_MATCH_LIMIT);
  }
}
