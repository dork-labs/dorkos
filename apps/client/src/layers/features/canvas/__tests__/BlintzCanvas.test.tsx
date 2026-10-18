/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { MarkdownEditorProps, MarkdownSourcePort } from 'blintz';

const editorControl = vi.hoisted(() => ({
  real: false,
  props: undefined as MarkdownEditorProps | undefined,
}));

// Keep theme controls isolated; the public-package case renders the genuine editor.
vi.mock('blintz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('blintz')>();
  return {
    ...actual,
    MarkdownEditor: (props: MarkdownEditorProps) => {
      editorControl.props = props;
      if (editorControl.real) return <actual.MarkdownEditor {...props} />;
      return (
        <div data-testid="markdown-editor" data-editor-theme={props.theme}>
          {props.value}
        </div>
      );
    },
  };
});

// Use the REAL store-backed hook so a theme change actually propagates. use-theme
// is a light module (zustand only), so importActual avoids pulling the whole
// shared/model barrel.
vi.mock('@/layers/shared/model', async () => {
  const theme = await vi.importActual<typeof import('@/layers/shared/model/use-theme')>(
    '@/layers/shared/model/use-theme'
  );
  return { useResolvedTheme: theme.useResolvedTheme };
});

// Import the store from the real module (only the barrel is mocked) — the same
// singleton the component's useResolvedTheme reads via importActual.
import { useThemeStore } from '@/layers/shared/model/use-theme';
import { BlintzCanvas } from '../ui/BlintzCanvas';

/** The wrapper element that carries data-theme (the editor's parent). */
function themeWrapper(): HTMLElement {
  const wrapper = screen.getByTestId('markdown-editor').parentElement;
  if (!wrapper) throw new Error('expected a wrapper element around the editor');
  return wrapper;
}

// jsdom has no layout. Only the genuine editor cursor plugin needs this
// placeholder geometry; these tests assert logical source offsets, not pixels.
// Real browser caret geometry remains a separate acceptance gate.
let rangeClientRectsDescriptor: PropertyDescriptor | undefined;
let rangeClientRectsFixtureInstalled = false;

beforeEach(() => {
  rangeClientRectsFixtureInstalled = false;
  rangeClientRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  if (typeof Range.prototype.getClientRects !== 'function') {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value() {
        const rect = new DOMRect(0, 0, 1, 1);
        return Object.assign([rect], {
          item: (index: number) => (index === 0 ? rect : null),
        });
      },
    });
    rangeClientRectsFixtureInstalled = true;
  }
  editorControl.real = false;
  editorControl.props = undefined;
  act(() => useThemeStore.getState().setTheme('light'));
});
afterEach(() => {
  try {
    cleanup();
  } finally {
    if (rangeClientRectsFixtureInstalled) {
      if (rangeClientRectsDescriptor) {
        Object.defineProperty(Range.prototype, 'getClientRects', rangeClientRectsDescriptor);
      } else {
        Reflect.deleteProperty(Range.prototype, 'getClientRects');
      }
    }
  }
});

describe('BlintzCanvas theme forwarding', () => {
  it('forwards a resolved light theme as data-theme="light"', () => {
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-editor-theme', 'light');
  });

  it('forwards a resolved dark theme as data-theme="dark"', () => {
    act(() => useThemeStore.getState().setTheme('dark'));
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-editor-theme', 'dark');
  });

  it('updates data-theme live when the store theme changes, without remounting the editor', () => {
    render(<BlintzCanvas value="# hi" editable={false} />);
    const editorBefore = screen.getByTestId('markdown-editor');
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-editor-theme', 'light');

    // A theme switch from any surface flows through the shared store (S2).
    act(() => useThemeStore.getState().setTheme('dark'));

    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByTestId('markdown-editor')).toHaveAttribute('data-editor-theme', 'dark');
    // Same editor node — the wrapper re-rendered, the editor was not torn down.
    expect(screen.getByTestId('markdown-editor')).toBe(editorBefore);
  });
});

