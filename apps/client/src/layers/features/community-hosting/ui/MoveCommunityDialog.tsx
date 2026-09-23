/**
 * "Move a community here": bring a community from another host by its owner
 * export, then make it yours and connect this DorkOS to it.
 *
 * @module features/community-hosting/ui/MoveCommunityDialog
 */
import { useId, useState, type FormEvent } from 'react';
import type { CloudCommunityMove } from '@dorkos/shared/cloud-schemas';
import { Button, Input, Label, Progress, Spinner } from '@/layers/shared/ui';
import { formatBytes, moveFailureCopy, readWebAddress } from '../model/hosting-copy';
import { useClaimAndConnect } from '../model/use-claim-and-connect';
import { useMoveCommunity, type MoveStep } from '../model/use-move-community';
import {
  useWebAddressStatus,
  type StartFailure,
  type WebAddressStatus,
} from '../model/use-start-community';
import { claimConnectStep } from './claim-connect-step';
import { CommunityFields } from './community-fields';
import { HostingNoticeView, HostingStepDialog, type HostingStep } from './hosting-step';

/** What a finished move says once this DorkOS is connected. */
export const MOVE_DONE_DETAIL = 'Your history is here. Send invitations so people can join again.';

/**
 * The first step: what moving does, and how to get the export.
 *
 * @param onNext - Go on to choosing the file.
 * @param onCancel - Close without doing anything.
 */
export function moveExplainStep(onNext: () => void, onCancel: () => void): HostingStep {
  return {
    title: 'Move a community here',
    description:
      'Moving copies your community’s history and files. Everyone joins again and reconnects their DorkOS. Your old community keeps running until you delete it.',
    body: (
      <div className="space-y-2 text-sm">
        <p className="font-medium">First, get an export of the old community:</p>
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5">
          <li>Open the old community’s Settings, signed in as its owner.</li>
          <li>Choose Export.</li>
          <li>Confirm with your password.</li>
          <li>Save the file. It ends in .zip.</li>
        </ol>
      </div>
    ),
    actions: (
      <>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onNext}>I have the file</Button>
      </>
    ),
  };
}

/** What the choose step needs. */
export interface MoveChooseStepProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  name: string;
  onNameChange: (name: string) => void;
  webAddress: string;
  onWebAddressChange: (webAddress: string) => void;
  webAddressStatus: WebAddressStatus;
  failure: StartFailure;
  formId: string;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
}

/** The export file picker. */
function ExportFileField({
  file,
  onFileChange,
}: {
  file: File | null;
  onFileChange: (file: File | null) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Export file</Label>
      <Input
        id={id}
        type="file"
        accept=".zip,application/zip"
        onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        className="cursor-pointer"
      />
      {file && (
        <p className="text-muted-foreground text-sm break-all">
          {file.name}, {formatBytes(file.size)}
        </p>
      )}
    </div>
  );
}

/**
 * The second step: pick the export and name the new community.
 *
 * @param props - The values and handlers.
 */
export function moveChooseStep(props: MoveChooseStepProps): HostingStep {
  const address = readWebAddress(props.webAddress);
  const blocked =
    props.file === null ||
    props.name.trim() === '' ||
    !address.valid ||
    props.webAddressStatus.kind === 'taken' ||
    props.webAddressStatus.kind === 'reserved';
  return {
    title: 'Choose the export',
    description: 'Pick the .zip file you saved, and name the community here.',
    body: (
      <form id={props.formId} onSubmit={props.onSubmit} className="space-y-4" noValidate>
        <ExportFileField file={props.file} onFileChange={props.onFileChange} />
        <CommunityFields
          name={props.name}
          onNameChange={props.onNameChange}
          webAddress={props.webAddress}
          onWebAddressChange={props.onWebAddressChange}
          webAddressStatus={props.webAddressStatus}
          webAddressError={props.failure.field}
          disabled={false}
        />
        {props.failure.notice && <HostingNoticeView notice={props.failure.notice} />}
      </form>
    ),
    actions: (
      <>
        <Button type="button" variant="outline" onClick={props.onBack}>
          Back
        </Button>
        <Button type="submit" form={props.formId} disabled={blocked}>
          Start moving
        </Button>
      </>
    ),
  };
}

