/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { WithheldExtensionsNotice } from '../ui/WithheldExtensionsNotice';

const state = vi.hoisted(() => ({
  approvals: [] as Partial<PendingExtensionApproval>[],
  extensions: [] as Partial<ExtensionRecordPublic>[],
}));
vi.mock('../model/use-pending-extension-approvals', () => ({
  usePendingExtensionApprovals: () => ({
    approvals: state.approvals,
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('../model/use-extension-list', () => ({
  useExtensionList: () => ({ data: state.extensions }),
}));

/** An installed mini app that declares `slots`. */
function installed(id: string, slots: string[]): Partial<ExtensionRecordPublic> {
  return {
    id,
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      contributions: Object.fromEntries(slots.map((slot) => [slot, true])),
    } as ExtensionRecordPublic['manifest'],
  };
}

describe('WithheldExtensionsNotice (DOR-3068)', () => {
  beforeEach(() => {
    state.approvals = [];
    state.extensions = [];
  });

  it('names a mini app held back for changed code, and Review opens its card', async () => {
    state.extensions = [installed('flow', ['right-panel'])];
    state.approvals = [{ id: 'flow', name: 'Flow', changedFiles: ['index.ts'], updatedFrom: null }];
    const onReview = vi.fn();
    render(<WithheldExtensionsNotice slot="right-panel" onReview={onReview} />);

    expect(screen.getByText('Flow changed and is waiting for your OK')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it('names one held back for an update too', () => {
    state.extensions = [installed('flow', ['dashboard.sections'])];
    state.approvals = [{ id: 'flow', name: 'Flow', changedFiles: null, updatedFrom: '1.2.0' }];
    render(<WithheldExtensionsNotice slot="dashboard.sections" onReview={vi.fn()} />);
    expect(screen.getByText('Flow changed and is waiting for your OK')).toBeInTheDocument();
  });

  it('draws nothing for one that never ran, or one that draws in another slot', () => {
    state.extensions = [
      installed('new', ['right-panel']),
      installed('card', ['dashboard.sections']),
    ];
    state.approvals = [
      { id: 'new', name: 'New', changedFiles: null, updatedFrom: null },
      { id: 'card', name: 'Card', changedFiles: ['index.ts'], updatedFrom: null },
    ];
    const { container } = render(
      <WithheldExtensionsNotice slot="right-panel" onReview={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
