// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GroupCreateInput } from '../ui/GroupCreateInput';

afterEach(() => cleanup());

function renderInput() {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <ul>
      <GroupCreateInput onCommit={onCommit} onCancel={onCancel} />
    </ul>
  );
  const input = screen.getByLabelText('New section name');
  return { input, onCommit, onCancel };
}

describe('GroupCreateInput', () => {
  it('focuses the input on mount', () => {
    const { input } = renderInput();
    expect(input).toHaveFocus();
  });

  it('commits a valid name on Enter (trimmed)', () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: '  Acme  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Acme');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('accepts the 40-character boundary', () => {
    const name = 'a'.repeat(40);
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(name);
  });

  it('rejects 41 characters (does not commit)', () => {
    // fireEvent.change bypasses the input's maxLength, exercising the
    // defensive validation in commit().
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: 'a'.repeat(41) } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('rejects an empty name (does not commit)', () => {
    const { input, onCommit } = renderInput();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only name (does not commit)', () => {
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels on Escape without committing', () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: 'Acme' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels on a blur that hands focus to something else', () => {
    // **`relatedTarget` is the whole test.** A blur with nothing taking focus is
    // the menu that opened this field tearing itself down, and the field takes
    // its focus back instead of closing (`useInlineEditorSettle`, DOR-1371).
    // Clicking another control is the reader moving on, and still cancels.
    const other = document.createElement('button');
    document.body.append(other);
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: 'Acme' } });
    fireEvent.blur(input, { relatedTarget: other });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    other.remove();
  });

  it('survives the blur its own menu causes on the way out', () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: 'Acme' } });
    fireEvent.blur(input, { relatedTarget: null });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('guards against double commit (second Enter and post-commit blur are no-ops)', () => {
    const { input, onCommit, onCancel } = renderInput();
    fireEvent.change(input, { target: { value: 'Acme' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Acme');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('caps typing at 40 characters via maxLength', () => {
    const { input } = renderInput();
    expect(input).toHaveAttribute('maxlength', '40');
  });
});
