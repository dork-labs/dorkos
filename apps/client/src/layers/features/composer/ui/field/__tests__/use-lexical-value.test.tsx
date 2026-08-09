// @vitest-environment jsdom
import { useEffect, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical';
import { COMPOSER_NODES } from '../lexical-nodes';
import { HYDRATE_TAG, useLexicalValue } from '../use-lexical-value';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

/**
 * Counts hydrations through Lexical's own update tags rather than by spying on
 * a private function — the hook tags its re-hydration update, so this observes
 * the real thing and cannot drift from it.
 */
function useHydrationCounter(counter: { count: number }): void {
  const [editor] = useLexicalComposerContext();
  // Registered once with cleanup: re-registering per render would stack
  // listeners and count one hydration several times.
  useEffect(
    () =>
      editor.registerUpdateListener(({ tags }) => {
        if (tags.has(HYDRATE_TAG)) counter.count += 1;
      }),
    [editor, counter]
  );
}

interface HarnessProps {
  initialValue?: string;
  counter: { count: number };
  onChange?: (value: string) => void;
  onCursorChange?: (pos: number) => void;
  editorOut?: (editor: LexicalEditor) => void;
  /** When false, the host does NOT echo onChange back into value. */
  echo?: boolean;
}

/** The value hook under a real editor, wired the way the field wires it. */
function Harness({
  initialValue = '',
  counter,
  onChange,
  onCursorChange,
  editorOut,
  echo = true,
}: HarnessProps) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'composer',
        nodes: COMPOSER_NODES,
        onError: (error: Error) => {
          throw error;
        },
      }}
    >
      <Inner
        initialValue={initialValue}
        counter={counter}
        onChange={onChange}
        onCursorChange={onCursorChange}
        editorOut={editorOut}
        echo={echo}
      />
    </LexicalComposer>
  );
}

/** The part inside the composer context. */
function Inner({
  initialValue = '',
  counter,
  onChange,
  onCursorChange,
  editorOut,
  echo,
}: HarnessProps) {
  const [editor] = useLexicalComposerContext();
  const [value, setValue] = useState(initialValue);
  useHydrationCounter(counter);
  useLexicalValue({
    value,
    onChange: (next) => {
      onChange?.(next);
      if (echo) setValue(next);
    },
    onCursorChange,
  });
  editorOut?.(editor);
  return <div data-testid="value">{value}</div>;
}

/** Type `text` into the document the way a keystroke would. */
function typeInto(editor: LexicalEditor, text: string): void {
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        const node = $createTextNode(text);
        root.clear().append($createParagraphNode().append(node));
        // A real keystroke leaves a caret behind; without one there is no
        // selection to report and the cursor half never fires.
        node.select(text.length, text.length);
      },
      { discrete: true }
    );
  });
}

describe('useLexicalValue — the emitted-value latch', () => {
  // THE test. Without the latch every keystroke round-trips its own output back
  // through the parser, which rebuilds every node, resets the selection and
  // empties the undo stack — while every other test in the suite stays green.
  it('never re-hydrates a value it emitted itself', async () => {
    const counter = { count: 0 };
    let editor: LexicalEditor | null = null;
    render(<Harness counter={counter} editorOut={(e) => (editor = e)} />);

    await waitFor(() => expect(editor).not.toBeNull());
    // One hydration is expected: the mount, seeding the document from ''.
    const afterMount = counter.count;

    for (const text of ['h', 'he', 'hel', 'hell', 'hello']) {
      typeInto(editor!, text);
      await waitFor(() => expect(screen.getByTestId('value').textContent).toBe(text));
    }

    expect(counter.count - afterMount).toBe(0);
  });

  it('does hydrate a genuinely external write, exactly once', async () => {
    const counter = { count: 0 };
    let editor: LexicalEditor | null = null;
    const { rerender } = render(
      <ExternalHarness value="" counter={counter} editorOut={(e) => (editor = e)} />
    );
    await waitFor(() => expect(editor).not.toBeNull());
    const afterMount = counter.count;

    rerender(<ExternalHarness value="restored draft" counter={counter} editorOut={() => {}} />);

    await waitFor(() => expect(counter.count - afterMount).toBe(1));
  });
});

/** A host that OWNS the value — it never echoes, so every write is external. */
function ExternalHarness({
  value,
  counter,
  editorOut,
}: {
  value: string;
  counter: { count: number };
  editorOut: (editor: LexicalEditor) => void;
}) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'composer',
        nodes: COMPOSER_NODES,
        onError: (error: Error) => {
          throw error;
        },
      }}
    >
      <ExternalInner value={value} counter={counter} editorOut={editorOut} />
    </LexicalComposer>
  );
}

/** The inner half of {@link ExternalHarness}. */
function ExternalInner({
  value,
  counter,
  editorOut,
}: {
  value: string;
  counter: { count: number };
  editorOut: (editor: LexicalEditor) => void;
}) {
  const [editor] = useLexicalComposerContext();
  useHydrationCounter(counter);
  useLexicalValue({ value, onChange: () => {} });
  editorOut(editor);
  return null;
}

describe('useLexicalValue — what it emits, and in what order', () => {
  it('emits onChange before onCursorChange, in one listener call', async () => {
    const calls: string[] = [];
    const counter = { count: 0 };
    let editor: LexicalEditor | null = null;

    render(
      <Harness
        counter={counter}
        editorOut={(e) => (editor = e)}
        onChange={() => calls.push('change')}
        onCursorChange={() => calls.push('cursor')}
      />
    );
    await waitFor(() => expect(editor).not.toBeNull());
    calls.length = 0;

    typeInto(editor!, 'hi');
    await waitFor(() => expect(calls).toContain('change'));

    expect(calls.indexOf('change')).toBeLessThan(calls.indexOf('cursor'));
  });

  it('emits only onCursorChange when nothing but the selection moved', async () => {
    const changes: string[] = [];
    const cursors: number[] = [];
    const counter = { count: 0 };
    let editor: LexicalEditor | null = null;

    render(
      <Harness
        counter={counter}
        editorOut={(e) => (editor = e)}
        onChange={(v) => changes.push(v)}
        onCursorChange={(p) => cursors.push(p)}
      />
    );
    await waitFor(() => expect(editor).not.toBeNull());
    typeInto(editor!, 'hello');
    await waitFor(() => expect(changes.length).toBeGreaterThan(0));

    changes.length = 0;
    cursors.length = 0;

    act(() => {
      editor!.update(
        () => {
          const node = $getRoot().getAllTextNodes()[0];
          node.select(2, 2);
        },
        { discrete: true }
      );
    });

    await waitFor(() => expect(cursors).toContain(2));
    expect(changes).toEqual([]);
  });
});
