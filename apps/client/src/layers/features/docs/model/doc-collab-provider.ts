/**
 * The Yjs provider for one live doc (DOR-2984): keeps a `Y.Doc` and its
 * presence in sync with the server over the doc socket, and says how the
 * connection stands.
 *
 * Speaks `y-protocols` sync and awareness in the `y-websocket` framing
 * (`@dorkos/shared/doc-collab`), plus the server's notes. Three rules keep a
 * person's edits safe:
 *
 * - **Nothing is sent until the server names the copy it holds.** Every
 *   connection opens with a `hello` naming the server's generation; this
 *   provider reconnects naming the generation it holds, sends nothing before
 *   that hello, and only syncs when the two match. A server holding a fresh
 *   copy (the file changed while nobody had it open) closes instead, and this
 *   provider starts over on the fresh copy rather than merging the old one in.
 * - **A silent connection is a dead one.** The server sends a heartbeat every
 *   few seconds; silence past {@link DocCollabProviderOptions.silenceTimeoutMs}
 *   drops the connection and reconnects, so a socket that died without closing
 *   is noticed, and the edits typed meanwhile sync when it returns.
 * - **Edits a fresh copy cannot take are reported, never dropped.** When the
 *   copy is replaced while this one held edits of its own that the file does
 *   not have yet (the server's `saved` notes say which), `lostEdits` goes up;
 *   the editor keeps that text as a version.
 *
 * The connect timeout covers the handshake only (up to the `hello`): the first
 * sync of a large doc over a slow link takes as long as it takes.
 *
 * A doc the server will not serve (Docs off, an old server, a refused file)
 * ends as `unavailable`, the editor's cue to save the file the old way.
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
  DOC_COLLAB_HEARTBEAT_MS,
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
   * server holds a fresh copy, and the editor remounts on it.
   */
  epoch: number;
  /** Whether the current copy has received the server's doc, so an editor may show it. */
  synced: boolean;
  /** Whether this provider was ever live: a later `unavailable` is a lost connection, not a refusal. */
  everLive: boolean;
  /** How many times a fresh copy replaced one that held unsaved edits of its own. */
  lostEdits: number;
  /** The file's hash at the last save this editor heard of, or `null` before one. */
  savedHash: string | null;
  /** Whether this editor typed something the file does not have yet. */
  ownEditsUnsaved: boolean;
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
  /** How long one attempt may take to reach the server's hello. Default 10 s. */
  connectTimeoutMs?: number;
  /** Silence after which a live connection counts as dead. Default 2.5 heartbeats. */
  silenceTimeoutMs?: number;
  /**
   * How long the first sync may take after the hello. Generous (default
   * 2 minutes): a large doc over a slow link is not cut off, but a server
   * that said hello and then went quiet does not leave the editor loading forever.
   */
  firstSyncTimeoutMs?: number;
}