describe('BlintzCanvas public source callbacks', () => {
  it('forwards the original optional revision and callback identities', () => {
    const onSourceReady = vi.fn<NonNullable<MarkdownEditorProps['onSourceReady']>>();
    const onSourceSelection = vi.fn<NonNullable<MarkdownEditorProps['onSourceSelection']>>();
    const onTaskToggleRequest = vi.fn<NonNullable<MarkdownEditorProps['onTaskToggleRequest']>>();
    render(
      <BlintzCanvas
        value="# raw"
        editable={false}
        sourceRevision="raw-1"
        onSourceReady={onSourceReady}
        onSourceSelection={onSourceSelection}
        onTaskToggleRequest={onTaskToggleRequest}
      />
    );
    expect(editorControl.props?.sourceRevision).toBe('raw-1');
    expect(editorControl.props?.onSourceReady).toBe(onSourceReady);
    expect(editorControl.props?.onSourceSelection).toBe(onSourceSelection);
    expect(editorControl.props?.onTaskToggleRequest).toBe(onTaskToggleRequest);
    expect(onTaskToggleRequest).not.toHaveBeenCalled();
  });

  it('forwards the embed registry by identity, and none when the caller passes none', () => {
    const embeds = { note: { component: () => null } };
    const { unmount } = render(<BlintzCanvas value="::note" editable={false} embeds={embeds} />);
    expect(editorControl.props?.embeds).toBe(embeds);
    unmount();
    render(<BlintzCanvas value="::note" editable={false} />);
    expect(editorControl.props?.embeds).toBeUndefined();
  });

  it('hides embed diagnostics only for a reader with embeds on', () => {
    const embeds = { note: { component: () => null } };
    const wrapper = () => screen.getByTestId('markdown-editor').parentElement!;
    const { unmount } = render(
      <BlintzCanvas value="::note" editable={false} embeds={embeds} embedDiagnostics={false} />
    );
    expect(wrapper()).toHaveAttribute('data-embed-diagnostics', 'off');
    unmount();
    const second = render(<BlintzCanvas value="::note" editable={false} embeds={embeds} />);
    expect(wrapper()).not.toHaveAttribute('data-embed-diagnostics');
    second.unmount();
    // Docs off: no embeds, so Blintz's own placeholders stay as they were.
    render(<BlintzCanvas value="::note" editable={false} embedDiagnostics={false} />);
    expect(wrapper()).not.toHaveAttribute('data-embed-diagnostics');
  });

  it('keeps legacy callers callback-free', () => {
    render(<BlintzCanvas value="# raw" editable={false} />);
    expect(editorControl.props?.sourceRevision).toBeUndefined();
    expect(editorControl.props?.onSourceReady).toBeUndefined();
    expect(editorControl.props?.onSourceSelection).toBeUndefined();
    expect(editorControl.props?.onTaskToggleRequest).toBeUndefined();
  });

  it('receives the genuine published editor port and invalidates an equal-text old revision', async () => {
    editorControl.real = true;
    let port: MarkdownSourcePort | undefined;
    const onSourceReady: NonNullable<MarkdownEditorProps['onSourceReady']> = (next) => {
      port = next;
    };
    const mounted = render(
      <BlintzCanvas
        value="Raw source"
        editable={false}
        sourceRevision="raw-1"
        onSourceReady={onSourceReady}
      />
    );
    await waitFor(() => expect(port?.snapshot().kind).toBe('mapped'));
    const originalPort = port!;
    const oldGeneration = originalPort.generation();
    expect(originalPort.snapshot()).toMatchObject({
      kind: 'mapped',
      value: { text: 'Raw source' },
    });
    mounted.rerender(
      <BlintzCanvas
        value="Raw source"
        editable={false}
        sourceRevision="raw-2"
        onSourceReady={onSourceReady}
      />
    );
    await waitFor(() => expect(originalPort.generation()).not.toBe(oldGeneration));
    expect(originalPort.selection(oldGeneration)).toMatchObject({
      kind: 'unavailable',
      reason: 'stale',
    });
    mounted.unmount();
    expect(originalPort.snapshot()).toMatchObject({ kind: 'unavailable', reason: 'disposed' });
  });
  it.each([
    { text: '# raw', start: 2, end: 5 },
    { text: '# raw 😀', start: 2, end: 8 },
  ])('maps genuine heading source and UTF-16 selection for $text', async ({ text, start, end }) => {
    editorControl.real = true;
    let port: MarkdownSourcePort | undefined;
    const changed = vi.fn();
    const onSourceReady: NonNullable<MarkdownEditorProps['onSourceReady']> = (next) => {
      port = next;
    };
    const mounted = render(
      <BlintzCanvas
        value={text}
        editable
        onChange={changed}
        sourceRevision="heading-1"
        onSourceReady={onSourceReady}
      />
    );
    await waitFor(() =>
      expect(port?.snapshot()).toMatchObject({ kind: 'mapped', value: { text } })
    );
    const editor = mounted.container.querySelector<HTMLElement>('.ProseMirror');
    if (!editor) throw new Error('Expected the genuine published editor');
    editor.focus();
    // Keyboard input selects; only the public port supplies original-source offsets.
    fireEvent.keyDown(editor, { key: 'a', code: 'KeyA', ctrlKey: true });
    await waitFor(() =>
      expect(port!.selection()).toMatchObject({
        kind: 'mapped',
        value: { ranges: [{ start, end }] },
      })
    );
    const selected = port!.selection();
    if (selected.kind !== 'mapped') throw new Error('Expected genuine mapped selection');
    expect(selected.value.ranges).toHaveLength(1);
    expect(text.slice(selected.value.ranges[0]!.start, selected.value.ranges[0]!.end)).toBe(
      text.slice(2)
    );
    const generation = port!.generation();
    const focused = document.activeElement;
    const renderedText = editor.textContent;
    act(() => {
      expect(port!.bindSource(text, generation)).toMatchObject({ kind: 'mapped', value: { text } });
    });
    expect(document.activeElement).toBe(focused);
    expect(editor.textContent).toBe(renderedText);
    expect(port!.selection()).toMatchObject({
      kind: 'mapped',
      value: { ranges: selected.value.ranges },
    });
    expect(port!.selection(generation)).toMatchObject({ kind: 'unavailable', reason: 'stale' });
    let mismatch: ReturnType<MarkdownSourcePort['bindSource']> | undefined;
    act(() => {
      mismatch = port!.bindSource('# genuinely different', port!.generation());
    });
    expect(mismatch).toMatchObject({ kind: 'unavailable', reason: 'model-mismatch' });
    expect(changed).not.toHaveBeenCalled();
    mounted.unmount();
    expect(port!.snapshot()).toMatchObject({ kind: 'unavailable', reason: 'disposed' });
  });
});
