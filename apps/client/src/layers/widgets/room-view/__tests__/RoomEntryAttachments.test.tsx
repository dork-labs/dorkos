// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomAttachment } from '@dorkos/shared/room-schemas';
import { RoomEntryAttachments, attachmentsSummary } from '../ui/RoomEntryAttachments';

afterEach(cleanup);

/** One attachment as the server writes it — every field server-derived. */
function attachment(overrides: Partial<RoomAttachment> = {}): RoomAttachment {
  return {
    id: 'att-1',
    name: 'screenshot.png',
    mimeType: 'image/png',
    size: 2048,
    preview: 'image',
    url: '/api/rooms/room-1/attachments/att-1',
    ...overrides,
  };
}

describe('RoomEntryAttachments — a verified image', () => {
  it('draws a thumbnail named after the file, linked to the file', () => {
    render(<RoomEntryAttachments attachments={[attachment()]} />);

    const image = screen.getByRole('img', { name: 'screenshot.png' });
    expect(image).toHaveAttribute('src', '/api/rooms/room-1/attachments/att-1');
    expect(image).toHaveAttribute('loading', 'lazy');
    // The link is the way to open the file at full size.
    expect(image.closest('a')).toHaveAttribute('href', '/api/rooms/room-1/attachments/att-1');
  });

  it('renders the server’s URL verbatim, including an absolute one', () => {
    // `url` is whatever the store answered. It is server-relative today and a
    // remote store would hand back an absolute https URL with no change here,
    // so a renderer that rebuilt it from ids would break the day that lands.
    render(
      <RoomEntryAttachments
        attachments={[attachment({ url: 'https://files.example.com/att-1/screenshot.png' })]}
      />
    );

    expect(screen.getByRole('img', { name: 'screenshot.png' })).toHaveAttribute(
      'src',
      'https://files.example.com/att-1/screenshot.png'
    );
  });
});

describe('RoomEntryAttachments — everything else', () => {
  it('draws a download chip, and no image, for a file the bytes were not verified for', () => {
    // THE SAFETY PROPERTY, and the whole reason this module exists. The fixture
    // is a `.png` whose declared type says image and whose `preview` is null:
    // exactly what the server stores for a file of GIF bytes named `.png`, so
    // this test and the server's describe one attack from two ends. Branch on
    // `mimeType` here instead of on `preview` and an uploader chooses what goes
    // into an `<img src>` on the cockpit's own origin — this assertion is what
    // turns red the moment that happens.
    render(
      <RoomEntryAttachments
        attachments={[
          attachment({ name: 'notes.pdf', mimeType: 'image/png', preview: null, size: 1536 }),
        ]}
      />
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const chip = screen.getByTestId('room-entry-attachment-chip');
    expect(chip).toHaveTextContent('notes.pdf');
    expect(chip).toHaveAttribute('href', '/api/rooms/room-1/attachments/att-1');
  });

  it('says how big the file is, in units a person reads', () => {
    render(
      <RoomEntryAttachments
        attachments={[
          attachment({ id: 'a', name: 'a.bin', preview: null, size: 812 }),
          attachment({ id: 'b', name: 'b.bin', preview: null, size: 1536 }),
          attachment({ id: 'c', name: 'c.bin', preview: null, size: 5 * 1024 * 1024 }),
        ]}
      />
    );

    expect(
      screen.getAllByTestId('room-entry-attachment-chip').map((chip) => chip.textContent)
    ).toEqual(['a.bin812 B', 'b.bin1.5 KB', 'c.bin5.0 MB']);
  });
});

describe('RoomEntryAttachments — an entry with no files', () => {
  it('renders nothing for an entry that predates the field', () => {
    // No rail, no ghost — the same silence `EntryReactionRow` keeps for a
    // message nobody reacted to.
    const { container } = render(<RoomEntryAttachments attachments={[]} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('room-entry-attachments')).not.toBeInTheDocument();
  });
});

describe('RoomEntryAttachments — several files', () => {
  it('draws them in the order the entry carries them', () => {
    // Posted order is the order the author chose, and it is the order the
    // server stores. Re-sorting here would disagree with what they saw in the
    // composer's chip bar a second earlier.
    render(
      <RoomEntryAttachments
        attachments={[
          attachment({ id: 'a', name: 'first.png' }),
          attachment({ id: 'b', name: 'second.pdf', preview: null }),
          attachment({ id: 'c', name: 'third.png' }),
        ]}
      />
    );

    const block = screen.getByTestId('room-entry-attachments');
    // Whichever shape each file took — thumbnail or chip — read left to right.
    expect(
      Array.from(block.querySelectorAll('img, [data-testid="room-entry-attachment-chip"]')).map(
        (node) => node.getAttribute('alt') ?? node.textContent
      )
    ).toEqual(['first.png', 'second.pdf2.0 KB', 'third.png']);
  });
});

describe('attachmentsSummary — what the row says about the files', () => {
  it('names the files, and counts them', () => {
    expect(
      attachmentsSummary([
        attachment({ id: 'a', name: 'screenshot.png' }),
        attachment({ id: 'b', name: 'notes.pdf', preview: null }),
      ])
    ).toBe('2 files: screenshot.png, notes.pdf');
  });

  it('says “file” for one of them', () => {
    expect(attachmentsSummary([attachment()])).toBe('1 file: screenshot.png');
  });

  it('says nothing at all where there are none', () => {
    expect(attachmentsSummary([])).toBeNull();
  });
});
