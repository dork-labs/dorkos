/**
 * The Yjs sync and presence protocol for one live doc's editors (DOR-2984).
 *
 * `y-protocols` sync and awareness, framed the way `y-websocket` frames them
 * (`@dorkos/shared/doc-collab`), plus the server's own notes. Runs on the
 * server's thread: applying an editor's update to the doc is a small, bounded
 * merge, never a parse, so it stays fast however busy the markdown worker is.
 *
 * Each editor is a {@link DocPeer}; the peer object itself is the Yjs
 * transaction origin of everything it sends, which is how its own updates are
 * not echoed back to it.
 *
 * @module services/docs/collab/doc-sync
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
import { DOC_COLLAB_MESSAGE, type DocCollabNote } from '@dorkos/shared/doc-collab';
import { logger } from '../../../lib/logger.js';

/** One editor's connection, as the protocol needs it. */
export interface DocPeer {
  /** Send one binary frame to this editor. */
  send(frame: Uint8Array): void;
  /** Close this editor's connection. */
  close(): void;
}

/** A frame holding one note. */
export function noteFrame(note: DocCollabNote): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.note);
  encoding.writeVarString(encoder, JSON.stringify(note));
  return encoding.toUint8Array(encoder);
}

/** Every editor of one doc, kept in sync with its `Y.Doc` and with each other. */
export class DocSyncHub {
  /** Presence: who is here, and where their cursor is. */
  readonly awareness: Awareness;
  readonly #doc: Y.Doc;
  /** Each peer, and the awareness clients it introduced (to remove when it leaves). */
  readonly #peers = new Map<DocPeer, Set<number>>();
  readonly #onUpdate: (update: Uint8Array, origin: unknown) => void;
  readonly #onAwareness: (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => void;

  /**
   * Start serving `doc` to whoever joins.
   *
   * @param doc - The live doc.
   */
  constructor(doc: Y.Doc) {
    this.#doc = doc;
    this.awareness = new Awareness(doc);
    // The server is not an editor: it has no cursor to show.
    this.awareness.setLocalState(null);
    this.#onUpdate = (update, origin) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.writeUpdate(encoder, update);
      const frame = encoding.toUint8Array(encoder);
      for (const peer of this.#peers.keys()) if (peer !== origin) peer.send(frame);
    };
    this.#onAwareness = ({ added, updated, removed }, origin) => {
      const owned = this.#peers.get(origin as DocPeer);
      if (owned) {
        for (const client of added) owned.add(client);
        for (const client of removed) owned.delete(client);
      }
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.awareness);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
      const frame = encoding.toUint8Array(encoder);
      for (const peer of this.#peers.keys()) peer.send(frame);
    };
    doc.on('update', this.#onUpdate);
    this.awareness.on('update', this.#onAwareness);
  }

  /** How many editors are here. */
  get size(): number {
    return this.#peers.size;
  }

  /**
   * Add an editor: greet it, ask for what it has, and show it who is here.
   *
   * @param peer - The new editor.
   * @param hello - The note it is greeted with (which copy of the doc this is).
   */
  join(peer: DocPeer, hello: DocCollabNote): void {
    this.#peers.set(peer, new Set());
    peer.send(noteFrame(hello));
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.writeSyncStep1(encoder, this.#doc);
    peer.send(encoding.toUint8Array(encoder));
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) {
      const presence = encoding.createEncoder();
      encoding.writeVarUint(presence, DOC_COLLAB_MESSAGE.awareness);
      encoding.writeVarUint8Array(presence, encodeAwarenessUpdate(this.awareness, present));
      peer.send(encoding.toUint8Array(presence));
    }
  }

  /**
   * Handle one frame from an editor. A frame that cannot be read closes that
   * editor's connection; it never reaches the doc.
   *
   * @param peer - Who sent it.
   * @param frame - What they sent.
   */
  receive(peer: DocPeer, frame: Uint8Array): void {
    if (!this.#peers.has(peer)) return;
    try {
      const decoder = decoding.createDecoder(frame);
      const type = decoding.readVarUint(decoder);
      if (type === DOC_COLLAB_MESSAGE.sync) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
        syncProtocol.readSyncMessage(decoder, encoder, this.#doc, peer);
        // Only a step 1 needs an answer (the step 2 it asked for).
        if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder));
      } else if (type === DOC_COLLAB_MESSAGE.awareness) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), peer);
      }
    } catch (err) {
      logger.warn('[docs] closed an editor that sent an unreadable frame', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.leave(peer);
      peer.close();
    }
  }

  /**
   * Remove an editor and its cursor.
   *
   * @param peer - The editor leaving.
   */
  leave(peer: DocPeer): void {
    const owned = this.#peers.get(peer);
    if (!owned) return;
    this.#peers.delete(peer);
    if (owned.size > 0) removeAwarenessStates(this.awareness, [...owned], null);
  }

  /**
   * Tell every editor something.
   *
   * @param note - What to say.
   */
  broadcast(note: DocCollabNote): void {
    const frame = noteFrame(note);
    for (const peer of this.#peers.keys()) peer.send(frame);
  }

  /** Close every connection and stop listening to the doc. */
  close(): void {
    this.#doc.off('update', this.#onUpdate);
    this.awareness.off('update', this.#onAwareness);
    for (const peer of [...this.#peers.keys()]) {
      this.leave(peer);
      peer.close();
    }
    this.awareness.destroy();
  }
}
