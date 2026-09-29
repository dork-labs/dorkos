/**
 * "Needs You" regrouping never remounts a row (DOR-2523 client review 4):
 * when a second project gets something waiting and the headings appear, a
 * decision row keeps its open field, its text and its focus.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionDecisionDTO } from '@dorkos/shared/extension-decision-schemas';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn(), useSafeNavigate: () => vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import { WaitingGroups, type WaitingGroupsProps } from '../ui/WaitingGroups';

const DORKOS = { root: '/repos/dorkos', name: 'dorkos' };
const BLINTZ = { root: '/repos/blintz', name: 'blintz' };

const decision: ExtensionDecisionDTO = {
  id: '01J0000000000000000000000D',
  extensionId: 'flow',
  extensionName: 'Flow',
  key: 'why',
  title: 'Why did the build break?',
  why: 'The agent needs a hint.',
  detail: null,
  project: DORKOS,
  projectLabel: null,
  since: null,
  actions: { kind: 'word', label: 'Answer', input: { placeholder: 'Why?', maxLength: 200 } },
  link: null,
  raisedAt: '2026-09-29T09:00:00.000Z',
  needsYou: false,
  watch: null,
  revision: 0,
};

const approval: PendingApproval = {
  approvalId: '01JZ0000000000000000000001',
  capabilityId: 'marketplace.uninstall',
  capabilityTitle: 'Uninstall a marketplace package',
  tier: 'destructive',
  summary: 'Uninstall "sentry-monitor"',
  requestedBy: '/Users/dev/agents/dorkbot',
  hasAgentPath: true,
  area: null,
  alwaysOffered: false,
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  project: BLINTZ,
};

const base: WaitingGroupsProps = {
  asks: [],
  hasSettlingAsks: false,
  approvals: [],
  decisions: [decision],
  schedules: [],
  onOpenSession: vi.fn(),
  onNavigate: vi.fn(),
  onScheduleNavigate: vi.fn(),
};

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

afterEach(() => cleanup());

describe('WaitingGroups', () => {
  it('keeps an open answer, its text and focus when the headings appear', async () => {
    const user = userEvent.setup();
    const view = render(<WaitingGroups {...base} />, { wrapper: wrapper() });
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    const field = screen.getByLabelText('Answer', { selector: 'textarea' });
    await user.type(field, 'A flaky test');

    view.rerender(<WaitingGroups {...base} approvals={[approval]} />);

    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['dorkos', 'blintz'])
    );
    const after = screen.getByLabelText('Answer', { selector: 'textarea' });
    expect(after).toBe(field);
    expect(after).toHaveValue('A flaky test');
    expect(after).toHaveFocus();
  });
});

describe('WaitingGroups keeps lists mounted when their order changes (client re-review)', () => {
  const second: PendingApproval = {
    ...approval,
    approvalId: '01JZ0000000000000000000002',
    project: null,
  };
  const first: PendingApproval = { ...approval, project: null };

  it('keeps the approval list, and focus in it, when the top card moves to the end', async () => {
    const view = render(<WaitingGroups {...base} decisions={[]} approvals={[first, second]} />, {
      wrapper: wrapper(),
    });
    const list = document.querySelector('[data-approval-id]')!.parentElement!;
    const allow = document.querySelector<HTMLElement>(
      `[data-approval-id="${second.approvalId}"] button`
    )!;
    allow.focus();
    // The answered card settles at the end: same cards, new order.
    view.rerender(<WaitingGroups {...base} decisions={[]} approvals={[second, first]} />);
    expect(document.querySelector('[data-approval-id]')!.parentElement).toBe(list);
    expect(allow).toHaveFocus();
  });
});
