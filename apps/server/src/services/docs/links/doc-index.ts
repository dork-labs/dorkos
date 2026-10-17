/**
 * The docs in one space, for wiki links and the `[[` menu (DOR-2982).
 *
 * A doc is a `.md` file under the space's root ({@link resolveDocSpace}). The
 * walk skips dot-folders, dependency and build folders, and symlinks (a link
 * could point outside the space), and it stops at {@link DOC_INDEX_LIMITS},
 * saying so with `truncated`. Each doc's title comes from the first few KB of
 * the file only: frontmatter `title:`, else the first `# ` heading outside a
 * code block, else the file name.
 *
 * **Why the folders are walked on every request, and only the titles are
 * cached.** The client asks again right after a doc is created, renamed or
 * saved, so a link to it stops showing as missing; a cache over the listing
 * would answer that request with the old list. Listing folders is cheap.
 * Reading files is the cost, so a title is kept per file and reused while the
 * file's modified time and size are unchanged. Two requests for one space at
 * once share one walk.
 *
 * @module server/services/docs/links/doc-index
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DOC_EXTENSION,
  docSlug,
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
  /** How much of each doc is read for its title, in bytes. */
  titleBytes: number;
}

/** The limits every live walk uses. */
export const DOC_INDEX_LIMITS: DocIndexLimits = {
  maxDocs: 2000,
  maxDepth: 8,
  maxFolders: 2000,
  titleBytes: 4096,
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
const READ_CONCURRENCY = 32;

/** Titles kept before the cache starts over. */
const TITLE_CACHE_LIMIT = 20_000;

/** A title, and the file state it was read from. */
interface CachedTitle {
  mtimeMs: number;
  size: number;
  title: string;
}

const titleCache = new Map<string, CachedTitle>();
const inFlight = new Map<string, Promise<DocIndex>>();

/** The file name without `.md`. */
function fileStem(fileName: string): string {
  return fileName.slice(0, fileName.length - DOC_EXTENSION.length);
}

/**
 * A one-line frontmatter value: without the quotes YAML allows around it, or
 * without a trailing ` # comment` when unquoted. A block scalar (`|`, `>`)
 * starts on the next lines, which this does not read, so it gives `''`.
 */
function frontmatterValue(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  if (quoted) return quoted[2]!.trim();
  if (/^[|>][+-]?\d*$/.test(trimmed)) return '';
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * A doc's title from the start of its text.
 *
 * @param head - The first bytes of the doc, decoded. A last line cut short
 *   by the read must already be dropped.
 * @param fileName - The doc's file name, the title when the text gives none.
 */
export function docTitleFromHead(head: string, fileName: string): string {
  const lines = head.replace(/^\uFEFF/, '').split(/\r?\n/);
  let line = 0;
  if (lines[0] === '---') {
    for (line = 1; line < lines.length; line += 1) {
      const text = lines[line]!;
      if (text === '---' || text === '...') break;
      const title = /^title:(.*)$/.exec(text);
      if (title) {
        const value = frontmatterValue(title[1]!);
        if (value !== '') return value;
      }
    }
    line += 1;
  }
  let fence: string | null = null;
  for (; line < lines.length; line += 1) {
    const text = lines[line]!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(text);
    if (heading && heading[1]!.trim() !== '') return heading[1]!.trim();
  }
  return fileStem(fileName);
}

/** Read the start of one doc and work out its title. */
async function readTitle(absolute: string, fileName: string, limit: number): Promise<string> {
  const handle = await fs.open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    let head = buffer.subarray(0, bytesRead).toString('utf8');
    // A read that filled the buffer may have cut the last line in half.
    if (bytesRead === limit) head = head.slice(0, Math.max(0, head.lastIndexOf('\n')));
    return docTitleFromHead(head, fileName);
  } finally {
    await handle.close();
  }
}

/** A doc's title, read again only when the file changed since last time. */
async function titleFor(absolute: string, fileName: string, limits: DocIndexLimits) {
  try {
    const stat = await fs.stat(absolute);
    const cached = titleCache.get(absolute);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.title;
    const title = await readTitle(absolute, fileName, limits.titleBytes);
    if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.clear();
    titleCache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, title });
    return title;
  } catch {
    // Gone or unreadable since the folder was listed: the name still links.
    return fileStem(fileName);
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
  limits: DocIndexLimits
): Promise<{ found: FoundDoc[]; truncated: boolean }> {
  const found: FoundDoc[] = [];
  const queue: { absolute: string; relative: string; depth: number }[] = [
    { absolute: root, relative: '', depth: 0 },
  ];
  let folders = 1;
  let truncated = false;
  for (let next = 0; next < queue.length; next += 1) {
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

/** Walk once and title every doc. */
async function build(space: DocSpace, limits: DocIndexLimits): Promise<DocIndex> {
  const { found, truncated } = await walk(space.root, limits);
  const docs: DocIndexEntry[] = [];
  for (let start = 0; start < found.length; start += READ_CONCURRENCY) {
    const batch = found.slice(start, start + READ_CONCURRENCY);
    const titles = await Promise.all(
      batch.map((doc) => titleFor(doc.absolute, doc.fileName, limits))
    );
    batch.forEach((doc, i) => {
      docs.push({ path: doc.relative, title: titles[i]!, slug: docSlug(fileStem(doc.fileName)) });
    });
  }
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { docs, truncated };
}

/**
 * Every doc in one space: its path, title and slug, sorted by path.
 *
 * @param space - The space, from {@link resolveDocSpace}.
 * @param limits - How far to walk; {@link DOC_INDEX_LIMITS} unless a test says otherwise.
 */
export function buildDocIndex(
  space: DocSpace,
  limits: DocIndexLimits = DOC_INDEX_LIMITS
): Promise<DocIndex> {
  const running = inFlight.get(space.key);
  if (running) return running;
  const started = build(space, limits).finally(() => inFlight.delete(space.key));
  inFlight.set(space.key, started);
  return started;
}

/** Forget every cached title and running walk. For tests. */
export function resetDocIndexCacheForTests(): void {
  titleCache.clear();
  inFlight.clear();
}
