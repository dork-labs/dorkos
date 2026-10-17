/**
 * Live doc editing on this server (DOR-2984): which docs are open, and the one
 * way anything outside an editor writes a doc.
 *
 * - **Open docs.** The first editor of a doc loads its `LiveDoc`; later ones
 *   join it. When the last one leaves, the doc lingers briefly (a reload, a
 *   dropped connection), then writes what is left and is dropped. One `LiveDoc`
 *   per resolved file.
 * - **Writes from outside an editor** (an agent's `doc_write`, a restore).
 *   While the doc is open, the write is merged into the live doc, so the
 *   people editing keep their cursors and their unsaved typing. While nobody
 *   has it open, it goes straight to the file through the installation's file
 *   writer, as any save does. Either way the doc's bytes before the write are
 *   kept as a version first.
 * - **Bases.** An agent's last read or write of a doc is remembered per
 *   (agent session, doc), so its next write is merged against what it last
 *   saw, not against what the doc says now. That is what keeps a person's
 *   typing when an agent writes from a stale read.
 *
 * @module services/docs/collab/doc-collab-service
 */
import fs from 'node:fs/promises';
import type { DocRef, DocVersion, DocWriter } from '@dorkos/shared/doc-collab';
import { sha256 } from '../../../lib/file-route-guards.js';
import { logger } from '../../../lib/logger.js';
import type { DocPeer } from './doc-sync.js';
import type { DocVersionStore } from './doc-versions.js';
import { LiveDoc, type DocFileWriter } from './live-doc.js';
import { MarkdownWorkerError, type MarkdownWorkerClient } from './markdown-worker-client.js';
import { resolveDoc, DocRefusal, type ResolvedDoc } from './resolve-doc.js';

/** How many (session, doc) bases are remembered at once. */
const MAX_BASES = 512;

/** What the service is built with. */
export interface DocCollabServiceDeps {
  worker: MarkdownWorkerClient;
  writer: DocFileWriter;
  versions: DocVersionStore;
  /** How long a doc stays loaded after its last editor leaves. Default 30 s. */
  lingerMs?: number;
  /** How long typing may pause before the file is written. Default 800 ms. */
  flushDelayMs?: number;
  /** The longest a change waits for the file. Default 5 s. */
  flushMaxWaitMs?: number;
  /** Whether open docs watch their files. Default true. */
  watch?: boolean;
}

/** A writer outside the editors, and the session its base belongs to. */
export interface DocAgentCaller {
  /** Who is writing, as editors see it. */
  writer: DocWriter;
  /** The agent session, so its base is its own. Absent: no base is kept. */
  sessionKey?: string;
}

/** The doc changed since the writer last read it, and it was not open to merge into. */
export class DocChangedError extends Error {
  /** A refusal that tells the writer to read again. */
  constructor() {
    super('This doc changed since you last read it. Read it again with doc_read, then write.');
    this.name = 'DocChangedError';
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
}

/** See the module doc. */
export class DocCollabService {
  readonly #deps: Required<DocCollabServiceDeps>;
  /** Open (or opening) docs, by resolved file. */
  readonly #docs = new Map<string, Promise<LiveDoc>>();
  readonly #lingers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Docs writing their last edits before being dropped; a reopen waits for them. */
  readonly #closing = new Map<string, Promise<void>>();
  readonly #bases = new Map<string, BaseRecord>();
  #stopped = false;

  /**
   * A service with nothing open yet.
   *
   * @param deps - The worker, the file writer and the version store.
   */
  constructor(deps: DocCollabServiceDeps) {
    this.#deps = {
      lingerMs: 30_000,
      flushDelayMs: 800,
      flushMaxWaitMs: 5_000,
      watch: true,
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

  /**
   * Add an editor to a doc, loading it if nobody has it open.
   *
   * @param doc - The resolved doc.
   * @param peer - The editor's connection.
   * @returns What the connection calls with each frame, and when it closes.
   */
  async join(doc: ResolvedDoc, peer: DocPeer): Promise<DocJoinHandle> {
    const live = await this.#open(doc);
    this.#cancelLinger(doc.file);
    live.join(peer);
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
      this.#remember(caller, doc, { generation: live.generation, base, hash: sha256(markdown) });
      return { markdown, live: true };
    }
    const markdown = await fs.readFile(doc.file, 'utf8');
    this.#remember(caller, doc, { generation: null, hash: sha256(markdown) });
    return { markdown, live: false };
  }

