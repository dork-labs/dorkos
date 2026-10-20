import { useId, useState } from 'react';
import { useOnWifi } from '@/layers/entities/config';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Input,
  Label,
  PasswordInput,
} from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import {
  useApprovalPasskeys,
  type ApprovalPasskeys as Passkeys,
} from '../model/use-approval-passkeys';
import { PasswordPrompt, type Prompt } from './PasswordPrompt';

/** Name the new passkey and give the password; the browser opens to make it. */
function AddPasskeyDialog({
  open,
  onClose,
  passkeys,
}: {
  open: boolean;
  onClose: () => void;
  passkeys: Passkeys;
}) {
  const labelId = useId();
  const passwordId = useId();
  const [label, setLabel] = useState('');
  const [password, setPassword] = useState('');
  const close = () => {
    setLabel('');
    setPassword('');
    onClose();
  };
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && close()}>
      <AlertDialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            passkeys.add(label.trim(), password);
            close();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Add a passkey</AlertDialogTitle>
            <AlertDialogDescription>
              Your browser opens to create it. Then come back here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={labelId}>Name</Label>
            <Input
              id={labelId}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="MacBook passkey"
              maxLength={64}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={passwordId}>Your password for this computer</Label>
            <PasswordInput
              id={passwordId}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!label.trim() || !password}>
              Continue
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The passkeys, each with Remove, and "Add a passkey". */
function PasskeyControls() {
  const passkeys = useApprovalPasskeys(true);
  const [adding, setAdding] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);
  return (
    <div className="space-y-2">
      <PasswordPrompt prompt={prompt} onClose={() => setPrompt(null)} />
      <AddPasskeyDialog open={adding} onClose={() => setAdding(false)} passkeys={passkeys} />
      {passkeys.damaged ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-destructive text-xs">
            Passkey file is damaged. Remove it to start again.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={passkeys.busy}
            onClick={() =>
              setPrompt({
                title: 'Remove the damaged passkey file?',
                confirm: 'Remove',
                run: passkeys.removeDamaged,
              })
            }
          >
            Remove
          </Button>
        </div>
      ) : passkeys.keys.length === 0 ? (
        <p className="text-muted-foreground text-xs">No passkeys yet.</p>
      ) : (
        <ul className="space-y-1" data-testid="approval-passkeys">
          {passkeys.keys.map((key) => (
            <li key={key.credentialId} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {key.label}
                {/* The id's end, so two passkeys with one name can be told apart. */}
                <span className="text-muted-foreground ml-2 font-mono text-xs">
                  …{key.credentialId.slice(-6)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-muted-foreground text-xs">
                  Added {formatRelativeTime(key.addedAt)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={passkeys.busy}
                  aria-label={`Remove ${key.label}`}
                  onClick={() =>
                    setPrompt({
                      title: 'Remove this passkey?',
                      confirm: 'Remove',
                      run: (password) => passkeys.remove(key.credentialId, password),
                    })
                  }
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={passkeys.busy || passkeys.damaged}
        onClick={() => setAdding(true)}
      >
        Add a passkey
      </Button>
      {passkeys.waiting && (
        <p className="text-muted-foreground text-xs">
          Finish in your browser. This list updates when you return.
        </p>
      )}
      {passkeys.error && (
        <p className="text-destructive text-xs" role="alert">
          {passkeys.error}
        </p>
      )}
    </div>
  );
}

/**
 * Approvals from the web (B4c): the passkeys a tool call can be approved with
 * from the owner's hub, with Remove, and "Add a passkey", which opens the
 * approve page in the browser. Shown on a linked computer, in the same switch
 * as the rest of chat from the web; managed only at this computer, and never
 * over Wi-Fi.
 */
export function ApprovalPasskeys({ atThisComputer }: { atThisComputer: boolean }) {
  const onWifi = useOnWifi();
  return (
    <div className="space-y-1.5" data-testid="approval-passkeys-section">
      <p className="text-muted-foreground text-xs font-medium">Approvals from the web</p>
      <p className="text-muted-foreground text-xs">
        Approve tool calls from your hub with a passkey made for this computer.
      </p>
      {onWifi || !atThisComputer ? (
        <p className="text-muted-foreground text-xs">Manage passkeys at this computer.</p>
      ) : (
        <PasskeyControls />
      )}
    </div>
  );
}
