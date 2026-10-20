import { createRoot } from 'react-dom/client';
import type { MarkdownSourcePort } from 'blintz';
import { BlintzCanvas } from '../src/layers/features/canvas/ui/BlintzCanvas';

// A test-only Vite HTML entry, never imported by the product entry or routes.
// The observer calls the genuine public port; it computes no source offsets.
const host = document.getElementById('blintz-heading-root');
if (!host) throw new Error('Missing browser fixture root');
const root = createRoot(host);
let port: MarkdownSourcePort | undefined;
let currentText = '';
let changes = 0;

interface BlintzHeadingProbe {
  mount(text: string): void;
  snapshot(): unknown;
  selection(): unknown;
  bindSame(): unknown;
  nativeRangeRects(): Array<{ width: number; height: number }>;
  changeCount(): number;
  dispose(): unknown;
}

declare global {
  interface Window {
    __blintzHeadingProbe: BlintzHeadingProbe;
  }
}

window.__blintzHeadingProbe = {
  mount(text) {
    currentText = text;
    root.render(
      <BlintzCanvas
        value={text}
        editable
        sourceRevision="browser-heading-1"
        onSourceReady={(next) => {
          port = next;
        }}
        onChange={() => {
          changes += 1;
        }}
      />
    );
  },
  snapshot: () => port?.snapshot(),
  selection: () => port?.selection(),
  bindSame() {
    if (!port) throw new Error('Genuine public port has not arrived');
    const editor = host.querySelector('.ProseMirror');
    if (!editor) throw new Error('Genuine editor has not mounted');
    const focused = document.activeElement;
    const beforeText = editor.textContent;
    const generation = port.generation();
    const bound = port.bindSource(currentText, generation);
    return {
      bound,
      selection: port.selection(),
      staleSelection: port.selection(generation),
      focusedBefore: focused === editor,
      focusedAfter: document.activeElement === focused,
      sameEditor: host.querySelector('.ProseMirror') === editor,
      sameRenderedText: editor.textContent === beforeText,
    };
  },
  nativeRangeRects() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return [];
    return Array.from(selection.getRangeAt(0).getClientRects(), ({ width, height }) => ({
      width,
      height,
    }));
  },
  changeCount: () => changes,
  dispose() {
    const original = port;
    root.unmount();
    return original?.snapshot();
  },
};
