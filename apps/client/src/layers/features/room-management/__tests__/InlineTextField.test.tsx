// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { InlineTextField } from '../ui/InlineTextField';

/**
 * What the draft does when the value underneath it moves.
 *
 * The rest of this component — Enter commits, Escape cancels, one write per
 * edit, focus handed back to the line — is asserted through the surface that
 * owns it in `RoomDetailsHeader.test.tsx`. This file is about the one case that
 * surface cannot reach: a value that arrives AFTER the editor has opened.
 */
function renderField(value: string) {
  const onCommit = vi.fn<(next: string) => void>();
  const field = (v: string) => (
    <InlineTextField
      value={v}
      onCommit={onCommit}
      maxLength={500}
      label="Topic"
      placeholder="Add a topic"
      commitEmpty
      startEditing
    />
  );
  const { rerender } = render(field(value));
  return {
    onCommit,
    editor: () => screen.getByRole('textbox', { name: 'Topic' }),
    revalue: (next: string) => rerender(field(next)),
  };
}

afterEach(cleanup);

describe('InlineTextField', () => {
  it('takes a fresher value while nothing has been typed', () => {
    // The sheet opens on the room the CALLER already had — a sidebar summary —
    // and the detail read lands a moment later. Opened straight into the editor
    // by "Edit topic…", the draft was seeded once from that stale copy and
    // never re-seeded, so Enter wrote the old topic back over the new one and
    // called it an edit.
    const { onCommit, editor, revalue } = renderField('Old topic');

    revalue('Topic somebody else just set');
    expect(editor()).toHaveValue('Topic somebody else just set');

    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('leaves what somebody is typing alone, however the value moves', () => {
    // The other half, and the reason this is not a plain "keep the draft in
    // step with the prop": a room renamed in another window mid-edit must not
    // rewrite what is under the cursor. The first keystroke is what makes the
    // draft the reader's.
    const { onCommit, editor, revalue } = renderField('Old topic');

    fireEvent.change(editor(), { target: { value: 'What I am typing' } });
    revalue('Topic somebody else just set');

    expect(editor()).toHaveValue('What I am typing');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('What I am typing');
  });

  it('lets an emptied field stay empty', () => {
    // `''` is a real edit where a topic can be removed, and it is also what a
    // lazily-seeded draft uses to mean "nothing typed yet". Red if clearing the
    // field falls back to the stored value instead of committing the removal.
    const { onCommit, editor } = renderField('Old topic');

    fireEvent.change(editor(), { target: { value: '' } });

    expect(editor()).toHaveValue('');
    fireEvent.keyDown(editor(), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('');
  });
});

describe('InlineTextField — a wrapping line edits in a box that grows (DOR-2358)', () => {
  const LONG = 'A topic long enough to wrap across many lines. '.repeat(10).trim();

  function renderTopic(wrap: boolean) {
    const onCommit = vi.fn<(next: string) => void>();
    render(
      <InlineTextField
        value={LONG}
        onCommit={onCommit}
        maxLength={500}
        label="Topic"
        placeholder="Add a topic"
        commitEmpty
        wrap={wrap}
      />
    );
    fireEvent.click(screen.getByRole('button'));
    return { onCommit, editor: () => screen.getByRole('textbox', { name: 'Topic' }) };
  }

  it('edits a wrapping line in a textarea, and Enter saves', () => {
    const { onCommit, editor } = renderTopic(true);
    expect(editor().tagName).toBe('TEXTAREA');
    expect(editor()).toHaveValue(LONG);

    fireEvent.change(editor(), { target: { value: 'A shorter topic' } });
    fireEvent.keyDown(editor(), { key: 'Enter', shiftKey: true });

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('A shorter topic');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('cancels on Escape without saving', () => {
    const { onCommit, editor } = renderTopic(true);
    fireEvent.change(editor(), { target: { value: 'Not this' } });
    fireEvent.keyDown(editor(), { key: 'Escape' });

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('keeps a one-line input for a line that does not wrap, like the room name', () => {
    const { editor } = renderTopic(false);
    expect(editor().tagName).toBe('INPUT');
  });
});
