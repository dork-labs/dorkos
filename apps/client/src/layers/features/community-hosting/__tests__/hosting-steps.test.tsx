/**
 * @vitest-environment jsdom
 *
 * Every state the hosted-community dialogs can draw (spec P5, "States"),
 * rendered through the same step builders the dialogs use, from the contract
 * package's own fixtures. Each state gets its own words; a state the release
 * does not know gets words too, never a blank or a crash.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { CommunityMoveFailureCode, HostedCommunity } from '@dork-labs/cloud-api';
import type { CloudCommunityMove } from '@dorkos/shared/cloud-schemas';
import listFixture from '@dork-labs/cloud-api/fixtures/v1/communities/list.json' with { type: 'json' };
import moveImportingFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-importing.json' with { type: 'json' };
import entitlementProblem from '@dork-labs/cloud-api/fixtures/v1/problem/entitlement-required-action.json' with { type: 'json' };
import {
  claimConnectStep,
  HostedCommunityList,
  HostingStepPreview,
  moveChooseStep,
  moveExplainStep,
  moveProgressStep,
  moveSendingStep,
  moveStepOf,
  startFormStep,
  type HostingStep,
} from '../index';
import { moveFailureCopy } from '../model/hosting-copy';

const mockOpenExternalLink = vi.fn((_href: string) => true);
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink: (href: string) => mockOpenExternalLink(href),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const communities = listFixture.items as unknown as HostedCommunity[];
const noop = () => {};

function show(step: HostingStep) {
  return render(<HostingStepPreview step={step} />);
}

function move(overrides: Partial<CloudCommunityMove>): CloudCommunityMove {
  return { ...(moveImportingFixture as unknown as CloudCommunityMove), upload: null, ...overrides };
}

const progressHandlers = {
  busy: false,
  notice: null,
  onCancelMove: noop,
  onSendAgain: noop,
  onStartOver: noop,
  onClose: noop,
};

function startForm(overrides: Partial<Parameters<typeof startFormStep>[0]> = {}) {
  return startFormStep({
    name: 'Night shift',
    webAddress: '',
    onNameChange: noop,
    onWebAddressChange: noop,
    webAddressStatus: { kind: 'none' },
    submitting: false,
    failure: { field: null, notice: null },
    allowance: null,
    formId: 'f',
    onSubmit: noop,
    onCancel: noop,
    ...overrides,
  });
}

describe('Start a community: the form', () => {
  it('shows the web address grammar as a hint, and nothing about allowance it was not told', () => {
    show(startForm());
    expect(screen.getByText(/Lower-case letters, numbers and single hyphens/)).toBeInTheDocument();
    expect(screen.queryByText(/more communit/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start community' })).toBeEnabled();
  });

  it('says how many more communities the account can start, when the service says', () => {
    show(startForm({ allowance: { maxCommunities: 3, usedCommunities: 1 } }));
    expect(screen.getByText('You can start 2 more communities.')).toBeInTheDocument();
  });

  it('puts a taken web address on the field and blocks the start', () => {
    show(startForm({ webAddress: 'acme', webAddressStatus: { kind: 'taken' } }));
    expect(screen.getByText('That web address is taken.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start community' })).toBeDisabled();
  });

  it('says a reserved web address can’t be used', () => {
    show(startForm({ webAddress: 'admin', webAddressStatus: { kind: 'reserved' } }));
    expect(screen.getByText('That web address can’t be used.')).toBeInTheDocument();
  });

  it('locks while submitting', () => {
    show(startForm({ submitting: true }));
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    expect(screen.getByLabelText('Community name')).toBeDisabled();
  });

  // Purpose: an entitlement refusal is the service's own text plus its link.
  // Fails if the app substitutes words or drops the link.
  it('shows an entitlement refusal in the service’s words, with its link', () => {
    show(startForm({ failure: { field: null, notice: { problem: entitlementProblem as never } } }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(entitlementProblem.title);
    expect(alert).toHaveTextContent(entitlementProblem.detail);
    fireEvent.click(within(alert).getByRole('button', { name: /Open your account/ }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(entitlementProblem.actionUrl);
  });

  it('keeps the form and says so when the account can’t be reached', () => {
    show(
      startForm({
        failure: {
          field: null,
          notice: { message: 'Couldn’t reach your DorkOS account. Try again.' },
        },
      })
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Couldn’t reach your DorkOS account. Try again.'
    );
    expect(screen.getByLabelText('Community name')).toHaveValue('Night shift');
  });

  it('treats a service title as text, never as markup', () => {
    show(
      startForm({
        failure: {
          field: null,
          notice: {
            problem: { ...entitlementProblem, title: '<img src=x onerror=alert(1)>' } as never,
          },
        },
      })
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('claim and connect', () => {
  const base = {
    name: 'Night shift',
    doneDetail: 'done detail',
    onOpenClaim: noop,
    onConfirmClaimed: noop,
    onOpenApproval: noop,
    onRetryConnect: noop,
    onClose: noop,
  };

  it('tells the person to finish in their browser', () => {
    show(
      claimConnectStep({
        ...base,
        state: { kind: 'claim', opened: false, busy: false, notice: null },
      })
    );
    expect(
      screen.getByText(
        'Finish in your browser. Sign in or create your account there, then come back.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open in your browser/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'I’ve finished' })).toBeInTheDocument();
  });

  it('offers to open it again once opened, and says when the sign-in is not done', () => {
    show(
      claimConnectStep({
        ...base,
        state: {
          kind: 'claim',
          opened: true,
          busy: false,
          notice: { message: 'Your sign-in isn’t finished yet.' },
        },
      })
    );
    expect(screen.getByRole('button', { name: /Open it again/ })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Your sign-in isn’t finished yet.');
  });

  it('waits while the community is being set up', () => {
    show(claimConnectStep({ ...base, state: { kind: 'preparing' } }));
    expect(screen.getByRole('heading', { name: 'Setting up Night shift' })).toBeInTheDocument();
  });

  it('asks for approval while connecting, and offers to connect again when it ends', () => {
    const { unmount } = show(
      claimConnectStep({
        ...base,
        state: {
          kind: 'connecting',
          approvalUrl: 'https://c.example/approve',
          busy: false,
          notice: null,
        },
      })
    );
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open approval page/ })).toBeEnabled();
    unmount();
    show(
      claimConnectStep({
        ...base,
        state: {
          kind: 'connecting',
          approvalUrl: null,
          busy: false,
          notice: { message: 'The approval ended.' },
        },
      })
    );
    expect(screen.getByRole('button', { name: 'Connect again' })).toBeInTheDocument();
  });

  it('says it is done, and selected', () => {
    show(claimConnectStep({ ...base, state: { kind: 'done', ref: 'r' } }));
    expect(screen.getByRole('heading', { name: 'Night shift is ready' })).toBeInTheDocument();
    expect(screen.getByText('It’s selected in your community list.')).toBeInTheDocument();
  });
});

describe('Move a community here', () => {
  it('explains what moves and how to export', () => {
    show(moveExplainStep(noop, noop));
    expect(
      screen.getByText(
        'Moving copies your community’s history and files. Everyone joins again and reconnects their DorkOS. Your old community keeps running until you delete it.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Confirm with your password.')).toBeInTheDocument();
  });

  it('needs a file before it will start', () => {
    show(
      moveChooseStep({
        file: null,
        onFileChange: noop,
        name: 'Old garden',
        onNameChange: noop,
        webAddress: '',
        onWebAddressChange: noop,
        webAddressStatus: { kind: 'none' },
        failure: { field: null, notice: null },
        formId: 'm',
        onSubmit: noop,
        onBack: noop,
      })
    );
    expect(screen.getByLabelText('Export file')).toHaveAttribute('accept', '.zip,application/zip');
    expect(screen.getByRole('button', { name: 'Start moving' })).toBeDisabled();
  });

  it('shows determinate progress while the file reaches this DorkOS', () => {
    show(moveSendingStep({ loaded: 25_000_000, total: 100_000_000 }, noop));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('25 MB of 100 MB')).toBeInTheDocument();
  });

  it('shows determinate progress while it uploads to the new host', () => {
    const step = moveStepOf(
      move({
        state: 'awaiting_upload',
        upload: { state: 'sending', sentBytes: 50, totalBytes: 100, failure: null },
      })
    );
    expect(step.kind).toBe('uploading');
    show(moveProgressStep(step as never, progressHandlers));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('button', { name: 'Cancel move' })).toBeInTheDocument();
  });

  it('offers to send again after a refused upload, and only a restart after a lost one', () => {
    const refused = moveStepOf(
      move({
        state: 'awaiting_upload',
        upload: { state: 'failed', sentBytes: 5, totalBytes: 100, failure: 'rejected' },
      })
    );
    const { unmount } = show(moveProgressStep(refused as never, progressHandlers));
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument();
    unmount();
    const lost = moveStepOf(move({ state: 'awaiting_upload', upload: null }));
    show(moveProgressStep(lost as never, progressHandlers));
    expect(screen.queryByRole('button', { name: 'Send again' })).not.toBeInTheDocument();
    expect(screen.getByText(/Cancel the move, then start again/)).toBeInTheDocument();
  });

  it('says the import is running, with counts only, and that closing is fine', () => {
    show(moveProgressStep(moveStepOf(move({})) as never, progressHandlers));
    expect(screen.getByText('Moving your history…')).toBeInTheDocument();
    expect(screen.getByText('12 channels, 3,400 messages and 210 files.')).toBeInTheDocument();
    expect(screen.getByText(/You can close this/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel move' })).toBeInTheDocument();
  });

  const codes: Array<CommunityMoveFailureCode | 'unrecognised'> = [
    'not_owner_export',
    'archive_invalid',
    'checksum_mismatch',
    'version_unsupported',
    'too_large',
    'storage_limit_reached',
    'upload_expired',
    'storage_unavailable',
    'unrecognised',
  ];

  // Purpose: each failure gets its own sentence and next step. Fails if a code
  // falls through to a generic line, or two codes share one.
  it.each(codes)('explains a %s failure in one sentence with a next step', (code) => {
    show(
      moveProgressStep(
        moveStepOf(move({ state: 'failed', failureCode: code })) as never,
        progressHandlers
      )
    );
    const copy = moveFailureCopy(code);
    expect(screen.getByRole('heading', { name: copy.title })).toBeInTheDocument();
    expect(screen.getByText(copy.next)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
  });

  it('gives every failure code different words', () => {
    const titles = new Set(codes.map((code) => moveFailureCopy(code).title));
    expect(titles.size).toBe(codes.length);
  });

  it('says a cancelled move kept nothing', () => {
    show(moveProgressStep(moveStepOf(move({ state: 'cancelled' })) as never, progressHandlers));
    expect(screen.getByRole('heading', { name: 'Move cancelled' })).toBeInTheDocument();
  });

  it('does not crash on a move state it does not know', () => {
    show(moveProgressStep(moveStepOf(move({ state: 'unrecognised' })) as never, progressHandlers));
    expect(screen.getByText(/a state this version of DorkOS doesn’t know/)).toBeInTheDocument();
  });

  it('hands a ready or claimed move to claim and connect', () => {
    expect(moveStepOf(move({ state: 'ready' })).kind).toBe('ready');
    expect(moveStepOf(move({ state: 'claimed' })).kind).toBe('ready');
  });
});

describe('Hosted communities', () => {
  const actions = {
    confirmingKeep: null as string | null,
    busyId: null,
    notices: {},
    askKeep: vi.fn(),
    cancelKeep: vi.fn(),
    keep: vi.fn(() => Promise.resolve()),
    restore: vi.fn(() => Promise.resolve()),
  };

  function list(items: HostedCommunity[], overrides: Partial<typeof actions> = {}) {
    return render(
      <HostedCommunityList
        communities={items}
        moves={[]}
        allowanceText={null}
        actions={{ ...actions, ...overrides }}
        onFinishSetup={noop}
        onOpenMove={noop}
      />
    );
  }

  it('shows each community’s state, a pending deletion date and the service notice', () => {
    list(communities);
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for its owner')).toHaveLength(2);
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(screen.getByText('Being deleted')).toBeInTheDocument();
    expect(screen.getByText(/It will be deleted for good on/)).toBeInTheDocument();
    expect(screen.getByText('This community will be deleted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Open settings/ }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(communities[3]!.notice!.actionUrl);
    expect(screen.getByRole('button', { name: 'Finish setting up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See the move' })).toBeInTheDocument();
  });

  it('explains a hold, and a host deletion notice', () => {
    const held = {
      ...communities[2]!,
      hold: {
        reason: 'host',
        since: '2026-08-01T00:00:00.000Z',
        deletionNoticeAt: '2026-10-01T00:00:00.000Z',
      },
      actions: {
        ...communities[2]!.actions,
        keep: { allowed: false, wouldHold: [] },
        restore: false,
      },
    } as HostedCommunity;
    list([held]);
    expect(
      screen.getByText('The host put this community on hold. People can still read it.')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The host may delete it after .*You can export it until then\./)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    // A whole-day date reads the same in every time zone.
    expect(screen.getByText(/On hold since .*(August 1|1 August)/)).toBeInTheDocument();
  });

  it('says so for a state or a hold reason it does not know', () => {
    const odd = {
      ...communities[2]!,
      state: 'unrecognised',
      hold: { reason: 'unrecognised', since: '2026-08-01T00:00:00.000Z', deletionNoticeAt: null },
    } as HostedCommunity;
    list([odd]);
    expect(screen.getByText('Unknown state')).toBeInTheDocument();
    expect(screen.getByText(/in a state this version of DorkOS doesn’t know/)).toBeInTheDocument();
    expect(
      screen.getByText(/on hold for a reason this version of DorkOS doesn’t know/)
    ).toBeInTheDocument();
  });

  // Purpose: keeping a community can hold others; the person sees exactly
  // which before confirming. Fails if the preview is not named.
  it('names the communities keeping one open would hold, before it does', () => {
    const held = communities[2]!;
    list(communities, { confirmingKeep: held.communityId });
    const confirm = screen.getByRole('group', { name: `Keep ${held.name} open` });
    expect(confirm).toHaveTextContent(
      `Keeping ${held.name} open puts this one on hold: Acme builders.`
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it open' }));
    expect(actions.keep).toHaveBeenCalledWith(held);
  });

  it('offers Reopen when the service allows it', () => {
    list([communities[2]!]);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(actions.restore).toHaveBeenCalledWith(communities[2]);
  });

  it('lists recent moves, a failed one with its sentence', () => {
    render(
      <HostedCommunityList
        communities={[]}
        moves={[
          move({
            moveId: 'm1',
            name: 'Book club',
            state: 'failed',
            failureCode: 'checksum_mismatch',
          }),
        ]}
        allowanceText={null}
        actions={actions}
        onFinishSetup={noop}
        onOpenMove={noop}
      />
    );
    expect(screen.getByText('Part of this export is damaged.')).toBeInTheDocument();
    expect(screen.getByText('You don’t host any communities yet.')).toBeInTheDocument();
  });
});
