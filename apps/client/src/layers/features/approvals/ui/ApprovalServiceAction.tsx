import type { ApprovalServiceAction as ApprovalServiceActionValue } from '@dorkos/shared/approval-schemas';
import { ServiceMark } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';

export interface ApprovalServiceActionProps {
  /** The connected-app action, as the server described it. */
  action: ApprovalServiceActionValue;
  /** Whether the action can't be undone, which the card then says in words. */
  destructive: boolean;
  className?: string;
}

/**
 * What a connected-app action would do: the app and account it runs on, its
 * arguments, and — when it can't be undone — a plain line saying so
 * (DOR-2504). The card's heading above names the action itself.
 *
 * Everything here arrives already in words. The app, account and action come
 * from the server's own records, never the agent's; the argument values are
 * the agent's, already shortened to one line each and swept for secrets, so
 * this renders them as text and never reshapes them. The labels sit in their
 * own column, apart from the app line, so an argument can never read as the
 * account it runs on.
 */
export function ApprovalServiceAction({
  action,
  destructive,
  className,
}: ApprovalServiceActionProps) {
  return (
    <div data-slot="approval-service-action" className={cn('mt-1 min-w-0', className)}>
      {/* Wraps rather than truncating: the account is how a person tells two
          Gmail accounts apart, so its tail must never hide behind an ellipsis. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
        <ServiceMark
          iconKey={action.serviceId}
          displayName={action.serviceName}
          className="size-5 rounded"
        />
        <span className="text-foreground font-medium">{action.serviceName}</span>
        <span aria-hidden className="text-muted-foreground">
          ·
        </span>
        <span className="text-muted-foreground min-w-0 break-all">{action.accountLabel}</span>
      </div>
      {action.details.length > 0 && (
        <dl
          data-slot="approval-service-details"
          className="mt-1.5 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs"
        >
          {action.details.map((detail, index) => (
            <div key={`${detail.label}-${index}`} className="contents">
              <dt className="text-muted-foreground max-w-40 break-words">{detail.label}</dt>
              <dd className="text-foreground min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {action.moreDetails !== undefined && (
        <p className="text-muted-foreground mt-0.5 text-xs">
          {action.moreDetails === 1 ? '1 more detail' : `${action.moreDetails} more details`}
        </p>
      )}
      {destructive && (
        <p data-slot="approval-irreversible" className="text-destructive mt-1.5 text-xs">
          {`Once this runs, it can't be undone in ${action.serviceName}.`}
        </p>
      )}
    </div>
  );
}
