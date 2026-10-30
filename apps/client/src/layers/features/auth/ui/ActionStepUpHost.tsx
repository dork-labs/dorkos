import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { HeldStepUpView } from '@dorkos/shared/step-up';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Label,
  PasswordInput,
} from '@/layers/shared/ui';
import {
  finishActionStepUp,
  getActionStepUpShowing,
  subscribeActionStepUp,
  type ActionStepUpOutcome,
} from '@/layers/shared/lib';
import {
  cancelHeldAction,
  changePasswordAndConfirm,
  confirmWithPassword,
  readHeldAction,
  type ConfirmActionFailure,
} from '../model/confirm-action';

/** The command that sets or resets the owner's password, run on the computer DorkOS runs on. */
const RESET_PASSWORD_COMMAND = 'dorkos auth reset-password';

/**
 * App-shell host for "Confirm it's you" before one sensitive action
 * (DOR-3234). A guarded action answers `428` with a held-action id; the
 * request waits on this sheet, and once the person confirms, the server runs
 * the action and the request answers with its result.
 *
 * Every sentence about what will run is the server's. Cancel, Esc or any
 * failure leaves the action undone.
 */
export function ActionStepUpHost() {
  const heldActionId = useSyncExternalStore(subscribeActionStepUp, getActionStepUpShowing);
  if (heldActionId === null) return null;
  // Keyed by the held action, so the next one starts with an empty field.
  return <ActionStepUpSheet key={heldActionId} heldActionId={heldActionId} />;
}

type Stage =
  | { kind: 'loading' }
  | { kind: 'password'; view: HeldStepUpView }
  | { kind: 'change'; view: HeldStepUpView; minLength: number }
  | { kind: 'ended'; message: string; askAgain: boolean };

