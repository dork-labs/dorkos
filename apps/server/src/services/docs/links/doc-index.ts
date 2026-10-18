/**
 * The docs in one space, for wiki links and the `[[` menu (DOR-2982).
 *
 * A doc is a `.md` file under the space's root ({@link resolveDocSpace}). The
 * walk goes breadth first, nearest folders first, and skips dot-folders,
 * dependency and build folders, and symlinks (a link could point outside the
 * space). It stops at its {@link DocIndexLimits} (docs, folders, depth, and a
 * time budget) and says so with `truncated`. Each doc's title comes from its
 * first few KB only (`@dorkos/shared/doc-title`).
 *
 * **Why the folders are walked on every request, and only the titles are
 * cached.** The client asks again right after a doc is created or renamed, so
 * a link to it stops showing as missing; a cache over the listing would
 * answer that request with the old list. Listing folders is cheap. Reading
 * files is the cost, so a title is kept per file and reused while the file's
 * identity, modified time and size are unchanged.
 *
 * **Requests that arrive during a walk wait for the next one.** A walk that
 * is already running may have listed a folder before the change the new
 * request is asking about, so its answer is never handed to a request that
 * arrived after it started. Every request that arrives while one walk runs
 * shares one follow-up walk, started when the running one ends.
 *
 * @module server/services/docs/links/doc-index
 */
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DOC_EXTENSION,
  DOC_TITLE_BYTES,
  docFileStem,
  docSlug,
  docTitleFromBytes,
  type DocIndex,
  type DocIndexEntry,
} from '@dorkos/shared/doc-links';
import { FILE_LISTING } from '../../../config/constants.js';
import type { DocSpace } from '../doc-space.js';

/** How far one walk goes. */
export interface DocIndexLimits {
  /** The most docs listed. */
  maxDocs: number;
  /** The deepest folder level read below the root (the root is level 0). */
  maxDepth: number;
  /** The most folders read. */
  maxFolders: number;
  /** How long one walk may take, titles included, before it stops. */
  budgetMs: number;
}

/** The limits the doc index walks with: enough for the `[[` menu, quick to answer. */
export const DOC_INDEX_LIMITS: DocIndexLimits = {
  maxDocs: 2000,
  maxDepth: 8,
  maxFolders: 2000,
  budgetMs: 1500,
};

/** Folders that hold dependencies or build output, never a person's docs. */
const SKIPPED_FOLDERS = new Set([
  ...FILE_LISTING.EXCLUDED_DIRS,
  'bower_components',
  'out',
  'target',
  'vendor',
  'venv',
]);

/** How many doc heads are read at once. */
const READ_CONCURRENCY = 8;

/** Titles kept before the cache starts over. */
const TITLE_CACHE_LIMIT = 20_000;

/**
 * Opens a doc for its title without following a symlink, and without waiting
 * on a FIFO or device that was swapped in after the folder was listed.
 * `O_NOFOLLOW` does not exist on Windows, where it is left out.
 */
const OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** A title, and the file state it was read from. */
interface CachedTitle {
  ino: number;
  mtimeMs: number;
  size: number;
  title: string;
}

const titleCache = new Map<string, CachedTitle>();

/**
 * A doc's title, read through one handle: the file is opened first, checked
 * to be a regular file on that same handle, and only then read, so nothing
 * swapped in between the listing and the read is ever read. The cached title
 * is reused while the file is unchanged.
 */
