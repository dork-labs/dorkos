import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { unifiedMergeView, getChunks, MergeView } from '@codemirror/merge';

/** Props for {@link CodeMirrorDiff}. */
export interface CodeMirrorDiffProps {
  /** The pre-edit content (diff "before" / original). */
  baseline: string;
  /** The current on-disk content (diff "after" / editor doc). */
  current: string;
  /** Resolved editor theme. */
  theme: 'light' | 'dark';
  /** File name used to auto-detect the syntax language. */
  filename: string;
  /** When `true`, render the two-column MergeView; otherwise the inline unified view. */
  sideBySide: boolean;
  /**
   * Called when a hunk is rejected — the editor's built-in `rejectChunk`
   * reverts that hunk in the doc, producing the reverted full-file text, which we
   * route to disk instead of leaving it as an in-editor mutation.
   */
  onRejectHunk: (revertedContent: string) => void;
  /** Reports the live count of unresolved hunks (falls as the operator accepts/rejects). */
  onHunkCountChange: (count: number) => void;
}

/** Resolve a CodeMirror language extension for a filename (grammar loaded on demand). */
function useLanguageExtension(filename: string): Extension[] {
  const [ext, setExt] = useState<Extension[]>([]);
  useEffect(() => {
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, filename);
    if (!description) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sync grammar to file; clear to plain text when no language matches
      setExt([]);
      return;
    }
    void description
      .load()
      .then((support) => {
        if (!cancelled) setExt([support]);
      })
      .catch(() => {
        if (!cancelled) setExt([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filename]);
  return ext;
}

/**
 * The CodeMirror-merge diff surface for a text file (DOR-212).
 *
 * The whole `@codemirror/merge` runtime lives in this module so it is code-split
 * away from the main bundle (loaded only when a diff first renders), exactly like
 * the file viewer's editor chunk.
 *
 * Unified (default): `@codemirror/merge`'s `unifiedMergeView` renders the inline
 * diff with its per-chunk accept/reject gutter. The editor is non-editable, so
 * the ONLY doc mutation is the built-in `rejectChunk` — we intercept it via
 * `onChange` and hand the reverted text up for a disk write (accept updates the
 * original in-memory and never changes the doc, so it dismisses without a write).
 *
 * Side-by-side: a read-only two-column `MergeView` for comparison on wide
 * viewports; per-hunk actions stay in the unified view.
 */
export function CodeMirrorDiff({
  baseline,
  current,
  theme,
  filename,
  sideBySide,
  onRejectHunk,
  onHunkCountChange,
}: CodeMirrorDiffProps) {
  const languageExtension = useLanguageExtension(filename);

  if (sideBySide) {
    return (
      <SplitDiff
        baseline={baseline}
        current={current}
        theme={theme}
        languageExtension={languageExtension}
      />
    );
  }

  return (
    <UnifiedDiff
      baseline={baseline}
      current={current}
      theme={theme}
      languageExtension={languageExtension}
      onRejectHunk={onRejectHunk}
      onHunkCountChange={onHunkCountChange}
    />
  );
}

/** Inline unified diff with the interactive accept/reject gutter. */
function UnifiedDiff({
  baseline,
  current,
  theme,
  languageExtension,
  onRejectHunk,
  onHunkCountChange,
}: {
  baseline: string;
  current: string;
  theme: 'light' | 'dark';
  languageExtension: Extension[];
  onRejectHunk: (revertedContent: string) => void;
  onHunkCountChange: (count: number) => void;
}) {
  const lastCountRef = useRef<number>(-1);

  const extensions = useMemo(
    () => [
      EditorView.lineWrapping,
      unifiedMergeView({
        original: baseline,
        gutter: true,
        mergeControls: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      }),
      ...languageExtension,
    ],
    [baseline, languageExtension]
  );

  return (
    <CodeMirror
      value={current}
      editable={false}
      readOnly
      theme={theme}
      height="100%"
      className="desktop-darwin:select-text h-full text-sm"
      extensions={extensions}
      basicSetup={{ highlightActiveLine: false, highlightActiveLineGutter: false }}
      // A non-editable doc only changes via the gutter's `rejectChunk`, which
      // produces the reverted full-file text — route it to disk.
      onChange={(value) => onRejectHunk(value)}
      onUpdate={(vu) => {
        const chunks = getChunks(vu.state)?.chunks.length ?? null;
        if (chunks !== null && chunks !== lastCountRef.current) {
          lastCountRef.current = chunks;
          onHunkCountChange(chunks);
        }
      }}
    />
  );
}

/** Read-only two-column comparison (baseline | current) for wide viewports. */
function SplitDiff({
  baseline,
  current,
  theme,
  languageExtension,
}: {
  baseline: string;
  current: string;
  theme: 'light' | 'dark';
  languageExtension: Extension[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const readOnly: Extension[] = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      ...(theme === 'dark' ? [darkThemeHint()] : []),
      ...languageExtension,
    ];
    const view = new MergeView({
      a: { doc: baseline, extensions: readOnly },
      b: { doc: current, extensions: readOnly },
      parent,
      collapseUnchanged: { margin: 3, minSize: 4 },
      highlightChanges: true,
      gutter: true,
    });
    return () => view.destroy();
  }, [baseline, current, theme, languageExtension]);

  return <div ref={hostRef} className="cm-diff-split h-full overflow-auto text-sm" />;
}

/** Minimal dark-surface hint for the raw MergeView editors (the app theme is applied by @uiw elsewhere). */
function darkThemeHint(): Extension {
  return EditorView.theme(
    { '&': { backgroundColor: 'transparent', color: 'inherit' } },
    { dark: true }
  );
}
