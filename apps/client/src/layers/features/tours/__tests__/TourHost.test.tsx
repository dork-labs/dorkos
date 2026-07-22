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
let mockPathname = '/';
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouterState: (opts: { select: (s: unknown) => unknown }) =>
    opts.select({ location: { pathname: mockPathname } }),
}));

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
  mockPathname = '/';
});

afterEach(() => cleanup());

describe('TourHost', () => {
  it('renders nothing when no tour is running', () => {
    const { queryByTestId } = render(<TourHost />);
    expect(queryByTestId('spotlight')).toBeNull();
  });

  it('starts a requested tour but HOLDS the request until it is running (deferred, never dropped)', () => {
    // The request is set, but the engine has not started the tour yet.
    mockRequestedTour = 'general';
    mockRunningDefinition = null;
    render(<TourHost />);

    // It starts the tour, but does NOT clear the request — so a settling
    // re-render that interrupts before the start commits cannot drop it.
    expect(runTour).toHaveBeenCalledWith('general');
    expect(clearRequestedTour).not.toHaveBeenCalled();
  });

  it('clears the request once the tour is actually running', () => {
    mockRequestedTour = 'general';
    mockRunningDefinition = TOUR_DEFINITIONS.general; // running now reflects the request
    render(<TourHost />);

    expect(clearRequestedTour).toHaveBeenCalled();
  });

  it('a re-render while the request is still pending never clears it', () => {
    mockRequestedTour = 'general';
    mockRunningDefinition = null;
    const { rerender } = render(<TourHost />);
    expect(runTour).toHaveBeenCalledTimes(1);
    expect(clearRequestedTour).not.toHaveBeenCalled();

    // A settling re-render lands while the tour has not started yet — the request
    // must survive it (this is the case that used to drop the launch).
    rerender(<TourHost />);
    expect(clearRequestedTour).not.toHaveBeenCalled();
  });

  it('ignores an unknown requested tour id but still clears it', () => {
    mockRequestedTour = 'nope';
    render(<TourHost />);
    expect(runTour).not.toHaveBeenCalled();
    expect(clearRequestedTour).toHaveBeenCalled();
  });

  it('deep-links a route tour (when not already there) and renders the spotlight', () => {
    mockRunningDefinition = TOUR_DEFINITIONS.tasks; // route: /tasks
    mockPathname = '/'; // not on /tasks yet
    const { getByTestId } = render(<TourHost />);
    expect(navigate).toHaveBeenCalledWith({ to: '/tasks' });
    expect(getByTestId('spotlight')).toBeInTheDocument();
  });

  it('does not re-navigate when already on the target route (no redundant remount)', () => {
    mockRunningDefinition = TOUR_DEFINITIONS.general; // route: /
    mockPathname = '/'; // already home
    render(<TourHost />);
    expect(navigate).not.toHaveBeenCalled();
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
