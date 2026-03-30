/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// Radix UI's @radix-ui/react-use-size calls ResizeObserver which jsdom doesn't provide.
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

// Mock sound effects — use importOriginal to preserve other exports (DEFAULT_FONT, etc.)
const mockPlaySliderTick = vi.fn();
const mockPlayCelebration = vi.fn();
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    playSliderTick: (...a: unknown[]) => mockPlaySliderTick(...a),
    playCelebration: (...a: unknown[]) => mockPlayCelebration(...a),
  };
});

const mockMutate = vi.fn();
let mockIsPending = false;
vi.mock('@/layers/entities/agent', () => ({
  useUpdateAgent: () => ({
    mutate: mockMutate,
    isPending: mockIsPending,
  }),
}));

vi.mock('../../model/use-onboarding', () => ({
  useOnboarding: () => ({
    config: {
      agents: {
        defaultDirectory: '~/.dork/agents',
        defaultAgent: 'dorkbot',
      },
    },
  }),
}));

import { MeetDorkBotStep } from '../MeetDorkBotStep';

describe('MeetDorkBotStep', () => {
  const onStepComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPending = false;
  });

  afterEach(() => {
    cleanup();
  });

  // --- Copy ---

  it('renders heading and description copy', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    expect(screen.getByText('Meet DorkBot')).toBeInTheDocument();
    expect(screen.getByText(/DorkBot is your guide to DorkOS/)).toBeInTheDocument();
    expect(
      screen.getByText(/Shape DorkBot\u2019s personality to match your style/)
    ).toBeInTheDocument();
  });

  // --- Personality sliders ---

  it('renders 5 trait sliders', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(5);
  });

  it('renders trait labels for each slider', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    // Check endpoint labels exist
    expect(screen.getByText('Serious')).toBeInTheDocument();
    expect(screen.getByText('Playful')).toBeInTheDocument();
    expect(screen.getByText('Ask first')).toBeInTheDocument();
    expect(screen.getByText('Act alone')).toBeInTheDocument();
    expect(screen.getByText('Conservative')).toBeInTheDocument();
    expect(screen.getByText('Bold')).toBeInTheDocument();
    expect(screen.getByText('Terse')).toBeInTheDocument();
    expect(screen.getByText('Thorough')).toBeInTheDocument();
    expect(screen.getByText('By the book')).toBeInTheDocument();
    expect(screen.getByText('Inventive')).toBeInTheDocument();
  });

  it('displays preview text', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    const preview = screen.getByTestId('personality-preview');
    // Default traits at level 3 should produce preview containing 'Balanced'
    expect(preview.textContent).toContain('Balanced');
  });

  it('avatar has breathe animation class', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    const avatar = screen.getByTestId('dorkbot-avatar');
    expect(avatar.className).toContain('dorkbot-avatar');
  });

  it('calls updateAgent with correct path and default traits when Continue is clicked', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    fireEvent.click(screen.getByTestId('continue-dorkbot'));

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const [opts] = mockMutate.mock.calls[0];
    expect(opts).toEqual({
      path: '~/.dork/agents/dorkbot',
      updates: { traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 } },
    });
  });

  it('shows Continue button text', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    expect(screen.getByTestId('continue-dorkbot')).toHaveTextContent('Continue');
  });

  it('shows Saving... when mutation is pending', () => {
    mockIsPending = true;
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    expect(screen.getByTestId('continue-dorkbot')).toHaveTextContent('Saving...');
  });

  it('calls onStepComplete and playCelebration on update success', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    fireEvent.click(screen.getByTestId('continue-dorkbot'));

    // Extract the onSuccess callback and invoke it
    const [, callbacks] = mockMutate.mock.calls[0];
    callbacks.onSuccess();

    expect(mockPlayCelebration).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });

  it('shows error message on update failure and allows retry', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    fireEvent.click(screen.getByTestId('continue-dorkbot'));

    // Simulate error — wrap in act because onError triggers setState
    const [, callbacks] = mockMutate.mock.calls[0];
    act(() => {
      callbacks.onError(new Error('Network error'));
    });

    expect(screen.getByTestId('update-error')).toHaveTextContent('Network error');

    // Button should still be clickable for retry
    fireEvent.click(screen.getByTestId('continue-dorkbot'));
    expect(mockMutate).toHaveBeenCalledTimes(2);
  });

  it('shows generic error message for non-Error failures', () => {
    render(<MeetDorkBotStep onStepComplete={onStepComplete} />);

    fireEvent.click(screen.getByTestId('continue-dorkbot'));

    const [, callbacks] = mockMutate.mock.calls[0];
    act(() => {
      callbacks.onError('some string error');
    });

    expect(screen.getByTestId('update-error')).toHaveTextContent('Failed to update personality');
  });
});
