// @vitest-environment jsdom
/**
 * The bar's quiet line about who leads the channel (DOR-2823).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomLeadChip } from '../ui/RoomLeadChip';

function member(authorId: string, kind: 'human' | 'agent', displayName: string): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId,
    responseMode: 'engaged',
    joinedAt: '2026-10-01T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    author: { id: authorId, kind, displayName, handle: null },
  } as RoomRosterEntry;
}

const MEMBERS = [member('author-me', 'human', 'Dorian'), member('author-kai', 'agent', 'Kai')];

function renderChip(room: Parameters<typeof RoomLeadChip>[0]['room']) {
  render(
    <TooltipProvider>
      <RoomLeadChip room={room} />
    </TooltipProvider>
  );
}

afterEach(cleanup);

describe('RoomLeadChip', () => {
  it('names the lead of a channel', () => {
    renderChip({ id: 'room-1', kind: 'channel', members: MEMBERS, leadAuthorId: 'author-kai' });
    expect(screen.getByRole('button', { name: 'Lead: Kai' })).toBeInTheDocument();
  });

  it('draws nothing when the channel has no lead', () => {
    renderChip({ id: 'room-1', kind: 'channel', members: MEMBERS, leadAuthorId: null });
    expect(screen.queryByTestId('bar-lead-chip')).not.toBeInTheDocument();
  });

  it('draws nothing for a lead who is no longer a member', () => {
    renderChip({ id: 'room-1', kind: 'channel', members: MEMBERS, leadAuthorId: 'author-gone' });
    expect(screen.queryByTestId('bar-lead-chip')).not.toBeInTheDocument();
  });

  it('draws nothing in a direct message', () => {
    renderChip({ id: 'room-1', kind: 'dm', members: MEMBERS, leadAuthorId: 'author-kai' });
    expect(screen.queryByTestId('bar-lead-chip')).not.toBeInTheDocument();
  });
});
