/**
 * Wiki links for one open doc (DOR-2982): `[[target]]` resolves to a doc in
 * the same space, `[[` offers the space's docs, and opening a link opens that
 * doc in the canvas, the way the file tree opens one.
 *
 * @module features/docs/model/use-doc-wiki-links
 */
import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import type { WikiLink, WikiLinkOptions, WikiLinkResolution } from 'blintz';
import { createDocLinkIndex, relativeDocHref } from '@dorkos/shared/doc-links';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { useDocIndex, useInvalidateDocIndex } from '@/layers/entities/doc';
import { executeUiCommand } from '@/layers/shared/lib';
import { DOCS_EXPERIMENT, useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { docPathInSpace } from '../lib/doc-path';

/** What {@link useDocWikiLinks} needs to know about the open doc. */
export interface UseDocWikiLinksInput {
  /** The working directory the doc was opened from: the space's root. */
  cwd: string | null;
  /** The doc's `sourcePath`, or `null` for a doc with no file behind it. */
  sourcePath: string | null | undefined;
  /**
   * True once the doc's latest save landed. Each time it turns true the
   * space's index is read again, so a title the save changed reaches links.
   */
  saved?: boolean;
}

/**
 * The `wikiLinks` prop for the editor of one file-backed doc, or `undefined`
 * while the Docs experiment is off, the doc has no file in the space, or the
 * space's docs have not arrived (links then show as plain text, never as
 * missing).
 *
 * `resolve` and `search` answer at once from the index. The returned object
 * keeps its identity until the index's data, the doc, or the experiment
 * changes, because Blintz caches each resolution for as long as `resolve`
 * stays the same function: a new index is what makes a just-created doc stop
 * showing as missing.
 *
 * @param input - The open doc.
 */
export function useDocWikiLinks({
  cwd,
  sourcePath,
  saved = false,
}: UseDocWikiLinksInput): WikiLinkOptions | undefined {
  const { enabled } = useExperimentEnabledState(DOCS_EXPERIMENT);
  const docPath = cwd && sourcePath ? docPathInSpace(cwd, sourcePath) : null;
  const active = enabled && docPath !== null;
  const { data } = useDocIndex(cwd, active);
  const invalidate = useInvalidateDocIndex();
  const transport = useTransport();
  const { setTheme } = useTheme();

  useEffect(() => {
    if (active && saved) invalidate(cwd);
  }, [active, saved, cwd, invalidate]);

  const index = useMemo(() => (data ? createDocLinkIndex(data.docs) : null), [data]);

  const open = useCallback(
    (link: WikiLink) => {
      if (!index || docPath === null || link.target.trim() === '') return;
      const doc = index.resolve(link.target, docPath);
      if (!doc) {
        toast.info(`No doc called “${link.target.trim()}” here yet.`);
        return;
      }
      // The same seam the file tree and the agent's `open_file` drive, so a
      // link opens the doc exactly as clicking it in the tree would.
      executeUiCommand(
        { getStore: useAppStore.getState, setTheme, supportsTerminal: transport.supportsTerminal },
        { action: 'open_file', sourcePath: doc.path },
        'user'
      );
    },
    [index, docPath, setTheme, transport]
  );

  return useMemo(() => {
    if (!active || !index || docPath === null) return undefined;
    const resolve = (link: WikiLink): WikiLinkResolution => {
      if (link.target.trim() === '') {
        // `[[#heading]]` points into this doc.
        return link.heading
          ? { exists: true, href: relativeDocHref(docPath, docPath, link.heading) }
          : { exists: false };
      }
      const doc = index.resolve(link.target, docPath);
      return doc
        ? { exists: true, href: relativeDocHref(docPath, doc.path, link.heading), title: doc.title }
        : { exists: false };
    };
    return {
      resolve,
      search: (query: string) => index.search(query, docPath),
      onOpen: open,
    };
  }, [active, index, docPath, open]);
}
