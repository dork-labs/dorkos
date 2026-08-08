/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/layers/features/dashboard-attention', () => ({
  DeadLetterDetailSheet: () => null,
  FailedRunDetailSheet: () => null,
  OfflineAgentDetailSheet: () => null,
}));

import { useExtensionRegistry, createInitialSlots } from '@/layers/shared/model';
import type { DashboardSectionContribution } from '@/layers/shared/model';
import { DashboardPage } from '../ui/DashboardPage';

const register = (contribution: DashboardSectionContribution) =>
  useExtensionRegistry.getState().register('dashboard.sections', contribution);

const makeSection = (
  id: string,
  overrides: Partial<DashboardSectionContribution> = {}
): DashboardSectionContribution => ({
  id,
  component: () => <div data-testid={id}>{id}</div>,
  ...overrides,
});

describe('DashboardPage', () => {
  beforeEach(() => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
  });

  it('renders built-in sections in priority order', () => {
    register(makeSection('needs-attention', { priority: 3 }));
    register(makeSection('composer', { priority: 1 }));

    render(<DashboardPage />);

    const rendered = screen
      .getAllByTestId(/composer|needs-attention/)
      .map((el) => el.dataset.testid);
    expect(rendered).toEqual(['composer', 'needs-attention']);
  });

  it('leaves extension sections to the Activity tab', () => {
    register(makeSection('composer'));
    register(makeSection('acme:widget'));

    render(<DashboardPage />);

    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(screen.queryByTestId('acme:widget')).not.toBeInTheDocument();
  });

  it('honours visibleWhen on built-in sections', () => {
    register(makeSection('composer', { visibleWhen: () => false }));

    render(<DashboardPage />);

    expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
  });
});
