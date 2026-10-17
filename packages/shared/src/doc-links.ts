/**
 * Wiki links between docs in one space (DOR-2982): the doc index the server
 * serves, and the one set of rules that turns what an author typed between
 * `[[` and `]]` into a doc.
 *
 * The client resolves links and fills the `[[` menu with these rules; any
 * later server-side reader of links (backlinks, publishing) uses the same
 * ones, so a link never points one place in the editor and another on the
 * server.
 *
 * **What a target can be.** The title (frontmatter `title:`, else the first
 * `# ` heading, else the file name), the slug (the file name without `.md`,
 * lowercased, spaces as `-`), the file name itself, or a path (`notes/plan`,
 * `notes/plan.md`). Matching ignores case and surrounding spaces. A path
 * starting with `/` is read from the space's root; any other path from the
 * linking doc's folder first, then from the root. A target that matches no
 * path is still tried as a name, because titles may contain `/`.
 *
 * **When names collide**, the doc nearest the linking doc wins: same folder
 * first, then the fewest folder steps away, then the shorter path, then the
 * path in plain string order, so the answer never depends on index order.
 *
 * Browser-safe: no Node imports.
 *
 * @module shared/doc-links
 */
import { z } from 'zod';

/** One doc in a space's index. */
export const DocIndexEntrySchema = z.object({
  /** Relative to the space root: forward slashes, no leading slash, `.md` kept. */
  path: z.string().min(1),
  /** Frontmatter `title:`, else the first `# ` heading, else the file name. */
  title: z.string(),
  /** The file name without `.md`, lowercased, spaces as `-` ({@link docSlug}). */
  slug: z.string(),
});

/** One doc in a space's index. */
export type DocIndexEntry = z.infer<typeof DocIndexEntrySchema>;

/** `GET /api/documents/index`: every doc in one space. */
export const DocIndexSchema = z.object({
  docs: z.array(DocIndexEntrySchema),
  /** True when the walk stopped at a limit, so some docs are not listed. */
  truncated: z.boolean(),
});

/** Every doc in one space. */
export type DocIndex = z.infer<typeof DocIndexSchema>;

/** `GET /api/documents/index` query: the folder the docs are reached from. */
export const DocIndexQuerySchema = z.object({
  cwd: z.string().min(1),
});

/** The file extension a doc has. */
export const DOC_EXTENSION = '.md';

/** One `[[` menu entry, in the shape Blintz takes. */
export interface DocLinkSuggestion {
  /** What gets written between the brackets; resolves back to this doc. */
  target: string;
  /** The doc's title. */
  title: string;
  /** The doc's path, so two docs with one title can be told apart. */
  description: string;
}

/** Compare form: Unicode NFC, trimmed, lowercased. */
function fold(text: string): string {
  return text.normalize('NFC').trim().toLowerCase();
}

/**
 * The slug of a name: NFC, trimmed, lowercased, each run of spaces as one `-`.
 * Letters outside ASCII are kept.
 *
 * @param name - A file name without its extension, or a typed target.
 */
export function docSlug(name: string): string {
  return fold(name).replace(/\s+/g, '-');
}

/** `name` without a trailing `.md`, in any case. */
function withoutDocExtension(name: string): string {
  return name.toLowerCase().endsWith(DOC_EXTENSION) ? name.slice(0, -DOC_EXTENSION.length) : name;
}

/** The last segment of a forward-slash path. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The folder part of a forward-slash path, `''` at the root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** A folder's segments; the root has none. */
function segments(folder: string): string[] {
  return folder === '' ? [] : folder.split('/');
}

/**
 * Join `relative` onto `folder` and resolve `.` and `..`, or `null` when the
 * result would leave the space.
 */
function joinWithin(folder: string, relative: string): string | null {
  const out = segments(folder);
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length === 0 ? null : out.join('/');
}

/** Folder steps between two folders: up from `from` to the shared part, then down. */
function folderDistance(from: string, to: string): number {
  const a = segments(from);
  const b = segments(to);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return a.length - common + (b.length - common);
}

/**
 * The anchor for a heading, GitHub style: lowercased, spaces as `-`, and
 * nothing kept but letters, digits, `-` and `_`.
 *
 * @param heading - The heading as typed after `#`.
 */
export function docHeadingAnchor(heading: string): string {
  return docSlug(heading).replace(/[^\p{L}\p{N}_-]/gu, '');
}

/**
 * A relative URL from one doc to another, each path segment percent-encoded,
 * with the heading's anchor when one is given. A link to the doc itself is
 * just the anchor, or the file name when there is no heading.
 *
 * @param fromPath - The linking doc's path in the space, or `null` from the root.
 * @param toPath - The target doc's path in the space.
 * @param heading - The heading after `#`, or `null`.
 */
export function relativeDocHref(
  fromPath: string | null,
  toPath: string,
  heading: string | null = null
): string {
  const anchor = heading && heading.trim() !== '' ? `#${docHeadingAnchor(heading)}` : '';
  if (fromPath === toPath && anchor) return anchor;
  const from = segments(fromPath === null ? '' : folderOf(fromPath));
  const to = toPath.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common += 1;
  const up = Array.from({ length: from.length - common }, () => '..');
  const href = [...up, ...to.slice(common)].map(encodeURIComponent).join('/');
  return href + anchor;
}