async function titleFor(absolute: string, fileName: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolute, OPEN_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile()) return docFileStem(fileName);
    const cached = titleCache.get(absolute);
    if (
      cached &&
      cached.ino === stat.ino &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.title;
    }
    const buffer = Buffer.alloc(DOC_TITLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, DOC_TITLE_BYTES, 0);
    const title = docTitleFromBytes(buffer.subarray(0, bytesRead), fileName);
    if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear();
    titleCache.set(absolute, { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, title });
    return title;
  } catch {
    // Gone, unreadable, or swapped for a symlink since the folder was listed:
    // nothing is read, and the file name still links.
    return docFileStem(fileName);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A doc file the walk found. */
interface FoundDoc {
  absolute: string;
  relative: string;
  fileName: string;
}

/** Walk the space's folders, breadth first, and collect its doc files. */
async function walk(
  root: string,
  limits: DocIndexLimits,
  deadline: number
): Promise<{ found: FoundDoc[]; truncated: boolean }> {
  const found: FoundDoc[] = [];
  const queue: { absolute: string; relative: string; depth: number }[] = [
    { absolute: root, relative: '', depth: 0 },
  ];
  let folders = 1;
  let truncated = false;
  for (let next = 0; next < queue.length; next += 1) {
    if (next > 0 && Date.now() >= deadline) return { found, truncated: true };
    const folder = queue[next]!;
    let entries;
    try {
      entries = await fs.readdir(folder.absolute, { withFileTypes: true });
    } catch {
      // Unreadable folders are left out, as the files list does.
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = folder.relative ? `${folder.relative}/${entry.name}` : entry.name;
      const absolute = path.join(folder.absolute, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_FOLDERS.has(entry.name)) continue;
        if (folder.depth + 1 > limits.maxDepth || folders >= limits.maxFolders) {
          truncated = true;
          continue;
        }
        folders += 1;
        queue.push({ absolute, relative, depth: folder.depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(DOC_EXTENSION)) {
        if (found.length >= limits.maxDocs) return { found, truncated: true };
        found.push({ absolute, relative, fileName: entry.name });
      }
    }
  }
  return { found, truncated };
}

/** Walk once and title every doc, within the time budget. */
async function build(space: DocSpace, limits: DocIndexLimits): Promise<DocIndex> {
  const deadline = Date.now() + limits.budgetMs;
  const walked = await walk(space.root, limits, deadline);
  let truncated = walked.truncated;
  const docs: DocIndexEntry[] = [];
  for (let start = 0; start < walked.found.length; start += READ_CONCURRENCY) {
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const batch = walked.found.slice(start, start + READ_CONCURRENCY);
    const titles = await Promise.all(batch.map((doc) => titleFor(doc.absolute, doc.fileName)));
    batch.forEach((doc, i) => {
      docs.push({
        path: doc.relative,
        title: titles[i]!,
        slug: docSlug(docFileStem(doc.fileName)),
      });
    });
  }
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: space.root, docs, truncated };
}

/** The walk running for one space, and the one queued behind it. */
interface Walks {
  running?: Promise<DocIndex>;
  queued?: Promise<DocIndex>;
}

/** Walks per limits (the index and the targeted resolve never share one), per space. */
const walksByLimits = new WeakMap<DocIndexLimits, Map<string, Walks>>();

/** Start a walk now and record it as running until it ends. */
function startWalk(
  walks: Map<string, Walks>,
  state: Walks,
  space: DocSpace,
  limits: DocIndexLimits
): Promise<DocIndex> {
  const started = build(space, limits);
  state.running = started;
  const settle = () => {
    if (state.running === started) state.running = undefined;
    if (!state.running && !state.queued) walks.delete(space.key);
  };
  started.then(settle, settle);
  return started;
}

/**
 * Every doc in one space: its path, title and slug, sorted by path, with the
 * space's resolved root.
 *
 * The answer always comes from a walk that started after this call: one
 * already running is waited out, never reused (see the module comment).
 *
 * @param space - The space, from {@link resolveDocSpace}.
 * @param limits - How far to walk; {@link DOC_INDEX_LIMITS} unless said otherwise.
 */
export function buildDocIndex(
  space: DocSpace,
  limits: DocIndexLimits = DOC_INDEX_LIMITS
): Promise<DocIndex> {
  let walks = walksByLimits.get(limits);
  if (!walks) {
    walks = new Map();
    walksByLimits.set(limits, walks);
  }
  const map = walks;
  const state = map.get(space.key) ?? {};
  map.set(space.key, state);
  if (!state.running) return startWalk(map, state, space, limits);
  if (!state.queued) {
    const after = () => {
      state.queued = undefined;
      return startWalk(map, state, space, limits);
    };
    state.queued = state.running.then(after, after);
  }
  return state.queued;
}

/** Forget every cached title. For tests. */
export function resetDocIndexCacheForTests(): void {
  titleCache.clear();
}
