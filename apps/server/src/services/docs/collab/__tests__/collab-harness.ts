/**
 * Test pieces for live docs: a folder inside the boundary, the real markdown
 * worker (the same bundle the shipped builds make), and an editor that syncs
 * with a live doc exactly as a browser does, over the Yjs protocols.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import {
  DOC_COLLAB_MESSAGE,
  DocCollabNoteSchema,
  type DocCollabNote,
} from '@dorkos/shared/doc-collab';
import { initBoundary } from '../../../../lib/boundary.js';
import { InstallationFileWrites } from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import { DocCollabService, type DocCollabServiceDeps } from '../doc-collab-service.js';
import { DocVersionStore } from '../doc-versions.js';
import { DocStateStore } from '../doc-states.js';
import type { DocPeer } from '../doc-sync.js';
import {
  handleMarkdownRequest,
  loadMarkdownModel,
  type MarkdownModel,
} from '../markdown-worker.js';
import { MarkdownWorkerClient } from '../markdown-worker-client.js';
import type { ResolvedDoc } from '../resolve-doc.js';
import { resolveMarkdownWorkerEntry } from '../worker-entry.js';

/** A folder for one test: its space, and a data folder beside it. */
export interface TestSpace {
  root: string;
  space: string;
  dorkHome: string;
  /** Write a file inside the space; returns its path relative to the space. */
  write(rel: string, content: string): string;
  cleanup(): void;
}

