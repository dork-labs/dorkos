import { useId } from 'react';
import type { SpendingSummary } from '@dorkos/shared/connector-spending';
import { useConnectorSpending, useSetSpendingLimit } from '@/layers/entities/connectors';
import { cn } from '@/layers/shared/lib';
import { Button, Skeleton } from '@/layers/shared/ui';
import { barPercent, barValueText, spendingStatus, whereItWent } from '../../lib/spending-lines';
import { SpendAmountField } from './SpendAmountField';
import { SpendingBar } from './SpendingBar';

/** Props for {@link SpendingBlock}. */
export interface SpendingBlockProps {
  /** Whether a connected app has an action that spends money. */
  canSpend: boolean;
  /** An app's display name from its service id. */
  nameOf: (toolkit: string) => string;
  /** Put the cursor in the monthly limit once it shows. */
  focusLimit?: boolean;
}

/** The section's anchor, for links that open Connections at Spending. */
export const SPENDING_SECTION = 'spending';

/**
 * Connections → Spending (DOR-4204 spec §2, §5, §7): one monthly limit for
 * what agents spend, the month so far, and where it went. With no limit set,
 * every paid action asks first. Hidden while nothing here can spend.
 */
export function SpendingBlock({ canSpend, nameOf, focusLimit = false }: SpendingBlockProps) {
  const headingId = useId();
  const spending = useConnectorSpending();
  const summary = spending.data;
  const hasHistory =
    summary !== undefined && (summary.limitMicro !== null || BigInt(summary.usedMicro ?? '0') > 0n);
  if (!canSpend && !hasHistory) return null;

  // A refetch that failed with a value already shown: DorkOS can't be reached.
  const offline = spending.isError && summary !== undefined;
  return (
    <section
      aria-labelledby={headingId}
      data-section={SPENDING_SECTION}
      data-testid="spending-block"
      className="bg-muted/40 scroll-mt-4 space-y-3 rounded-xl p-4"
    >
      <h2 id={headingId} className="text-sm font-medium">
        Spending
      </h2>
      {summary === undefined ? (
        spending.isError ? (
          <LoadFailed onRetry={() => void spending.refetch()} />
        ) : (
          <Skeleton className="h-20 rounded-lg" />
        )
      ) : (
        <div className={cn('space-y-3', offline && 'opacity-60')}>
          <LimitField summary={summary} online={!offline} autoFocus={focusLimit} />
          <Month summary={summary} nameOf={nameOf} />
          {offline && <p className="text-muted-foreground text-xs">Can’t reach DorkOS.</p>}
        </div>
      )}
    </section>
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-x-2 text-sm">
      Couldn’t load spending.
      <Button variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
        Retry
      </Button>
    </p>
  );
}

function LimitField({
  summary,
  online,
  autoFocus,
}: {
  summary: SpendingSummary;
  online: boolean;
  autoFocus: boolean;
}) {
  const setLimit = useSetSpendingLimit();
  const limited = summary.limitMicro !== null;
  return (
    <SpendAmountField
      label="Monthly limit"
      placeholder="Ask every time"
      savedMicro={summary.limitMicro}
      maxMicro={summary.maxMicro}
      online={online}
      onSave={(micro) => setLimit.mutateAsync(micro)}
      inputClassName="sm:w-40"
      autoFocus={autoFocus}
      help={
        limited ? (
          <>
            <p>Paid actions within the limit run without asking.</p>
            <p>Raising it asks you to confirm it’s you. Lowering never does.</p>
          </>
        ) : (
          <p>With no limit, every paid action asks you first.</p>
        )
      }
    />
  );
}

function Month({
  summary,
  nameOf,
}: {
  summary: SpendingSummary;
  nameOf: (toolkit: string) => string;
}) {
  const status = spendingStatus(summary);
  const percent = barPercent(summary);
  const { rows, more } = whereItWent(summary.byApp ?? [], nameOf);
  return (
    <div className="space-y-2">
      <p className="text-sm tabular-nums" data-testid="spending-status">
        <span>{status.first}</span>
        {status.second !== null && (
          <span className="max-sm:block max-sm:first-letter:uppercase">
            <span className="max-sm:hidden">{' · '}</span>
            {status.second}
          </span>
        )}
      </p>
      {percent !== null && <SpendingBar percent={percent} valueText={barValueText(summary)} />}
      {rows.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs font-medium">Where it went</p>
          <ul className="space-y-0.5" data-testid="spending-where">
            {rows.map((row) => (
              <li key={row.toolkit} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 tabular-nums">{row.amount}</span>
              </li>
            ))}
            {more > 0 && <li className="text-muted-foreground text-xs">+{more} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
