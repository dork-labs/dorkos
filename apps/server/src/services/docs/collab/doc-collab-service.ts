/**
 * Live doc editing on this server (DOR-2984): which docs are open, and the one
 * way anything outside an editor writes a doc.
 *
 * - **Open docs.** The first editor of a doc loads its `LiveDoc`; later ones
 *   join it. When the last one leaves, the doc lingers briefly (a reload, a
 *   dropped connection), then writes what is left and is dropped. One `LiveDoc`
 *   per resolved file, and a reopen waits for the copy before it to finish.
 * - **Writes from outside an editor** (an agent's `doc_write`, a restore).
 *   While the doc is open, the write is merged into the live doc, so the
 *   people editing keep their cursors and their unsaved typing; an agent must
 *   have read the doc first, so its write is merged against what it saw.
 *   While nobody has it open, it goes straight to the file through the
 *   installation's file writer, as any save does. Either way the doc's bytes
 *   before the write are kept as a version first.
 * - **Bases.** An agent's last read or write of a doc is remembered per
 *   (agent session, doc), so its next write is merged against what it last
 *   saw, not against what the doc says now. That is what keeps a person's
 *   typing when an agent writes from a stale read.
 * - **Bounds.** At most {@link DEFAULT_MAX_OPEN_DOCS} docs open, at most
 *   {@link DEFAULT_MAX_EDITORS} editors on one, and remembered bases within a
 *   count and a byte budget.
 *
 * @module services/docs/collab/doc-collab-service
 */
import fs from 'node:fs/promises';
import type { DocRef, DocVersion, DocWriter } from '@dorkos/shared/doc-collab';
import { sha256 } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import type { DocPeer } from './doc-sync.js';
import type { DocStateStore } from './doc-states.js';
import type { DocVersionStore } from './doc-versions.js';
import { LiveDoc, type DocFileWriter } from './live-doc.js';
import { MarkdownWorkerError, type MarkdownWorkerClient } from './markdown-worker-client.js';
import { resolveDoc, DocRefusal, type ResolvedDoc } from './resolve-doc.js';

/** The most docs open at once. */
export const DEFAULT_MAX_OPEN_DOCS = 64;
/** The most editors on one doc at once. */
export const DEFAULT_MAX_EDITORS = 32;
/** How many (session, doc) bases are remembered at once. */
const MAX_BASES = 512;
/** How many bytes of remembered bases are kept at once. */
const MAX_BASE_BYTES = 64 * 1024 * 1024;
/** How long the saved state and versions of a doc whose file is gone are kept. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** What the service is built with. */
export interface DocCollabServiceDeps {
  worker: MarkdownWorkerClient;
  writer: DocFileWriter;
  versions: DocVersionStore;
  /** Saved Yjs states, so a reopened doc is the same copy. */
  states: DocStateStore;
  /** How long a doc stays loaded after its last editor leaves. Default 30 s. */
  lingerMs?: number;
  /** How long typing may pause before the file is written. Default 800 ms. */
  flushDelayMs?: number;
  /** The longest a change waits for the file. Default 5 s. */
  flushMaxWaitMs?: number;
  /** First delay before a failed save is tried again. Default 1 s. */
  retryBaseMs?: number;
  /** Whether open docs watch their files. Default true. */
  watch?: boolean;
  /** The most docs open at once. */
  maxOpenDocs?: number;
  /** The most editors on one doc at once. */
  maxEditors?: number;
}

/** A writer outside the editors, and the session its base belongs to. */
export interface DocAgentCaller {
  /** Who is writing, as editors see it. */
  writer: DocWriter;
  /** The agent session, so its base is its own. Absent: no base is kept. */
  sessionKey?: string;
}

/** The doc changed since the writer last read it, in a way that cannot be merged. */
export class DocChangedError extends Error {
  /** A refusal that tells the writer to read again. */
  constructor() {
    super('This doc changed since you last read it. Read it again with doc_read, then write.');
    this.name = 'DocChangedError';
  }
}

/** A write to a doc somebody has open, from a writer that never read it. */
export class DocNotReadError extends Error {
  /** A refusal that tells the writer to read first. */
  constructor() {
    super(
      'Somebody has this doc open. Read it with doc_read first, so your change merges with theirs.'
    );
    this.name = 'DocNotReadError';
  }
}

/** A base from another doc, or from a copy of this doc the server no longer holds. */
export class DocBaseError extends Error {
  /** A refusal that tells the writer to read again. */
  constructor() {
    super('That read was of a different copy of this doc. Read it again with doc_read.');
    this.name = 'DocBaseError';
  }
}

