/**
 * What makes two canvas opens the same document — the one answer both the
 * client and the server give (spec `room-canvas` §3.2).
 *
 * **It lives here rather than in either of them because the two must not be able
 * to disagree.** The session canvas dedupes in the browser and a room's canvas
 * dedupes on the server, and a drift between the two implementations would not
 * show up as an error: a room would quietly grow two tabs for one file, and the
 * table would stop being a table. One function, imported by both, removes that
 * class of bug by construction rather than by a test that has to notice.
 *
 * Pure: a value in, a value out, no clock and no randomness. What to do with a
 * `null` key is each side's own decision — both mint a fresh id for it, because
 * content with no natural identity has nothing for a second open to be the same
 * AS.
 *
 * @module shared/canvas-source-key
 */
import type { UiCanvasContent } from './schemas.js';

/**
 * The dedupe key for one piece of canvas content, or `null` when it has none.
 *
 * `diff` deliberately coalesces on the PATH rather than on the diff itself, so
 * an agent's burst of edits refreshes one tab instead of spawning ten (DOR-212).
 *
 * @param content - The canvas content being opened.
 * @returns The key, or `null` for content with no natural identity.
 */
export function canvasSourceKey(content: UiCanvasContent): string | null {
  switch (content.type) {
    case 'url':
      return `url:${content.url}`;
    case 'browser':
      return `browser:${content.url}`;
    case 'markdown':
      return content.sourcePath ? `path:${content.sourcePath}` : null;
    case 'file':
      return `path:${content.sourcePath}`;
    case 'diff':
      return `diff:${content.sourcePath}`;
    case 'image':
    case 'pdf':
    case 'model3d':
    case 'audio':
    case 'video':
    case 'csv':
      return `src:${content.src}`;
    case 'mcp_app':
      return `mcp:${content.serverName}:${content.uri}`;
    case 'json':
    case 'widget':
      return null;
  }
}
