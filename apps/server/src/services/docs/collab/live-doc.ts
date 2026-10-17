/**
 * One doc while somebody has it open (DOR-2984).
 *
 * The server holds the doc's `Y.Doc` from the first editor's arrival until a
 * short while after the last one leaves. Editors sync with it directly
 * (`doc-sync.ts`); everything that turns markdown into Yjs or back goes to the
 * markdown worker. The file on disk follows the doc through debounced saves
 * written by the installation's one canonical file writer, so a save never
 * races another DorkOS write to the same file.
 *
 * **Nothing an editor typed is dropped.** A save counts only once the file
 * has it: a save that fails (the worker timed out, the disk refused) leaves
 * the doc unsaved and is tried again with backoff, and closing the doc keeps
 * trying for a bounded while, then keeps the text as a version. Each save also
 * records the doc's Yjs state (`doc-states.ts`), so a doc reopened later, or
 * after the server stopped, is the same copy and an editor that reconnects
 * merges instead of starting over. An editor holding a different copy is told
 * which copy this is and closed before it can send anything.
 *
 * **The file base.** `#fileBase` is the doc state the file on disk reflects:
 * the state it was loaded from, or the state the last save wrote. A change to
 * the file DorkOS did not make (an agent's own Write tool, say) is merged with
 * that state as its base, so only what the writer changed lands, and whatever
 * the people editing typed since stays.
 *
 * File work (saves, merges, restores) runs one at a time per doc. Editors'
 * typing never waits for it.
 *
 * @module services/docs/collab/live-doc
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import * as Y from 'yjs';
import type { DocCollabNote, DocWriter } from '@dorkos/shared/doc-collab';
import { sha256 } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import { watchDocFile, type DocFileWatch } from './doc-file-watch.js';
import { DocSyncHub, noteFrame, type DocPeer } from './doc-sync.js';
import type { DocStateStore } from './doc-states.js';
import type { DocVersionStore } from './doc-versions.js';
import type { MarkdownWorkerClient } from './markdown-worker-client.js';
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
  states: DocStateStore;
  /** How long typing may pause before the file is written. */
  flushDelayMs: number;
  /** The longest a change waits for the file while typing never pauses. */
  flushMaxWaitMs: number;
  /** First delay before a failed save is tried again; it doubles to 30 s. */
  retryBaseMs: number;
  /** Whether to watch the file for changes DorkOS did not make. */
  watch: boolean;
  /** The most editors one doc takes at once. */
  maxEditors: number;
  /** How soon after a change the whole doc is saved to the data folder (not the file). */
  persistDelayMs: number;
}

/** How an editor's arrival went. */
export type LiveDocJoin = 'joined' | 'stale' | 'full' | 'closing';

/** The longest wait between attempts to save a doc that keeps failing. */
const MAX_RETRY_MS = 30_000;