/** See the module doc. */
export class DocCollabProvider {
  /** The doc the editor binds to. Replaced when the server holds a fresh copy. */
  ydoc = new Y.Doc();
  /** Presence on {@link ydoc}. Replaced with it. */
  awareness = new Awareness(this.ydoc);
  readonly #options: Required<DocCollabProviderOptions>;
  #snapshot: DocCollabSnapshot = {
    status: 'connecting',
    epoch: 0,
    synced: false,
    everLive: false,
    lostEdits: 0,
    savedHash: null,
    ownEditsUnsaved: false,
  };
  readonly #listeners = new Set<() => void>();
  readonly #noteListeners = new Set<(note: DocCollabNote) => void>();
  #connection: DocCollabConnection | null = null;
  /** The copy this provider holds, as the last confirmed hello named it. */
  #generation: string | null = null;
  /** The current connection's hello matched: frames may flow both ways. */
  #confirmed = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #watchdog: ReturnType<typeof setInterval> | null = null;
  #syncTimer: ReturnType<typeof setTimeout> | null = null;
  #lastFrameAt = 0;
  /** A fresh copy was adopted and not fetched yet: the next close reconnects at once. */
  #fetchFresh = false;
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
      silenceTimeoutMs: Math.round(DOC_COLLAB_HEARTBEAT_MS * 2.5),
      firstSyncTimeoutMs: 120_000,
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
   * Hear the server's notes (who changed the doc, new versions, a gone file).
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
    this.#confirmed = false;
    let current: DocCollabConnection | null = null;
    const isCurrent = () => current !== null && this.#connection === current;
    current = this.#options.transport.connectDocCollab(
      this.#options.doc,
      {
        // Nothing goes out on open: the hello says which copy the server holds.
        onOpen: () => undefined,
        onMessage: (frame) => {
          if (!isCurrent()) return;
          this.#lastFrameAt = Date.now();
          this.#receive(frame);
        },
        onClose: (closed) => {
          if (isCurrent()) this.#closed(closed);
        },
      },
      this.#generation ? { generation: this.#generation } : {}
    );
    this.#connection = current;
    this.#connectTimer = setTimeout(() => {
      // An attempt that never says hello is a failed attempt, even if it never closes.
      if (isCurrent() && !this.#confirmed) this.#drop();
    }, this.#options.connectTimeoutMs);
  }

  /** Give up on the current connection and reconnect, as if it had closed. */
  #drop(): void {
    const stale = this.#connection;
    this.#connection = null;
    stale?.close();
    this.#closed({});
  }

  #closed({ status }: DocCollabClosed): void {
    this.#connection = null;
    this.#confirmed = false;
    this.#clearTimers();
    if (this.#destroyed) return;
    // Others' cursors go with the connection; ours stays for when it returns.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.ydoc.clientID);
    if (others.length > 0) removeAwarenessStates(this.awareness, others, this);
    const refused = status !== undefined && REFUSED.has(status);
    if (!refused && this.#fetchFresh) {
      // A fresh copy was just adopted: reconnect at once, one time, to fetch it.
      this.#fetchFresh = false;
      this.#retry = setTimeout(() => this.#connect(), 0);
      this.#set({ status: this.#snapshot.everLive ? 'reconnecting' : 'connecting' });
      return;
    }
    this.#fetchFresh = false;
    this.#failures += 1;
    if (
      refused ||
      (!this.#snapshot.everLive && this.#failures >= this.#options.attemptsBeforeUnavailable)
    ) {
      this.#set({ status: 'unavailable' });
      return;
    }
    this.#set({ status: this.#snapshot.everLive ? 'reconnecting' : 'connecting' });
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
      return;
    }
    // Before a matching hello, nothing the server sends belongs to this copy.
    if (!this.#confirmed) return;
    if (type === DOC_COLLAB_MESSAGE.sync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, this);
      if (encoding.length(encoder) > 1) this.#connection?.send(encoding.toUint8Array(encoder));
      if (kind === syncProtocol.messageYjsSyncStep2) {
        this.#failures = 0;
        if (this.#syncTimer) clearTimeout(this.#syncTimer);
        this.#syncTimer = null;
        this.#startWatchdog();
        this.#set({ status: 'live', synced: true, everLive: true });
      }
    } else if (type === DOC_COLLAB_MESSAGE.awareness) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  #note(note: DocCollabNote): void {
    if (note.type === 'heartbeat') return;
    if (note.type === 'saved') {
      this.#saved(note.hash, note.snapshot);
      return;
    }
    if (note.type === 'hello') {
      if (this.#generation !== null && this.#generation !== note.generation) {
        // The server holds a fresh copy; this one cannot merge into it. The
        // server closes this connection; the next one fetches the fresh copy.
        this.#replaceDoc(note.generation);
        return;
      }
      this.#generation = note.generation;
      this.#confirmed = true;
      if (this.#connectTimer) clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
      this.#syncTimer = setTimeout(() => {
        if (this.#connection) this.#drop();
      }, this.#options.firstSyncTimeoutMs);
      // Now ask for what the server has, and say who is here.
      this.#sendSyncStep1();
      this.#sendAwareness([this.ydoc.clientID]);
      return;
    }
    for (const listener of this.#noteListeners) listener(note);
  }

  /**
   * The file holds the doc as of `snapshot`: is everything this editor holds
   * in it, deletions included? Only then are its own edits saved.
   */
  #saved(hash: string, snapshot: string): void {
    const covers = (() => {
      try {
        const saved = Y.decodeSnapshot(fromBase64(snapshot));
        return Y.snapshotContainsUpdate(saved, Y.encodeStateAsUpdate(this.ydoc));
      } catch {
        return false;
      }
    })();
    this.#set({ savedHash: hash, ...(covers ? { ownEditsUnsaved: false } : {}) });
  }

  #replaceDoc(generation: string): void {
    const lost = this.#snapshot.ownEditsUnsaved;
    const user = this.awareness.getLocalState()?.user;
    this.#unbindDoc();
    this.awareness.destroy();
    this.ydoc.destroy();
    this.ydoc = new Y.Doc();
    this.awareness = new Awareness(this.ydoc);
    if (user) this.awareness.setLocalStateField('user', user);
    this.#generation = generation;
    this.#fetchFresh = true;
    this.#bind();
    this.#set({
      epoch: this.#snapshot.epoch + 1,
      synced: false,
      lostEdits: this.#snapshot.lostEdits + (lost ? 1 : 0),
      ownEditsUnsaved: false,
    });
  }

  #bind(): void {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      if (!this.#snapshot.ownEditsUnsaved) this.#set({ ownEditsUnsaved: true });
      // Held while unconfirmed: answering the server's step 1 sends it then.
      if (!this.#confirmed) return;
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
    if (clients.length === 0 || !this.#connection || !this.#confirmed) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.awareness);
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, clients));
    this.#connection.send(encoding.toUint8Array(encoder));
  }

  #startWatchdog(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#lastFrameAt = Date.now();
    const every = Math.max(10, Math.round(this.#options.silenceTimeoutMs / 3));
    this.#watchdog = setInterval(() => {
      if (Date.now() - this.#lastFrameAt > this.#options.silenceTimeoutMs) this.#drop();
    }, every);
  }

  #set(patch: Partial<DocCollabSnapshot>): void {
    const next = { ...this.#snapshot, ...patch };
    const keys = Object.keys(next) as (keyof DocCollabSnapshot)[];
    if (keys.every((key) => next[key] === this.#snapshot[key])) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #clearTimers(): void {
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    if (this.#watchdog) clearInterval(this.#watchdog);
    if (this.#syncTimer) clearTimeout(this.#syncTimer);
    this.#syncTimer = null;
    this.#retry = null;
    this.#connectTimer = null;
    this.#watchdog = null;
  }
}

/** Bytes from base64, without Node's `Buffer`. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
