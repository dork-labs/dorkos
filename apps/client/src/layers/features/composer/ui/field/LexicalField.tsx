/**
 * The composer's rich-text field — the lazy chunk root for everything Lexical.
 *
 * Satisfies `ComposerFieldProps` exactly, so `ComposerInput` renders it or
 * `TextareaField` without knowing which. Every Lexical import in the client
 * lives at or below this directory; nothing above it may import one, or the
 * flag-off bundle stops being free.
 *
 * @module features/composer/ui/field/LexicalField
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { registerMarkdownShortcuts } from '@lexical/markdown';
import type { EditorThemeClasses } from 'lexical';
import { useIsTouchOnly } from '@/layers/shared/model';
import type { EditingSurface } from '../editing-surface';
import type { ComposerFieldHandle, ComposerFieldProps } from './ComposerFieldProps';
import { COMPOSER_NODES } from './lexical-nodes';
import { createLexicalSurface } from './lexical-surface';
import { COMPOSER_TRANSFORMERS } from './lexical-transformers';
import { useLadderCommands } from './use-ladder-commands';
import { useMentionNodes } from './use-mention-nodes';
import { usePastePrecedence } from './use-paste-precedence';
import { useLexicalValue } from './use-lexical-value';

/**
 * How the composer's own nodes are drawn.
 *
 * Sized against the field's `text-sm` body rather than against a document: the
 * message box is one line tall at rest, so an `h1` that behaved like a page
 * heading would shove the send button off the card.
 */
const COMPOSER_THEME: EditorThemeClasses = {
  paragraph: 'm-0',
  heading: {
    h1: 'text-base font-semibold',
    h2: 'text-sm font-semibold',
    h3: 'text-sm font-medium',
  },
  list: {
    ul: 'list-disc pl-5',
    ol: 'list-decimal pl-5',
    listitem: 'ml-0',
  },
  text: {
    bold: 'font-semibold',
    italic: 'italic',
    code: 'bg-muted rounded px-1 py-0.5 font-mono text-[0.9em]',
  },
};

/**
 * What to do when Lexical throws.
 *
 * Rethrown in development, because a swallowed editor error leaves a composer
 * that looks fine and drops keystrokes — the worst possible failure for the box
 * everything is typed into. Reported and survived in production, where losing
 * the whole surface is worse than losing one update.
 *
 * @param error - Whatever Lexical threw.
 */
function onEditorError(error: Error): void {
  if (import.meta.env.DEV) throw error;
  console.error('[composer] editor error', error);
}

/** The field's own classes — the textarea's, minus the ones only it needs. */
const EDITABLE_CLASS =
  'block max-h-[200px] min-h-[24px] w-full overflow-y-auto bg-transparent py-0.5 text-sm focus:outline-none';

/**
 * The part that lives inside the composer context, where the editor exists.
 *
 * Split out because `useLexicalComposerContext` is only callable below
 * `LexicalComposer`, and the imperative handle needs the editor.
 */
const LexicalFieldInner = forwardRef<ComposerFieldHandle, ComposerFieldProps>(
  function LexicalFieldInner(
    {
      value,
      onChange,
      onCursorChange,
      onKeyDown,
      onFocus,
      onBlur,
      placeholder,
      placeholderOverlay,
      isPaletteOpen,
      paletteHasResults,
      paletteListboxId,
      activeDescendantId,
      onSurfaceChange,
      mentionSubjects,
    },
    ref
  ) {
    const [editor] = useLexicalComposerContext();
    const isTouchOnly = useIsTouchOnly();
    const { focusAt } = useLexicalValue({ value, onChange, onCursorChange });

    // Built once from the editor, which is stable for this component's life, so
    // the ladder's callback identity never churns on it.
    const surfaceRef = useRef<EditingSurface | null>(null);
    const [surface, setSurface] = useState<EditingSurface | null>(null);
    useEffect(() => {
      surfaceRef.current ??= createLexicalSurface(editor);
      setSurface(surfaceRef.current);
      onSurfaceChange(surfaceRef.current);
    }, [editor, onSurfaceChange]);

    // What makes `**bold**` become bold as the closing pair lands. Registered
    // here rather than as a plugin component so the transformer set and the
    // node set are configured in one place.
    useEffect(() => registerMarkdownShortcuts(editor, [...COMPOSER_TRANSFORMERS]), [editor]);

    useLadderCommands({ onKeyDown, surface, isPaletteOpen, paletteHasResults });
    usePastePrecedence();
    useMentionNodes(mentionSubjects);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => editor.focus(),
        focusUnlessTouch: () => {
          if (isTouchOnly) return;
          editor.focus();
        },
        focusAt,
      }),
      [editor, isTouchOnly, focusAt]
    );

    const hasText = value.trim().length > 0;
    const showNativePlaceholder = placeholderOverlay === undefined || placeholderOverlay === null;

    // Every attribute here also appears on the textarea, with the same value.
    // A difference is an a11y regression, not a swap — the flag-on baseline
    // review asserts the two maps match.
    const editableProps = {
      className: EDITABLE_CLASS,
      role: 'combobox',
      'aria-autocomplete': 'list' as const,
      'aria-controls': isPaletteOpen ? paletteListboxId : undefined,
      'aria-expanded': isPaletteOpen ?? false,
      'aria-activedescendant': isPaletteOpen ? activeDescendantId : undefined,
      // The visual placeholder may render as an overlay (AnimatedPlaceholder),
      // which suppresses the placeholder element — the aria-label keeps the
      // combobox's accessible name stable in both modes, exactly as it does on
      // the textarea.
      'aria-label': placeholder,
      'aria-multiline': true,
      // Deliberately NO React `onKeyDown`. The ladder reaches this field through
      // Lexical's commands at critical priority (`use-ladder-commands`), and a
      // synthetic handler here as well would run every rung a second time —
      // one Enter, two sends.
      onFocus,
      onBlur,
    };

    return (
      <div className="relative min-h-[24px] flex-1">
        {!hasText && placeholderOverlay}
        <RichTextPlugin
          contentEditable={
            showNativePlaceholder ? (
              <ContentEditable
                {...editableProps}
                aria-placeholder={placeholder}
                placeholder={
                  <div className="text-muted-foreground pointer-events-none absolute top-0 left-0 py-0.5 text-sm select-none">
                    {placeholder}
                  </div>
                }
              />
            ) : (
              <ContentEditable {...editableProps} />
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
      </div>
    );
  }
);

/**
 * The composer's rich-text field.
 *
 * Formatting appears as you type — bold, italic, inline code, three heading
 * levels and two kinds of list — and everything else stays the literal markdown
 * it already was. What leaves this component is a markdown string and an offset
 * into it, the same pair the plain field hands up.
 *
 * Two deliberate, recorded differences from `TextareaField`: the placeholder is
 * an element rather than a native attribute, and the 200 ms ease-down on an
 * emptied box is gone — that was an artifact of setting a textarea's height
 * imperatively, and a contenteditable grows on its own.
 */
const LexicalField = forwardRef<ComposerFieldHandle, ComposerFieldProps>(
  function LexicalField(props, ref) {
    return (
      <LexicalComposer
        initialConfig={{
          namespace: 'composer',
          nodes: COMPOSER_NODES,
          theme: COMPOSER_THEME,
          onError: onEditorError,
        }}
      >
        <LexicalFieldInner {...props} ref={ref} />
      </LexicalComposer>
    );
  }
);

/**
 * Default-exported because `ComposerInput` reaches it through `React.lazy`,
 * which requires a default. One export, so there is no second name to drift.
 */
export default LexicalField;
