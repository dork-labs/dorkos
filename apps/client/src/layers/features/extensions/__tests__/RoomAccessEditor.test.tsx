/**
 * @vitest-environment jsdom
 */
/**
 * "Rooms it can use" on a mini app's Settings card (DOR-3017). Every change is
 * written as the whole list, so the assertions read the list it was handed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

let mockAllowed: string[] = [];
const mockMutate = vi.fn();
let mockRooms: Array<{
  id: string;
  kind: 'channel' | 'dm';
  slug: string | null;
  title: string;
  bridge?: unknown;
}> = [];

vi.mock('../api/room-access', () => ({
  useRoomAccess: () => ({ data: mockAllowed }),
  useSetRoomAccess: () => ({ mutate: mockMutate }),
}));
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return { ...actual, useRooms: () => ({ data: mockRooms }) };
});

import { RoomAccessEditor } from '../ui/RoomAccessEditor';

beforeAll(() => {
  // cmdk scrolls the active item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  mockAllowed = [];
  mockMutate.mockReset();
  mockRooms = [
    { id: 'r1', kind: 'channel', slug: 'marketing', title: 'Marketing' },
    { id: 'r2', kind: 'channel', slug: 'general', title: 'General' },
    { id: 'r3', kind: 'channel', slug: 'telegram', title: 'Telegram', bridge: { kind: 'x' } },
  ];
});

afterEach(cleanup);

describe('RoomAccessEditor', () => {
  it('says it reaches nothing while no room is picked', () => {
    render(<RoomAccessEditor extensionId="social" name="Social Manager" />);
    expect(screen.getByText('None yet. It can’t read or reply anywhere.')).toBeInTheDocument();
  });

  it('adds a room, offering only rooms on this computer', () => {
    render(<RoomAccessEditor extensionId="social" name="Social Manager" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a room for Social Manager' }));

    expect(screen.queryByText('#telegram')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('#marketing'));

    expect(mockMutate).toHaveBeenCalledWith(['r1'], expect.anything());
  });

  it('removes a room', () => {
    mockAllowed = ['r1', 'r2'];
    render(<RoomAccessEditor extensionId="social" name="Social Manager" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove #marketing' }));
    expect(mockMutate).toHaveBeenCalledWith(['r2'], expect.anything());
  });
});
