/**
 * Live doc editing (DOR-2984): the server holds an open doc's `Y.Doc`, people
 * edit it together over a socket, and agents' writes merge into it instead of
 * overwriting it. Gated by the `docs.enabled` experiment.
 *
 * One service per server, made at startup with the installation's file writer
 * (`startup/steps/doc-delivery.ts`) and stopped before that writer drains, so
 * every open doc is written before the server exits.
 *
 * @module services/docs/collab
 */
import path from 'node:path';
import { DocCollabService } from './doc-collab-service.js';
import { DocVersionStore } from './doc-versions.js';
import { DocStateStore } from './doc-states.js';
import { logger } from '../../../lib/logger.js';
import type { DocFileWriter } from './live-doc.js';
import { MarkdownWorkerClient } from './markdown-worker-client.js';
import { resolveMarkdownWorkerEntry } from './worker-entry.js';

export {
  DocCollabService,
  DocBaseError,
  DocChangedError,
  DocNotReadError,
  type DocAgentCaller,
  type DocJoinHandle,
} from './doc-collab-service.js';
export { DocRefusal } from './resolve-doc.js';
export { docsEnabled } from './docs-enabled.js';
export type { DocPeer } from './doc-sync.js';

let service: DocCollabService | null = null;

/** What {@link initDocCollab} needs from the running server. */
export interface DocCollabWiring {
  /** DorkOS's data folder: saved versions and the development worker bundle live here. */
  dorkHome: string;
  /** The installation's file writer, shared with every other save. */
  writer: DocFileWriter;
}

/**
 * Make this server's live-doc service. Nothing loads until a doc is opened,
 * and the markdown worker starts on first use.
 *
 * @param wiring - The data folder and the file writer.
 */
export function initDocCollab(wiring: DocCollabWiring): DocCollabService {
  service = new DocCollabService({
    worker: new MarkdownWorkerClient({
      resolveEntry: () => resolveMarkdownWorkerEntry(wiring.dorkHome),
    }),
    writer: wiring.writer,
    versions: new DocVersionStore(path.join(wiring.dorkHome, 'docs', 'versions')),
    states: new DocStateStore(path.join(wiring.dorkHome, 'docs', 'live')),
  });
  // Saved states and versions of docs whose files have been gone a while.
  void service.sweep().catch((err) => logger.warn('[docs] doc sweep failed', { err }));
  return service;
}

/** This server's live-doc service, or `null` before startup made it. */
export function getDocCollab(): DocCollabService | null {
  return service;
}

/** Write every open doc and stop the markdown worker. */
export async function stopDocCollab(): Promise<void> {
  const stopping = service;
  service = null;
  await stopping?.stop();
}
