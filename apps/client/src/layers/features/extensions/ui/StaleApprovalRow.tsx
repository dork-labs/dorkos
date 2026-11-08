/**
 * An approval whose extension is gone, as one row under "Needs you" (DOR-3372):
 * "Folder missing", and Review opens the one decision, Forget it.
 *
 * Until it is forgotten, anything put back at that folder could meet the old
 * yes, which is why it sits with what needs the person.
 *
 * @module features/extensions/ui/StaleApprovalRow
 */
import { useEffect, useId, useRef } from 'react';
import { Badge, Button } from '@/layers/shared/ui';
import { cn, shortenHomePath } from '@/layers/shared/lib';
import type { StaleApproval } from '../api/removal-queries';

/** Props for {@link StaleApprovalRow}. */
export interface StaleApprovalRowProps {
  /** The approval left behind. */
  approval: StaleApproval;
  /** Whether the row is open. */
  open: boolean;
  /** Open or close it. */
  onOpenChange: (open: boolean) => void;
  /** Forget the approval. */
  onForget: (id: string) => void;
  /** Whether a forget is in flight. */
  isForgetting: boolean;
}

/**
 * One approval left behind.
 *
 * @param props - {@link StaleApprovalRowProps}.
 */
export function StaleApprovalRow({
  approval,
  open,
  onOpenChange,
  onForget,
  isForgetting,
}: StaleApprovalRowProps) {
  const panelId = useId();
  const nameId = useId();
  const forgetRef = useRef<HTMLButtonElement>(null);
  const focusForget = useRef(false);

  useEffect(() => {
    if (!open || !focusForget.current) return;
    focusForget.current = false;
    forgetRef.current?.focus();
  }, [open]);

  return (
    <li
      data-testid={`stale-approval-${approval.id}`}
      className={cn(
        'rounded-lg transition-colors duration-150 motion-reduce:transition-none',
        open ? 'bg-muted dark:bg-foreground/5' : 'hover:bg-muted dark:hover:bg-foreground/5'
      )}
    >
      <div className="flex min-h-10 items-center gap-2 pr-2 max-sm:min-h-16">
        <button
          type="button"
          data-row-button=""
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-4 rounded-lg py-2 pl-3 text-left max-sm:flex-wrap max-sm:gap-y-0.5"
        >
          <span
            id={nameId}
            title={approval.id}
            className="w-[200px] shrink-0 truncate text-[13px] font-medium max-sm:w-auto max-sm:text-base"
          >
            {approval.id}
          </span>
          {/* The short path is for the eye; a screen reader hears the full one. */}
          <span
            aria-hidden="true"
            title={approval.path ?? undefined}
            className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs max-sm:basis-full"
          >
            {approval.path ? shortenHomePath(approval.path) : ''}
          </span>
          {approval.path && <span className="sr-only">{approval.path}</span>}
          <Badge tone="warning" className="shrink-0">
            Folder missing
          </Badge>
        </button>
        <div className="flex w-16 shrink-0 justify-end max-sm:w-[52px]">
          {!open && (
            <Button
              size="xs"
              variant="secondary"
              aria-label={`Review ${approval.id}`}
              onClick={() => {
                focusForget.current = true;
                onOpenChange(true);
              }}
            >
              Review
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div id={panelId} role="region" aria-labelledby={nameId} className="px-3 pt-1 pb-4">
          <div className="bg-status-warning-bg space-y-3 rounded-lg p-4 dark:bg-[hsl(40_25%_14%)]">
            <p className="text-sm font-semibold">Its folder is gone.</p>
            <div className="text-muted-foreground space-y-1 text-sm">
              <p>What you allowed it is still saved.</p>
              <p>Forget it so a new copy has to ask again.</p>
            </div>
            <Button
              ref={forgetRef}
              size="sm"
              onClick={() => onForget(approval.id)}
              disabled={isForgetting}
            >
              Forget it
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
