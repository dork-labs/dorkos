// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FileChipBar } from '../ui/FileChipBar';
import type { PendingFile } from '../model/use-file-upload';

// Mock URL.createObjectURL / revokeObjectURL for jsdom
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock-thumbnail-url');
  URL.revokeObjectURL = vi.fn();
});

afterAll(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

afterEach(() => {
  cleanup();
});

function createPendingFile(overrides: Partial<PendingFile> = {}): PendingFile {
  return {
    id: 'test-id-1',
    file: new File(['content'], 'test-file.txt', { type: 'text/plain' }),
    status: 'pending',
    progress: 0,
    ...overrides,
  };
}

describe('FileChipBar', () => {
  it('renders a chip for each pending file', () => {
    const files = [
      createPendingFile({ id: '1', file: new File(['a'], 'file-a.txt', { type: 'text/plain' }) }),
      createPendingFile({
        id: '2',
        file: new File(['b'], 'file-b.pdf', { type: 'application/pdf' }),
      }),
    ];

    render(<FileChipBar files={files} onRemove={vi.fn()} />);

    expect(screen.getByText('file-a.txt')).toBeInTheDocument();
    expect(screen.getByText('file-b.pdf')).toBeInTheDocument();
  });

  it('renders nothing when files array is empty', () => {
    const { container } = render(<FileChipBar files={[]} onRemove={vi.fn()} />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows progress percentage during upload', () => {
    const files = [createPendingFile({ status: 'uploading', progress: 45 })];

    render(<FileChipBar files={files} onRemove={vi.fn()} />);

    expect(screen.getByText('45%')).toBeInTheDocument();
  });

  it('does not show progress percentage when status is pending', () => {
    const files = [createPendingFile({ status: 'pending', progress: 0 })];

    render(<FileChipBar files={files} onRemove={vi.fn()} />);

    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('calls onRemove with the correct file id when X button is clicked', () => {
    const onRemove = vi.fn();
    const files = [createPendingFile({ id: 'remove-me' })];

    render(<FileChipBar files={files} onRemove={onRemove} />);

    const removeButton = screen.getByRole('button', { name: /remove/i });
    fireEvent.click(removeButton);

    expect(onRemove).toHaveBeenCalledWith('remove-me');
  });

  it('remove button has aria-label with the filename', () => {
    const files = [
      createPendingFile({ file: new File(['x'], 'my-doc.pdf', { type: 'application/pdf' }) }),
    ];

    render(<FileChipBar files={files} onRemove={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Remove my-doc.pdf' })).toBeInTheDocument();
  });

  it('filename span has truncate class for long filenames', () => {
    const longName = 'this-is-a-very-long-filename-that-should-be-truncated.txt';
    const files = [createPendingFile({ file: new File(['x'], longName, { type: 'text/plain' }) })];

    render(<FileChipBar files={files} onRemove={vi.fn()} />);

    const nameEl = screen.getByText(longName);
    expect(nameEl.className).toContain('truncate');
  });

  it('progress percentage has tabular-nums class', () => {
    const files = [createPendingFile({ status: 'uploading', progress: 72 })];

    const { container } = render(<FileChipBar files={files} onRemove={vi.fn()} />);

    const progressEl = screen.getByText('72%');
    expect(progressEl.className).toContain('tabular-nums');
    // Suppress unused variable warning
    void container;
  });

  it('calls onRemove with correct id when multiple chips are present', () => {
    const onRemove = vi.fn();
    const files = [
      createPendingFile({
        id: 'first',
        file: new File(['a'], 'alpha.txt', { type: 'text/plain' }),
      }),
      createPendingFile({
        id: 'second',
        file: new File(['b'], 'beta.txt', { type: 'text/plain' }),
      }),
    ];

    render(<FileChipBar files={files} onRemove={onRemove} />);

    const removeButtons = screen.getAllByRole('button', { name: /remove/i });
    expect(removeButtons).toHaveLength(2);

    fireEvent.click(removeButtons[1]);
    expect(onRemove).toHaveBeenCalledWith('second');
  });

  it('renders an image thumbnail for image files', () => {
    const files = [
      createPendingFile({
        id: 'img-1',
        file: new File(['pixels'], 'photo.png', { type: 'image/png' }),
      }),
    ];

    const { container } = render(<FileChipBar files={files} onRemove={vi.fn()} />);

    // Thumbnail has alt="" (decorative — filename text provides context), so query by element
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'blob:mock-thumbnail-url');
  });

  it('does not render a thumbnail for non-image files', () => {
    const files = [
      createPendingFile({
        id: 'doc-1',
        file: new File(['text'], 'readme.md', { type: 'text/markdown' }),
      }),
    ];

    const { container } = render(<FileChipBar files={files} onRemove={vi.fn()} />);

    expect(container.querySelector('img')).toBeNull();
  });

  it('shows spinner instead of thumbnail during upload of an image', () => {
    const files = [
      createPendingFile({
        id: 'img-uploading',
        file: new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' }),
        status: 'uploading',
        progress: 60,
      }),
    ];

    const { container } = render(<FileChipBar files={files} onRemove={vi.fn()} />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('60%')).toBeInTheDocument();
  });
});
