/**
 * The file a canvas document reads, for an approval card to name (DOR-4060), so
 * a person approving `read_canvas_document` sees what they are letting the agent
 * read rather than an opaque document id.
 *
 * Read off the row, never off the agent's arguments, which carry only the id.
 *
 * @module services/canvas/canvas-document-subject
 */
import path from 'node:path';
import { canvasSourcePath } from './document-key.js';
import { peekCanvasService, sessionScope } from './index.js';

/**
 * The file a session's canvas document reads, as an absolute path when its row
 * records a folder. `undefined` when the document is not there or names no file.
 *
 * @param sessionId - The session whose canvas the document is on.
 * @param documentId - The document.
 */
export function canvasDocumentFilePath(sessionId: string, documentId: string): string | undefined {
  const canvas = peekCanvasService();
  const scope = sessionScope(sessionId);
  const document = canvas?.get(scope, documentId);
  const source = document ? canvasSourcePath(document.content) : null;
  if (source === null) return undefined;
  const tree = canvas?.resolvedTreeOf(scope, documentId) ?? null;
  return tree === null ? source : path.resolve(tree, source);
}
