/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockTransport, mockCanvasDocument } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RoomCanvasMarkdown, type RoomCanvasMarkdownProps } from '../ui/room/RoomCanvasMarkdown';

const { editLock } = vi.hoisted(() => ({ editLock: vi.fn() }));
vi.mock('../model/use-room-canvas', () => ({ useRoomCanvasEditLock: editLock }));
// Keep the real save owner and lazy editor seam; the rich-editor runtime is not needed here.
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({
    value,
    editable,
    onChange,
  }: {
    value: string;
    editable: boolean;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      aria-label="Room markdown"
      value={value}
      readOnly={!editable}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
beforeEach(() => editLock.mockClear());
afterEach(cleanup);

function deferredSave() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(onSave: RoomCanvasMarkdownProps['onSave']) {
  const content = { type: 'markdown' as const, content: 'Initial' };
  const document = mockCanvasDocument({ id: 'room-document', content });
  render(
    <TransportProvider transport={createMockTransport()}>
      <RoomCanvasMarkdown roomId="room" document={document} content={content} onSave={onSave} />
    </TransportProvider>
  );
  await screen.findByRole('textbox', { name: 'Room markdown' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit this document' }));
  return screen.getByRole('textbox', { name: 'Room markdown' }) as HTMLTextAreaElement;
}

it('keeps a newer draft, editor and lock when an older deferred save succeeds', async () => {
  const first = deferredSave();
  const onSave = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce(true);
  const editor = await mount(onSave);
  fireEvent.change(editor, { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save for the room' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith('room-document', {
    type: 'markdown',
    content: 'A',
  });
  fireEvent.change(editor, { target: { value: 'B' } });
  editor.focus();
  editor.setSelectionRange(1, 1);
  await act(async () => {
    first.resolve(true);
    await first.promise;
  });
  expect(screen.getByRole('textbox', { name: 'Room markdown' })).toBe(editor);
  expect(editor).toHaveValue('B');
  expect(editor).not.toHaveAttribute('readonly');
  expect(editor).toHaveFocus();
  expect(editor.selectionStart).toBe(1);
  expect(editLock).toHaveBeenLastCalledWith('room', 'room-document');
  expect(screen.getByRole('button', { name: 'Save for the room' })).toBeEnabled();
  expect(onSave).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save for the room' }));
  });
  expect(onSave).toHaveBeenNthCalledWith(2, 'room-document', { type: 'markdown', content: 'B' });
  expect(screen.getByRole('button', { name: 'Edit this document' })).toBeInTheDocument();
  expect(editLock).toHaveBeenLastCalledWith('room', null);
});

it('exits editing when the deferred acknowledgement owns the unchanged submitted draft', async () => {
  const save = deferredSave();
  const onSave = vi.fn(() => save.promise);
  const editor = await mount(onSave);
  fireEvent.change(editor, { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save for the room' }));
  await act(async () => {
    save.resolve(true);
    await save.promise;
  });
  expect(onSave).toHaveBeenCalledExactlyOnceWith('room-document', {
    type: 'markdown',
    content: 'A',
  });
  expect(screen.getByRole('button', { name: 'Edit this document' })).toBeInTheDocument();
  expect(editLock).toHaveBeenLastCalledWith('room', null);
});

it('keeps the newer draft and edit lock after a refused deferred save', async () => {
  const save = deferredSave();
  const onSave = vi.fn(() => save.promise);
  const editor = await mount(onSave);
  fireEvent.change(editor, { target: { value: 'A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save for the room' }));
  fireEvent.change(editor, { target: { value: 'B' } });
  await act(async () => {
    save.resolve(false);
    await save.promise;
  });
  expect(editor).toHaveValue('B');
  expect(screen.getByRole('textbox', { name: 'Room markdown' })).toBe(editor);
  expect(screen.getByRole('button', { name: 'Save for the room' })).toBeEnabled();
  expect(screen.getByRole('status')).toHaveTextContent('Your words are still here');
  expect(editLock).toHaveBeenLastCalledWith('room', 'room-document');
  expect(onSave).toHaveBeenCalledTimes(1);
});
