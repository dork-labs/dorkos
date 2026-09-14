import { MarkdownEditor } from 'blintz';
import './blintz.css';
import { cn } from '@/layers/shared/lib';
import { useResolvedTheme } from '@/layers/shared/model';

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

/**
 * Thin controlled wrapper around Blintz's `<MarkdownEditor>` for the canvas.
 *
 * Isolates the heavy `blintz` import (Milkdown + ProseMirror + CodeMirror +
 * KaTeX) and its stylesheet to a single module, so the canvas can lazy-load it
 * only when a markdown document renders — never for the `url` / `json` canvas
 * variants or the main bundle — and tests have one module to mock.
 *
 * Uses the app's resolved theme and semantic colors through Blintz's public
 * theme contract. An open document follows theme changes without remounting.
 */
export function BlintzCanvas({ value, editable, onChange, className }: BlintzCanvasProps) {
  const resolvedTheme = useResolvedTheme();
  return (
    // The ancestor supplies inherited theme tokens without adding another inset.
    <div data-theme={resolvedTheme} className="dorkos-markdown contents">
      {/* desktop:select-text — the desktop shell defaults chrome to
          non-selectable on every platform (index.css). Canvas documents are
          content, and in view mode (`editable={false}`) the ProseMirror surface
          is NOT contenteditable, so without this the body-level
          user-select:none would make the document unselectable (DOR-253). */}
      <MarkdownEditor
        value={value}
        theme={resolvedTheme}
        editable={editable}
        onChange={onChange}
        className={cn('desktop:select-text', className)}
      />
    </div>
  );
}
