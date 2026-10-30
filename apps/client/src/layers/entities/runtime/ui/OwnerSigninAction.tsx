import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ClaudeSigninPolicyChange } from '@dorkos/shared/runtime-connect';
import { configKeys, useTransport } from '@/layers/shared/model';
import { Button, Dialog, DialogContent, DialogTitle, DialogDescription } from '@/layers/shared/ui';
import { SIGNIN_POLICY_KEY } from '../model/use-signin-policy';

/**
 * One change to the person's Claude sign-in list, behind a short confirm that
 * shows what it changes. Only the person can make it: the server refuses agents.
 */
export function OwnerSigninAction({
  label,
  title,
  description,
  change,
  children,
  disabled = false,
}: {
  label: string;
  title: string;
  /** One line under the title saying what happens. */
  description: string;
  change: ClaudeSigninPolicyChange;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transport = useTransport();
  const client = useQueryClient();
  async function apply() {
    setPending(true);
    setError(null);
    try {
      await transport.changeClaudeSigninPolicy(change);
      await Promise.all([
        client.invalidateQueries({ queryKey: SIGNIN_POLICY_KEY }),
        client.invalidateQueries({ queryKey: configKeys.current() }),
        client.invalidateQueries({ queryKey: ['accounts'] }),
      ]);
      setOpen(false);
    } catch {
      setError('Couldn’t change this sign-in. Try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="pointer-coarse:min-h-11"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setError(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          {children}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => void apply()} disabled={pending}>
              {pending ? 'Saving…' : label}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
