import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useIsTouchOnly } from '@/layers/shared/model';
import type { EditingSurface } from '../editing-surface';
import { createTextareaSurface } from '../textarea-surface';
import { useTextareaResize } from '../use-textarea-resize';
import type { ComposerFieldHandle, ComposerFieldProps } from './ComposerFieldProps';

/**
 * The composer's plain-text field — a `<textarea>`, exactly the one the composer
 * used to render inline.
 *
 * Moved out whole rather than rewritten: the markup, the class strings, the ARIA
 * quartet and the growth behaviour are character for character what shipped, so
 * the rendered DOM is identical and the composer's DOM-parity baselines diff
 * empty. What changed is only who owns them.
 */
export const TextareaField = forwardRef<ComposerFieldHandle, ComposerFieldProps>(
  function TextareaField(
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
      paletteListboxId,
      activeDescendantId,
      onSurfaceChange,
    },
    ref
  ) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const isTouchOnly = useIsTouchOnly();

    // Built once, after mount, and reported up. The factory closes over the ref
    // OBJECT — stable for the life of this component — so the same surface is
    // handed up every time and the ladder's callback identity never churns on
    // it, however often the host re-renders.
    const surfaceRef = useRef<EditingSurface | null>(null);
    useEffect(() => {
      surfaceRef.current ??= createTextareaSurface(textareaRef);
      onSurfaceChange(surfaceRef.current);
    }, [onSurfaceChange]);

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      focusUnlessTouch: () => {
        if (isTouchOnly) return;
        textareaRef.current?.focus();
      },
      focusAt: (pos: number) => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(pos, pos);
      },
    }));

    // Sizing is driven by `value` alone, so a programmatic change (a queued item
    // opened for edit, a restored draft, a seeded prompt) grows the box exactly
    // the way typing does.
    useTextareaResize(textareaRef, value);

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onChange(e.target.value);
        onCursorChange?.(e.target.selectionStart);
      },
      [onChange, onCursorChange]
    );

    const handleSelect = useCallback(() => {
      if (textareaRef.current) onCursorChange?.(textareaRef.current.selectionStart);
    }, [onCursorChange]);

    const hasText = value.trim().length > 0;

    return (
      <div className="relative min-h-[24px] flex-1">
        {!hasText && placeholderOverlay}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          onSelect={handleSelect}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={isPaletteOpen ? paletteListboxId : undefined}
          aria-expanded={isPaletteOpen ?? false}
          aria-activedescendant={isPaletteOpen ? activeDescendantId : undefined}
          // The visual placeholder may render as an overlay (AnimatedPlaceholder),
          // which empties the native placeholder attr — the aria-label keeps the
          // combobox's accessible name stable in both modes.
          aria-label={placeholder}
          placeholder={placeholderOverlay ? '' : placeholder}
          className="block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent py-0.5 text-sm focus:outline-none"
          rows={1}
        />
      </div>
    );
  }
);
