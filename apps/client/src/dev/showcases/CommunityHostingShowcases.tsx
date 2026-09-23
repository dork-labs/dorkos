import type { HostedCommunity } from '@dork-labs/cloud-api';
import type { CloudCommunityMove } from '@dorkos/shared/cloud-schemas';
import listFixture from '@dork-labs/cloud-api/fixtures/v1/communities/list.json' with { type: 'json' };
import moveImportingFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-importing.json' with { type: 'json' };
import entitlementProblem from '@dork-labs/cloud-api/fixtures/v1/problem/entitlement-required-action.json' with { type: 'json' };
import {
  claimConnectStep,
  HostedCommunityList,
  HostingStepPreview,
  MOVE_DONE_DETAIL,
  moveChooseStep,
  moveExplainStep,
  moveProgressStep,
  moveSendingStep,
  moveStepOf,
  startFormStep,
  type HostingStep,
} from '@/layers/features/community-hosting';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/*
 * Every state of "Start a community", "Move a community here" and the hosted
 * list, drawn by the same step builders the real dialogs use, from the
 * contract package's own synthetic fixtures. Each demo has the phone, tablet
 * and desktop width toggle.
 */

const noop = () => {};
const communities = listFixture.items as unknown as HostedCommunity[];
const importing = { ...(moveImportingFixture as unknown as CloudCommunityMove), upload: null };

/** One labelled state. */
function State({ label, step }: { label: string; step: HostingStep }) {
  return (
    <div className="space-y-2">
      <ShowcaseLabel>{label}</ShowcaseLabel>
      <HostingStepPreview step={step} />
    </div>
  );
}

const form = {
  name: 'Night shift',
  webAddress: 'night-shift',
  onNameChange: noop,
  onWebAddressChange: noop,
  webAddressStatus: { kind: 'available' } as const,
  submitting: false,
  failure: { field: null, notice: null },
  allowance: { maxCommunities: 3, usedCommunities: 1 },
  formId: 'showcase-start',
  onSubmit: noop,
  onCancel: noop,
};

const claimBase = {
  name: 'Night shift',
  doneDetail: 'Invite people from the community’s own settings when you’re ready.',
  onOpenClaim: noop,
  onConfirmClaimed: noop,
  onOpenApproval: noop,
  onRetryConnect: noop,
  onClose: noop,
};

const progress = {
  busy: false,
  notice: null,
  onCancelMove: noop,
  onSendAgain: noop,
  onStartOver: noop,
  onClose: noop,
};

function moveAt(overrides: Partial<CloudCommunityMove>) {
  return moveProgressStep(moveStepOf({ ...importing, ...overrides }) as never, progress);
}

