/**
 * The top of the phone's You tab: you, then your DorkOS account — the same two
 * rows the header menu opens with (DOR-2628), drawn from the same model so the
 * two can never say different things.
 *
 * @module features/dashboard-sidebar/ui/context/YouRows
 */
import type { ReactNode } from 'react';
import { ChevronRight, CircleUserRound } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { TOUCH_TARGET_MIN_H } from '@/layers/shared/ui';
import { useIdentityModel } from './use-header-block-menu';

/** The two rows at the top of the phone's You tab. */
export function YouRows() {
  const identity = useIdentityModel('sm');

  return (
    <div className="space-y-1 pb-2">
      {identity.you !== null && (
        <Row
          leading={identity.you.face}
          label={identity.you.name}
          description="View profile"
          onClick={identity.you.onOpen}
        />
      )}
      <Row
        leading={<CircleUserRound className="text-muted-foreground size-7 p-0.5" aria-hidden />}
        label="DorkOS account"
        description={identity.accountStatus}
        onClick={identity.onOpenAccount}
      />
    </div>
  );
}

/**
 * One full-width row: a face or glyph, a name, a quiet status line, a chevron.
 *
 * @param props.leading - The face or glyph on the left.
 * @param props.label - What the row is.
 * @param props.description - Its state, or `undefined` while it is being read.
 * @param props.onClick - Open what the row names.
 */
function Row({
  leading,
  label,
  description,
  onClick,
}: {
  leading: ReactNode;
  label: string;
  description: string | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-hidden focus-visible:ring-2',
        TOUCH_TARGET_MIN_H
      )}
    >
      <span className="flex shrink-0">{leading}</span>
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate text-sm font-medium">{label}</span>
        {description !== undefined && (
          <span className="text-muted-foreground block truncate text-xs">{description}</span>
        )}
      </span>
      <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
    </button>
  );
}
