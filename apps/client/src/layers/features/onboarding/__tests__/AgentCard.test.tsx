/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('motion/react', () => ({
  useReducedMotion: () => false,
}));

import { AgentCard } from '../ui/AgentCard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createCandidate(overrides: Record<string, unknown> = {}) {
  return {
    path: '/home/user/projects/my-app',
    name: 'my-app',
    markers: ['CLAUDE.md', '.github/copilot'],
    gitBranch: null as string | null,
    gitRemote: null as string | null,
    hasDorkManifest: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders agent name and path', () => {
    render(
      <AgentCard candidate={createCandidate()} selected={false} onToggle={vi.fn()} />
    );

    expect(screen.getByText('my-app')).toBeTruthy();
    expect(screen.getByText('~/projects/my-app')).toBeTruthy();
  });

  it('shows marker badges', () => {
    render(
      <AgentCard candidate={createCandidate()} selected={false} onToggle={vi.fn()} />
    );

    expect(screen.getByText('CLAUDE.md')).toBeTruthy();
    expect(screen.getByText('Copilot')).toBeTruthy();
  });

  it('shows git remote when provided', () => {
    const candidate = createCandidate({ gitRemote: 'https://github.com/dork-labs/dorkos.git' });

    render(<AgentCard candidate={candidate} selected={false} onToggle={vi.fn()} />);

    expect(screen.getByText('dork-labs/dorkos')).toBeTruthy();
  });

  it('does not render git remote when null', () => {
    render(
      <AgentCard candidate={createCandidate()} selected={false} onToggle={vi.fn()} />
    );

    expect(screen.queryByText('github.com')).toBeNull();
  });

  it('clicking the card calls onToggle', () => {
    const onToggle = vi.fn();

    render(<AgentCard candidate={createCandidate()} selected={false} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('button'));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows Registered badge when hasDorkManifest is true', () => {
    const candidate = createCandidate({ hasDorkManifest: true });

    render(<AgentCard candidate={candidate} selected={false} onToggle={vi.fn()} />);

    expect(screen.getByText('Registered')).toBeTruthy();
  });

  it('does not show Registered badge when hasDorkManifest is false', () => {
    render(
      <AgentCard candidate={createCandidate()} selected={false} onToggle={vi.fn()} />
    );

    expect(screen.queryByText('Registered')).toBeNull();
  });

  it('renders checkmark SVG when selected', () => {
    const { container } = render(
      <AgentCard candidate={createCandidate()} selected={true} onToggle={vi.fn()} />
    );

    // The checkmark SVG path is rendered when selected
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('does not render checkmark SVG when not selected', () => {
    const { container } = render(
      <AgentCard candidate={createCandidate()} selected={false} onToggle={vi.fn()} />
    );

    // No checkmark SVG when not selected
    const inlineSvg = container.querySelector('svg path[d="M5 13l4 4L19 7"]');
    expect(inlineSvg).toBeNull();
  });

  it('formats unknown markers as-is', () => {
    const candidate = createCandidate({ markers: ['custom-marker'] });

    render(<AgentCard candidate={candidate} selected={false} onToggle={vi.fn()} />);

    expect(screen.getByText('custom-marker')).toBeTruthy();
  });

  it('formats .dork marker as DorkOS', () => {
    const candidate = createCandidate({ markers: ['.dork'] });

    render(<AgentCard candidate={candidate} selected={false} onToggle={vi.fn()} />);

    expect(screen.getByText('DorkOS')).toBeTruthy();
  });
});
