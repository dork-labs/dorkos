// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ComposerRoot } from '../ui/ComposerRoot';

afterEach(cleanup);

/** The card chrome every surface shares, asserted class by class. */
const CARD_CLASSES = ['bg-surface', 'relative', 'm-2', 'rounded-xl', 'border', 'p-2'];

function file(name: string, type = 'text/plain') {
  return new File(['x'], name, { type });
}

/** A `drop` that react-dropzone will accept: files on both `files` and `items`. */
function dropFiles(target: Element, files: File[]) {
  fireEvent.drop(target, {
    dataTransfer: {
      files,
      items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })),
      types: ['Files'],
    },
  });
}

/** The drag the file tree produces: a path under our own type, and no files. */
function dropPath(target: Element, path: string) {
  const type = 'application/x-dorkos-file-path';
  fireEvent.drop(target, {
    dataTransfer: {
      files: [],
      items: [],
      types: ['text/plain', type],
      getData: (t: string) => (t === type || t === 'text/plain' ? path : ''),
    },
  });
}

describe('ComposerRoot', () => {
  it('mounts no dropzone at all when the caller wires no attach handler', () => {
    // (a) The reason the two-component split exists: useDropzone attaches
    // document-level drag listeners, so a room composer with no attach must
    // not mount it — not even with a no-op handler.
    const { container } = render(
      <ComposerRoot>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    expect(container.querySelector('input[type="file"]')).toBeNull();

    const card = screen.getByTestId('child').parentElement!;
    // react-dropzone marks its root; without it there is no drag wiring.
    expect(card.getAttribute('role')).toBeNull();
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });

  it('hands every dropped file to the caller in one call', async () => {
    // (b)
    const onFilesDropped = vi.fn();
    const { container } = render(
      <ComposerRoot onFilesDropped={onFilesDropped}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    expect(container.querySelector('input[type="file"]')).not.toBeNull();

    const card = screen.getByTestId('child').parentElement!;
    const a = file('a.txt');
    const b = file('b.txt');
    dropFiles(card, [a, b]);

    await waitFor(() => expect(onFilesDropped).toHaveBeenCalledTimes(1));
    expect(onFilesDropped).toHaveBeenCalledWith([a, b]);
  });

  it('takes the file out of a paste and ignores the text beside it', () => {
    // (c) A pasted screenshot usually arrives alongside a string item; only the
    // file is an attachment.
    const onFilesDropped = vi.fn();
    render(
      <ComposerRoot onFilesDropped={onFilesDropped}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    const card = screen.getByTestId('child').parentElement!;
    const pasted = file('shot.png', 'image/png');

    fireEvent.paste(card, {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => pasted },
        ],
      },
    });

    expect(onFilesDropped).toHaveBeenCalledTimes(1);
    expect(onFilesDropped).toHaveBeenCalledWith([pasted]);
  });

  it('carries the shared card chrome, with or without attach wiring', () => {
    // (d)
    const { rerender } = render(
      <ComposerRoot>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );
    for (const cls of CARD_CLASSES) {
      expect(screen.getByTestId('child').parentElement!.classList).toContain(cls);
    }

    rerender(
      <ComposerRoot onFilesDropped={vi.fn()}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );
    for (const cls of CARD_CLASSES) {
      expect(screen.getByTestId('child').parentElement!.classList).toContain(cls);
    }
  });

  it('keeps a caller class that no Tailwind rule knows about', () => {
    // (d, and the safe-area case specifically) `chat-input-container` carries
    // the notched-device inset in index.css and rides on this very element.
    // Root must never bake it in, and must never let the class merge drop it.
    render(
      <ComposerRoot className="chat-input-container">
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    const card = screen.getByTestId('child').parentElement!;
    expect(card.classList).toContain('chat-input-container');
    for (const cls of CARD_CLASSES) {
      expect(card.classList).toContain(cls);
    }
  });

  it('lets the caller override a chrome class it disagrees with', () => {
    render(
      <ComposerRoot className="m-0">
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    const card = screen.getByTestId('child').parentElement!;
    expect(card.classList).toContain('m-0');
    expect(card.classList).not.toContain('m-2');
  });

  it('hands a file dragged out of the tree to the caller as a path, not an upload', () => {
    // (DOR-1032) The file tree drags a REFERENCE to a file the machine already
    // has. It must reach `onPathDropped` and must never be treated as an upload.
    const onFilesDropped = vi.fn();
    const onPathDropped = vi.fn();
    render(
      <ComposerRoot onFilesDropped={onFilesDropped} onPathDropped={onPathDropped}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    const card = screen.getByTestId('child').parentElement!;
    dropPath(card, 'src/a.ts');

    expect(onPathDropped).toHaveBeenCalledWith('src/a.ts');
    expect(onFilesDropped).not.toHaveBeenCalled();
  });

  it('accepts a dragged path on a card with no attach wiring at all', () => {
    // Rooms mount no dropzone; a path drop is a different capability and must
    // not need one.
    const onPathDropped = vi.fn();
    render(
      <ComposerRoot onPathDropped={onPathDropped}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    dropPath(screen.getByTestId('child').parentElement!, 'notes.md');

    expect(onPathDropped).toHaveBeenCalledWith('notes.md');
  });

  it('still uploads files dropped from the operating system', async () => {
    const onFilesDropped = vi.fn();
    const onPathDropped = vi.fn();
    render(
      <ComposerRoot onFilesDropped={onFilesDropped} onPathDropped={onPathDropped}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    const card = screen.getByTestId('child').parentElement!;
    const a = file('a.txt');
    dropFiles(card, [a]);

    await waitFor(() => expect(onFilesDropped).toHaveBeenCalledWith([a]));
    expect(onPathDropped).not.toHaveBeenCalled();
  });

  it('renders the drop overlay only while a drag is over the card', async () => {
    render(
      <ComposerRoot onFilesDropped={vi.fn()}>
        <span data-testid="child">hi</span>
      </ComposerRoot>
    );

    const card = screen.getByTestId('child').parentElement!;
    expect(screen.queryByText('Drop files to attach')).toBeNull();

    fireEvent.dragEnter(card, {
      dataTransfer: {
        files: [file('a.txt')],
        items: [{ kind: 'file', type: 'text/plain' }],
        types: ['Files'],
      },
    });

    await waitFor(() => expect(screen.getByText('Drop files to attach')).toBeInTheDocument());
  });
});
