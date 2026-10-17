/**
 * One doc while somebody has it open (DOR-2984).
 *
 * The server holds the doc's `Y.Doc` from the first editor's arrival until a
 * short while after the last one leaves. Editors sync with it directly
 * (`doc-sync.ts`); everything that turns markdown into Yjs or back goes to the
 * markdown worker. The file on disk follows the doc through debounced flushes
 * written by the installation's one canonical file writer, so a flush never
 * races another DorkOS write to the same file.
 *
 * **The file base.** `#fileBase` is the doc state the file on disk reflects:
 * the state it was loaded from, or the state the last flush wrote. A change
 * to the file DorkOS did not make (an agent's own Write tool, say) is merged
 * with that state as its base, so only what the writer changed lands, and
 * whatever the people editing typed since stays. An agent that never read the
 * doc through DorkOS is treated the same way: its markdown is an edit of the
 * file as it is on disk.
 *
 * File work (flushes, merges, restores) runs one at a time per doc. Editors'
 * typing never waits for it.
 *
 * @module services/docs/collab/live-doc
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import * as Y from 'yjs';
import type { DocCollabNote, DocWriter } from '@dorkos/shared/doc-collab';
import { sha256 } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import { DocSyncHub, type DocPeer } from './doc-sync.js';
import type { MarkdownWorkerClient } from './markdown-worker-client.js';
import type { DocVersionStore } from './doc-versions.js';
import type { ResolvedDoc } from './resolve-doc.js';

/** The installation's file writer, as a live doc uses it (`InstallationFileWrites`). */
export interface DocFileWriter {
  /** Replace an existing file's content, when it still matches `expectedHash`. */
  save(input: {
    cwd: string;
    path: string;
    content: string;
    expectedHash?: string;
  }): Promise<
    | { status: 200; body: { hash: string } }
    | { status: 409; body: { currentHash: string; currentContent: string } }
  >;
}

/** What a live doc is built with. */
export interface LiveDocDeps {
  worker: MarkdownWorkerClient;
  writer: DocFileWriter;
  versions: DocVersionStore;
  /** How long typing may pause before the file is written. */
  flushDelayMs: number;
  /** The longest a change waits for the file while typing never pauses. */
  flushMaxWaitMs: number;
  /** Whether to watch the file for changes DorkOS did not make. */
  watch: boolean;
}

/** The transaction origin of the doc's first load: not an edit. */
const LOAD = Symbol('doc-load');

/** The transaction origin of a write from outside the editors. */
interface WriteOrigin {
  readonly kind: 'write';
  readonly writer: DocWriter;
}

/** The doc state the file on disk reflects; see the module doc. */
interface FileBase {
  state: Uint8Array;
  hash: string;
  content: string;
}

/** What a merged write hands back to its writer. */
export interface LiveDocWriteResult {
  /** The base for the same writer's next write. */
  base: Uint8Array;
  /** Whether the doc changed. */
  changed: boolean;
}

/** One open doc; see the module doc. */
export class LiveDoc {
  /** Which copy of the doc this is; a fresh load is a new generation. */
  readonly generation = randomUUID();
  readonly ref: ResolvedDoc;
  readonly #deps: LiveDocDeps;
  readonly #doc = new Y.Doc();
  readonly #hub: DocSyncHub;
  #fileBase: FileBase;
  /** The doc holds edits the file does not have yet. */
  #dirty = false;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #firstUnflushedAt: number | null = null;
  #ops: Promise<unknown> = Promise.resolve();
  #watcher: FSWatcher | null = null;
  #closed = false;

