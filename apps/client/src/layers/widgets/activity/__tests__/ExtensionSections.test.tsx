/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useExtensionRegistry, createInitialSlots } from '@/layers/shared/model';
import type { DashboardSectionContribution } from '@/layers/shared/model';
import { ExtensionSections } from '../ui/ExtensionSections';

const withheld = vi.hoisted(() => ({ list: [] as { id: string; name: string }[] }));
const requestInbox = vi.hoisted(() => vi.fn());
vi.mock('@/layers/entities/notifications', () => ({ requestInbox }));
vi.mock('@/layers/entities/extension', () => ({
  useWithheldExtensions: () => withheld.list,
  WithheldExtensionsNotice: ({ onReview }: { onReview: () => void }) =>
    withheld.list.map((ext) => (
      <button key={ext.id} onClick={onReview}>
        {ext.name} changed and is waiting for your OK
      </button>
    )),
}));

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

describe('ExtensionSections', () => {
  beforeEach(() => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
    withheld.list = [];
    requestInbox.mockClear();
  });

  it('says a section held back for changed code is waiting, never blank (DOR-3068)', () => {
    withheld.list = [{ id: 'flow', name: 'Flow' }];
    render(<ExtensionSections />);
    expect(screen.getByText('From your extensions')).toBeInTheDocument();
    screen.getByText('Flow changed and is waiting for your OK').click();
    expect(requestInbox).toHaveBeenCalledOnce();
  });

  it('renders nothing at all when no extension has contributed', () => {
    const { container } = render(<ExtensionSections />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('From your extensions')).not.toBeInTheDocument();
  });

  it('renders extension contributions under one heading, in priority order', () => {
    register(makeSection('acme:second', { priority: 20 }));
    register(makeSection('acme:first', { priority: 10 }));

    render(<ExtensionSections />);

    expect(screen.getByText('From your extensions')).toBeInTheDocument();
    const rendered = screen.getAllByTestId(/^acme:/).map((el) => el.dataset.testid);
    expect(rendered).toEqual(['acme:first', 'acme:second']);
  });

  it('honours visibleWhen', () => {
    register(makeSection('acme:shown', { visibleWhen: () => true }));
    register(makeSection('acme:hidden', { visibleWhen: () => false }));

    render(<ExtensionSections />);

    expect(screen.getByTestId('acme:shown')).toBeInTheDocument();
    expect(screen.queryByTestId('acme:hidden')).not.toBeInTheDocument();
  });

  it('leaves built-in dashboard sections alone — they are not extensions', () => {
    for (const builtIn of [
      'composer',
      'pending-approvals',
      'needs-attention',
      'your-agents',
      'system-status',
      'promo',
      'recent-activity',
    ]) {
      register(makeSection(builtIn));
    }

    const { container } = render(<ExtensionSections />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the extension sections even when built-ins share the slot', () => {
    register(makeSection('recent-activity'));
    register(makeSection('acme:widget'));

    render(<ExtensionSections />);

    expect(screen.getByTestId('acme:widget')).toBeInTheDocument();
    expect(screen.queryByTestId('recent-activity')).not.toBeInTheDocument();
  });
});
