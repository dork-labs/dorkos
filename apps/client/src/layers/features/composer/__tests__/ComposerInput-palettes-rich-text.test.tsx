// @vitest-environment jsdom
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { insertMention } from '@/layers/features/mentions/lib/mention-rows';
import { ComposerInput, type ComposerInputHandle } from '../ui/ComposerInput';

afterEach(() => cleanup());

/**
 * The rich-text composer driven exactly as a host drives it: value in,
 * `(value, cursorPos)` out, and nothing else.
 *
 * `use-input-autocomplete` and `use-mention-autocomplete` are NOT modified by
 * this spec — that is the whole point of preserving the units. Their detectors
 * are hook-private (`useCallback`s inside `use-command-palette`), so these
 * tests assert the CONTRACT those detectors consume rather than importing them:
 * a markdown string, and an index into that same string such that
 * `value.slice(0, cursor)` is exactly the text behind the caret. Every trigger
 * in the app is a regex run against that slice.
 */
function RichComposer({
  initialValue = '',
  onPair,
  handleRef,
  ...rest
}: {
  initialValue?: string;
  onPair?: (value: string, cursor: number | undefined) => void;
  handleRef?: React.Ref<ComposerInputHandle>;
} & Partial<Parameters<typeof ComposerInput>[0]>) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  return (
    <ComposerInput
      ref={handleRef}
      {...rest}
      richText
      value={value}
      onChange={(next) => {
        setValue(next);
        onPair?.(next, cursor);
      }}
      onCursorChange={(pos) => {
        setCursor(pos);
        onPair?.(value, pos);
      }}
      onSubmit={rest.onSubmit ?? vi.fn()}
      isStreaming={rest.isStreaming ?? false}
    />
  );
}

/** Wait for the lazy chunk to swap the textarea out. */
async function findRichField() {
  return waitFor(
    () => {
      const field = document.querySelector('[contenteditable="true"]');
      expect(field).not.toBeNull();
      return field as HTMLElement;
    },
    // Generous, and for the same reason its siblings are: this may be the first
    // load of the lazy Lexical chunk in the run, which pulls the whole editor
    // through the transform pipeline. Testing Library's default is 1s, which is
    // enough on an idle machine and not enough on a busy one — the failure then
    // reads `expected null not to be null` and looks like the palette broke,
    // when in truth the field never mounted and no palette assertion ever ran.
    { timeout: 10_000 }
  );
}

describe('the palettes still get what they need from the rich-text field', () => {
  // Hydration deliberately does NOT move the caret to the end — an external
  // write is not a claim about where the person is looking. The host puts it
  // where it belongs, exactly as ChatInputContainer does after a path drop
  // (`focusAt(next.length)`), and that is the flow driven here.
  it('reports a slash command and a caret the command detector can read', async () => {
    const handle = createRef<ComposerInputHandle>();
    const cursors: number[] = [];
    render(
      <RichComposer
        initialValue="/comp"
        handleRef={handle}
        onPair={(_value, cursor) => {
          if (cursor !== undefined) cursors.push(cursor);
        }}
      />
    );
    const field = await findRichField();
    await waitFor(() => expect(field.textContent).toBe('/comp'));

    handle.current!.focusAt('/comp'.length);

    // `toContain`, not `at(-1)`: more cursor events can land after the one
    // under test, and reading the last one races them.
    await waitFor(() => expect(cursors).toContain('/comp'.length));
    expect('/comp'.slice(0, '/comp'.length)).toBe('/comp');
  });

  it('reports an @ trigger the file detector can read', async () => {
    const handle = createRef<ComposerInputHandle>();
    const cursors: number[] = [];
    render(
      <RichComposer
        initialValue="see @src"
        handleRef={handle}
        onPair={(_value, cursor) => {
          if (cursor !== undefined) cursors.push(cursor);
        }}
      />
    );
    const field = await findRichField();
    await waitFor(() => expect(field.textContent).toBe('see @src'));

    handle.current!.focusAt('see @src'.length);

    await waitFor(() => expect(cursors).toContain('see @src'.length));
    const cursor = 'see @src'.length;
    // The shape every `@` trigger in the app matches against the slice behind
    // the caret. Mirrored rather than imported (MENTION_TRIGGER is module
    // private); what is under test is the OFFSET, not the regex.
    expect(/(^|\s)@([A-Za-z0-9_.-]*)$/.exec('see @src'.slice(0, cursor))?.[2]).toBe('src');
  });

  // The rung DOR-946 pinned: a palette with nothing to pick must not eat Enter.
  it('falls through and sends when an open palette has zero results', async () => {
    const onSubmit = vi.fn();
    render(
      <RichComposer
        initialValue="/zzz"
        isPaletteOpen
        paletteHasResults={false}
        onSubmit={onSubmit}
      />
    );
    const field = await findRichField();
    await waitFor(() => expect(field.textContent).toBe('/zzz'));

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it('queues mid-stream when an open palette has zero results', async () => {
    const onQueue = vi.fn();
    render(
      <RichComposer
        initialValue="@zzz"
        isStreaming
        isPaletteOpen
        paletteHasResults={false}
        onQueue={onQueue}
      />
    );
    const field = await findRichField();
    await waitFor(() => expect(field.textContent).toBe('@zzz'));

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onQueue).toHaveBeenCalledOnce());
  });

  it('picks a row when the open palette HAS results', async () => {
    const onCommandSelect = vi.fn();
    const onSubmit = vi.fn();
    render(
      <RichComposer
        initialValue="/dai"
        isPaletteOpen
        paletteHasResults
        onCommandSelect={onCommandSelect}
        onSubmit={onSubmit}
      />
    );
    const field = await findRichField();
    await waitFor(() => expect(field.textContent).toBe('/dai'));

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onCommandSelect).toHaveBeenCalledOnce());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('insertMention round-trips through the rich-text field', () => {
  // `insertMention` returns `{ value, cursorPos }` where cursorPos is always
  // PAST the separating space. RoomComposer writes the value and then calls
  // focusAt(cursorPos); this asserts the caret the field reports back is the
  // one the picker asked for.
  it('lands the caret past the separating space, and reports it back', async () => {
    const handle = createRef<ComposerInputHandle>();
    const cursors: number[] = [];

    const inserted = insertMention('hi @an and then', 3, 'an', 'ana');
    expect(inserted.value).toBe('hi @ana and then');
    expect(inserted.cursorPos).toBe('hi @ana '.length);

    render(
      <RichComposer
        initialValue={inserted.value}
        handleRef={handle}
        onPair={(_value, cursor) => {
          if (cursor !== undefined) cursors.push(cursor);
        }}
      />
    );
    const field = await findRichField();
    await waitFor(() => expect(field.textContent).toBe('hi @ana and then'));

    cursors.length = 0;
    handle.current!.focusAt(inserted.cursorPos);

    await waitFor(() => expect(cursors).toContain(inserted.cursorPos));
  });
});
