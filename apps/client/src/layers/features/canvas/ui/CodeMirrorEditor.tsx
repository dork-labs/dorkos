import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

/** Props for {@link CodeMirrorEditor}. */
export interface CodeMirrorEditorProps {
  /** Current document text. */
  value: string;
  /** When `false`, render read-only (no keyboard input, no active-line highlight). */
  editable: boolean;
  /** File name used to auto-detect the syntax language when no explicit hint is given. */
  filename: string;
  /** Explicit CodeMirror language name (e.g. `typescript`); overrides filename detection. */
  languageHint?: string;
  /** Resolved editor theme. */
  theme: 'light' | 'dark';
  /** Called with the new text on each edit (edit mode only). */
  onChange?: (value: string) => void;
}

/**
 * Thin wrapper around `@uiw/react-codemirror` for the canvas file viewer.
 *
 * Isolates the heavy CodeMirror import (state + view + the lazily-loaded
 * language grammar) to a single module so the canvas can `React.lazy` it — the
 * editor bundle never lands in the main chunk, only when a non-markdown file
 * first renders. The syntax language is resolved from `@codemirror/language-data`
 * (by explicit hint or filename) and loaded on demand, so only the grammars a
 * user actually opens are fetched.
 */
export function CodeMirrorEditor({
  value,
  editable,
  filename,
  languageHint,
  theme,
  onChange,
}: CodeMirrorEditorProps) {
  const [languageExtension, setLanguageExtension] = useState<Extension[]>([]);

  useEffect(() => {
    let cancelled = false;
    const description = languageHint
      ? LanguageDescription.matchLanguageName(languages, languageHint, true)
      : LanguageDescription.matchFilename(languages, filename);
    if (!description) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing the editor's grammar to the file: clear to plain text when no language matches
      setLanguageExtension([]);
      return;
    }
    void description
      .load()
      .then((support) => {
        if (!cancelled) setLanguageExtension([support]);
      })
      .catch(() => {
        // A grammar that fails to load degrades to plain text — never fatal.
        if (!cancelled) setLanguageExtension([]);
      });
    return () => {
      cancelled = true;
    };
  }, [filename, languageHint]);

  return (
    <CodeMirror
      value={value}
      editable={editable}
      readOnly={!editable}
      onChange={onChange}
      theme={theme}
      height="100%"
      className="h-full text-sm"
      extensions={[EditorView.lineWrapping, ...languageExtension]}
      basicSetup={{ highlightActiveLine: editable, highlightActiveLineGutter: editable }}
    />
  );
}
