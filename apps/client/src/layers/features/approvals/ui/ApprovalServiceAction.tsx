import type { ApprovalServiceAction as ApprovalServiceActionValue } from '@dorkos/shared/approval-schemas';
import { useId, useState } from 'react';
import { ServiceMark } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';

export interface ApprovalServiceActionProps {
  /** The connected-app action, as the server described it. */
  action: ApprovalServiceActionValue;
  /** Whether the service marks the action high risk, which the card then says in words. */
  destructive: boolean;
  className?: string;
}

/** Indent per nesting level in the complete list, as a Tailwind padding class. */
const DEPTH_INDENT = ['pl-0', 'pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-15', 'pl-18', 'pl-21', 'pl-24'];

/** "1 value is", "3 values are". */
function cutLine(count: number): string {
  const values = count === 1 ? '1 value is' : `${count} values are`;
  return `${values} too long to show here. If you're not sure what this sends, deny it.`;
}

/**
 * What a connected-app action would do: the app and account it runs on, its
 * arguments, and — when the service marks it high risk — a plain line saying so
 * (DOR-2504). The card's heading above names the action itself.
 *
 * Everything here arrives already in words. The app, account and action come
 * from the server's own records, never the agent's; the argument values are
 * the agent's, swept for secrets by the server, so this renders them as text
 * and never reshapes them. The labels sit in their own column, apart from the
 * app line, so an argument can never read as the account it runs on.
 *
 * ## Nothing that would run stays unreadable
 *
 * The glance is short on purpose: a few lines, each value on one line. When
 * that leaves anything out — a long value shortened, a list counted, more
 * arguments than fit — the server also sends every argument whole, and
 * "Show everything" opens it right here on the card, each list item and
 * nested field on its own indented line. It scrolls inside the card, so a
 * long message body never pushes the answer buttons away.
 */
export function ApprovalServiceAction({
  action,
  destructive,
  className,
}: ApprovalServiceActionProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const everything = action.everything;
  return (
    <div data-slot="approval-service-action" className={cn('mt-1 min-w-0', className)}>
      {/* Wraps rather than truncating: the account is how a person tells two
          Gmail accounts apart, so its tail must never hide behind an ellipsis.
          No separator glyph, so a wrapped line never starts with one; weight
          and colour tell the app from the account. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        <span className="flex shrink-0 items-center gap-1.5">
          <ServiceMark
            iconKey={action.serviceId}
            displayName={action.serviceName}
            className="size-5 rounded"
          />
          <span className="text-foreground font-medium">{action.serviceName}</span>
        </span>
        <span className="text-muted-foreground min-w-0 break-all">{action.accountLabel}</span>
      </div>
      {expanded && everything ? (
        <dl
          id={listId}
          data-slot="approval-service-everything"
          className="border-border/60 bg-muted/40 mt-1.5 grid max-h-[50dvh] grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 overflow-auto rounded-md border p-2 text-xs md:max-h-72"
        >
          {everything.map((line, index) => (
            <div key={`${index}-${line.label}`} className="contents">
              <dt
                className={cn(
                  'text-muted-foreground max-w-48 break-words',
                  DEPTH_INDENT[line.depth]
                )}
              >
                {line.label}
              </dt>
              <dd className="text-foreground min-w-0 break-words whitespace-pre-wrap">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        action.details.length > 0 && (
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
        )
      )}
      {(everything || action.moreDetails !== undefined) && (
        <p className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          {!expanded && action.moreDetails !== undefined && (
            <span>
              {action.moreDetails === 1 ? '1 more detail' : `${action.moreDetails} more details`}
            </span>
          )}
          {everything && (
            <button
              type="button"
              data-slot="approval-show-everything"
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              className="hover:text-foreground focus-visible:ring-ring rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show less' : 'Show everything'}
            </button>
          )}
        </p>
      )}
      {expanded && action.everythingCut !== undefined && (
        <p data-slot="approval-everything-cut" className="text-muted-foreground mt-0.5 text-xs">
          {cutLine(action.everythingCut)}
        </p>
      )}
      {destructive && (
        <p data-slot="approval-irreversible" className="text-destructive mt-1.5 text-xs">
          {`This is a high-risk action in ${action.serviceName}. Check what it does before you allow it.`}
        </p>
      )}
    </div>
  );
}