/** Make a space inside a fresh boundary. */
export async function makeSpace(): Promise<TestSpace> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-collab-')));
  const space = path.join(root, 'space');
  const dorkHome = path.join(root, 'dork');
  mkdirSync(space, { recursive: true });
  mkdirSync(dorkHome, { recursive: true });
  await initBoundary(space);
  return {
    root,
    space,
    dorkHome,
    write(rel, content) {
      const file = path.join(space, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return rel;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One shared data folder for the worker bundle, so it is built once per file. */
const workerHome = realpathSync(mkdtempSync(path.join(tmpdir(), 'doc-collab-worker-')));
afterAll(() => rmSync(workerHome, { recursive: true, force: true }));

/** The real, bundled worker file, built once per test file. */
export function workerEntry(): Promise<string> {
  return resolveMarkdownWorkerEntry(workerHome);
}

/** A worker client over the real, bundled worker. */
export function makeWorker(): MarkdownWorkerClient {
  return new MarkdownWorkerClient({ resolveEntry: workerEntry });
}

/** A service over the real worker, writer, version store and saved-state store. */
export function makeService(
  space: TestSpace,
  overrides: Partial<DocCollabServiceDeps> = {}
): {
  service: DocCollabService;
  writer: InstallationFileWrites;
  versions: DocVersionStore;
  states: DocStateStore;
} {
  const writer = new InstallationFileWrites();
  const versions = new DocVersionStore(path.join(space.dorkHome, 'docs', 'versions'));
  const states = new DocStateStore(path.join(space.dorkHome, 'docs', 'live'));
  const service = new DocCollabService({
    worker: makeWorker(),
    writer,
    versions,
    states,
    lingerMs: 0,
    flushDelayMs: 20,
    flushMaxWaitMs: 100,
    retryBaseMs: 20,
    watch: false,
    ...overrides,
  });
  return { service, writer, versions, states };
}

/** What a bare `LiveDoc` is built with, for tests below the service. */
export function liveDocDeps(space: TestSpace) {
  return {
    worker: makeWorker(),
    writer: new InstallationFileWrites(),
    versions: new DocVersionStore(path.join(space.dorkHome, 'docs', 'versions')),
    states: new DocStateStore(path.join(space.dorkHome, 'docs', 'live')),
    flushDelayMs: 20,
    flushMaxWaitMs: 100,
    retryBaseMs: 20,
    watch: false,
    maxEditors: 32,
    persistDelayMs: 20,
  };
}

let model: Promise<MarkdownModel> | null = null;

/** The in-process model an editor uses to turn its typing into Yjs. */
function editorModel(): Promise<MarkdownModel> {
  model ??= loadMarkdownModel();
  return model;
}

/** How {@link TestEditor.join} joins. */
export interface TestEditorJoin {
  /** Rejoin with this copy of the doc (a reconnect), instead of a fresh one. */
  ydoc?: Y.Doc;
  /** The generation that copy came from. */
  generation?: string | null;
}

/**
 * An editor joined to a live doc, syncing the way a browser does: nothing
 * goes to the server until its `hello` confirms the copy this editor holds.
 */
export class TestEditor {
  readonly doc: Y.Doc;
  readonly notes: DocCollabNote[] = [];
  /** The generation of the copy this editor holds, once a hello confirmed it. */
  generation: string | null;
  /** The server named a different copy: this editor must start over. */
  stale = false;
  closed = false;
  #ready = false;
  #handle: { receive: (frame: Uint8Array) => void; leave: () => void } | null = null;
  /** Replies to frames the server sent from inside `join`, before the handle existed. */
  readonly #early: Uint8Array[] = [];

  private constructor(options: TestEditorJoin) {
    this.doc = options.ydoc ?? new Y.Doc();
    this.generation = options.generation ?? null;
  }

  /**
   * Join `doc` on `service` and wait for the first sync.
   *
   * @param service - The live-doc service.
   * @param doc - Which doc.
   * @param options - A copy to rejoin with, for a reconnect.
   */
  static async join(
    service: DocCollabService,
    doc: ResolvedDoc,
    options: TestEditorJoin = {}
  ): Promise<TestEditor> {
    const editor = new TestEditor(options);
    const peer: DocPeer = {
      send: (frame) => editor.#receive(frame),
      close: () => {
        editor.closed = true;
      },
    };
    editor.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === 'server' || editor.closed || !editor.#ready) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.writeUpdate(encoder, update);
      editor.#send(encoding.toUint8Array(encoder));
    });
    const handle = await service.join(doc, peer, {
      ...(editor.generation ? { generation: editor.generation } : {}),
    });
    editor.#handle = handle;
    for (const frame of editor.#early.splice(0)) handle.receive(frame);
    return editor;
  }

  /**
   * Join again with this editor's own copy, as a browser does after a drop.
   *
   * @param service - The live-doc service (maybe a fresh one, after a restart).
   * @param doc - Which doc.
   */
  reconnect(service: DocCollabService, doc: ResolvedDoc): Promise<TestEditor> {
    this.leave();
    return TestEditor.join(service, doc, { ydoc: this.doc, generation: this.generation });
  }

  /** Type: change the editor's doc to say `markdown`, as a person's keystrokes would. */
  async type(markdown: string): Promise<void> {
    const result = handleMarkdownRequest(await editorModel(), {
      id: 0,
      op: 'merge',
      state: Y.encodeStateAsUpdate(this.doc),
      markdown,
    });
    if (result.op !== 'merge') throw new Error('unexpected result');
    Y.applyUpdate(this.doc, result.update, 'local');
  }

  /** What this editor shows, as markdown. */
  async markdown(): Promise<string> {
    const result = handleMarkdownRequest(await editorModel(), {
      id: 0,
      op: 'serialize',
      state: Y.encodeStateAsUpdate(this.doc),
    });
    if (result.op !== 'serialize') throw new Error('unexpected result');
    return result.markdown;
  }

  /** Send any frame, as a misbehaving client might. */
  sendRaw(frame: Uint8Array): void {
    this.#send(frame);
  }

  /** Leave the doc. */
  leave(): void {
    this.closed = true;
    this.#handle?.leave();
  }

  #receive(frame: Uint8Array): void {
    if (this.closed) return;
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type === DOC_COLLAB_MESSAGE.note) {
      // Notes this editor does not know are ignored, as a browser's are.
      const parsed = DocCollabNoteSchema.safeParse(JSON.parse(decoding.readVarString(decoder)));
      if (!parsed.success) return;
      const note = parsed.data;
      this.notes.push(note);
      if (note.type !== 'hello') return;
      if (this.generation && this.generation !== note.generation) {
        this.stale = true;
        return;
      }
      this.generation = note.generation;
      this.#ready = true;
      // Ask for what the server has (sync step 1), as a browser does once confirmed.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.#send(encoding.toUint8Array(encoder));
    } else if (type === DOC_COLLAB_MESSAGE.sync && this.#ready) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, 'server');
      if (encoding.length(encoder) > 1) this.#send(encoding.toUint8Array(encoder));
    }
  }

  #send(frame: Uint8Array): void {
    if (this.closed) return;
    if (this.#handle) this.#handle.receive(frame);
    else this.#early.push(frame);
  }
}
