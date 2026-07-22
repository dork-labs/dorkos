/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AgentDiscoveryStep } from '../AgentDiscoveryStep';

const mockStartScan = vi.fn();
let mockDiscoveryState: {
  candidates: { path: string }[];
  existingAgents: unknown[];
  isScanning: boolean;
  progress: null;
  error: null;
  lastScanAt: string | null;
} = {
  candidates: [],
  existingAgents: [],
  isScanning: false,
  progress: null,
  error: null,
  lastScanAt: null,
};

vi.mock('@/layers/entities/mesh', () => ({
  useRegisterAgent: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/layers/entities/discovery', () => ({
  useDiscoveryScan: () => ({ startScan: mockStartScan }),
  useDiscoveryStore: () => mockDiscoveryState,
  useActedPaths: () => ({ actedPaths: new Set(), markActed: vi.fn(), resetActed: vi.fn() }),
  buildRegistrationOverrides: vi.fn(),
  sortCandidates: (c: unknown[]) => c,
  CandidateCard: ({ candidate }: { candidate: { path: string } }) => (
    <div data-testid="candidate">{candidate.path}</div>
  ),
  BulkAddBar: () => null,
  CollapsibleImportedSection: () => null,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('AgentDiscoveryStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiscoveryState = {
      candidates: [],
      existingAgents: [],
      isScanning: false,
      progress: null,
      error: null,
      lastScanAt: null,
    };
  });

  afterEach(cleanup);

  it('self-starts a scan when the store is cold (standalone mount)', () => {
    render(<AgentDiscoveryStep onStepComplete={vi.fn()} />);
    expect(mockStartScan).toHaveBeenCalledTimes(1);
  });

  it('does not rescan when the flow already prefetched (warm store)', () => {
    mockDiscoveryState = {
      candidates: [{ path: '/p' }],
      existingAgents: [],
      isScanning: false,
      progress: null,
      error: null,
      lastScanAt: '2026-07-21T00:00:00Z',
    };
    render(<AgentDiscoveryStep onStepComplete={vi.fn()} />);
    expect(mockStartScan).not.toHaveBeenCalled();
  });

  it('renders the import header and a card per candidate once the scan completes', () => {
    mockDiscoveryState = {
      candidates: [{ path: '/a' }, { path: '/b' }],
      existingAgents: [],
      isScanning: false,
      progress: null,
      error: null,
      lastScanAt: '2026-07-21T00:00:00Z',
    };
    render(<AgentDiscoveryStep onStepComplete={vi.fn()} />);

    expect(screen.getByText('Import your projects')).toBeInTheDocument();
    expect(screen.getAllByTestId('candidate')).toHaveLength(2);
  });

  it('Continue advances onboarding once the scan has results', async () => {
    const user = userEvent.setup();
    const onStepComplete = vi.fn();
    mockDiscoveryState = {
      candidates: [{ path: '/a' }],
      existingAgents: [],
      isScanning: false,
      progress: null,
      error: null,
      lastScanAt: '2026-07-21T00:00:00Z',
    };
    render(<AgentDiscoveryStep onStepComplete={onStepComplete} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
