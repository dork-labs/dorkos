import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/layers/shared/model', () => ({
  useAppStore: vi.fn((selector: (s: { selectedCwd: string | null }) => unknown) =>
    selector({ selectedCwd: '/test/project' })
  ),
}));

import { FileAttachmentList } from '../FileAttachmentList';
import type { ParsedFile } from '../../../lib/parse-file-prefix';

describe('FileAttachmentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('returns null when files array is empty', () => {
    const { container } = render(<FileAttachmentList files={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an image thumbnail with correct src and alt', () => {
    const files: ParsedFile[] = [
      {
        path: '.dork/.temp/uploads/abc12345-photo.png',
        displayName: 'photo.png',
        isImage: true,
      },
    ];

    render(<FileAttachmentList files={files} />);

    const img = screen.getByRole('img', { name: 'photo.png' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', expect.stringContaining('/api/uploads/'));
    expect(img).toHaveAttribute('alt', 'photo.png');
  });

  it('renders a file chip with icon and display name for non-image files', () => {
    const files: ParsedFile[] = [
      {
        path: '.dork/.temp/uploads/def67890-report.pdf',
        displayName: 'report.pdf',
        isImage: false,
      },
    ];

    render(<FileAttachmentList files={files} />);

    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders both images and file chips for mixed content', () => {
    const files: ParsedFile[] = [
      {
        path: '.dork/.temp/uploads/aaa-screenshot.jpg',
        displayName: 'screenshot.jpg',
        isImage: true,
      },
      {
        path: '.dork/.temp/uploads/bbb-notes.md',
        displayName: 'notes.md',
        isImage: false,
      },
    ];

    render(<FileAttachmentList files={files} />);

    expect(screen.getByRole('img', { name: 'screenshot.jpg' })).toBeInTheDocument();
    expect(screen.getByText('notes.md')).toBeInTheDocument();
  });

  it('applies truncate class to long filenames', () => {
    const files: ParsedFile[] = [
      {
        path: '.dork/.temp/uploads/ccc-a-very-long-filename-that-should-be-truncated.ts',
        displayName: 'a-very-long-filename-that-should-be-truncated.ts',
        isImage: false,
      },
    ];

    render(<FileAttachmentList files={files} />);

    const nameEl = screen.getByText('a-very-long-filename-that-should-be-truncated.ts');
    expect(nameEl).toHaveClass('truncate');
  });
});
