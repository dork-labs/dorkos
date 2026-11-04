/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { ApprovalCard } from '../ui/ApprovalCard';
import { DeclinedHookReviews } from '../ui/DeclinedHookReviews';
import { discardSettlingApprovals } from '../model/settling-approvals';

const hash = 'a'.repeat(64);
const directory = '/workspaces/' + 'cedar-'.repeat(30);
const command = '   echo 40 spaces' + ' '.repeat(40) + 'tail   ';
const detail = `Package: "lunar-hooks"\nWorking directory: "${directory}"\n\nHook 1\nEvent: "PostToolUse"\nMatcher: "Bash|Write"\nCommand: "${command}"\n\nHook 2\nEvent: "Stop"\nMatcher: null\nCommand: "node ./end.mjs"\n\nFile: "hooks/end.mjs"\nFingerprint: "${hash}"`;
const approval: PendingApproval = {
  approvalId: 'hook-review',
  capabilityId: 'harness.project_hooks',
  capabilityTitle: 'Run hooks',
  summary: 'Review 2 hooks before this package can run them.',
  detail,
  packageLabel: 'lunar-hooks',
  tier: 'destructive',
  requestedBy: 'Atlas',
  hasAgentPath: true,
  area: 'packages',
  alwaysOffered: false,
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 119 * 60000).toISOString(),
};
function mount(card = approval, history = false, overrides = {}) {
  const transport = createMockTransport(overrides);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        {history ? <DeclinedHookReviews enabled /> : <ApprovalCard approval={card} />}
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...view, transport };
}
afterEach(() => {
  cleanup();
  discardSettlingApprovals();
  vi.restoreAllMocks();
});
describe('complete hook review', () => {
  it('keeps count and exact answers outside the one body scroll, and focuses the title', async () => {
    const { container } = mount();
    const title = screen.getByRole('heading', {
      name: 'lunar-hooks wants to run code on this computer',
    });
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByText('2 hooks')).toBeVisible();
    expect(screen.getByText('Asked by Atlas')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Allow these 2 hooks' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeVisible();
    expect(screen.queryByText('Cannot be undone')).toBeNull();
    const body = screen.getByRole('region', { name: 'Hook details' });
    expect(body).not.toContainElement(title);
    expect(body).not.toContainElement(screen.getByRole('button', { name: 'Allow these 2 hooks' }));
    expect(body).toHaveTextContent(directory);
    expect(body).toHaveTextContent(hash);
    expect(body).toHaveTextContent('"Bash|Write"');
    expect(body).toHaveTextContent('Files these commands load can change without asking again.');
    expect(container.querySelectorAll('[data-slot="hook-block"]')).toHaveLength(2);
  });
  it('styles only actual padding at the beginning, middle and end as accessible chips', () => {
    mount();
    expect(screen.getAllByRole('img', { name: '3 spaces' })).toHaveLength(2);
    expect(screen.getByRole('img', { name: '40 spaces' })).toHaveAttribute(
      'data-slot',
      'hook-space-token'
    );
    expect(screen.getAllByRole('img')).toHaveLength(3);
    expect(screen.getByText(/echo 40 spaces/)).not.toHaveAttribute('data-slot', 'hook-space-token');
  });
  it('keeps unknown prototype-like event names as quoted data', () => {
    mount({ ...approval, detail: detail.replace('"PostToolUse"', '"__proto__"') });
    expect(screen.getByText('When this event happens')).toBeVisible();
    expect(screen.getByText('"__proto__"')).toBeVisible();
  });

  it('has a singular button and sends a one-time yes', async () => {
    const { transport } = mount({
      ...approval,
      detail: detail.replace(/\n\nHook 2[\s\S]*?\n\nFile:/u, '\n\nFile:'),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Allow this hook' }));
    expect(transport.grantApproval).toHaveBeenCalledWith('hook-review', undefined);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('declines incomplete cards without revealing a command fragment', async () => {
    const { transport } = mount({ ...approval, cannotAllow: true });
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(/echo 40 spaces/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(transport.denyApproval).toHaveBeenCalled();
  });
  it('never offers a yes when a detail cannot be read as the whole server format', () => {
    mount({ ...approval, detail: `${detail}\nunexpected line` });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Decline' })).toBeVisible();
  });
});
describe('individual declined hook recovery', () => {
  it('shows the incomplete outcome and asks again for this row only', async () => {
    const { transport } = mount(approval, true, {
      listDeclinedHookApprovals: vi.fn().mockResolvedValue({
        approvals: [
          {
            approval,
            declineKind: 'incomplete',
            canAskAgain: true,
            reviewPending: false,
            askedAgain: false,
          },
        ],
      }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask again' }));
    expect(screen.getByText('lunar-hooks’s hooks are off')).toBeVisible();
    expect(
      screen.getByText("You declined a request that couldn't be shown in full.")
    ).toBeVisible();
    expect(transport.askAgainHookApproval).toHaveBeenCalledWith('hook-review');
    expect(transport.grantApproval).not.toHaveBeenCalled();
  });
  it('keeps the old refusal and explains the pending review instead of offering another re-ask', async () => {
    mount(approval, true, {
      listDeclinedHookApprovals: vi.fn().mockResolvedValue({
        approvals: [
          {
            approval,
            declineKind: 'refused',
            canAskAgain: false,
            reviewPending: true,
            askedAgain: true,
          },
        ],
      }),
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Hooks stay off until you allow them.'
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});
