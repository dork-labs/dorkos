/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/db/client', () => ({ getDb: vi.fn() }));
vi.mock('@/layers/features/marketing', () => ({
  MarketingChrome: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { getDb } from '@/db/client';
import FeedbackStatusPage from '../page';

const VALID_ID = '00000000-0000-0000-0000-000000000000';

let mockLimit: ReturnType<typeof vi.fn>;
let row: Record<string, unknown> | undefined;

beforeEach(() => {
  row = {
    status: 'shipped',
    kind: 'bug',
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
    shippedVersion: '0.56.3',
  };
  mockLimit = vi.fn().mockImplementation(() => Promise.resolve(row ? [row] : []));
  vi.mocked(getDb).mockReturnValue({
    select: () => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) }),
  } as never);
});

describe('FeedbackStatusPage', () => {
  it('renders the status label for a known id', async () => {
    const ui = await FeedbackStatusPage({ params: Promise.resolve({ id: VALID_ID }) });
    render(ui);
    expect(screen.getByText('Shipped v0.56.3')).toBeTruthy();
    expect(screen.getByText(/Your bug report/)).toBeTruthy();
  });

  it('404s a syntactically invalid id before querying', async () => {
    await expect(
      FeedbackStatusPage({ params: Promise.resolve({ id: 'not-a-uuid' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('404s a well-formed id that matches no row', async () => {
    row = undefined;
    await expect(FeedbackStatusPage({ params: Promise.resolve({ id: VALID_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );
  });
});
