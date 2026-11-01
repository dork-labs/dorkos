import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { HeldStepUpView, StepUpActionKind } from '@dorkos/shared/step-up';
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
  getActionStepUpAfterExpiry,
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
  // In the Mac app the password is never typed into this page: the shell takes
  // it in a window of its own (Security's Must 3).
  if (typeof window !== 'undefined' && window.electronAPI) {
    return <DesktopStepUpSheet key={heldActionId} heldActionId={heldActionId} />;
  }
  // Keyed by the held action, so the next one starts with an empty field.
  return <ActionStepUpSheet key={heldActionId} heldActionId={heldActionId} />;
}

/** The held actions the shell's window is open for. */
const askedTheShell = new Set<string>();

/** The Mac app's sheet: it points at the shell's own window, and never asks itself. */
function DesktopStepUpSheet({ heldActionId }: { heldActionId: string }) {
  const confirm = window.electronAPI?.confirmStepUp;
  useEffect(() => {
    // Once per held action: React may run this twice, and two windows for one
    // action would be one too many.
    if (!confirm || askedTheShell.has(heldActionId)) return;
    askedTheShell.add(heldActionId);
    void confirm(heldActionId)
      .catch((): ActionStepUpOutcome => ({ kind: 'not-confirmed' }))
      .then((outcome) => {
        askedTheShell.delete(heldActionId);
        // A no-op unless it is still the one showing.
        finishActionStepUp(heldActionId, outcome);
      });
  }, [confirm, heldActionId]);
  return (
    <AlertDialog open>
      <AlertDialogContent aria-modal="true">
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>Confirm it’s you</AlertDialogTitle>
          <AlertDialogDescription>
            {confirm
              ? 'Confirm in the window that just opened.'
              : 'Update the DorkOS app to confirm this.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!confirm && (
          <Button
            type="button"
            onClick={() => {
              void cancelHeldAction(heldActionId);
              finishActionStepUp(heldActionId, { kind: 'not-confirmed' });
            }}
          >
            Close
          </Button>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

type Stage =
  | { kind: 'loading' }
  | { kind: 'password'; view: HeldStepUpView }
  | { kind: 'change'; view: HeldStepUpView; minLength: number }
  | { kind: 'ended'; message: string };

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
  const passwordRef = useRef<HTMLInputElement>(null);
  const afterExpiry = useSyncExternalStore(subscribeActionStepUp, getActionStepUpAfterExpiry);

  useEffect(() => {
    let live = true;
    void readHeldAction(heldActionId).then((read) => {
      if (!live) return;
      if (read.ok) setStage({ kind: 'password', view: read.view });
      // Gone before it could be read: ask for the action again, on the same sheet.
      else if (read.reason === 'expired') finishActionStepUp(heldActionId, { kind: 'ask-again' });
      else setStage(endedBy(read) ?? { kind: 'ended', message: read.message });
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

  /** Cancel, Esc or Close. Waits while a password check is in flight, whose answer ends the sheet. */
  function cancel() {
    if (pending) return;
    void cancelHeldAction(heldActionId);
    finishActionStepUp(heldActionId, { kind: 'not-confirmed' });
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
      finishActionStepUp(heldActionId, {
        kind: 'confirmed',
        status: result.status,
        result: result.result,
      });
      return;
    }
    if (result.reason === 'password-too-short' && stage.kind === 'password') {
      setFailure(null);
      setStage({ kind: 'change', view: stage.view, minLength: result.minLength ?? 8 });
      return;
    }
    // It expired while open: the action is asked for again, and the new sheet
    // says why (designer, DOR-3467: an expired proof reopens on the same method).
    if (result.reason === 'expired') {
      finishActionStepUp(heldActionId, { kind: 'ask-again' });
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
    if (result.reason === 'wrong-password') queueMicrotask(() => passwordRef.current?.select());
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const waiting = waitUntil !== null;
  const view = stage.kind === 'password' || stage.kind === 'change' ? stage.view : null;

  return (
    <AlertDialog open onOpenChange={(next) => !next && cancel()}>
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
          {afterExpiry && (
            <p role="status" className="text-sm">
              This took too long. Confirm it’s you again.
            </p>
          )}
        </AlertDialogHeader>
        {stage.kind === 'ended' ? (
          <EndedBody message={stage.message} onClose={cancel} />
        ) : view?.passwordUnavailable === 'insecure-connection' ? (
          <EndedBody message="Confirm this on the computer running DorkOS." onClose={cancel} />
        ) : view?.passwordUnavailable === 'no-password' ? (
          <NoPasswordBody onClose={cancel} />
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
                ref={passwordRef}
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
            {/* On a phone: stacked, full width, 44px tall (designer, DOR-3467). */}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full sm:h-9 sm:w-auto"
                onClick={cancel}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11 w-full sm:h-9 sm:flex-1"
                disabled={pending || waiting || stage.kind === 'loading'}
              >
                {pending
                  ? 'Confirming…'
                  : stage.kind === 'change'
                    ? 'Change and confirm'
                    : primaryLabel(view?.kind)}
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
    case 'too-many-tries':
      return {
        kind: 'ended',
        message: 'Too many wrong passwords. Nothing changed.',
      };
    case 'insecure-connection':
      return {
        kind: 'ended',
        message: 'Confirm this on the computer running DorkOS.',
      };
    case 'not-your-action':
    case 'not-a-person':
    case 'offline':
      return { kind: 'ended', message: failure.message };
    case 'no-password':
      return {
        kind: 'ended',
        message: `Set a DorkOS password first: run ${RESET_PASSWORD_COMMAND} on this computer.`,
      };
    default:
      return null;
  }
}

function EndedBody({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <p role="status" className="text-sm">
        {message}
      </p>
      <Button type="button" className="h-11 w-full sm:h-9" onClick={onClose} autoFocus>
        Close
      </Button>
    </div>
  );
}

/**
 * The sheet's main button, named for the action where the designer named it
 * (DOR-3467: "Confirm setting"); "Confirm" otherwise.
 */
function primaryLabel(kind: StepUpActionKind | undefined): string {
  return kind === 'connection.confirm-setting' ? 'Confirm setting' : 'Confirm';
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
      : failure.reason === 'wrong-password'
        ? 'That password isn’t right.'
        : failure.message;
  return (
    <p id={id} role="alert" className="text-destructive text-sm">
      {text}
    </p>
  );
}