  private constructor(ref: ResolvedDoc, deps: LiveDocDeps, base: FileBase) {
    this.ref = ref;
    this.#deps = deps;
    this.#fileBase = base;
    Y.applyUpdate(this.#doc, base.state, LOAD);
    this.#hub = new DocSyncHub(this.#doc);
    this.#doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === LOAD) return;
      // A change on disk is already in the file; everything else is not.
      if ((origin as WriteOrigin | undefined)?.writer?.kind === 'disk') return;
      this.#markDirty();
    });
  }

  /**
   * Load a doc from its file and start serving it.
   *
   * @param ref - Which doc.
   * @param deps - The worker, the writer and the version store.
   */
  static async open(ref: ResolvedDoc, deps: LiveDocDeps): Promise<LiveDoc> {
    const content = await fs.readFile(ref.file, 'utf8');
    const state = await deps.worker.seed(content);
    const doc = new LiveDoc(ref, deps, { state, hash: sha256(content), content });
    if (deps.watch) doc.#watch();
    return doc;
  }

  /** How many editors are here. */
  get editors(): number {
    return this.#hub.size;
  }

  /** The hash of the file as this doc last read or wrote it. */
  get fileHash(): string {
    return this.#fileBase.hash;
  }

  /** The state the file on disk reflects, as a base for a writer who read the file. */
  get fileBaseState(): Uint8Array {
    return this.#fileBase.state;
  }

  /**
   * Add an editor.
   *
   * @param peer - Its connection.
   */
  join(peer: DocPeer): void {
    this.#hub.join(peer, { type: 'hello', generation: this.generation });
  }

  /**
   * Handle a frame from an editor.
   *
   * @param peer - Who sent it.
   * @param frame - What they sent.
   */
  receive(peer: DocPeer, frame: Uint8Array): void {
    this.#hub.receive(peer, frame);
  }

  /**
   * Remove an editor.
   *
   * @param peer - The editor leaving.
   */
  leave(peer: DocPeer): void {
    this.#hub.leave(peer);
  }

  /**
   * Tell every editor something.
   *
   * @param note - What to say.
   */
  notify(note: DocCollabNote): void {
    this.#hub.broadcast(note);
  }

  /** The doc's markdown now, and the state it was read from (an agent's base). */
  async read(): Promise<{ markdown: string; base: Uint8Array }> {
    const base = Y.encodeStateAsUpdate(this.#doc);
    return { markdown: await this.#deps.worker.serialize(base), base };
  }

  /**
   * Merge a writer's markdown into the doc, keeping the doc as it was first.
   *
   * @param markdown - What the writer wants the doc to say.
   * @param writer - Who is writing.
   * @param base - What the writer read. Omitted, the doc is made to equal
   *   `markdown` exactly (a restore).
   * @throws MarkdownWorkerError with code `BASE_MISMATCH` for a base from another copy.
   */
  write(markdown: string, writer: DocWriter, base?: Uint8Array): Promise<LiveDocWriteResult> {
    return this.#serial(() => this.#merge(markdown, writer, base));
  }

  /** Write any edits the file does not have yet. */
  flush(): Promise<void> {
    return this.#serial(() => this.#flushNow());
  }

  /** Write what is left, stop watching, and close every editor's connection. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#clearFlushTimer();
    await this.flush().catch((err) => {
      logger.warn('[docs] could not write a doc before closing it', { err });
    });
    this.#closed = true;
    await this.#watcher?.close();
    this.#watcher = null;
    this.#hub.close();
    this.#doc.destroy();
  }

  async #merge(
    markdown: string,
    writer: DocWriter,
    base?: Uint8Array
  ): Promise<LiveDocWriteResult> {
    const before = Y.encodeStateAsUpdate(this.#doc);
    const previous = await this.#deps.worker.serialize(before);
    const merged = await this.#deps.worker.merge(before, markdown, base);
    if (merged.markdown === previous) return { base: merged.base, changed: false };
    const kept = await this.#deps.versions.keep(this.ref.scope, previous, writer);
    const origin: WriteOrigin = { kind: 'write', writer };
    Y.applyUpdate(this.#doc, merged.update, origin);
    this.notify({ type: 'changed', changedBy: writer });
    if (kept) this.notify({ type: 'versions' });
    return { base: merged.base, changed: true };
  }

  /**
   * Merge bytes somebody else put in the file, with the file base as their base.
   *
   * @param content - What the file says now.
   */
  async #mergeDisk(content: string): Promise<void> {
    const hash = sha256(content);
    if (hash === this.#fileBase.hash) return;
    const fileBase = this.#fileBase;
    const before = Y.encodeStateAsUpdate(this.#doc);
    const previous = await this.#deps.worker.serialize(before);
    const merged = await this.#deps.worker.merge(before, content, fileBase.state);
    // The state the file now reflects: what it reflected, plus this writer's
    // change, and none of the edits only the editors have.
    const reflected = Y.mergeUpdates([fileBase.state, merged.update]);
    this.#fileBase = { state: reflected, hash, content };
    if (merged.markdown === previous) return;
    const writer: DocWriter = { kind: 'disk' };
    const kept = await this.#deps.versions.keep(this.ref.scope, previous, writer);
    Y.applyUpdate(this.#doc, merged.update, { kind: 'write', writer } satisfies WriteOrigin);
    // Only when the editors had unsaved edits does the merged doc differ from
    // the file; otherwise the file keeps the writer's exact bytes.
    if (merged.markdown !== (await this.#deps.worker.serialize(reflected))) this.#markDirty();
    this.notify({ type: 'changed', changedBy: writer });
    if (kept) this.notify({ type: 'versions' });
  }

  async #flushNow(): Promise<void> {
    this.#clearFlushTimer();
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#firstUnflushedAt = null;
    const state = Y.encodeStateAsUpdate(this.#doc);
    const markdown = await this.#deps.worker.serialize(state);
    const hash = sha256(markdown);
    if (hash === this.#fileBase.hash) {
      this.#fileBase = { state, hash, content: markdown };
      return;
    }
    let result: Awaited<ReturnType<DocFileWriter['save']>>;
    try {
      result = await this.#deps.writer.save({
        cwd: this.ref.space.root,
        path: this.ref.path,
        content: markdown,
        expectedHash: this.#fileBase.hash,
      });
    } catch (err) {
      // The file is gone or unwritable for now; keep the edits and try again later.
      this.#markDirty();
      logger.warn('[docs] could not write an open doc to its file', {
        err,
        key: this.ref.key,
      });
      return;
    }
    if (result.status === 200) {
      this.#fileBase = { state, hash, content: markdown };
      return;
    }
    // Somebody changed the file since this doc last read it: take their
    // change in first, then write the result.
    this.#markDirty();
    await this.#mergeDisk(result.body.currentContent);
  }

  #markDirty(): void {
    if (this.#closed) return;
    this.#dirty = true;
    this.#firstUnflushedAt ??= Date.now();
    this.#clearFlushTimer();
    const waited = Date.now() - this.#firstUnflushedAt;
    const delay = Math.max(
      0,
      Math.min(this.#deps.flushDelayMs, this.#deps.flushMaxWaitMs - waited)
    );
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.flush().catch((err) => logger.warn('[docs] doc flush failed', { err }));
    }, delay);
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }

  #watch(): void {
    const watcher = chokidar.watch(this.ref.file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });
    const check = () => {
      void this.#serial(async () => {
        if (this.#closed) return;
        const content = await fs.readFile(this.ref.file, 'utf8').catch(() => null);
        if (content !== null) await this.#mergeDisk(content);
      }).catch((err) => logger.warn('[docs] could not merge a change on disk', { err }));
    };
    watcher.on('change', check);
    watcher.on('add', check);
    this.#watcher = watcher;
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#ops.catch(() => undefined).then(work);
    this.#ops = next;
    return next;
  }
}
