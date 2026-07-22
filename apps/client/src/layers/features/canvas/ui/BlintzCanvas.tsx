import { useEffect, useState } from 'react';
import { MarkdownEditor } from 'blintz';
import './blintz.css';
import { cn } from '@/layers/shared/lib';
import { useTheme } from '@/layers/shared/model';

/** Props for {@link BlintzCanvas}. */
export interface BlintzCanvasProps {
  /** Current markdown document. Seeds the editor; on divergence it re-seeds. */
  value: string;
  /** When `false`, render read-only — no editing chrome, no keyboard input. */
  editable: boolean;
  /** Called with the new markdown on each edit (edit mode only). */
  onChange?: (markdown: string) => void;
  /** Extra class on the editor host element. */
  className?: string;
}

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Whether the OS currently prefers a dark color scheme (false when unavailable). */
function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(DARK_MEDIA_QUERY).matches
  );
}

/**
 * Resolve the app's theme preference to a concrete `light`/`dark`, following the
 * OS live when the preference is `system` — the same resolution the app applies
 * to the root `.dark` class. Forwarded to Blintz as `data-theme` so DorkOS's
 * explicit choice wins over Blintz's own OS media query in both directions.
 */
function useResolvedTheme(): 'light' | 'dark' {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Track the OS preference regardless of the current setting, so switching to
  // `system` (or the OS flipping while on `system`) is reflected live. Only the
  // change handler sets state — never the effect body — so no cascading render.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DARK_MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (theme === 'light' || theme === 'dark') return theme;
  return systemDark ? 'dark' : 'light';
}

/**
 * Thin controlled wrapper around Blintz's `<MarkdownEditor>` for the canvas.
 *
 * Isolates the heavy `blintz` import (Milkdown + ProseMirror + CodeMirror +
 * KaTeX) and its stylesheet to a single module, so the canvas can lazy-load it
 * only when a markdown document renders — never for the `url` / `json` canvas
 * variants or the main bundle — and tests have one module to mock.
 *
 * Forwards the app's resolved theme as `data-theme` on the wrapper so the host's
 * explicit light/dark choice beats the OS preference in Blintz's own CSS (fixes
 * black-on-black markdown when the OS is dark but the app is light).
 */
export function BlintzCanvas({ value, editable, onChange, className }: BlintzCanvasProps) {
  const resolvedTheme = useResolvedTheme();
  return (
    // `display: contents` — the wrapper exists only to carry `data-theme` as an
    // ancestor of Blintz's `.milkdown`; it adds no box, so layout is unchanged.
    <div data-theme={resolvedTheme} className="contents">
      {/* desktop-darwin:select-text — the desktop shell defaults chrome to
          non-selectable (index.css). Canvas documents are content, and in view
          mode (`editable={false}`) the ProseMirror surface is NOT contenteditable,
          so without this the body-level user-select:none would make the document
          unselectable (DOR-253). */}
      <MarkdownEditor
        value={value}
        editable={editable}
        onChange={onChange}
        className={cn('desktop-darwin:select-text', className)}
      />
    </div>
  );
}
