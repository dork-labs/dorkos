import { lazy, type ReactNode } from 'react';
import type { BlintzPlugin } from 'blintz';
import type { DocRef } from '@dorkos/shared/doc-comments';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { DOCS_EXPERIMENT } from '@/layers/shared/model';

// Lazy: `@blintz/comments` loads with the editor, never in the main bundle.
// It suspends inside the caller's own editor boundary, and the editor is only
// rendered once it has loaded, so the editor mounts once.
const DocCommentsSurface = lazy(() =>
  import('./DocCommentsSurface').then((m) => ({ default: m.DocCommentsSurface }))
);

/** Props for {@link DocCommentsFrame}. */
export interface DocCommentsFrameProps {
  /** The doc, when the markdown is a `.md` file on disk; `null` when it is not. */
  doc: DocRef | null;
  /** The markdown the editor shows now (a draft while editing). */
  value: string;
  /**
   * The markdown known to be on disk: the last confirmed save while editing,
   * else what was loaded. Moved comment anchors are saved only against it.
   */
  saved: string;
  /**
   * The editor. Handed the comment plugin to install, or `undefined` while
   * the Docs experiment is off or the markdown is not a file.
   */
  children: (plugins: BlintzPlugin[] | undefined) => ReactNode;
}

/**
 * Comments around a markdown editor (DOR-2983), for a file-backed doc and only
 * while the Docs experiment is on.
 *
 * The editor is not rendered until the config has said whether the
 * experiment is on, so it never mounts once without its plugins and again
 * with them. For a file, the editor then always sits inside the comments
 * surface, on or off, so the experiment flipping never remounts it; off, the
 * surface hands the editor nothing and shows nothing.
 *
 * Render it inside the editor's `Suspense`: the comments chunk suspends there.
 */
export function DocCommentsFrame({ doc, value, saved, children }: DocCommentsFrameProps) {
  const { enabled, isLoading } = useExperimentEnabledState(DOCS_EXPERIMENT);
  if (isLoading) return null;
  if (!doc) return <>{children(undefined)}</>;
  return (
    <DocCommentsSurface doc={doc} enabled={enabled} value={value} saved={saved}>
      {children}
    </DocCommentsSurface>
  );
}
