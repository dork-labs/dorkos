import { lazy, Suspense, useState, type ReactNode } from 'react';
import type { BlintzPlugin } from 'blintz';
import { docRefFor } from '@/layers/entities/doc';
import { DocCommentsFrame, useDocEmbeds, useDocWikiLinks } from '@/layers/features/docs';
import { useLiveDocsOn } from '../model/live-docs-context';

// Lazy: live editing brings Yjs and the Blintz collaboration plugin, loaded
// only when a live doc first opens. The editor itself stays the canvas's own.
const LiveDocEditor = lazy(() =>
  import('@/layers/features/docs').then((m) => ({ default: m.LiveDocEditor }))
);
const BlintzCanvas = lazy(() =>
  import('./BlintzCanvas').then((m) => ({ default: m.BlintzCanvas }))
);

/** What the live editor is handed by `LiveDocEditor`. */
interface LiveBinding {
  plugins: BlintzPlugin[];
  editable: boolean;
  onChange: (markdown: string) => void;
}

/**
 * The live editor with everything today's editor has: wiki links, embeds and
 * comments. The comments plugin and the collaboration plugin go to Blintz as
 * one array.
 */
function LiveBlintz({
  cwd,
  sourcePath,
  loaded,
  binding,
}: {
  cwd: string;
  sourcePath: string;
  loaded: string;
  binding: LiveBinding;
}) {
  // The doc as the editor shows it now, for wiki-link titles and comment
  // anchors. The live copy is saved by the server shortly after each change.
  const [text, setText] = useState(loaded);
  const embeds = useDocEmbeds();
  const wikiLinks = useDocWikiLinks({ cwd, sourcePath, content: text });
  const onChange = (markdown: string) => {
    setText(markdown);
    binding.onChange(markdown);
  };
  return (
    <DocCommentsFrame doc={docRefFor(cwd, sourcePath)} value={text} saved={text}>
      {(commentPlugins) => (
        <BlintzCanvas
          value={loaded}
          editable={binding.editable}
          onChange={onChange}
          wikiLinks={wikiLinks}
          embeds={embeds}
          plugins={[...(commentPlugins ?? []), ...binding.plugins]}
        />
      )}
    </DocCommentsFrame>
  );
}

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
  /** Reload the file: it changed outside today's editor (a restore, a saved draft). */
  onFileChanged?: () => void;
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
  onFileChanged,
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
        onFileChanged={onFileChanged}
        renderEditor={({ key, ...binding }) => (
          <div className="px-2 pb-6">
            <Suspense fallback={loading}>
              <LiveBlintz
                key={key}
                cwd={cwd}
                sourcePath={sourcePath}
                loaded={loaded}
                binding={binding}
              />
            </Suspense>
          </div>
        )}
      />
    </Suspense>
  );
}
