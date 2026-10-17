/**
 * An in-memory live doc server for client tests: the same Yjs sync, presence
 * and notes the real one speaks (`apps/server/src/services/docs/collab/doc-sync.ts`),
 * behind a `connectDocCollab` the provider can use.
 */
import { vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { DOC_COLLAB_MESSAGE, type DocCollabNote } from '@dorkos/shared/doc-collab';
import type { DocCollabHandlers, DocCollabTransport } from '@dorkos/shared/transport-doc-collab';

interface Peer {
  handlers: DocCollabHandlers;
  open: boolean;
}

/** One doc on a fake server. */
export class FakeDocServer {
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  generation = 'gen-1';
  readonly peers = new Set<Peer>();
  /** When set, the next connection is refused with this status. */
  refuseWith: number | null = null;
  /** When set, every connection is refused with this status (Docs turned off). */
  refuseAll: number | null = null;
  /** When set, start refusing every connection with it once a stale copy has been turned away. */
  refuseAfterStale: number | null = null;
  /** While true, nothing reaches editors and nothing closes: a half-open socket. */
  muted = false;
  /** How long the server takes to answer a sync request: a large doc over a slow link. */
  syncDelayMs = 0;

  constructor(text = '') {
    if (text) this.doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText(text)]);
    this.#bind();
  }

  #bind(): void {
    this.awareness.setLocalState(null);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.writeUpdate(encoder, update);
      this.#broadcast(encoding.toUint8Array(encoder), origin as Peer);
    });
    this.awareness.on('update', ({ added, updated, removed }: Record<string, number[]>) => {
      const changed = [...added!, ...updated!, ...removed!];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.awareness);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
      this.#broadcast(encoding.toUint8Array(encoder));
    });
  }

  /** The text the doc's fragment holds. */
  text(): string {
    return this.doc.getXmlFragment('prosemirror').toString();
  }

  /** Load the doc afresh: new items, new generation, as a server restart would. */
  reload(text: string): void {
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText(text)]);
    this.#bind();
    this.generation = `gen-${Date.now()}-${Math.random()}`;
  }

  /** Drop every connection, as a network failure would. */
  dropAll(): void {
    for (const peer of [...this.peers]) {
      this.peers.delete(peer);
      peer.handlers.onClose({});
    }
  }

  /** Save: tell every editor the file now holds the doc as it is. */
  save(hash = 'saved-hash'): void {
    const stateVector = btoa(String.fromCharCode(...Y.encodeStateVector(this.doc)));
    this.note({ type: 'saved', hash, stateVector });
  }

  /** Say something to every editor. */
  note(note: DocCollabNote): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.note);
    encoding.writeVarString(encoder, JSON.stringify(note));
    this.#broadcast(encoding.toUint8Array(encoder));
  }

  /** A transport whose sockets reach this server. */
  transport(): Pick<DocCollabTransport, 'connectDocCollab'> & {
    connectDocCollab: ReturnType<typeof vi.fn>;
  } {
    return {
      connectDocCollab: vi.fn(
        (_doc, handlers: DocCollabHandlers, options: { generation?: string } = {}) => {
          const peer: Peer = { handlers, open: false };
          const refused = this.refuseAll ?? this.refuseWith;
          this.refuseWith = null;
          queueMicrotask(() => {
            if (refused !== null) {
              handlers.onClose({ status: refused });
              return;
            }
            handlers.onOpen();
            if (options.generation !== undefined && options.generation !== this.generation) {
              // As the real server does: name this copy, then close, syncing nothing.
              const hello = encoding.createEncoder();
              encoding.writeVarUint(hello, DOC_COLLAB_MESSAGE.note);
              encoding.writeVarString(
                hello,
                JSON.stringify({ type: 'hello', generation: this.generation })
              );
              handlers.onMessage(encoding.toUint8Array(hello));
              if (this.refuseAfterStale !== null) this.refuseAll = this.refuseAfterStale;
              handlers.onClose({});
              return;
            }
            this.peers.add(peer);
            peer.open = true;
            this.#hello(peer);
          });
          return {
            send: (frame: Uint8Array) => {
              if (peer.open && this.peers.has(peer) && !this.muted) this.#receive(peer, frame);
            },
            close: () => {
              if (!this.peers.delete(peer)) return;
              handlers.onClose({});
            },
          };
        }
      ),
    };
  }

  #hello(peer: Peer): void {
    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, DOC_COLLAB_MESSAGE.note);
    encoding.writeVarString(hello, JSON.stringify({ type: 'hello', generation: this.generation }));
    peer.handlers.onMessage(encoding.toUint8Array(hello));
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.writeSyncStep1(step1, this.doc);
    peer.handlers.onMessage(encoding.toUint8Array(step1));
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) {
      const presence = encoding.createEncoder();
      encoding.writeVarUint(presence, DOC_COLLAB_MESSAGE.awareness);
      encoding.writeVarUint8Array(presence, encodeAwarenessUpdate(this.awareness, present));
      peer.handlers.onMessage(encoding.toUint8Array(presence));
    }
  }

  #receive(peer: Peer, frame: Uint8Array): void {
    const decoder = decoding.createDecoder(frame);
    const type = decoding.readVarUint(decoder);
    if (type === DOC_COLLAB_MESSAGE.sync) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, peer);
      if (encoding.length(encoder) > 1) {
        const reply = encoding.toUint8Array(encoder);
        if (this.syncDelayMs > 0)
          setTimeout(() => peer.handlers.onMessage(reply), this.syncDelayMs);
        else peer.handlers.onMessage(reply);
      }
    } else if (type === DOC_COLLAB_MESSAGE.awareness) {
      applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), peer);
    }
  }

  #broadcast(frame: Uint8Array, except?: Peer): void {
    if (this.muted) return;
    for (const peer of this.peers) if (peer !== except) peer.handlers.onMessage(frame);
  }
}

/** The text a client doc's fragment holds. */
export function textOf(doc: Y.Doc): string {
  return doc.getXmlFragment('prosemirror').toString();
}

/** Type into a client doc as an editor would. */
export function typeInto(doc: Y.Doc, text: string): void {
  doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText(text)]);
}
