'use client';

import { useState } from 'react';

import { requestAccountDeletion } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/layers/shared/ui';

/**
 * The `/account` "Danger zone": self-serve data export and account deletion
 * (GDPR/CCPA; cloud-account-management, DOR-187).
 *
 * Honest by design — no dark patterns. Export is one click. Deletion is guarded
 * by a typed email confirmation and then an emailed link (the server requires
 * delete-account verification), and the copy states plainly that it is
 * permanent and cascades to instances. Deletion is never made artificially hard,
 * only un-accidental.
 *
 * @param props.email - The signed-in account's email, used to gate the delete
 *   confirmation (the user must type it to enable the button).
 */
export function DangerZone({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const confirmed = confirmText.trim().toLowerCase() === email.trim().toLowerCase();

  async function onDelete() {
    setState('submitting');
    setError(null);
    const result = await requestAccountDeletion({ callbackURL: '/signin' });
    if (result.error) {
      // Keep the dialog open so the user sees the error and can retry.
      setState('idle');
      setError(result.error.message ?? 'Could not start account deletion. Please try again.');
      return;
    }
    // Success: close the dialog and surface the "check your email" state.
    setState('sent');
    setOpen(false);
  }

  return (
    <Card className="border-destructive/40 w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-destructive text-xl">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Export — one click, no friction. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Export your data</span>
            <span className="text-muted-foreground text-sm">
              Download everything we hold about your account as JSON. Secrets are never included.
            </span>
          </div>
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href="/api/account/export" download />}
          >
            Export my data
          </Button>
        </div>

        {/* Delete — typed confirmation, then an emailed confirmation link. */}
        <div className="flex flex-col gap-2 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">Delete your account</span>
            <span className="text-muted-foreground text-sm">
              Permanently erase your account, sign-in methods, API keys, and unlink every connected
              instance. This cannot be undone.
            </span>
          </div>
          {state === 'sent' ? (
            <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Check your email to confirm deletion.
            </span>
          ) : (
            <AlertDialog open={open} onOpenChange={setOpen}>
              <AlertDialogTrigger className={cn(buttonVariants({ variant: 'destructive' }))}>
                Delete my account
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete your DorkOS account?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently erases your account and unlinks every connected instance. It
                    cannot be undone. We&rsquo;ll email a confirmation link to finish — nothing is
                    deleted until you follow it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="confirm-delete">
                    Type your email (<span className="font-medium">{email}</span>) to confirm
                  </Label>
                  <Input
                    id="confirm-delete"
                    value={confirmText}
                    autoComplete="off"
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={email}
                  />
                  {error ? <span className="text-destructive text-sm">{error}</span> : null}
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setConfirmText('')}>Cancel</AlertDialogCancel>
                  <Button
                    variant="destructive"
                    disabled={!confirmed || state === 'submitting'}
                    onClick={() => void onDelete()}
                  >
                    {state === 'submitting' ? 'Sending…' : 'Email me the confirmation link'}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
