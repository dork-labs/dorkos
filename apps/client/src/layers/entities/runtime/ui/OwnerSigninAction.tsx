import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ClaudeSigninPolicyChange } from '@dorkos/shared/runtime-connect';
import { configKeys, useTransport } from '@/layers/shared/model';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Input,
  Label,
} from '@/layers/shared/ui';
import { SIGNIN_POLICY_KEY } from '../model/use-signin-policy';

type Change = ClaudeSigninPolicyChange extends infer T
  ? T extends { password: string }
    ? Omit<T, 'password'>
    : never
  : never;

/** Step-up secrets stay in this form; never stored in a mutation/query cache. */
export function OwnerSigninAction({
  label,
  title,
  change,
  children,
  disabled = false,
}: {
  label: string;
  title: string;
  change: Change;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transport = useTransport();
  const client = useQueryClient();
  async function apply() {
    setPending(true);
    setError(null);
    const stepUp = password;
    setPassword('');
    try {
      await transport.changeClaudeSigninPolicy({ ...change, password: stepUp });
      await Promise.all([
        client.invalidateQueries({ queryKey: SIGNIN_POLICY_KEY }),
        client.invalidateQueries({ queryKey: configKeys.current() }),
        client.invalidateQueries({ queryKey: ['accounts'] }),
      ]);
      setOpen(false);
    } catch (failure) {
      const reason = (failure as { body?: { reason?: string } }).body?.reason;
      setError(
        reason === 'no-owner' || reason === 'no-password'
          ? 'Confirm this on the Mac running DorkOS.'
          : 'Couldn’t change this sign-in. Check your password and try again.'
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) {
            setPassword('');
            setError(null);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Confirm it’s you with this computer’s owner password.
          </DialogDescription>
          {children}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void apply();
            }}
            className="space-y-3"
          >
            <Label htmlFor="signin-step-up">Owner password</Label>
            <Input
              id="signin-step-up"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
            />
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending || !password}>
              {pending ? 'Checking…' : label}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
