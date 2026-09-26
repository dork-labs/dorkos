import { useRef, type ReactNode, type RefObject } from 'react';
import { MoreHorizontal, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@dork-labs/ui';
import { REMOVAL_COPY, type RemovalAction } from '../entry-removal.js';
import type { Attachment } from '../types.js';

/** What a confirmation is about: the whole message, or one of its files. */
export type RemovalTarget = { kind: 'message' } | { kind: 'file'; attachment: Attachment };

/** One open confirmation: its target and the action the menu offered when it was chosen. */
export type RemovalRequest = { target: RemovalTarget; action: RemovalAction };

/**
 * A one-item actions menu (a message's, or a file chip's) whose item asks for confirmation.
 * The trigger is remembered so a cancelled confirmation can hand focus back to it.
 */
export function RemovalMenu({
  label,
  itemLabel,
  onChoose,
  className = '',
}: {
  /** The trigger's accessible name, e.g. "Message actions". */
  label: string;
  itemLabel: string;
  /** Called with the trigger, which takes focus back if the person cancels. */
  onChoose: (trigger: HTMLButtonElement | null) => void;
  className?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className={`button ghost removal-trigger ${className}`}
          aria-label={label}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={() => onChoose(trigger.current)}>
          <Trash2 size={14} aria-hidden="true" />
          {itemLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The "are you sure?" step before a message or file is deleted or removed. It says what everyone
 * will see afterwards and what the action cannot reach. Confirming hands focus to `settle` (the
 * message, which stays in place); cancelling hands it back to the menu that asked.
 */
export function RemovalConfirmation({
  request,
  returnFocus,
  settle,
  onConfirm,
  onClose,
}: {
  request: RemovalRequest | null;
  returnFocus: RefObject<HTMLButtonElement | null>;
  settle: RefObject<HTMLElement | null>;
  onConfirm: (request: RemovalRequest) => void;
  onClose: () => void;
}) {
  const confirmed = useRef(false);
  const copy = request ? REMOVAL_COPY[request.target.kind][request.action] : null;
  let detail: ReactNode = null;
  if (request?.target.kind === 'file')
    detail = <span className="block font-medium break-all">{request.target.attachment.name}</span>;
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {copy && request && (
        <AlertDialogContent
          onOpenAutoFocus={() => {
            confirmed.current = false;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // The menu that opened this is gone once the removal lands; the message stays.
            const next = confirmed.current ? settle.current : returnFocus.current;
            (next ?? settle.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2">
                {detail}
                <p className="mb-0">{copy.body}</p>
                {copy.leftovers && <p className="mb-0">{copy.leftovers}</p>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => {
                confirmed.current = true;
                onConfirm(request);
              }}
            >
              {copy.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