/** One editor's place in an open doc: what its connection calls. */
export interface DocJoinHandle {
  /** Hand the doc one frame the editor sent. */
  receive: (frame: Uint8Array) => void;
  /** The editor's connection closed. */
  leave: () => void;
}

/** What a write did. */
export interface DocWriteResult {
  /** Whether the doc was open, so the write was merged live. */
  live: boolean;
  /** Whether anything changed. */
  changed: boolean;
}

interface BaseRecord {
  /** The live generation the base belongs to, or `null` for a read of the closed file. */
  generation: string | null;
  base?: Uint8Array;
  /** The hash of the markdown the writer saw. */
  hash: string;
  /** The hash of the file at the time of the read. */
  fileHash: string;
}

const NO_HANDLE: DocJoinHandle = { receive: () => undefined, leave: () => undefined };

/** See the module doc. */
export class DocCollabService {
  readonly #deps: Required<DocCollabServiceDeps>;
  /** Open (or opening) docs, by resolved file. */
  readonly #docs = new Map<string, Promise<LiveDoc>>();
  readonly #lingers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Docs writing their last edits before being dropped; a reopen waits for them. */
  readonly #closing = new Map<string, Promise<void>>();
  readonly #bases = new Map<string, BaseRecord>();
  #baseBytes = 0;
  #stopped = false;