/** Start a community, every state. */
function StartShowcase() {
  return (
    <PlaygroundSection
      title="Start a community"
      description="The switcher's Start flow while linked to a DorkOS account: form, errors on the field, a refusal in the service's own words, claim in the browser, connecting, done."
    >
      <ShowcaseDemo responsive>
        <div className="grid gap-6">
          <State label="Form, with the allowance the service sent" step={startFormStep(form)} />
          <State
            label="Web address taken"
            step={startFormStep({ ...form, webAddressStatus: { kind: 'taken' } })}
          />
          <State
            label="Web address can’t be used"
            step={startFormStep({
              ...form,
              webAddress: 'admin',
              webAddressStatus: { kind: 'reserved' },
            })}
          />
          <State label="Submitting" step={startFormStep({ ...form, submitting: true })} />
          <State
            label="Refused: the service’s words and link"
            step={startFormStep({
              ...form,
              failure: { field: null, notice: { problem: entitlementProblem as never } },
            })}
          />
          <State
            label="Account unreachable"
            step={startFormStep({
              ...form,
              failure: {
                field: null,
                notice: { message: 'Couldn’t reach your DorkOS account. Try again.' },
              },
            })}
          />
          <State
            label="Setting up"
            step={claimConnectStep({ ...claimBase, state: { kind: 'preparing' } })}
          />
          <State
            label="Claim in the browser"
            step={claimConnectStep({
              ...claimBase,
              state: { kind: 'claim', opened: false, busy: false, notice: null },
            })}
          />
          <State
            label="Claim opened, not finished yet"
            step={claimConnectStep({
              ...claimBase,
              state: {
                kind: 'claim',
                opened: true,
                busy: false,
                notice: {
                  message:
                    'Your sign-in isn’t finished yet. Finish it in your browser, then try again.',
                },
              },
            })}
          />
          <State
            label="Connecting"
            step={claimConnectStep({
              ...claimBase,
              state: {
                kind: 'connecting',
                approvalUrl: 'https://community.example.invalid/approve',
                busy: false,
                notice: null,
              },
            })}
          />
          <State
            label="Done"
            step={claimConnectStep({ ...claimBase, state: { kind: 'done', ref: 'r' } })}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Move a community here, every state. */
function MoveShowcase() {
  return (
    <PlaygroundSection
      title="Move a community here"
      description="Moving in from an owner export: explain, choose, the two upload legs with determinate progress, importing, every failure, cancelled, an unknown state, and the claim at the end."
    >
      <ShowcaseDemo responsive>
        <div className="grid gap-6">
          <State label="Explain" step={moveExplainStep(noop, noop)} />
          <State
            label="Choose the export"
            step={moveChooseStep({
              file: null,
              onFileChange: noop,
              name: 'Old garden',
              onNameChange: noop,
              webAddress: 'old-garden',
              onWebAddressChange: noop,
              webAddressStatus: { kind: 'checking' },
              failure: { field: null, notice: null },
              formId: 'showcase-move',
              onSubmit: noop,
              onBack: noop,
            })}
          />
          <State
            label="Getting the file ready"
            step={moveSendingStep({ loaded: 31_000_000, total: 70_254_592 }, noop)}
          />
          <State
            label="Uploading to the new host"
            step={moveAt({
              state: 'awaiting_upload',
              upload: {
                state: 'sending',
                sentBytes: 52_000_000,
                totalBytes: 70_254_592,
                failure: null,
              },
            })}
          />
          <State
            label="Upload refused by the new host"
            step={moveAt({
              state: 'awaiting_upload',
              upload: {
                state: 'failed',
                sentBytes: 0,
                totalBytes: 70_254_592,
                failure: 'rejected',
              },
            })}
          />
          <State
            label="Upload broken off, can send again"
            step={moveAt({
              state: 'awaiting_upload',
              upload: {
                state: 'failed',
                sentBytes: 0,
                totalBytes: 70_254_592,
                failure: 'interrupted',
              },
            })}
          />
          <State label="Upload lost" step={moveAt({ state: 'awaiting_upload', upload: null })} />
          <State label="Importing" step={moveAt({})} />
          {(
            [
              'not_owner_export',
              'archive_invalid',
              'checksum_mismatch',
              'version_unsupported',
              'too_large',
              'storage_limit_reached',
              'upload_expired',
              'storage_unavailable',
              'unrecognised',
            ] as const
          ).map((code) => (
            <State
              key={code}
              label={`Failed: ${code}`}
              step={moveAt({ state: 'failed', failureCode: code, pollAfterMs: null })}
            />
          ))}
          <State label="Cancelled" step={moveAt({ state: 'cancelled', pollAfterMs: null })} />
          <State label="Unknown state" step={moveAt({ state: 'unrecognised' })} />
          <State
            label="Done"
            step={claimConnectStep({
              ...claimBase,
              name: 'Old garden',
              doneDetail: MOVE_DONE_DETAIL,
              state: { kind: 'done', ref: 'r' },
            })}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

const listActions = {
  confirmingKeep: null,
  busyId: null,
  notices: {},
  askKeep: noop,
  cancelKeep: noop,
  keep: async () => {},
  restore: async () => {},
};

/** The hosted list: every state, holds, notices, keep preview. */
function HostedListShowcase() {
  const hostHeld = {
    ...communities[2]!,
    communityId: 'host-held',
    name: 'Quiet corner',
    hold: {
      reason: 'host',
      since: '2026-09-01T00:00:00.000Z',
      deletionNoticeAt: '2026-10-15T00:00:00.000Z',
    },
    notice: {
      title: 'On hold by the host.',
      detail:
        'Contact the host to talk about it. You can export the community until the date shown.',
      actionUrl: 'https://host.example.invalid/contact',
      actionLabel: 'Contact the host',
    },
    actions: { claimLink: false, keep: { allowed: false, wouldHold: [] }, restore: false },
  } as HostedCommunity;
  const unknown = {
    ...communities[0]!,
    communityId: 'unknown',
    name: 'From the future',
    state: 'unrecognised',
  } as HostedCommunity;
  const moves = [
    {
      ...importing,
      moveId: 'm-failed',
      name: 'Book club',
      state: 'failed',
      failureCode: 'checksum_mismatch',
    },
    importing,
  ] as CloudCommunityMove[];
  return (
    <PlaygroundSection
      title="Hosted communities"
      description="Every community the account hosts: open, waiting for its owner, on hold with the service's notice and a deletion date, being deleted, an unknown state, the keep preview, and recent moves."
    >
      <ShowcaseLabel>List</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <HostedCommunityList
          communities={[...communities, hostHeld, unknown]}
          moves={moves}
          allowanceText="You can start 1 more community."
          actions={listActions}
          onFinishSetup={noop}
          onOpenMove={noop}
        />
      </ShowcaseDemo>
      <ShowcaseLabel>Keep preview: which others it would hold</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <HostedCommunityList
          communities={communities}
          moves={[]}
          allowanceText={null}
          actions={{ ...listActions, confirmingKeep: communities[2]!.communityId }}
          onFinishSetup={noop}
          onOpenMove={noop}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Hosted communities in the DorkOS app (community-host-operator-api P5). */
export function CommunityHostingShowcases() {
  return (
    <>
      <StartShowcase />
      <MoveShowcase />
      <HostedListShowcase />
    </>
  );
}
