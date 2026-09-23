import { ArrowRight, RotateCcw } from 'lucide-react';
import {
  reactivationScope,
  recoveryInstruction,
  type AdmissionFailure,
  type PendingAdmission,
} from '../admission.js';

function finishBy(expiresAt: string): string {
  return new Date(expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Why joining stopped, announced as it appears, with its one way forward. */
export function AdmissionFailurePanel({
  failure,
  busy,
  onRetry,
}: {
  failure: AdmissionFailure;
  busy: boolean;
  onRetry: () => void;
}) {
  const instruction = recoveryInstruction(failure.recovery);
  return (
    <div className="panel">
      <div role="alert">
        <p className="mb-2">{failure.detail}</p>
        {instruction && <p className="mb-0 font-semibold">{instruction}</p>}
      </div>
      {failure.recovery === 'retry' && (
        <button
          className="button primary mt-5 w-full"
          type="button"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? 'Trying again…' : 'Try again'}
          <RotateCcw size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/** What rejoining restores and what stays removed, confirmed before anything changes. */
export function ReactivationReview({
  preview,
  busy,
  onConfirm,
}: {
  preview: PendingAdmission;
  busy: boolean;
  onConfirm: () => void;
}) {
  const scope = reactivationScope(preview.channelName);
  return (
    <div className="panel">
      <p className="mb-4">
        You were a member of {preview.communityName} before. {preview.inviterName} invited you back.
      </p>
      <h2 className="text-base font-semibold">What comes back</h2>
      <ul className="mb-5 list-disc pl-5">
        {scope.restored.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h2 className="text-base font-semibold">What stays removed</h2>
      <ul className="mb-5 list-disc pl-5">
        {scope.notRestored.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <button className="button primary w-full" type="button" disabled={busy} onClick={onConfirm}>
        Rejoin community
        <ArrowRight size={17} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Who sent the invitation, what it includes, and how long this browser holds it. */
export function InvitationSummary({ preview }: { preview: PendingAdmission }) {
  return (
    <div className="notice mb-5">
      <p className="mb-0">
        Invited by <strong>{preview.inviterName}</strong>
        {preview.channelName ? (
          <>
            {' '}
            to <strong>#{preview.channelName}</strong>
          </>
        ) : null}
      </p>
      <p className="small muted mt-1 mb-0">Finish joining by {finishBy(preview.expiresAt)}.</p>
    </div>
  );
}

/** The clean join URL has nothing left to resume, so the invitation must be opened again. */
export function JoinLostNotice() {
  return (
    <div className="notice mb-5">
      <strong>Open your invitation link again.</strong>
      <p className="small muted mt-1 mb-0">
        This page no longer holds an invitation, so membership was not added. If you are already a
        member, sign in below.
      </p>
    </div>
  );
}
