// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { AttachmentThumbnail } from '../ui/AttachmentThumbnail';

type ThumbnailProps = Parameters<typeof AttachmentThumbnail>[0];

afterEach(cleanup);

function renderThumbnail(overrides: Partial<ThumbnailProps> = {}) {
  const props: ThumbnailProps = {
    imageUrl: 'data:image/webp;base64,AAAA',
    alt: 'The screenshot you attached',
    onRemove: vi.fn(),
    removeLabel: 'Remove screenshot',
    ...overrides,
  };
  render(
    <TooltipProvider>
      <AttachmentThumbnail {...props} />
    </TooltipProvider>
  );
  return props;
}

describe('AttachmentThumbnail', () => {
  it('shows the exact picture that will be sent', () => {
    renderThumbnail();
    expect(screen.getByAltText('The screenshot you attached')).toHaveAttribute(
      'src',
      'data:image/webp;base64,AAAA'
    );
  });

  it('opens the full preview from the thumbnail, named for what it opens', () => {
    const onOpen = vi.fn();
    renderThumbnail({ onOpen });
    fireEvent.click(screen.getByRole('button', { name: 'Open the screenshot you attached' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('labels its remove button for WHICH attachment it removes', () => {
    const { onRemove } = renderThumbnail({ removeLabel: 'Remove message list' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove message list' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('captions a pointed-at element with its readable name', () => {
    renderThumbnail({ caption: 'Message list', pointed: true });
    expect(screen.getByText('Message list')).toBeInTheDocument();
  });

  it('still names an element that has no picture', () => {
    renderThumbnail({
      imageUrl: undefined,
      alt: 'The part you pointed at: Message list',
      caption: 'Message list',
      pointed: true,
      detail: '[data-testid="message-list"]',
    });
    expect(
      screen.getByRole('img', { name: 'The part you pointed at: Message list' })
    ).toBeInTheDocument();
    // Nothing to open, so it is not a control.
    expect(screen.queryByRole('button', { name: /^Open/ })).not.toBeInTheDocument();
  });
});
