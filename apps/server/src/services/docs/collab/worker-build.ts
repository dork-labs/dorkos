/**
 * How the markdown worker is bundled (DOR-2984), in one place for the three
 * places that bundle it: the CLI build, the desktop build, and the server's
 * own development bundle (`worker-entry.ts`). A leaf with no imports, so the
 * build scripts can read it without loading the server.
 *
 * @module services/docs/collab/worker-build
 */

/** The file name the production builds emit beside the server bundle. */
export const MARKDOWN_WORKER_FILE = 'docs-markdown-worker.mjs';

/** The worker's source, relative to the repo root. */
export const MARKDOWN_WORKER_SOURCE = 'apps/server/src/services/docs/collab/markdown-worker.ts';

/**
 * The banner every ESM bundle of this worker carries: a few of Blintz's
 * dependencies are CommonJS and call `require`, which an ES module lacks.
 */
export const MARKDOWN_WORKER_BANNER =
  "import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);";
