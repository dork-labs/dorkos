/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  editorControl.real = false;
  editorControl.props = undefined;
  act(() => useThemeStore.getState().setTheme('light'));
});
afterEach(cleanup);

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
  it('preserves the genuine package unavailable result for model-mismatched heading input', async () => {
    editorControl.real = true;
    let port: MarkdownSourcePort | undefined;
    const onSourceReady: NonNullable<MarkdownEditorProps['onSourceReady']> = (next) => {
      port = next;
    };
    render(
      <BlintzCanvas
        value="# raw"
        editable={false}
        sourceRevision="heading-1"
        onSourceReady={onSourceReady}
      />
    );
    await waitFor(() => expect(port).toBeDefined());
    expect(port!.snapshot()).toMatchObject({ kind: 'unavailable', reason: 'unmapped' });
    let rebound: ReturnType<MarkdownSourcePort['bindSource']> | undefined;
    act(() => {
      rebound = port!.bindSource('# raw', port!.generation());
    });
    expect(rebound).toMatchObject({ kind: 'unavailable', reason: 'model-mismatch' });
  });
});
