import { lazy, Suspense, type ReactNode } from 'react';
import { useLiveDocsOn } from '../model/live-docs-context';

// Lazy: live editing brings Yjs and the Blintz collaboration plugin, loaded
// only when a live doc first opens. The editor itself stays the canvas's own.
const LiveDocEditor = lazy(() =>
  import('@/layers/features/docs').then((m) => ({ default: m.LiveDocEditor }))
);
const BlintzCanvas = lazy(() =>
  import('./BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

/** The files live editing serves: markdown Blintz edits. */
const LIVE_MARKDOWN = /\.(md|markdown)$/i;

/** Props for {@link LiveDocSlot}. */
export interface LiveDocSlotProps {
  /** The session folder, or `null` when there is none. */
  cwd: string | null;
  /** The file, relative to `cwd`, or `undefined` for generated markdown. */
  sourcePath: string | undefined;
  /** Whether this doc may be edited at all. */
  editable: boolean;
  /** The markdown as loaded, handed to the editor (which shows the live copy instead). */
  loaded: string;
  /** Today's editor, unchanged: shown while Docs are off, and whenever live editing is not. */
  children: ReactNode;
  /** Reload the file after a restore while the doc was not live. */
  onRestored?: () => void;
}

/**
 * Where a file-backed markdown doc becomes live (DOR-2984). While live docs
 * are off ({@link useLiveDocsOn}: the `docs.enabled` experiment, read by the
 * shell), or the doc is not an editable markdown file, this renders `children`
 * and nothing else, so the canvas behaves exactly as before.
 */
export function LiveDocSlot({
  cwd,
  sourcePath,
  editable,
  loaded,
  children,
  onRestored,
}: LiveDocSlotProps) {
  const liveDocs = useLiveDocsOn();
  if (!liveDocs || !cwd || !sourcePath || !editable || !LIVE_MARKDOWN.test(sourcePath)) {
    return <>{children}</>;
  }
  const loading = <div className="text-muted-foreground p-4 text-sm">Loading editor…</div>;
  return (
    <Suspense fallback={loading}>
      <LiveDocEditor
        doc={{ cwd, path: sourcePath }}
        fallback={children}
        onRestored={onRestored}
        renderEditor={({ plugins, key }) => (
          <div className="px-2 pb-6">
            <Suspense fallback={loading}>
              <BlintzCanvas key={key} value={loaded} editable plugins={plugins} />
            </Suspense>
          </div>
        )}
      />
    </Suspense>
  );
}
