/**
 * Live doc editing, as the client reaches it (DOR-2984). A slice of the
 * `Transport` (`transport-slices.ts`).
 *
 * The socket is handed back as bytes in and bytes out: the Yjs provider that
 * speaks the protocol (`doc-collab.ts`) lives in the client, so this port
 * knows nothing about Yjs.
 *
 * @module shared/transport-doc-collab
 */
import type {
  DocRef,
  DocVersion,
  DocVersionList,
  RestoreDocVersionResponse,
} from './doc-collab.js';

/** Why a doc socket closed. */
export interface DocCollabClosed {
  /**
   * The HTTP status the server refused with (404 while Docs are off or the
   * file is gone, 403 outside the folder boundary), or absent for a socket
   * that dropped.
   */
  status?: number;
}

/** What a doc socket reports. Each is called on the socket's own events. */
export interface DocCollabHandlers {
  /** The socket is open; the client may start syncing. */
  onOpen: () => void;
  /** One binary frame arrived. */
  onMessage: (frame: Uint8Array) => void;
  /** The socket closed, refused or dropped. Called once. */
  onClose: (closed: DocCollabClosed) => void;
}

/** One open doc socket. */
export interface DocCollabConnection {
  /** Send one binary frame. Dropped when the socket is not open. */
  send: (frame: Uint8Array) => void;
  /** Close the socket. `onClose` still runs. */
  close: () => void;
}

/** How a doc socket is opened. */
export interface DocCollabConnectOptions {
  /**
   * The copy of the doc this editor already holds (the generation its last
   * `hello` named). The server refuses to sync a different copy into its own.
   */
  generation?: string;
}

/** Join a doc's live editing, and restore its saved versions. */
export interface DocCollabTransport {
  /** Open a socket to a doc's live editing. */
  connectDocCollab(
    doc: DocRef,
    handlers: DocCollabHandlers,
    options?: DocCollabConnectOptions
  ): DocCollabConnection;
  /** Keep text an editor could not save as a version of the doc. */
  keepDocDraft(doc: DocRef, markdown: string): Promise<{ ok: true; version: DocVersion | null }>;
  /** A doc's saved versions, newest first. */
  listDocVersions(doc: DocRef): Promise<DocVersionList>;
  /** Put a saved version back, as a write everyone editing it sees. */
  restoreDocVersion(doc: DocRef, versionId: string): Promise<RestoreDocVersionResponse>;
}