/**
 * A determinate progress bar with its words.
 *
 * @param label - What is moving.
 * @param loaded - Bytes done.
 * @param total - Bytes in all.
 */
function ByteProgress({ label, loaded, total }: { label: string; loaded: number; total: number }) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  return (
    <div className="space-y-2">
      <Progress value={pct} aria-label={label} />
      <p className="text-muted-foreground text-sm tabular-nums">
        {formatBytes(loaded)} of {formatBytes(total)}
      </p>
    </div>
  );
}

/**
 * The step while the export reaches this DorkOS.
 *
 * @param sending - Bytes sent so far.
 * @param onCancel - Stop sending.
 */
export function moveSendingStep(
  sending: { loaded: number; total: number },
  onCancel: () => void
): HostingStep {
  return {
    title: 'Getting the file ready',
    description: 'Keep this open until the file is ready. It then uploads on its own.',
    body: <ByteProgress label="Getting the file ready" {...sending} />,
    actions: (
      <Button variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    ),
  };
}

/** The handlers the move's own steps use. */
export interface MoveStepHandlers {
  busy: boolean;
  notice: StartFailure['notice'];
  onCancelMove: () => void;
  onSendAgain: () => void;
  onStartOver: () => void;
  onClose: () => void;
}

/** "12 channels, 3,400 messages and 210 files", from a move's report. */
function reportLine(move: CloudCommunityMove): string | null {
  const report = move.report;
  if (!report) return null;
  const n = (value: number) => value.toLocaleString();
  return `${n(report.channels)} ${report.channels === 1 ? 'channel' : 'channels'}, ${n(report.entries)} ${
    report.entries === 1 ? 'message' : 'messages'
  } and ${n(report.attachments)} ${report.attachments === 1 ? 'file' : 'files'}.`;
}

/**
 * Build the step for where an existing move is, before it is ready to claim.
 *
 * @param step - The move's step, from {@link useMoveCommunity}.
 * @param handlers - What the buttons do.
 */
export function moveProgressStep(
  step: Exclude<MoveStep, { kind: 'ready' }>,
  handlers: MoveStepHandlers
): HostingStep {
  const { move } = step;
  const notice = handlers.notice ? <HostingNoticeView notice={handlers.notice} /> : null;
  const cancelMove = (
    <Button variant="outline" disabled={handlers.busy} onClick={handlers.onCancelMove}>
      Cancel move
    </Button>
  );
  const startOver = <Button onClick={handlers.onStartOver}>Start again</Button>;
  const close = (
    <Button variant="outline" onClick={handlers.onClose}>
      Close
    </Button>
  );
  switch (step.kind) {
    case 'uploading': {
      const upload = move.upload!;
      return {
        title: `Uploading ${move.name}`,
        description:
          'Your DorkOS is sending the export to the new host. You can close this window, but keep DorkOS running until this finishes.',
        body: (
          <>
            <ByteProgress
              label={`Uploading ${move.name}`}
              loaded={upload.sentBytes}
              total={upload.totalBytes}
            />
            {notice}
          </>
        ),
        actions: cancelMove,
      };
    }
    case 'upload-failed':
      if (step.why === 'interrupted') {
        return {
          title: 'The upload didn’t finish',
          description:
            'The upload stopped part way. Your DorkOS still has the file; send it again to carry on.',
          body: notice,
          actions: (
            <>
              {cancelMove}
              <Button disabled={handlers.busy} onClick={handlers.onSendAgain}>
                Send again
              </Button>
            </>
          ),
        };
      }
      return step.why === 'refused'
        ? {
            title: 'The new host didn’t accept the file',
            description:
              'The file arrived changed or incomplete. Cancel the move, export the old community again, then start again.',
            body: notice,
            actions: cancelMove,
          }
        : {
            title: 'This move can’t carry on',
            description:
              'Your DorkOS no longer has the file for it. Cancel the move, then start again with the same export.',
            body: notice,
            actions: cancelMove,
          };
    case 'importing': {
      const counts = reportLine(move);
      return {
        title: `Moving ${move.name}`,
        description:
          'The new host is reading your history and files. You can close this window, or quit DorkOS; the move keeps going and shows here again when you come back.',
        body: (
          <>
            <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner className="size-4" /> Moving your history…
            </p>
            {counts && <p className="text-sm">{counts}</p>}
            {notice}
          </>
        ),
        actions: (
          <>
            {cancelMove}
            <Button onClick={handlers.onClose}>Close</Button>
          </>
        ),
      };
    }
    case 'failed': {
      const copy = moveFailureCopy(move.failureCode ?? 'unrecognised');
      return {
        title: copy.title,
        description: copy.next,
        body: (
          <p className="text-muted-foreground text-sm">
            Nothing was kept, and your old community is unchanged.
          </p>
        ),
        actions: (
          <>
            {close}
            {startOver}
          </>
        ),
      };
    }
    case 'cancelled':
      return {
        title: 'Move cancelled',
        description: 'Nothing was kept, and your old community is unchanged.',
        actions: (
          <>
            {close}
            {startOver}
          </>
        ),
      };
    case 'unrecognised':
      return {
        title: `Moving ${move.name}`,
        description:
          'This move is in a state this version of DorkOS doesn’t know. Update DorkOS to see more.',
        body: notice,
        actions: close,
      };
  }
}

