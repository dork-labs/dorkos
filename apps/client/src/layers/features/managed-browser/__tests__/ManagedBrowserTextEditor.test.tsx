import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagedBrowserTextEditor } from '../ui/ManagedBrowserTextEditor';
afterEach(() => cleanup());
it('local draft and selection cause no remote input; an explicit send clears it once', async () => {
  const commit = vi.fn(async () => {});
  render(<ManagedBrowserTextEditor targetLabel="Message" pending={false} onCommit={commit} />);
  const input = screen.getByLabelText('New text') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'local draft' } });
  input.setSelectionRange(1, 3);
  fireEvent.select(input);
  expect(commit).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByText('Insert text'));
  });
  expect(commit).toHaveBeenCalledExactlyOnceWith({ kind: 'insertText', text: 'local draft' });
  expect(input.value).toBe('');
});
it('pending suspends commits while preserving original local input focus and DOM', async () => {
  const commit = vi.fn(async () => {});
  const view = render(
    <ManagedBrowserTextEditor targetLabel="Message" pending={false} onCommit={commit} />
  );
  const input = screen.getByLabelText('New text') as HTMLInputElement;
  input.focus();
  view.rerender(
    <ManagedBrowserTextEditor targetLabel="Message" pending={true} onCommit={commit} />
  );
  expect(screen.getByLabelText('New text')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.readOnly).toBe(true);
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  });
  expect(commit).not.toHaveBeenCalled();
  view.unmount();
  expect(input.value).toBe('');
});
it('composition blocks commit and explicit replacement can empty the exact field', async () => {
  const commit = vi.fn(async () => {});
  render(<ManagedBrowserTextEditor targetLabel="Message" pending={false} onCommit={commit} />);
  const input = screen.getByLabelText('New text');
  fireEvent.compositionStart(input);
  await act(async () => {
    fireEvent.click(screen.getByText('Replace text'));
  });
  expect(commit).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await act(async () => {
    fireEvent.click(screen.getByText('Replace text'));
  });
  expect(commit).toHaveBeenCalledExactlyOnceWith({ kind: 'replaceText', text: '' });
});