/** Characters a target cannot hold and still be one wiki link. */
const UNWRITABLE_TARGET = /[[\]|#\n\r]/;

/** An index entry with its compare keys worked out once. */
interface Keyed {
  doc: DocIndexEntry;
  folder: string;
  path: string;
  title: string;
  base: string;
}

/** Resolves wiki-link targets and suggests docs over one space's index. */
export interface DocLinkIndex {
  /** Every doc, as given. */
  readonly docs: readonly DocIndexEntry[];
  /**
   * The doc a target names, or `null` when none does.
   *
   * @param target - What the author typed before `#` and `|`, as typed.
   * @param fromPath - The linking doc's path, or `null` when it has none.
   */
  resolve(target: string, fromPath: string | null): DocIndexEntry | null;
  /**
   * Docs for the `[[` menu, best match first. An empty query lists the docs
   * nearest the linking doc. The linking doc itself is never offered.
   *
   * @param query - What the author typed after `[[`.
   * @param fromPath - The linking doc's path, or `null` when it has none.
   * @param limit - The most suggestions to return.
   */
  search(query: string, fromPath: string | null, limit?: number): DocLinkSuggestion[];
}

/** How many `[[` suggestions {@link DocLinkIndex.search} returns by default. */
export const DOC_LINK_SEARCH_LIMIT = 20;

/**
 * Build the link rules over one space's docs. Build it once per index and
 * reuse it: the compare keys are worked out here.
 *
 * @param docs - The space's docs, e.g. {@link DocIndex.docs}.
 */
export function createDocLinkIndex(docs: readonly DocIndexEntry[]): DocLinkIndex {
  const keyed: Keyed[] = docs.map((doc) => ({
    doc,
    folder: folderOf(doc.path),
    path: fold(doc.path),
    title: fold(doc.title),
    base: fold(withoutDocExtension(baseName(doc.path))),
  }));
  const byPath = new Map(keyed.map((entry) => [entry.path, entry]));

  /** Nearest first, then shorter path, then plain path order. */
  const nearest = (fromFolder: string) => (a: Keyed, b: Keyed) =>
    folderDistance(fromFolder, a.folder) - folderDistance(fromFolder, b.folder) ||
    a.doc.path.length - b.doc.path.length ||
    (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0);

  /** The doc a path-shaped target names, trying the linking doc's folder first. */
  function byTypedPath(typed: string, fromFolder: string): Keyed | undefined {
    const bare = withoutDocExtension(typed);
    const bases = typed.startsWith('/') ? [''] : [fromFolder, ''];
    for (const base of bases) {
      const joined = joinWithin(base, bare);
      if (joined === null) continue;
      const hit = byPath.get(fold(joined + DOC_EXTENSION));
      if (hit) return hit;
    }
    return undefined;
  }

  function resolveKeyed(target: string, fromPath: string | null): Keyed | null {
    const typed = target.normalize('NFC').trim();
    if (typed === '') return null;
    const fromFolder = fromPath === null ? '' : folderOf(fromPath);
    if (typed.includes('/')) {
      const hit = byTypedPath(typed, fromFolder);
      if (hit) return hit;
    }
    const name = fold(typed);
    const bare = fold(withoutDocExtension(typed));
    const slug = docSlug(bare);
    const matches = keyed.filter(
      (entry) => entry.title === name || entry.base === bare || entry.doc.slug === slug
    );
    if (matches.length === 0) return null;
    return matches.sort(nearest(fromFolder))[0] ?? null;
  }

  /** The first way of writing a link to `entry` that resolves back to it. */
  function targetFor(entry: Keyed, fromPath: string | null): string | null {
    const candidates = [
      entry.doc.title.trim(),
      withoutDocExtension(baseName(entry.doc.path)),
      `/${withoutDocExtension(entry.doc.path)}`,
    ];
    for (const candidate of candidates) {
      if (candidate === '' || UNWRITABLE_TARGET.test(candidate)) continue;
      if (resolveKeyed(candidate, fromPath) === entry) return candidate;
    }
    return null;
  }

  return {
    docs,
    resolve: (target, fromPath) => resolveKeyed(target, fromPath)?.doc ?? null,
    search(query, fromPath, limit = DOC_LINK_SEARCH_LIMIT) {
      const q = fold(query);
      const fromFolder = fromPath === null ? '' : folderOf(fromPath);
      const self = fromPath === null ? null : fold(fromPath);
      const scored: { entry: Keyed; score: number }[] = [];
      for (const entry of keyed) {
        if (entry.path === self) continue;
        const score =
          q === ''
            ? 0
            : entry.title.startsWith(q)
              ? 0
              : entry.title.split(/[\s\-_/]+/).some((word) => word.startsWith(q))
                ? 1
                : entry.title.includes(q)
                  ? 2
                  : entry.path.includes(q)
                    ? 3
                    : -1;
        if (score >= 0) scored.push({ entry, score });
      }
      const order = nearest(fromFolder);
      scored.sort((a, b) => a.score - b.score || order(a.entry, b.entry));
      const out: DocLinkSuggestion[] = [];
      for (const { entry } of scored) {
        if (out.length >= limit) break;
        const target = targetFor(entry, fromPath);
        if (target === null) continue;
        out.push({ target, title: entry.doc.title, description: entry.doc.path });
      }
      return out;
    },
  };
}