/** Props for {@link MoveCommunityDialog}. */
export interface MoveCommunityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the new community will call this DorkOS. */
  installName: string;
  /** An unfinished move to pick up, read from the account when the dialog opens. */
  resumeMoveId: string | null;
  /** Runs once this DorkOS is connected to the new community, with its local ref. */
  onConnected: (ref: string) => void;
}

/** Move a community here from the switcher. Mounted only while linked. */
export function MoveCommunityDialog(props: MoveCommunityDialogProps) {
  return props.open ? <MoveCommunityFlow {...props} /> : null;
}

/** The flow, mounted fresh for each open. */
function MoveCommunityFlow({
  open,
  onOpenChange,
  installName,
  resumeMoveId,
  onConnected,
}: MoveCommunityDialogProps) {
  const [stage, setStage] = useState<'explain' | 'choose'>('explain');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [webAddress, setWebAddress] = useState('');
  const move = useMoveCommunity(resumeMoveId);
  const status = useWebAddressStatus(stage === 'choose' && !move.step ? webAddress : '');
  const readyMove = move.step?.kind === 'ready' ? move.step.move : null;
  const claim = useClaimAndConnect(
    readyMove
      ? {
          communityId: readyMove.communityId,
          name: readyMove.name,
          communityUrl: readyMove.communityUrl,
        }
      : null,
    installName,
    onConnected
  );
  const close = () => onOpenChange(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const address = readWebAddress(webAddress);
    if (!file || name.trim() === '' || !address.valid) return;
    void move.start({ file, name, shortName: address.value });
  }

  let step: HostingStep;
  if (move.sending) {
    step = moveSendingStep(move.sending, () => void move.cancel());
  } else if (move.step?.kind === 'ready') {
    step = claimConnectStep({
      state: claim.state,
      name: move.step.move.name,
      doneDetail: MOVE_DONE_DETAIL,
      onOpenClaim: claim.openClaim,
      onConfirmClaimed: claim.confirmClaimed,
      onOpenApproval: claim.openApproval,
      onRetryConnect: claim.retryConnect,
      onClose: close,
    });
  } else if (move.step) {
    step = moveProgressStep(move.step, {
      busy: move.busy,
      notice: move.failure.notice,
      onCancelMove: () => void move.cancel(),
      onSendAgain: () => void move.sendAgain(),
      onStartOver: () => {
        move.startOver();
        setStage('choose');
      },
      onClose: close,
    });
  } else if (stage === 'explain') {
    step = moveExplainStep(() => setStage('choose'), close);
  } else {
    step = moveChooseStep({
      file,
      onFileChange: setFile,
      name,
      onNameChange: setName,
      webAddress,
      onWebAddressChange: (next) => {
        setWebAddress(next);
        move.clearFieldFailure();
      },
      webAddressStatus: status,
      failure: move.failure,
      formId: 'move-community-form',
      onSubmit: submit,
      onBack: () => setStage('explain'),
    });
  }

  return (
    <HostingStepDialog
      open={open}
      onOpenChange={onOpenChange}
      step={step}
      locked={move.sending !== null}
    />
  );
}
