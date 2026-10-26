import { useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  PasswordInput,
} from '@/layers/shared/ui';
import {
  finishPersonStepUp,
  getPersonStepUpOpen,
  subscribePersonStepUp,
} from '@/layers/shared/lib';
import { confirmItsYou } from '../model/confirm-its-you';

/**
 * App-shell host for the owner's one password step-up at this computer
 * (DOR-3330). A person-only action from a browser with no session answers
 * `401 person_session_required`; the request waits on this dialog, and once
 * the password matches, the browser holds a lasting session for this computer
 * and the action runs. Cancelling leaves the action refused.
 */
export function PersonStepUpHost() {
  const open = useSyncExternalStore(subscribePersonStepUp, getPersonStepUpOpen);
  if (!open) return null;
  return <PersonStepUpDialog />;
}

function PersonStepUpDialog() {
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    const result = await confirmItsYou(password);
    setPending(false);
    if (result.ok) {
      finishPersonStepUp(true);
      return;
    }
    setError(result.message);
  }

  return (
    <Dialog open onOpenChange={(next) => !next && finishPersonStepUp(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Confirm it’s you</DialogTitle>
          <DialogDescription>
            Enter your password. This browser won’t ask again on this computer.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={passwordId}>Password</Label>
            <PasswordInput
              id={passwordId}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => finishPersonStepUp(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={pending}>
              {pending ? 'Checking…' : 'Confirm'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