/** Seconds left until `until`, never below zero. */
function secondsUntil(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function ActionStepUpSheet({ heldActionId }: { heldActionId: string }) {
  const passwordId = useId();
  const newPasswordId = useId();
  const failureId = useId();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ConfirmActionFailure | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    let live = true;
    void readHeldAction(heldActionId).then((read) => {
      if (!live) return;
      if (read.ok) setStage({ kind: 'password', view: read.view });
      else setStage(endedBy(read) ?? { kind: 'ended', message: read.message, askAgain: false });
    });
    return () => {
      live = false;
    };
  }, [heldActionId]);

  useEffect(() => {
    if (waitUntil === null) return;
    const tick = () => {
      const left = secondsUntil(waitUntil);
      setSecondsLeft(left);
      if (left === 0) {
        setWaitUntil(null);
        setFailure(null);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [waitUntil]);

  function finish(outcome: ActionStepUpOutcome) {
    if (outcome.kind !== 'confirmed') void cancelHeldAction(heldActionId);
    finishActionStepUp(outcome);
  }

  async function submit() {
    if (pending || waitUntil !== null) return;
    if (stage.kind !== 'password' && stage.kind !== 'change') return;
    setPending(true);
    const result =
      stage.kind === 'change'
        ? await changePasswordAndConfirm(heldActionId, password, newPassword)
        : await confirmWithPassword(heldActionId, password);
    setPending(false);
    if (result.ok) {
      finishActionStepUp({ kind: 'confirmed', status: result.status, result: result.result });
      return;
    }
    if (result.reason === 'password-too-short' && stage.kind === 'password') {
      setFailure(null);
      setStage({ kind: 'change', view: stage.view, minLength: result.minLength ?? 8 });
      return;
    }
    if (result.reason === 'too-many-attempts') {
      setWaitUntil(Date.now() + (result.retryAfterSeconds ?? 60) * 1000);
    }
    const ended = endedBy(result);
    if (ended) {
      setStage(ended);
      return;
    }
    setFailure(result);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const waiting = waitUntil !== null;
  const view = stage.kind === 'password' || stage.kind === 'change' ? stage.view : null;

  return (
    <AlertDialog open onOpenChange={(next) => !next && finish({ kind: 'not-confirmed' })}>
      <AlertDialogContent aria-modal="true">
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>Confirm it’s you</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground font-medium">
            {view?.reason ?? (stage.kind === 'loading' ? 'Checking what this will do…' : '')}
          </AlertDialogDescription>
          {view?.notes.map((note) => (
            <p key={note} className="text-muted-foreground text-sm">
              {note}
            </p>
          ))}
        </AlertDialogHeader>
        {stage.kind === 'ended' ? (
          <EndedBody
            message={stage.message}
            askAgain={stage.askAgain}
            onClose={() => finish({ kind: 'not-confirmed' })}
            onAskAgain={() => finishActionStepUp({ kind: 'ask-again' })}
          />
        ) : view?.passwordUnavailable === 'insecure-connection' ? (
          <EndedBody
            message="Confirm this on the computer running DorkOS."
            askAgain={false}
            onClose={() => finish({ kind: 'not-confirmed' })}
          />
        ) : view?.passwordUnavailable === 'no-password' ? (
          <NoPasswordBody onClose={() => finish({ kind: 'not-confirmed' })} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {stage.kind === 'change' && (
              <p className="text-sm">
                Your password is too short. Choose one of at least {stage.minLength} characters.
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={passwordId}>
                {stage.kind === 'change' ? 'Current password' : 'DorkOS password'}
              </Label>
              <PasswordInput
                id={passwordId}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={waiting || stage.kind === 'loading'}
                aria-invalid={failure?.reason === 'wrong-password' || undefined}
                aria-describedby={failure ? failureId : undefined}
                required
                autoFocus
              />
            </div>
            {stage.kind === 'change' && (
              <div className="space-y-1.5">
                <Label htmlFor={newPasswordId}>New password</Label>
                <PasswordInput
                  id={newPasswordId}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={stage.minLength}
                  required
                />
              </div>
            )}
            {failure && <FailureLine id={failureId} failure={failure} secondsLeft={secondsLeft} />}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => finish({ kind: 'not-confirmed' })}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={pending || waiting || stage.kind === 'loading'}
              >
                {pending ? 'Checking…' : stage.kind === 'change' ? 'Change and confirm' : 'Confirm'}
              </Button>
            </div>
          </form>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The failures that end the sheet, as an ended stage, or `null` for one that
 * stays on the form (a wrong password, a wait, a new password too short).
 */
function endedBy(failure: ConfirmActionFailure): Extract<Stage, { kind: 'ended' }> | null {
  switch (failure.reason) {
    case 'expired':
      return { kind: 'ended', message: 'That took too long. Nothing changed.', askAgain: true };
    case 'too-many-tries':
      return {
        kind: 'ended',
        message: 'Too many wrong passwords. Nothing changed.',
        askAgain: false,
      };
    case 'insecure-connection':
      return {
        kind: 'ended',
        message: 'Confirm this on the computer running DorkOS.',
        askAgain: false,
      };
    case 'not-your-action':
    case 'not-a-person':
    case 'offline':
      return { kind: 'ended', message: failure.message, askAgain: false };
    case 'no-password':
      return {
        kind: 'ended',
        message: `Set a DorkOS password first: run ${RESET_PASSWORD_COMMAND} on this computer.`,
        askAgain: false,
      };
    default:
      return null;
  }
}

function EndedBody({
  message,
  askAgain,
  onClose,
  onAskAgain,
}: {
  message: string;
  askAgain: boolean;
  onClose: () => void;
  onAskAgain?: () => void;
}) {
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        {message}
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onClose} autoFocus={!askAgain}>
          Close
        </Button>
        {askAgain && onAskAgain && (
          <Button type="button" className="flex-1" onClick={onAskAgain} autoFocus>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

function NoPasswordBody({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        This computer has no DorkOS password yet. Set one in a terminal here:{' '}
        <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
          {RESET_PASSWORD_COMMAND}
        </code>
      </p>
      <div className="flex gap-2">
        <Button type="button" className="flex-1" onClick={onClose} autoFocus>
          Close
        </Button>
      </div>
    </div>
  );
}

/** What went wrong, in the person's words. */
function FailureLine({
  id,
  failure,
  secondsLeft,
}: {
  id: string;
  failure: ConfirmActionFailure;
  secondsLeft: number;
}) {
  const text =
    failure.reason === 'too-many-attempts'
      ? `Too many tries. Try again in ${Math.max(1, secondsLeft)} sec.`
      : failure.reason === 'wrong-password' && failure.triesLeft !== undefined
        ? `That’s not your DorkOS password. ${failure.triesLeft} ${
            failure.triesLeft === 1 ? 'try' : 'tries'
          } left.`
        : failure.message;
  return (
    <p id={id} role="alert" className="text-destructive text-sm">
      {text}
    </p>
  );
}
