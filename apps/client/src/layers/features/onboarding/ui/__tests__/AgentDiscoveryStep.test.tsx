/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useAgentCreationStore } from '@/layers/shared/model';
import { AgentDiscoveryStep } from '../AgentDiscoveryStep';

// Force the "zero candidates found" state: not scanning, no candidates, no
// existing agents — so the component renders the create-your-first-agent CTA.
vi.mock('@/layers/entities/mesh', () => ({
  useRegisterAgent: () => ({ mutate: vi.fn() }),
  useMeshScanRoots: () => ({ roots: [], setScanRoots: vi.fn() }),
}));

vi.mock('@/layers/entities/discovery', () => ({
  useDiscoveryScan: () => ({ startScan: vi.fn() }),
  useDiscoveryStore: () => ({
    candidates: [],
    existingAgents: [],
    isScanning: false,
    progress: null,
    error: null,
  }),
  useActedPaths: () => ({ actedPaths: new Set(), markActed: vi.fn(), resetActed: vi.fn() }),
  buildRegistrationOverrides: vi.fn(),
  sortCandidates: (c: unknown[]) => c,
  CandidateCard: () => null,
  BulkAddBar: () => null,
  CollapsibleImportedSection: () => null,
  ScanRootInput: () => null,
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

describe('AgentDiscoveryStep — zero candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentCreationStore.setState({ isOpen: false, seed: null, onCreated: null });
  });

  afterEach(cleanup);

  it('offers "Create your first agent" instead of a bespoke form', () => {
    render(<AgentDiscoveryStep onStepComplete={vi.fn()} />);
    expect(screen.getByTestId('create-first-agent')).toBeInTheDocument();
    // The retired bespoke form's Persona field must be gone.
    expect(screen.queryByLabelText(/persona/i)).not.toBeInTheDocument();
  });

  it('opens the real creation dialog and advances onboarding on a successful create', async () => {
    const user = userEvent.setup();
    const onStepComplete = vi.fn();
    render(<AgentDiscoveryStep onStepComplete={onStepComplete} />);

    await user.click(screen.getByTestId('create-first-agent'));

    // The gallery (M2) opens via the shared creation store, seeded with an
    // onCreated hook that advances onboarding.
    const state = useAgentCreationStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.seed).toBeNull();
    expect(typeof state.onCreated).toBe('function');

    // A successful create fires the hook → onboarding advances.
    state.onCreated?.();
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});