/** How many times closing a doc tries to save it before keeping its text as a version. */
const CLOSE_SAVE_ATTEMPTS = 5;

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
  /** Which copy of the doc this is. Kept across reopens while the file is unchanged. */
  readonly generation: string;
  readonly ref: ResolvedDoc;
  readonly #deps: LiveDocDeps;
  readonly #doc = new Y.Doc();
  readonly #hub: DocSyncHub;
  #fileBase: FileBase;
  /** Counts every change the file does not have yet; equal to `#savedRevision` when saved. */
  #revision = 0;
  #savedRevision = 0;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #firstUnsavedAt: number | null = null;
  #retryMs: number | null = null;
  #ops: Promise<unknown> = Promise.resolve();
  #watch: DocFileWatch | null = null;
  /** The file was moved or deleted: nothing is saved until it is back. */
  #gone = false;
  #closing: Promise<void> | null = null;
  /** State saves, one after another, so the newest always lands last. */
  #persisting: Promise<void> = Promise.resolve();
  #persistTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(ref: ResolvedDoc, deps: LiveDocDeps, base: FileBase, generation: string) {
    this.ref = ref;
    this.#deps = deps;
    this.#fileBase = base;
    this.generation = generation;
    Y.applyUpdate(this.#doc, base.state, LOAD);
    this.#hub = new DocSyncHub(this.#doc);
    this.#doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === LOAD) return;
      // A change on disk is already in the file; everything else is not.
      if ((origin as WriteOrigin | undefined)?.writer?.kind === 'disk') return;
      this.#changed();
    });
  }

  /**
   * Load a doc and start serving it: the saved state of this copy when the
   * file is unchanged since it was saved, otherwise a fresh copy of the file.
   *
   * @param ref - Which doc.
   * @param deps - The worker, the writer and the stores.
   */
  static async open(ref: ResolvedDoc, deps: LiveDocDeps): Promise<LiveDoc> {
    const content = await fs.readFile(ref.file, 'utf8');
    const hash = sha256(content);
    const seeded = await deps.worker.seed(content);
    const saved = await deps.states.load(ref.key, hash);
    const check = saved ? await LiveDoc.#check(deps, saved, seeded) : null;
    let doc: LiveDoc | null = null;
    if (saved && check?.trusted) {
      try {
        doc = new LiveDoc(ref, deps, { state: saved.fileState, hash, content }, saved.generation);
        // The whole doc as it was last saved, unsaved edits included: those
        // are written to the file now, as if just typed. Judged by text, so
        // edits that only delete count too.
        Y.applyUpdate(doc.#doc, saved.state, LOAD);
        if (check.wholeText !== check.fileText) doc.#changed();
      } catch (err) {
        logger.warn('[docs] a saved doc state could not be read; loading the file', { err });
        doc = null;
      }
    } else if (saved && check?.wholeText != null && check.wholeText !== check.fileText) {
      // A state that cannot be trusted as this copy still holds somebody's
      // words: keep them as a version before starting from the file.
      await deps.versions
        .keep(ref.scope, check.wholeText, { kind: 'person' }, 'unsaved-edits')
        .catch((err) => logger.warn('[docs] could not keep an untrusted state’s text', { err }));
    }
    if (!doc) {
      doc = new LiveDoc(ref, deps, { state: seeded, hash, content }, randomUUID());
      doc.#persist();
    }
    if (deps.watch) {
      const opened = doc;
      opened.#watch = watchDocFile(ref.file, () => opened.#onFileEvent());
      await opened.#watch.ready;
      // Anything that happened to the file between the read above and the
      // watcher's first report is caught here instead.
      opened.#onFileEvent();
    }
    return doc;
  }

  /**
   * Whether a saved state can be trusted: its file state must say what the
   * file says, as an editor would write it, and the whole state must hold it.
   * Also the two texts, so a caller can tell unsaved edits (deletions
   * included, which a state vector cannot show) and keep them.
   */
  static async #check(
    deps: LiveDocDeps,
    saved: { state: Uint8Array; fileState: Uint8Array },
    seeded: Uint8Array
  ): Promise<{ trusted: boolean; wholeText: string | null; fileText: string | null }> {
    const text = (state: Uint8Array) => deps.worker.serialize(state).catch(() => null);
    const [wholeText, filedText, fileText] = await Promise.all([
      text(saved.state),
      text(saved.fileState),
      text(seeded),
    ]);
    if (wholeText === null || filedText === null || filedText !== fileText) {
      return { trusted: false, wholeText, fileText };
    }
    try {
      const whole = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(saved.state));
      for (const [client, clock] of Y.decodeStateVector(
        Y.encodeStateVectorFromUpdate(saved.fileState)
      )) {
        if ((whole.get(client) ?? 0) < clock) return { trusted: false, wholeText, fileText };
      }
    } catch {
      return { trusted: false, wholeText, fileText };
    }
    return { trusted: true, wholeText, fileText };
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
   * Add an editor that holds `generation` (absent: an editor with nothing yet).
   * An editor holding another copy is told which copy this is and closed,
   * before anything it holds can reach this doc.
   *
   * @param peer - Its connection.
   * @param generation - The copy it holds.
   */
  join(peer: DocPeer, generation?: string): LiveDocJoin {
    const hello: DocCollabNote = { type: 'hello', generation: this.generation };
    if (this.#closing) return 'closing';
    if (generation !== undefined && generation !== this.generation) {
      peer.send(noteFrame(hello));
      peer.close();
      return 'stale';
    }
    if (this.#hub.size >= this.#deps.maxEditors) return 'full';
    this.#hub.join(peer, hello);
    peer.send(noteFrame(this.#savedNote()));
    if (this.#gone) peer.send(noteFrame({ type: 'gone' }));
    return 'joined';
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
   * Merge a writer's markdown into the doc, keeping the doc's bytes as a
   * version first.
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

  /** Write any edits the file does not have yet. Resolves whether the file has them. */
  flush(): Promise<boolean> {
    return this.#serial(() => this.#flushNow());
  }

  /**
   * Close every editor's connection, write what is left (trying a few times),
   * stop watching, and drop the doc. Text that still could not be written is
   * kept as a version, never dropped.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    // No more frames: whatever is in the doc now is what gets written.
    this.#hub.close();
    this.#clearFlushTimer();
    await this.#watch?.close().catch(() => undefined);
    this.#watch = null;
    await this.#serial(async () => {
      for (let attempt = 0; attempt < CLOSE_SAVE_ATTEMPTS && this.#unsaved; attempt++) {
        // Each attempt answers for its own failure: none may skip the version below.
        const saved = this.#gone ? false : await this.#flushNow().catch(() => false);
        if (saved || this.#gone) continue;
        await sleep(Math.min(MAX_RETRY_MS, this.#deps.retryBaseMs * 2 ** attempt));
      }
      if (this.#unsaved) await this.#keepUnsaved();
    }).catch((err) => logger.warn('[docs] could not write a doc before closing it', { err }));
    this.#clearFlushTimer();
    // The whole doc, so a reopen still has anything the file could not take.
    this.#persist();
    await this.#persisting;
    this.#doc.destroy();
  }

  /** What the file holds now, for editors to tell their saved edits from their unsaved ones. */
  #savedNote(): DocCollabNote {
    // A snapshot, not a state vector: a state vector cannot show deletions,
    // and an edit that only deletes must not read as saved before it is.
    const filed = new Y.Doc({ gc: false });
    Y.applyUpdate(filed, this.#fileBase.state);
    const snapshot = Buffer.from(Y.encodeSnapshot(Y.snapshot(filed))).toString('base64');
    filed.destroy();
    return { type: 'saved', hash: this.#fileBase.hash, snapshot };
  }

  /** Keep the doc's text as a version when it could not reach the file. Never throws. */
  async #keepUnsaved(): Promise<void> {
    const text = await this.#deps.worker
      .serialize(Y.encodeStateAsUpdate(this.#doc))
      .catch(() => null);
    const kept =
      text !== null &&
      (await this.#deps.versions
        .keep(this.ref.scope, text, { kind: 'person' }, 'unsaved-edits')
        .then(() => true)
        .catch(() => false));
    logger.warn('[docs] closed a doc whose last edits could not be written to its file', {
      key: this.ref.key,
      keptAsVersion: kept,
    });
  }

  get #unsaved(): boolean {
    return this.#revision !== this.#savedRevision;
  }

  async #merge(
    markdown: string,
    writer: DocWriter,
    base?: Uint8Array
  ): Promise<LiveDocWriteResult> {
    // Write the editors' pending edits first, so the version kept below is the
    // file's own bytes whenever the file has everything the doc has.
    await this.#flushNow();
    const before = Y.encodeStateAsUpdate(this.#doc);
    const previous = await this.#deps.worker.serialize(before);
    const merged = await this.#deps.worker.merge(before, markdown, base);
    if (merged.markdown === previous) return { base: merged.base, changed: false };
    const bytes = this.#unsaved || this.#gone ? previous : this.#fileBase.content;
    const kept = await this.#deps.versions.keep(this.ref.scope, bytes, writer);
    Y.applyUpdate(this.#doc, merged.update, { kind: 'write', writer } satisfies WriteOrigin);
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
    const reflected = merged.reflected;
    if (!reflected) throw new Error('A merge with a base came back without its reflected state.');
    const writer: DocWriter = { kind: 'disk' };
    const changed = merged.markdown !== previous;
    // The version first: if it cannot be kept, nothing has moved, and the
    // change is taken in on the next try (the file event, or the save's 409).
    const kept = changed
      ? await this.#deps.versions.keep(
          this.ref.scope,
          this.#unsaved ? previous : fileBase.content,
          writer
        )
      : null;
    // Always applied, even when it changes no text (an edit to a block an
    // editor deleted): the file base below holds these items, and a base
    // must never hold what the doc lacks.
    Y.applyUpdate(this.#doc, merged.update, { kind: 'write', writer } satisfies WriteOrigin);
    this.#fileBase = { state: reflected, hash, content };
    if (changed) {
      this.notify({ type: 'changed', changedBy: writer });
      if (kept) this.notify({ type: 'versions' });
    }
    // Only when the editors had unsaved edits does the merged doc differ from
    // the file; otherwise the file keeps the writer's exact bytes, and this
    // copy is what it holds.
    if (this.#unsaved) this.#schedule(this.#deps.flushDelayMs);
    this.#persist();
  }

  /** One save attempt. Resolves whether the file now has every edit it was asked to save. */
  async #flushNow(): Promise<boolean> {
    this.#clearFlushTimer();
    if (!this.#unsaved) return true;
    if (this.#gone) return false;
    const revision = this.#revision;
    const state = Y.encodeStateAsUpdate(this.#doc);
    let markdown: string;
    let result: Awaited<ReturnType<DocFileWriter['save']>> | null = null;
    try {
      markdown = await this.#deps.worker.serialize(state);
      const hash = sha256(markdown);
      if (hash !== this.#fileBase.hash) {
        result = await this.#deps.writer.save({
          cwd: this.ref.space.root,
          path: this.ref.path,
          content: markdown,
          expectedHash: this.#fileBase.hash,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.#markGone();
        return false;
      }
      logger.warn('[docs] could not write an open doc to its file; trying again', {
        err,
        key: this.ref.key,
      });
      this.#retryLater();
      return false;
    }
    if (result?.status === 409) {
      // Somebody changed the file since this doc last read it: take their
      // change in first, then save the result. A merge that fails leaves the
      // edits unsaved and is tried again, like any other failed save.
      try {
        await this.#mergeDisk(result.body.currentContent);
      } catch (err) {
        logger.warn('[docs] could not merge a change on disk before saving; trying again', {
          err,
          key: this.ref.key,
        });
        this.#retryLater();
        return false;
      }
      this.#schedule(0);
      return false;
    }
    const hash = sha256(markdown);
    this.#fileBase = { state, hash, content: markdown };
    this.#savedRevision = revision;
    this.#retryMs = null;
    this.#firstUnsavedAt = null;
    this.#persist();
    this.notify(this.#savedNote());
    // Edits that arrived while this save ran get a save of their own.
    if (this.#unsaved) this.#schedule(this.#deps.flushDelayMs);
    return !this.#unsaved;
  }

  #changed(): void {
    this.#revision += 1;
    this.#persistSoon();
    this.#firstUnsavedAt ??= Date.now();
    if (this.#retryMs !== null) return; // a retry is already on its way
    const waited = Date.now() - this.#firstUnsavedAt;
    this.#schedule(
      Math.max(0, Math.min(this.#deps.flushDelayMs, this.#deps.flushMaxWaitMs - waited))
    );
  }

  #retryLater(): void {
    this.#retryMs = Math.min(
      MAX_RETRY_MS,
      this.#retryMs === null ? this.#deps.retryBaseMs : this.#retryMs * 2
    );
    this.#schedule(this.#retryMs);
  }

  #schedule(delay: number): void {
    // While closing, the close loop does the saving; no timer may outlive it.
    if (this.#closing || this.#gone) return;
    this.#clearFlushTimer();
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.flush().catch((err) => logger.warn('[docs] doc save failed', { err }));
    }, delay);
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
  }

  /**
   * Record this copy's states now: the whole doc and what the file holds. A
   * failure costs only the reconnect merge, never the file.
   */
  #persist(): void {
    if (this.#persistTimer) clearTimeout(this.#persistTimer);
    this.#persistTimer = null;
    const saved = {
      generation: this.generation,
      hash: this.#fileBase.hash,
      state: Y.encodeStateAsUpdate(this.#doc),
      fileState: this.#fileBase.state,
    };
    this.#persisting = this.#persisting.then(() =>
      this.#deps.states
        .save(this.ref.key, this.ref.file, saved)
        .catch((err) => logger.warn('[docs] could not save a doc state', { err }))
    );
  }

  /** Record the states a little after a change, so a crash keeps unsaved edits too. */
  #persistSoon(): void {
    if (this.#persistTimer || this.#closing) return;
    this.#persistTimer = setTimeout(() => this.#persist(), this.#deps.persistDelayMs);
    this.#persistTimer.unref?.();
  }

  /** The file changed, appeared or went: read it and act on what it says now. */
  #onFileEvent(): void {
    void this.#serial(async () => {
      if (this.#closing) return;
      const content = await fs.readFile(this.ref.file, 'utf8').catch(() => null);
      if (content === null) {
        // Replacements are atomic renames, so a file that cannot be read is gone.
        await this.#markGone();
        return;
      }
      if (this.#gone) {
        this.#gone = false;
        this.notify({ type: 'changed', changedBy: { kind: 'disk' } });
      }
      // A merge with unsaved typing saves on the usual delay (`#mergeDisk`),
      // not at once: until then the file keeps the writer's own bytes, so a
      // second write from the same stale view still merges around the typing.
      await this.#mergeDisk(content);
    }).catch((err) => logger.warn('[docs] could not merge a change on disk', { err }));
  }

  /** The file was moved or deleted: say so, keep the text, and stop saving until it is back. */
  async #markGone(): Promise<void> {
    if (this.#gone) return;
    this.#gone = true;
    this.#clearFlushTimer();
    const text = await this.#deps.worker
      .serialize(Y.encodeStateAsUpdate(this.#doc))
      .catch(() => null);
    const kept =
      text !== null &&
      (await this.#deps.versions.keep(this.ref.scope, text, { kind: 'disk' }).catch(() => null));
    this.notify({ type: 'gone' });
    if (kept) this.notify({ type: 'versions' });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#ops.catch(() => undefined).then(work);
    this.#ops = next;
    return next;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
