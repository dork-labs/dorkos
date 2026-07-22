/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { TourOfferChips } from '../ui/TourOfferChips';
import { TOUR_DEFINITIONS } from '../model/tour-definitions';

const acceptOffer = vi.fn();
const declineOffer = vi.fn();
let mockPendingOffer: unknown = null;
let mockPendingOfferId: string | null = null;

vi.mock('../model/use-tours', () => ({
  useTours: () => ({
    pendingOffer: mockPendingOffer,
    pendingOfferId: mockPendingOfferId,
    acceptOffer,
    declineOffer,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockPendingOffer = null;
  mockPendingOfferId = null;
});

describe('TourOfferChips', () => {
  it('renders nothing when no occasion stands', () => {
    const { container } = render(<TourOfferChips />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the offer line and both chips when an occasion stands', () => {
    mockPendingOffer = TOUR_DEFINITIONS.tasks;
    mockPendingOfferId = 'tasks';
    render(<TourOfferChips />);
    expect(screen.getByText(TOUR_DEFINITIONS.tasks.offerLine as string)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  });

  it('accepts the offer on "Show me"', () => {
    mockPendingOffer = TOUR_DEFINITIONS.tasks;
    mockPendingOfferId = 'tasks';
    render(<TourOfferChips />);
    fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(acceptOffer).toHaveBeenCalledWith('tasks');
  });

  it('declines the offer on "Later"', () => {
    mockPendingOffer = TOUR_DEFINITIONS.relay;
    mockPendingOfferId = 'relay';
    render(<TourOfferChips />);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(declineOffer).toHaveBeenCalledWith('relay');
  });

  afterEach(() => cleanup());
});
