/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { TourHost } from '../ui/TourHost';
import { TOUR_DEFINITIONS, type TourDefinition } from '../model/tour-definitions';

vi.mock('../model/use-tour-occasions', () => ({ useTourOccasions: () => {} }));

const runTour = vi.fn();
let mockRunningDefinition: TourDefinition | null = null;
vi.mock('../model/use-tours', () => ({
  useTours: () => ({
    runningDefinition: mockRunningDefinition,
    activeIndex: 0,
    advanceStep: vi.fn(),
    endTour: vi.fn(),
    runTour,
  }),
}));

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const openSettingsToTab = vi.fn();
const clearRequestedTour = vi.fn();
let mockRequestedTour: string | null = null;
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ openSettingsToTab, requestedTour: mockRequestedTour, clearRequestedTour }),
}));

vi.mock('@/layers/shared/ui', () => ({
  TourSpotlight: (props: { activeIndex: number }) => (
    <div data-testid="spotlight" data-active={props.activeIndex} />
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockRunningDefinition = null;
  mockRequestedTour = null;
});

afterEach(() => cleanup());

describe('TourHost', () => {
  it('renders nothing when no tour is running', () => {
    const { queryByTestId } = render(<TourHost />);
    expect(queryByTestId('spotlight')).toBeNull();
  });

  it('consumes a requested tour: runs it and clears the request', () => {
    mockRequestedTour = 'general';
    render(<TourHost />);
    expect(runTour).toHaveBeenCalledWith('general');
    expect(clearRequestedTour).toHaveBeenCalled();
  });

  it('ignores an unknown requested tour id but still clears it', () => {
    mockRequestedTour = 'nope';
    render(<TourHost />);
    expect(runTour).not.toHaveBeenCalled();
    expect(clearRequestedTour).toHaveBeenCalled();
  });

  it('deep-links a route tour and renders the spotlight', () => {
    mockRunningDefinition = TOUR_DEFINITIONS.tasks; // route: /tasks
    const { getByTestId } = render(<TourHost />);
    expect(navigate).toHaveBeenCalledWith({ to: '/tasks' });
    expect(getByTestId('spotlight')).toBeInTheDocument();
  });

  it('deep-links a settings-tab tour to the right tab', () => {
    mockRunningDefinition = TOUR_DEFINITIONS.relay; // settings-tab: channels
    render(<TourHost />);
    expect(openSettingsToTab).toHaveBeenCalledWith('channels');
  });

  it('does not navigate for a no-deep-link tour (mesh)', () => {
    mockRunningDefinition = TOUR_DEFINITIONS.mesh; // deepLink: none
    render(<TourHost />);
    expect(navigate).not.toHaveBeenCalled();
    expect(openSettingsToTab).not.toHaveBeenCalled();
  });
});
