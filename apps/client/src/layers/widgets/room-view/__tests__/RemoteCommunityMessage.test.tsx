// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { RemoteCommunityEntrySchema } from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { Conversation, type ConversationCapabilities } from '@/layers/features/conversation';
import { RemoteCommunityMessage } from '../ui/RemoteCommunityMessage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const fileName = `scan-${'community-proof-'.repeat(14)}.png`;
const capabilities: ConversationCapabilities = {
  reactions: false,
  threads: true,
  runWith: false,
  attachments: true,
  mentions: true,
  streamHealth: true,
  presence: false,
  turnStatus: false,
  asks: false,
};
const entry = RemoteCommunityEntrySchema.parse({
  community: 'acceptance-a',
  roomId: 'general',
  id: 'entry-1',
  authorId: 'ada',
  authorKind: 'human',
  authorDisplayName: 'Ada',
  text: 'A remote attachment',
  mentions: [],
  parentEntryId: null,
  threadRootEntryId: null,
  depth: 0,
  remoteSeq: 1,
  attachments: [
    {
      id: 'attachment-1',
      name: fileName,
      contentType: 'image/png',
      byteSize: 1,
      checksum: 'sha256:test',
    },
  ],
  cursor: 'cursor-1',
  createdAt: '2026-09-16T10:00:00Z',
});

describe('RemoteCommunityMessage', () => {
  it('constrains a long attachment label while keeping its full accessible download name', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.downloadRemoteCommunityAttachment).mockResolvedValue(
      new Blob(['x'], { type: 'image/png' })
    );
    const createObjectURL = vi.fn(() => 'blob:attachment');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <Conversation.Root surface="room" capabilities={capabilities} anchor="rail">
            <RemoteCommunityMessage entry={entry} onThread={vi.fn()} />
          </Conversation.Root>
        </TooltipProvider>
      </TransportProvider>
    );

    const download = screen.getByRole('button', { name: fileName });
    expect(download).toHaveClass('max-w-full');
    expect(download.firstElementChild).toHaveClass('min-w-0', 'truncate');

    fireEvent.click(download);
    await waitFor(() =>
      expect(transport.downloadRemoteCommunityAttachment).toHaveBeenCalledWith(
        entry.community,
        entry.roomId,
        entry.attachments[0].id
      )
    );
  });
});
