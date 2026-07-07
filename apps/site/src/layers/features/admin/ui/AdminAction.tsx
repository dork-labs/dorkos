'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
  Input,
  Label,
} from '@/layers/shared/ui';

/** The result shape every Better Auth client call returns. */
type ActionResult = { error?: { message?: string } | null };

/**
 * A single admin action rendered as a button that opens a confirmation dialog,
 * runs an async Better Auth call, surfaces its error, and on success closes and
 * refreshes the route so the table reflects the change. Optionally collects a
 * free-text field (e.g. a ban reason) and/or requires a typed confirmation
 * string (e.g. the target email) before enabling the confirm button.
 *
 * @param props.label - The trigger button label.
 * @param props.title - The dialog title.
 * @param props.description - The dialog body copy.
 * @param props.confirmLabel - The confirm button label.
 * @param props.onConfirm - Runs the action; receives the collected field value.
 * @param props.variant - Trigger + confirm button variant (default `outline`).
 * @param props.field - Optional free-text field config (value passed to onConfirm).
 * @param props.typedConfirm - Optional string the user must type to enable confirm.
 * @param props.disabled - Disables the trigger.
 */
export function AdminAction({
  label,
  title,
  description,
  confirmLabel,
  onConfirm,
  variant = 'outline',
  field,
  typedConfirm,
  disabled,
}: {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: (fieldValue: string) => Promise<ActionResult>;
  variant?: 'outline' | 'destructive' | 'default';
  field?: { label: string; placeholder?: string };
  typedConfirm?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fieldValue, setFieldValue] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typedOk =
    !typedConfirm || confirmText.trim().toLowerCase() === typedConfirm.trim().toLowerCase();

  function reset() {
    setFieldValue('');
    setConfirmText('');
    setError(null);
    setPending(false);
  }

  async function run() {
    setPending(true);
    setError(null);
    const result = await onConfirm(fieldValue.trim());
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? 'That action failed. Please try again.');
      return;
    }
    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <AlertDialogTrigger
        disabled={disabled}
        className={cn(buttonVariants({ variant, size: 'sm' }))}
      >
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {field ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-action-field">{field.label}</Label>
            <Input
              id="admin-action-field"
              value={fieldValue}
              placeholder={field.placeholder}
              autoComplete="off"
              onChange={(e) => setFieldValue(e.target.value)}
            />
          </div>
        ) : null}
        {typedConfirm ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-action-confirm">
              Type <span className="font-medium">{typedConfirm}</span> to confirm
            </Label>
            <Input
              id="admin-action-confirm"
              value={confirmText}
              autoComplete="off"
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={typedConfirm}
            />
          </div>
        ) : null}
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant={variant} disabled={!typedOk || pending} onClick={() => void run()}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
