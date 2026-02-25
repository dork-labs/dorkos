/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseMeshEnabled = vi.fn().mockReturnValue(false);
const mockUseMeshStatus = vi.fn().mockReturnValue({ data: undefined, isLoading: false });

vi.mock('@/layers/entities/mesh', () => ({
  useMeshEnabled: (...args: unknown[]) => mockUseMeshEnabled(...args),
  useMeshStatus: (...args: unknown[]) => mockUseMeshStatus(...args),
}));

import { MeshStatsHeader } from '../MeshStatsHeader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockStatus = {
  totalAgents: 7,
  activeCount: 4,
  inactiveCount: 2,
  staleCount: 1,
  byRuntime: {},
  byProject: {},
};

function enableMeshWithStatus() {
  mockUseMeshEnabled.mockReturnValue(true);
  mockUseMeshStatus.mockReturnValue({ data: mockStatus, isLoading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseMeshEnabled.mockReturnValue(false);
  mockUseMeshStatus.mockReturnValue({ data: undefined, isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MeshStatsHeader', () => {
  describe('renders null when conditions are not met', () => {
    it('renders null when mesh is disabled', () => {
      mockUseMeshEnabled.mockReturnValue(false);
      const { container } = render(<MeshStatsHeader />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null when enabled prop is false', () => {
      enableMeshWithStatus();
      const { container } = render(<MeshStatsHeader enabled={false} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null while loading', () => {
      mockUseMeshEnabled.mockReturnValue(true);
      mockUseMeshStatus.mockReturnValue({ data: undefined, isLoading: true });
      const { container } = render(<MeshStatsHeader />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null when status data is absent', () => {
      mockUseMeshEnabled.mockReturnValue(true);
      mockUseMeshStatus.mockReturnValue({ data: undefined, isLoading: false });
      const { container } = render(<MeshStatsHeader />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('renders counts when mesh is enabled with data', () => {
    beforeEach(enableMeshWithStatus);

    it('shows total agent count', () => {
      render(<MeshStatsHeader />);
      expect(screen.getByText('7 agents')).toBeInTheDocument();
    });

    it('shows active count', () => {
      render(<MeshStatsHeader />);
      expect(screen.getByText('4')).toBeInTheDocument();
    });

    it('shows inactive count', () => {
      render(<MeshStatsHeader />);
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('shows stale count', () => {
      render(<MeshStatsHeader />);
      expect(screen.getByText('1')).toBeInTheDocument();
    });

    it('renders three status dot indicators', () => {
      render(<MeshStatsHeader />);
      // Each dot has aria-hidden="true" and one of the status colors
      const greenDot = document.querySelector('.bg-green-500');
      const amberDot = document.querySelector('.bg-amber-500');
      const zincDot = document.querySelector('.bg-zinc-400');
      expect(greenDot).toBeInTheDocument();
      expect(amberDot).toBeInTheDocument();
      expect(zincDot).toBeInTheDocument();
    });
  });

  describe('passes enabled flag to useMeshStatus', () => {
    it('passes combined enabled state to the hook', () => {
      mockUseMeshEnabled.mockReturnValue(true);
      mockUseMeshStatus.mockReturnValue({ data: mockStatus, isLoading: false });
      render(<MeshStatsHeader enabled={true} />);
      // enabled && meshEnabled => true
      expect(mockUseMeshStatus).toHaveBeenCalledWith(true);
    });

    it('passes false to the hook when enabled prop is false', () => {
      mockUseMeshEnabled.mockReturnValue(true);
      mockUseMeshStatus.mockReturnValue({ data: mockStatus, isLoading: false });
      render(<MeshStatsHeader enabled={false} />);
      expect(mockUseMeshStatus).toHaveBeenCalledWith(false);
    });
  });
});
