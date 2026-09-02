/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ImagePart } from '@dorkos/shared/types';
import { MessageImage } from '../MessageImage';

const PART: ImagePart = {
  type: 'image',
  attachmentId: 'abc123',
  url: '/api/sessions/s1/attachments/abc123.png',
  mediaType: 'image/png',
  size: 2048,
  alt: 'banana.png',
};

describe('MessageImage', () => {
  afterEach(cleanup);

  it('renders the picture from its URL and never from inlined bytes', () => {
    render(<MessageImage part={PART} />);

    const image = screen.getByRole('img');
    expect(image).toHaveAttribute('src', PART.url);
    expect(image.getAttribute('src')?.startsWith('data:')).toBe(false);
  });

  it('uses the alt text the runtime recorded', () => {
    render(<MessageImage part={PART} />);

    expect(screen.getByAltText('banana.png')).toBeInTheDocument();
  });

  it('falls back to a described alt when the runtime recorded none', () => {
    const { alt: _alt, ...withoutAlt } = PART;
    render(<MessageImage part={withoutAlt as ImagePart} />);

    expect(screen.getByAltText('Image produced by the agent')).toBeInTheDocument();
  });

  it('says the image is not available rather than showing nothing', () => {
    // The silent nothing is the bug this whole feature exists to end; a picture
    // that fails to load must not reproduce it in a smaller way.
    render(<MessageImage part={PART} />);

    fireEvent.error(screen.getByRole('img'));

    expect(screen.getByTestId('message-image-missing')).toHaveTextContent('not available');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('links to the raw bytes for a full-size view', () => {
    render(<MessageImage part={PART} />);

    expect(screen.getByRole('link')).toHaveAttribute('href', PART.url);
  });
});