  /**
   * Write a doc for an agent: merged into the open doc, or straight to the file.
   *
   * @param ref - The doc.
   * @param markdown - What the agent wants the doc to say.
   * @param caller - Who is writing.
   * @throws DocChangedError when the closed file changed since the agent's read,
   *   or the open doc moved past a read of the file it can no longer merge.
   */
  async write(ref: DocRef, markdown: string, caller: DocAgentCaller): Promise<DocWriteResult> {
    const doc = await this.resolve(ref);
    const record = caller.sessionKey ? this.#bases.get(baseKey(caller.sessionKey, doc)) : undefined;
    const live = await this.#openNow(doc.file);
    if (live) {
      let base: Uint8Array;
      if (record?.generation === live.generation && record.base) base = record.base;
      // A read of the file, or no read through DorkOS at all: the agent's
      // markdown is an edit of the file as it is on disk.
      else if (!record || record.hash === live.fileHash) base = live.fileBaseState;
      else throw new DocChangedError();
      const result = await this.writeWithBase(doc, markdown, caller.writer, base);
      this.#remember(caller, doc, {
        generation: live.generation,
        base: result.base,
        hash: sha256(markdown),
      });
      return { live: true, changed: result.changed };
    }
    const changed = await this.#writeFile(doc, markdown, caller.writer, record?.hash);
    this.#remember(caller, doc, { generation: null, hash: sha256(markdown) });
    return { live: false, changed };
  }

  /**
   * Read an open doc together with its base, for a writer that keeps its own.
   *
   * @param doc - The resolved doc.
   * @returns The markdown and base, or `null` when nobody has the doc open.
   */
  async readWithBase(doc: ResolvedDoc): Promise<{ markdown: string; base: Uint8Array } | null> {
    const live = await this.#openNow(doc.file);
    return live ? live.read() : null;
  }

  /**
   * Merge markdown into an open doc against an explicit base.
   *
   * @param doc - The resolved doc; must be open.
   * @param markdown - What the writer wants it to say.
   * @param writer - Who is writing.
   * @param base - What the writer read.
   * @throws DocBaseError for a base from another doc or another copy of this one.
   */
  async writeWithBase(
    doc: ResolvedDoc,
    markdown: string,
    writer: DocWriter,
    base: Uint8Array
  ): Promise<{ base: Uint8Array; changed: boolean }> {
    const live = await this.#openNow(doc.file);
    if (!live) throw new DocBaseError();
    try {
      return await live.write(markdown, writer, base);
    } catch (err) {
      if (err instanceof MarkdownWorkerError && err.code === 'BASE_MISMATCH') {
        throw new DocBaseError();
      }
      throw err;
    }
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
   * Put a saved version back: the doc becomes exactly that version, keeping
   * what it said just before as a version of its own.
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

  /** Write the closed file, keeping what it held before. */
  async #writeFile(
    doc: ResolvedDoc,
    markdown: string,
    writer: DocWriter,
    expectedHash?: string
  ): Promise<boolean> {
    const current = await fs.readFile(doc.file, 'utf8');
    const currentHash = sha256(current);
    if (expectedHash !== undefined && expectedHash !== currentHash) throw new DocChangedError();
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

  #open(doc: ResolvedDoc): Promise<LiveDoc> {
    if (this.#stopped) return Promise.reject(new Error('Live docs are stopped.'));
    let pending = this.#docs.get(doc.file);
    if (!pending) {
      const closing = this.#closing.get(doc.file) ?? Promise.resolve();
      const deps = {
        worker: this.#deps.worker,
        writer: this.#deps.writer,
        versions: this.#deps.versions,
        flushDelayMs: this.#deps.flushDelayMs,
        flushMaxWaitMs: this.#deps.flushMaxWaitMs,
        watch: this.#deps.watch,
      };
      // A reopen reads the file only after the copy before it wrote its last edits.
      pending = closing.then(() => LiveDoc.open(doc, deps));
      this.#docs.set(doc.file, pending);
      // A doc that fails to load is forgotten, so the next editor tries again.
      pending.catch(() => {
        if (this.#docs.get(doc.file) === pending) this.#docs.delete(doc.file);
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
    this.#bases.delete(key);
    this.#bases.set(key, record);
    // Oldest first: a Map iterates in insertion order.
    while (this.#bases.size > MAX_BASES) {
      const oldest = this.#bases.keys().next().value;
      if (oldest === undefined) break;
      this.#bases.delete(oldest);
    }
  }
}

function baseKey(sessionKey: string, doc: ResolvedDoc): string {
  return `${sessionKey}\u0000${doc.file}`;
}
