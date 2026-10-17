import { lazy, type ReactNode } from 'react';
import type { BlintzPlugin } from 'blintz';
import type { DocRef } from '@dorkos/shared/doc-comments';
import { useExperimentEnabledState } from '@/layers/entities/config';
import { DOCS_EXPERIMENT } from '@/layers/shared/model';

// Lazy: `@blintz/comments` loads with the editor, never for the main bundle.
// It suspends inside the caller's own editor boundary, so the editor mounts
// once, with its plugins, rather than once without and again with them.
const DocCommentsSurface = lazy(() =>
  import('./DocCommentsSurface').then((m) => ({ default: m.DocCommentsSurface }))
);

/** Props for {@link DocCommentsFrame}. */
export interface DocCommentsFrameProps {
  /** The doc, when the markdown is a file on disk; `null` when it is not. */
  doc: DocRef | null;
  /**
   * The editor. Handed the comment plugin to install, or `undefined` while
   * the Docs experiment is off or the markdown is not a file.
   */
  children: (plugins: BlintzPlugin[] | undefined) => ReactNode;
}

/**
 * Comments around a markdown editor (DOR-2983), for a file-backed doc and only
 * while the Docs experiment is on. Otherwise it renders the editor exactly as
 * it was, with none of the Docs additions.
 *
 * Render it inside the editor's `Suspense`: the comments chunk suspends there.
 */
export function DocCommentsFrame({ doc, children }: DocCommentsFrameProps) {
  const { enabled } = useExperimentEnabledState(DOCS_EXPERIMENT);
  if (!enabled || !doc) return <>{children(undefined)}</>;
  return <DocCommentsSurface doc={doc}>{children}</DocCommentsSurface>;
}