  /**
   * A service with nothing open yet.
   *
   * @param deps - The worker, the file writer and the stores.
   */
  constructor(deps: DocCollabServiceDeps) {
    this.#deps = {
      lingerMs: 30_000,
      flushDelayMs: 800,
      flushMaxWaitMs: 5_000,
      retryBaseMs: 1_000,
      watch: true,
      maxOpenDocs: DEFAULT_MAX_OPEN_DOCS,
      maxEditors: DEFAULT_MAX_EDITORS,
      ...deps,
    };
  }

  /**
   * Resolve a doc as the wire names it.
   *
   * @param ref - The doc.
   * @throws DocRefusal when it cannot be reached.
   */
  resolve(ref: DocRef): Promise<ResolvedDoc> {
    return resolveDoc(ref);
  }

  /** Remove the saved states and versions of docs whose files have been gone a while. */
  async sweep(): Promise<void> {
    await Promise.all([this.#deps.states.sweep(STALE_MS), this.#deps.versions.sweep(STALE_MS)]);
  }

  /**
   * Add an editor to a doc, loading it if nobody has it open. An editor that
   * names another copy of the doc is told which copy this is and closed.
   *
   * @param doc - The resolved doc.
   * @param peer - The editor's connection.
   * @param options - The copy the editor holds, when it holds one.
   * @throws DocRefusal (429 or 503) when the doc or the server is full.
   */
  async join(
    doc: ResolvedDoc,
    peer: DocPeer,
    options: { generation?: string } = {}
  ): Promise<DocJoinHandle> {
    let live = await this.#open(doc);
    let joined = live.join(peer, options.generation);
    if (joined === 'closing') {
      // It was dropped between the lookup and the join: load the next copy.
      live = await this.#open(doc);
      joined = live.join(peer, options.generation);
    }
    if (joined === 'stale' || joined === 'closing') return NO_HANDLE;
    if (joined === 'full') {
      throw new DocRefusal(429, 'TOO_MANY_EDITORS', 'Too many people have this doc open.');
    }
    this.#cancelLinger(doc.file);
    let left = false;
    return {
      receive: (frame) => live.receive(peer, frame),
      leave: () => {
        if (left) return;
        left = true;
        live.leave(peer);
        if (live.editors === 0) this.#linger(doc.file, live);
      },
    };
  }

  /**
   * Read a doc for an agent, remembering what it saw as its base.
   *
   * @param ref - The doc.
   * @param caller - Who is reading.
   * @returns The markdown, and whether the doc is open (so a write would merge live).
   */
  async read(ref: DocRef, caller: DocAgentCaller): Promise<{ markdown: string; live: boolean }> {
    const doc = await this.resolve(ref);
    const live = await this.#openNow(doc.file);
    if (live) {
      const { markdown, base } = await live.read();
      this.#remember(caller, doc, {
        generation: live.generation,
        base,
        hash: sha256(markdown),
        fileHash: live.fileHash,
      });
      return { markdown, live: true };
    }
    const markdown = await fs.readFile(doc.file, 'utf8');
    const hash = sha256(markdown);
    this.#remember(caller, doc, { generation: null, hash, fileHash: hash });
    return { markdown, live: false };
  }

  /**
   * Write a doc for an agent: merged into the open doc, or straight to the file.
   *
   * @param ref - The doc.
   * @param markdown - What the agent wants the doc to say.
   * @param caller - Who is writing.
   * @throws DocNotReadError when the doc is open and the agent never read it;
   *   DocChangedError when the doc moved past the agent's read in a way that
   *   cannot be merged.
   */
  async write(ref: DocRef, markdown: string, caller: DocAgentCaller): Promise<DocWriteResult> {
    const doc = await this.resolve(ref);
    const record = caller.sessionKey ? this.#bases.get(baseKey(caller.sessionKey, doc)) : undefined;
    const live = await this.#openNow(doc.file);
    if (live) {
      let base: Uint8Array;
      if (!record) throw new DocNotReadError();
      if (record.generation === live.generation && record.base) base = record.base;
      // A read of the closed file, which this open copy was loaded from.
      else if (record.generation === null && record.fileHash === live.fileHash) {
        base = live.fileBaseState;
      } else throw new DocChangedError();
      const result = await this.#writeWithBase(live, markdown, caller.writer, base);
      this.#remember(caller, doc, {
        generation: live.generation,
        base: result.base,
        hash: sha256(markdown),
        fileHash: live.fileHash,
      });
      return { live: true, changed: result.changed };
    }
    const changed = await this.#writeFile(doc, markdown, caller.writer, record);
    const hash = sha256(markdown);
    this.#remember(caller, doc, { generation: null, hash, fileHash: hash });
    return { live: false, changed };
  }

  /**
   * Keep text an editor could not save as a version, so it can be put back.
   *
   * @param ref - The doc.
   * @param markdown - The text.
   * @param writer - Who typed it.
   * @returns The version, or `null` when the newest version already holds it.
   */
  async keepDraft(ref: DocRef, markdown: string, writer: DocWriter): Promise<DocVersion | null> {
    const doc = await this.resolve(ref);
    const kept = await this.#deps.versions.keep(doc.scope, markdown, writer, 'unsaved-edits');
    if (kept) (await this.#openNow(doc.file))?.notify({ type: 'versions' });
    return kept;
  }

  /**
   * A doc's saved versions, newest first.
   *
   * @param ref - The doc.
   */
  async listVersions(ref: DocRef): Promise<DocVersion[]> {
    const doc = await this.resolve(ref);
    return this.#deps.versions.list(doc.scope);
  }

  /**
   * Put a saved version back: the doc becomes exactly that version, replacing
   * what it says now, which is kept as a version of its own first.
   *
   * @param ref - The doc.
   * @param versionId - The version.
   * @param writer - Who is restoring.
   * @returns Whether the doc was open.
   * @throws DocRefusal (404) when there is no such version.
   */
  async restore(ref: DocRef, versionId: string, writer: DocWriter): Promise<{ live: boolean }> {
    const doc = await this.resolve(ref);
    const content = await this.#deps.versions.read(doc.scope, versionId);
    if (content === null) throw new DocRefusal(404, 'VERSION_NOT_FOUND', 'That version is gone.');
    const live = await this.#openNow(doc.file);
    if (live) {
      await live.write(content, writer);
      return { live: true };
    }
    await this.#writeFile(doc, content, writer);
    return { live: false };
  }

  /** Write every open doc, drop it, and stop the markdown worker. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#lingers.values()) clearTimeout(timer);
    this.#lingers.clear();
    const open = [...this.#docs.values()];
    this.#docs.clear();
    await Promise.allSettled([
      ...open.map(async (pending) => (await pending).close()),
      ...this.#closing.values(),
    ]);
    await this.#deps.worker.close();
  }

  /** The open doc for a file, or `undefined` when nobody has it open. */
  async #openNow(file: string): Promise<LiveDoc | undefined> {
    return this.#docs.get(file)?.catch(() => undefined);
  }

  async #writeWithBase(
    live: LiveDoc,
    markdown: string,
    writer: DocWriter,
    base: Uint8Array
  ): Promise<{ base: Uint8Array; changed: boolean }> {
    try {
      return await live.write(markdown, writer, base);
    } catch (err) {
      if (err instanceof MarkdownWorkerError && err.code === 'BASE_MISMATCH') {
        throw new DocBaseError();
      }
      throw err;
    }
  }

  /** Write the closed file, keeping what it held before. */
  async #writeFile(
    doc: ResolvedDoc,
    markdown: string,
    writer: DocWriter,
    record?: BaseRecord
  ): Promise<boolean> {
    // A copy that is still writing its last edits goes first.
    await this.#closing.get(doc.file);
    const current = await fs.readFile(doc.file, 'utf8');
    const currentHash = sha256(current);
    if (record && !(await this.#sawCurrent(record, current, currentHash))) {
      throw new DocChangedError();
    }
    if (current === markdown) return false;
    await this.#deps.versions.keep(doc.scope, current, writer);
    const result = await this.#deps.writer.save({
      cwd: doc.space.root,
      path: doc.path,
      content: markdown,
      expectedHash: currentHash,
    });
    if (result.status === 409) throw new DocChangedError();
    return true;
  }

  /**
   * Whether a writer's read saw what the file holds now: the same file, the
   * same markdown, or the same markdown once the file is written the way an
   * editor writes it (a doc that closed and saved its normalized text).
   */
  async #sawCurrent(record: BaseRecord, current: string, currentHash: string): Promise<boolean> {
    if (currentHash === record.fileHash || currentHash === record.hash) return true;
    const normalized = await this.#deps.worker
      .serialize(await this.#deps.worker.seed(current))
      .catch(() => null);
    return normalized !== null && sha256(normalized) === record.hash;
  }

  #open(doc: ResolvedDoc): Promise<LiveDoc> {
    if (this.#stopped) {
      return Promise.reject(new DocRefusal(503, 'UNAVAILABLE', 'Live docs are stopping.'));
    }
    let pending = this.#docs.get(doc.file);
    if (!pending) {
      if (this.#docs.size >= this.#deps.maxOpenDocs) {
        return Promise.reject(
          new DocRefusal(503, 'TOO_MANY_DOCS', 'Too many docs are open. Close one and try again.')
        );
      }
      const closing = this.#closing.get(doc.file) ?? Promise.resolve();
      const deps = {
        worker: this.#deps.worker,
        writer: this.#deps.writer,
        versions: this.#deps.versions,
        states: this.#deps.states,
        flushDelayMs: this.#deps.flushDelayMs,
        flushMaxWaitMs: this.#deps.flushMaxWaitMs,
        retryBaseMs: this.#deps.retryBaseMs,
        watch: this.#deps.watch,
        maxEditors: this.#deps.maxEditors,
      };
      // A reopen reads the file only after the copy before it wrote its last edits.
      const opening = closing.then(() => LiveDoc.open(doc, deps));
      pending = opening;
      this.#docs.set(doc.file, opening);
      // A doc that fails to load is forgotten, so the next editor tries again.
      opening.catch(() => {
        if (this.#docs.get(doc.file) === opening) this.#docs.delete(doc.file);
      });
    }
    return pending;
  }

  #linger(file: string, live: LiveDoc): void {
    this.#cancelLinger(file);
    const timer = setTimeout(() => {
      this.#lingers.delete(file);
      if (live.editors > 0) return;
      this.#docs.delete(file);
      const closing = live
        .close()
        .catch((err) => logger.warn('[docs] could not close a doc', { err }))
        .finally(() => {
          if (this.#closing.get(file) === closing) this.#closing.delete(file);
        });
      this.#closing.set(file, closing);
    }, this.#deps.lingerMs);
    timer.unref?.();
    this.#lingers.set(file, timer);
  }

  #cancelLinger(file: string): void {
    const timer = this.#lingers.get(file);
    if (timer) clearTimeout(timer);
    this.#lingers.delete(file);
  }

  #remember(caller: DocAgentCaller, doc: ResolvedDoc, record: BaseRecord): void {
    if (!caller.sessionKey) return;
    const key = baseKey(caller.sessionKey, doc);
    this.#forget(key);
    this.#bases.set(key, record);
    this.#baseBytes += record.base?.byteLength ?? 0;
    // Oldest first: a Map iterates in insertion order.
    while (this.#bases.size > MAX_BASES || this.#baseBytes > MAX_BASE_BYTES) {
      const oldest = this.#bases.keys().next().value;
      if (oldest === undefined) break;
      this.#forget(oldest);
    }
  }

  #forget(key: string): void {
    const record = this.#bases.get(key);
    if (!record) return;
    this.#baseBytes -= record.base?.byteLength ?? 0;
    this.#bases.delete(key);
  }
}

function baseKey(sessionKey: string, doc: ResolvedDoc): string {
  return `${sessionKey}\u0000${doc.file}`;
}
