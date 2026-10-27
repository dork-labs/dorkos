import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
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
  finishPersonStepUp,
  getPersonStepUpDismissible,
  getPersonStepUpOpen,
  subscribePersonStepUp,
} from '@/layers/shared/lib';
import { confirmItsYou, type ConfirmItsYouResult } from '../model/confirm-its-you';

/** The command that sets or resets the owner's password, run on the computer DorkOS runs on. */
const RESET_PASSWORD_COMMAND = 'dorkos auth reset-password';

type Failure = Extract<ConfirmItsYouResult, { ok: false }>;

/**
 * App-shell host for the owner's one password step-up at this computer
 * (DOR-3330). A person-only action from a browser with no session answers
 * `401 person_session_required`; the request waits on this dialog, and once
 * the password matches, the browser holds a lasting session for this computer
 * and the action runs by itself.
 *
 * Before a person-only action it can be cancelled (Cancel or Esc), which
 * leaves the action undone and gives focus back. Before the first chat there
 * is nothing to go back to, so it cannot; every failure there says the way out.
 */
export function PersonStepUpHost() {
  const open = useSyncExternalStore(subscribePersonStepUp, getPersonStepUpOpen);
  const dismissible = useSyncExternalStore(subscribePersonStepUp, getPersonStepUpDismissible);
  // While it is up, the app behind it is a gate's backdrop: nothing there can
  // be reached by keyboard, pointer or a screen reader.
  useEffect(() => {
    const app = document.getElementById('root');
    if (!open || !app) return;
    app.inert = true;
    return () => {
      app.inert = false;
    };
  }, [open]);
  if (!open) return null;
  return <PersonStepUpDialog dismissible={dismissible} />;
}

/** Seconds left until `until`, never below zero. */
function secondsUntil(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function PersonStepUpDialog({ dismissible }: { dismissible: boolean }) {
  const passwordId = useId();
  const failureId = useId();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [showReset, setShowReset] = useState(false);
  // When a too-many-tries wait ends, and the seconds left on it.
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

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

  async function submit() {
    if (pending || waitUntil !== null) return;
    setPending(true);
    const result = await confirmItsYou(password);
    setPending(false);
    if (result.ok) {
      finishPersonStepUp(true);
      return;
    }
    setFailure(result);
    if (result.reason === 'too-many-attempts') {
      setWaitUntil(Date.now() + (result.retryAfterSeconds ?? 60) * 1000);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const waiting = waitUntil !== null;
  const offline = failure?.reason === 'offline';
  // Nothing to type until a password is set, and nothing to forget.
  const noPassword = failure?.reason === 'no-password';
  const wrong = failure?.reason === 'wrong-password';
  const primaryLabel = pending ? 'Checking…' : offline ? 'Try again' : 'Confirm';

  function checkAgain() {
    // Back to the field, for the password they just set in the terminal.
    setFailure(null);
    setShowReset(false);
  }

  return (
    <AlertDialog open onOpenChange={(next) => !next && dismissible && finishPersonStepUp(false)}>
      <AlertDialogContent
        aria-modal="true"
        onEscapeKeyDown={(e) => !dismissible && e.preventDefault()}
      >
        <AlertDialogHeader className="text-left">
          <AlertDialogTitle>Confirm it’s you</AlertDialogTitle>
          <AlertDialogDescription>
            So other programs on this computer, agents included, can’t act as you.
          </AlertDialogDescription>
          <p className="text-muted-foreground text-sm">You only do this once here.</p>
          <p className="text-muted-foreground text-sm">
            It lasts while you keep using DorkOS, and asks again after 30 days away.
          </p>
        </AlertDialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            {!noPassword && (
              <>
                <Label htmlFor={passwordId}>DorkOS password</Label>
                <PasswordInput
                  id={passwordId}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={waiting}
                  aria-invalid={wrong || undefined}
                  aria-describedby={failure ? failureId : undefined}
                  required
                  autoFocus
                />
              </>
            )}
            {failure && (
              <FailureLine
                id={failureId}
                failure={failure}
                minutesLeft={Math.ceil(secondsLeft / 60)}
              />
            )}
            {!noPassword && !offline && (
              <button
                type="button"
                onClick={() => setShowReset((shown) => !shown)}
                aria-expanded={showReset}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-xs underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
              >
                Forgot it?
              </button>
            )}
            {(showReset || noPassword) && !offline && (
              <p className="text-muted-foreground text-xs">
                {noPassword ? 'Set one' : 'Reset it'} in a terminal on this computer:{' '}
                <code className="bg-muted rounded px-1 py-0.5 font-mono">
                  {RESET_PASSWORD_COMMAND}
                </code>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {dismissible && (
              <Button type="button" variant="ghost" onClick={() => finishPersonStepUp(false)}>
                Cancel
              </Button>
            )}
            {noPassword ? (
              <Button type="button" className="flex-1" autoFocus onClick={checkAgain}>
                I’ve set one
              </Button>
            ) : (
              <Button type="submit" className="flex-1" disabled={pending || waiting}>
                {primaryLabel}
              </Button>
            )}
          </div>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What went wrong, in the person's words. */
function FailureLine({
  id,
  failure,
  minutesLeft,
}: {
  id: string;
  failure: Failure;
  minutesLeft: number;
}) {
  const text = {
    'wrong-password': 'That’s not your DorkOS password. Try again.',
    'too-many-attempts': `Too many tries. Try again in ${Math.max(1, minutesLeft)} min.`,
    'no-password': 'This computer has no DorkOS password yet.',
    offline: 'Can’t reach DorkOS on this computer.',
    other: failure.message,
  }[failure.reason];
  return (
    <p id={id} role="alert" className="text-destructive text-sm">
      {text}
    </p>
  );
}
