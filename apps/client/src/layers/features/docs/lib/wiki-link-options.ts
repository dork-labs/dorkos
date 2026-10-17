/**
 * The `wikiLinks` options for one open doc, built over the space's index
 * (DOR-2982). Pure apart from the callbacks it is handed, so the rules for
 * what a link shows and does sit in one place the hook only wires up.
 *
 * @module features/docs/lib/wiki-link-options
 */
import type { WikiLink, WikiLinkOptions, WikiLinkResolution } from 'blintz';
import {
  relativeDocHref,
  type DocIndexEntry,
  type DocLinkIndex,
  type DocResolve,
} from '@dorkos/shared/doc-links';

/** Shown on a `[[#heading]]` link, which points into the open doc. */
export const SELF_LINK_TITLE = 'Links within this doc don’t open.';
/** Shown when even the whole-space look stopped before finding the doc. */
export const TOO_BIG_TITLE = 'This folder is too big to check this link.';
/** Shown when the whole-space look failed. */
export const UNCHECKED_TITLE = 'Couldn’t check this link.';

/** What {@link createWikiLinkOptions} builds on. */
export interface WikiLinkOptionsInput {
  /** The space's docs. */
  index: DocLinkIndex;
  /** Whether the index stopped at a limit, so a miss is not yet missing. */
  truncated: boolean;
  /** The open doc's path in the space. */
  docPath: string;
  /** Look one target up through the whole space. */
  lookup: (target: string) => Promise<DocResolve>;
  /** Open a doc by its path in the space. */
  open: (path: string) => void;
  /** Tell the person a link could not be opened, and why. */
  refuse: (message: string) => void;
}

/** What a found doc looks like as a link from the open doc. */
function found(docPath: string, doc: DocIndexEntry, heading: string | null): WikiLinkResolution {
  return { exists: true, href: relativeDocHref(docPath, doc.path, heading), title: doc.title };
}

/**
 * Build the options. `resolve` and `search` answer at once from the index;
 * only a target a truncated index cannot place is looked up, once, and the
 * answer is shared by `resolve` and `onOpen`. A miss in a complete index is
 * missing; a miss the whole-space look could not settle is never shown as
 * missing.
 *
 * @param input - The index, the open doc and the callbacks.
 */
export function createWikiLinkOptions(input: WikiLinkOptionsInput): WikiLinkOptions {
  const { index, truncated, docPath, lookup, open, refuse } = input;
  const lookups = new Map<string, Promise<DocResolve | null>>();
  const lookUp = (target: string) => {
    const key = target.normalize('NFC').trim().toLowerCase();
    let pending = lookups.get(key);
    if (!pending) {
      pending = lookup(target.trim()).catch(() => null);
      lookups.set(key, pending);
    }
    return pending;
  };

  const resolve = (link: WikiLink): WikiLinkResolution | Promise<WikiLinkResolution> => {
    if (link.target.trim() === '') return { exists: false, title: SELF_LINK_TITLE };
    const doc = index.resolve(link.target, docPath);
    if (doc) return found(docPath, doc, link.heading);
    if (!truncated) return { exists: false };
    return lookUp(link.target).then((answer) => {
      if (answer === null) return { exists: true, title: UNCHECKED_TITLE };
      if (answer.doc) return found(docPath, answer.doc, link.heading);
      return answer.complete ? { exists: false } : { exists: true, title: TOO_BIG_TITLE };
    });
  };

  const onOpen = (link: WikiLink) => {
    const target = link.target.trim();
    if (target === '') {
      refuse(SELF_LINK_TITLE);
      return;
    }
    const missing = `No doc called “${target}” here yet.`;
    const doc = index.resolve(target, docPath);
    if (doc) {
      open(doc.path);
      return;
    }
    if (!truncated) {
      refuse(missing);
      return;
    }
    void lookUp(target).then((answer) => {
      if (answer?.doc) open(answer.doc.path);
      else refuse(answer === null ? UNCHECKED_TITLE : answer.complete ? missing : TOO_BIG_TITLE);
    });
  };

  return { resolve, search: (query: string) => index.search(query, docPath), onOpen };
}
