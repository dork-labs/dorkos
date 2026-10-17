/**
 * The Yjs provider for one live doc (DOR-2984): keeps a `Y.Doc` and its
 * presence in sync with the server over the doc socket, and says how the
 * connection stands.
 *
 * Speaks `y-protocols` sync and awareness in the `y-websocket` framing
 * (`@dorkos/shared/doc-collab`), plus the server's notes. A dropped
 * connection reconnects with backoff while the editor keeps working on its
 * own copy; Yjs merges the edits when the connection returns. A doc the
 * server will not serve (Docs off, an old server, a file it refuses) ends as
 * `unavailable`, which is the editor's cue to save the file the old way.
 *
 * @module features/docs/model/doc-collab-provider
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  DOC_COLLAB_MESSAGE,
  DocCollabNoteSchema,
  type DocCollabNote,
  type DocRef,
} from '@dorkos/shared/doc-collab';
import type {
  DocCollabClosed,
  DocCollabConnection,
  DocCollabTransport,
} from '@dorkos/shared/transport-doc-collab';

/**
 * How the connection stands. `connecting` until the first sync; `live` while
 * synced; `reconnecting` after a drop; `unavailable` when the server will not
 * serve this doc live.
 */
export type LiveDocStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

/** What the provider says about itself, for React's `useSyncExternalStore`. */
export interface DocCollabSnapshot {
  status: LiveDocStatus;
  /**
   * Which copy of the doc the editor should bind to. It changes when the
   * server loaded the doc afresh, and the editor remounts on the new copy.
   */
  epoch: number;
  /** Edits made while offline that the fresh copy could not take. */
  offlineEditsLost: boolean;
}

/** Statuses after which reconnecting cannot help. */
const REFUSED: ReadonlySet<number> = new Set([400, 403, 404, 413, 415]);

/** Options for {@link DocCollabProvider}. */
export interface DocCollabProviderOptions {
  /** The socket half of the transport. */
  transport: Pick<DocCollabTransport, 'connectDocCollab'>;
  /** The doc. */
  doc: DocRef;
  /** First retry delay. Default 1 s; doubles to {@link maxDelayMs}. */
  baseDelayMs?: number;
  /** Longest retry delay. Default 15 s. */
  maxDelayMs?: number;
  /** Failed attempts before a doc that never synced counts as unavailable. Default 3. */
  attemptsBeforeUnavailable?: number;
  /** How long one attempt may take to sync. Default 10 s. */
  connectTimeoutMs?: number;
}

/** See the module doc. */
export class DocCollabProvider {
  /** The doc the editor binds to. Replaced when the server loads the doc afresh. */
  ydoc = new Y.Doc();
  /** Presence on {@link ydoc}. Replaced with it. */
  awareness = new Awareness(this.ydoc);
  readonly #options: Required<DocCollabProviderOptions>;
  #snapshot: DocCollabSnapshot = { status: 'connecting', epoch: 0, offlineEditsLost: false };
  readonly #listeners = new Set<() => void>();
  readonly #noteListeners = new Set<(note: DocCollabNote) => void>();
  #connection: DocCollabConnection | null = null;
  #generation: string | null = null;
  #everSynced = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Local edits the server may not have yet. */
  #unsent = false;
  #destroyed = false;
  readonly #unbind: Array<() => void> = [];

