/**
 * Wiki links for one open doc (DOR-2982): `[[target]]` resolves to a doc in
 * the same space, `[[` offers the space's docs, and opening a link opens that
 * doc in the canvas, the way the file tree opens one.
 *
 * @module features/docs/model/use-doc-wiki-links
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import type { WikiLinkOptions } from 'blintz';
import { createDocLinkIndex, docTitleFromText } from '@dorkos/shared/doc-links';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { useDocIndex, useInvalidateDocIndex } from '@/layers/entities/doc';
import { executeUiCommand } from '@/layers/shared/lib';
import { DOCS_EXPERIMENT, useAppStore, useTheme, useTransport } from '@/layers/shared/model';
import { docPathInSpace } from '../lib/doc-path';
import { createWikiLinkOptions } from '../lib/wiki-link-options';

/** What {@link useDocWikiLinks} needs to know about the open doc. */
export interface UseDocWikiLinksInput {
  /** The working directory the doc was opened from: the space's root. */
  cwd: string | null;
  /** The doc's `sourcePath`, or `null` for a doc with no file behind it. */
  sourcePath: string | null | undefined;
  /** The doc's markdown as the editor holds it. */
  content?: string;
  /**
   * True once the doc's latest save landed. When it turns true and the saved
   * text gives the doc a title the index does not have (or the index does not
   * list the doc yet), the index is read again, so links by that title work.
   */
  saved?: boolean;
}

/**
 * The `wikiLinks` prop for the editor of one file-backed doc, or `undefined`
 * while the Docs experiment is off, the doc has no file in the space, or the
 * space's docs have not arrived (links then show as plain text, never as
 * missing).
 *
 * The returned object keeps its identity until the index's data, the doc, or
 * the experiment changes, because Blintz caches each resolution for as long
 * as `resolve` stays the same function: a new index is what makes a
 * just-created doc stop showing as missing.
 *
 * @param input - The open doc.
 */
export function useDocWikiLinks({
  cwd,
  sourcePath,
  content = '',
  saved = false,
}: UseDocWikiLinksInput): WikiLinkOptions | undefined {
  const { enabled } = useExperimentEnabledState(DOCS_EXPERIMENT);
  const active = enabled && Boolean(cwd) && Boolean(sourcePath);
  const { data } = useDocIndex(cwd, active);
  const invalidate = useInvalidateDocIndex();
  const transport = useTransport();
  const { setTheme } = useTheme();

  // The doc's place in the space: against the working directory, or the
  // server's resolved root when an absolute path names it through a symlink.
  const docPath =
    active && data && cwd && sourcePath
      ? (docPathInSpace(cwd, sourcePath) ?? docPathInSpace(data.root, sourcePath))
      : null;

  const index = useMemo(() => (data ? createDocLinkIndex(data.docs) : null), [data]);

  // Re-read the index after a save only when the saved text changes what the
  // index says about this doc: its title, or that it is listed at all.
  const latest = useRef({ index, docPath, content, cwd });
  useEffect(() => {
    latest.current = { index, docPath, content, cwd };
  });
  useEffect(() => {
    const { index: current, docPath: path, content: text, cwd: dir } = latest.current;
    if (!saved || !current || path === null) return;
    const listed = current.docs.find(
      (doc) => doc.path.normalize('NFC').toLowerCase() === path.toLowerCase()
    );
    const fileName = path.slice(path.lastIndexOf('/') + 1);
    if (!listed || listed.title !== docTitleFromText(text, fileName)) invalidate(dir);
  }, [saved, invalidate]);

  const open = useCallback(
    (path: string) => {
      // The same seam the file tree and the agent's `open_file` drive, so a
      // link opens the doc exactly as clicking it in the tree would.
      executeUiCommand(
        { getStore: useAppStore.getState, setTheme, supportsTerminal: transport.supportsTerminal },
        { action: 'open_file', sourcePath: path },
        'user'
      );
    },
    [setTheme, transport]
  );

  return useMemo(() => {
    if (!index || !data || docPath === null || !cwd) return undefined;
    return createWikiLinkOptions({
      index,
      truncated: data.truncated,
      docPath,
      lookup: (target) => transport.resolveDocLink(cwd, target, docPath),
      open,
      refuse: (message) => toast.info(message),
    });
  }, [index, data, docPath, cwd, transport, open]);
}