  /**
   * Start connecting.
   *
   * @param options - The transport and the doc.
   */
  constructor(options: DocCollabProviderOptions) {
    this.#options = {
      baseDelayMs: 1_000,
      maxDelayMs: 15_000,
      attemptsBeforeUnavailable: 3,
      connectTimeoutMs: 10_000,
      ...options,
    };
    this.#bind();
    this.#connect();
  }

  /** The current snapshot; the same object until something changes. */
  getSnapshot = (): DocCollabSnapshot => this.#snapshot;

  /**
   * Hear about every change to the snapshot.
   *
   * @param listener - Called after each change.
   * @returns Unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Hear the server's notes (who changed the doc, new versions).
   *
   * @param listener - Called with each note.
   * @returns Unsubscribe.
   */
  onNote(listener: (note: DocCollabNote) => void): () => void {
    this.#noteListeners.add(listener);
    return () => this.#noteListeners.delete(listener);
  }

  /** Close the connection and stop for good. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#clearTimers();
    this.#connection?.close();
    this.#connection = null;
    this.#unbindDoc();
    this.awareness.destroy();
    this.ydoc.destroy();
    this.#listeners.clear();
    this.#noteListeners.clear();
  }

  #connect(): void {
    if (this.#destroyed) return;
    this.#clearTimers();
    let current: DocCollabConnection | null = null;
    const isCurrent = () => current !== null && this.#connection === current;
    current = this.#options.transport.connectDocCollab(this.#options.doc, {
      onOpen: () => {
        if (!isCurrent()) return;
        this.#sendSyncStep1();
        this.#sendAwareness([this.ydoc.clientID]);
      },
      onMessage: (frame) => {
        if (isCurrent()) this.#receive(frame);
      },
      onClose: (closed) => {
        if (isCurrent()) this.#closed(closed);
      },
    });
    this.#connection = current;
    this.#connectTimer = setTimeout(() => {
      // An attempt that never syncs is a failed attempt, even if it never closes.
      if (isCurrent() && this.#snapshot.status !== 'live') {
        const stale = this.#connection;
        this.#connection = null;
        stale?.close();
        this.#closed({});
      }
    }, this.#options.connectTimeoutMs);
  }

  #closed({ status }: DocCollabClosed): void {
    this.#connection = null;
    this.#clearTimers();
    if (this.#destroyed) return;
    // Others' cursors go with the connection; ours stays for when it returns.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.ydoc.clientID);
    if (others.length > 0) removeAwarenessStates(this.awareness, others, this);
    this.#failures += 1;
    const refused = status !== undefined && REFUSED.has(status);
    if (
      refused ||
      (!this.#everSynced && this.#failures >= this.#options.attemptsBeforeUnavailable)
    ) {
      this.#set({ status: 'unavailable' });
      return;
    }
    this.#set({ status: this.#everSynced ? 'reconnecting' : 'connecting' });
    const delay = Math.min(
      this.#options.maxDelayMs,
      this.#options.baseDelayMs * 2 ** (this.#failures - 1)
    );
    this.#retry = setTimeout(() => this.#connect(), delay);
  }

  #receive(frame: Uint8Array): void {
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type === DOC_COLLAB_MESSAGE.note) {
      const parsed = DocCollabNoteSchema.safeParse(safeJson(decoding.readVarString(decoder)));
      if (parsed.success) this.#note(parsed.data);
    } else if (type === DOC_COLLAB_MESSAGE.sync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, this);
      if (encoding.length(encoder) > 1) {
        this.#connection?.send(encoding.toUint8Array(encoder));
        // Answering the server's step 1 sends it everything this copy holds.
        this.#unsent = false;
      }
      if (kind === syncProtocol.messageYjsSyncStep2) {
        this.#everSynced = true;
        this.#failures = 0;
        if (this.#connectTimer) clearTimeout(this.#connectTimer);
        this.#connectTimer = null;
        this.#set({ status: 'live' });
      }
    } else if (type === DOC_COLLAB_MESSAGE.awareness) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  #note(note: DocCollabNote): void {
    if (note.type === 'hello') {
      if (this.#generation !== null && this.#generation !== note.generation) {
        // The server loaded the doc afresh: this copy cannot merge into it.
        this.#replaceDoc();
      }
      this.#generation = note.generation;
      return;
    }
    for (const listener of this.#noteListeners) listener(note);
  }

  #replaceDoc(): void {
    const lost = this.#unsent;
    const user = this.awareness.getLocalState()?.user;
    this.#unbindDoc();
    this.awareness.destroy();
    this.ydoc.destroy();
    this.ydoc = new Y.Doc();
    this.awareness = new Awareness(this.ydoc);
    if (user) this.awareness.setLocalStateField('user', user);
    this.#unsent = false;
    this.#bind();
    this.#set({
      epoch: this.#snapshot.epoch + 1,
      offlineEditsLost: this.#snapshot.offlineEditsLost || lost,
    });
    // The server asked this socket for its state before the hello was read;
    // ask for the fresh copy now.
    this.#sendSyncStep1();
    this.#sendAwareness([this.ydoc.clientID]);
  }

  #bind(): void {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      if (this.#snapshot.status !== 'live') this.#unsent = true;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.writeUpdate(encoder, update);
      this.#connection?.send(encoding.toUint8Array(encoder));
    };
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown
    ) => {
      if (origin === this) return;
      this.#sendAwareness([...added, ...updated, ...removed]);
    };
    const doc = this.ydoc;
    const awareness = this.awareness;
    doc.on('update', onUpdate);
    awareness.on('update', onAwareness);
    this.#unbind.push(
      () => doc.off('update', onUpdate),
      () => awareness.off('update', onAwareness)
    );
  }

  #unbindDoc(): void {
    for (const off of this.#unbind.splice(0)) off();
  }

  #sendSyncStep1(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.writeSyncStep1(encoder, this.ydoc);
    this.#connection?.send(encoding.toUint8Array(encoder));
  }

  #sendAwareness(clients: number[]): void {
    if (clients.length === 0 || !this.#connection) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.awareness);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients));
    this.#connection.send(encoding.toUint8Array(encoder));
  }

  #set(patch: Partial<DocCollabSnapshot>): void {
    const next = { ...this.#snapshot, ...patch };
    if (
      next.status === this.#snapshot.status &&
      next.epoch === this.#snapshot.epoch &&
      next.offlineEditsLost === this.#snapshot.offlineEditsLost
    )
      return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #clearTimers(): void {
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    this.#retry = null;
    this.#connectTimer = null;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
