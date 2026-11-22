/**
 * One Inbox card for apps that ask again only because they now say where
 * they show (DOR-4282): "3 apps need a quick look", one row per app with
 * its own Allow and Not now. The apps keep running meanwhile; only their new
 * places stay off. There is no way to allow them all at once.
 *
 * @module widgets/inbox-bell/ui/PlacesReaskCard
 */
import { useId, useState } from 'react';
import { Check, Puzzle } from 'lucide-react';
import type { ApprovalAnswerContext } from '@dorkos/shared/step-up';
import { ApprovalAnswerNote, Button, Spinner } from '@/layers/shared/ui';
import { ALLOW_NOT_CONFIRMED_COPY } from '@/layers/entities/extension';
import { PLACES_GROUP_VISIBLE, newPlacesLine, reaskKeyOf } from '../lib/places-reask';
import type { PlacesGroupRow } from '../model/use-places-reask-group';

/** Props for {@link PlacesReaskCard}. */
export interface PlacesReaskCardProps {
  /** The card's rows, answered ones included. */
  rows: readonly PlacesGroupRow[];
  /** Allow one app: the same person-only approval its own card makes. */
  onAllow: (row: PlacesGroupRow) => void;
  /** Leave one app's new places off: the same answer its own card's "Not now" gives. */
  onNotNow: (row: PlacesGroupRow) => void;
  /** The app whose answer is in flight, and which answer, or `null`. */
  pending: { id: string; action: 'approve' | 'dismiss' } | null;
  /** Where the person is answering from, when that changes what Allow needs. */
  answerContext?: ApprovalAnswerContext;
  /** Start with every row shown, as if "Show N more" was pressed. */
  defaultExpanded?: boolean;
  /** The apps whose last Allow ended on "Confirm it's you" closed unconfirmed (DOR-4909). */
  notConfirmed?: Readonly<Record<string, string>>;
}

/** One app's row: its name, the places it now names, and its two answers. */
function PlacesRow({
  row,
  onAllow,
  onNotNow,
  pending,
  notConfirmed,
}: { row: PlacesGroupRow; notConfirmed: boolean } & Pick<
  PlacesReaskCardProps,
  'onAllow' | 'onNotNow' | 'pending'
>) {
  const { approval, answer } = row;
  const busy = pending !== null;
  const working = pending?.id === approval.id ? pending.action : null;
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 py-1"
      data-testid={`places-reask-row-${approval.id}`}
    >
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-[18px] shrink-0 items-center justify-center rounded-md border"
      >
        <Puzzle className="size-3" />
      </span>
      {/* A 9rem start keeps the words whole: on a narrow card the buttons drop
          to their own line rather than squeezing the text to a letter a line. */}
      <p className="min-w-0 flex-1 basis-36 text-xs break-words">
        <bdi className="text-foreground font-medium">{approval.name}</bdi>
        <span className="text-muted-foreground">
          {' · '}
          {answer === 'allowed'
            ? 'Allowed'
            : answer === 'not-now'
              ? 'Not now'
              : newPlacesLine(approval)}
        </span>
        {answer === 'allowed' && (
          <Check aria-hidden className="text-status-success-fg ml-1 inline size-3" />
        )}
      </p>
      {answer === null && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            responsive={false}
            disabled={busy}
            aria-label={`Allow ${approval.name}`}
            onClick={() => onAllow(row)}
          >
            {working === 'approve' && <Spinner size="xs" />}
            Allow
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            responsive={false}
            disabled={busy}
            aria-label={`Not now for ${approval.name}`}
            onClick={() => onNotNow(row)}
          >
            {working === 'dismiss' && <Spinner size="xs" />}
            Not now
          </Button>
        </span>
      )}
      {answer === null && notConfirmed && (
        <p
          role="status"
          className="text-status-warning-fg basis-full text-xs leading-snug font-medium"
        >
          {ALLOW_NOT_CONFIRMED_COPY}
        </p>
      )}
    </li>
  );
}

/**
 * The card. Shows the first {@link PLACES_GROUP_VISIBLE} rows, then "Show N
 * more". Each row is answered on its own; an allowed row collapses to
 * "Allowed ✓", and the list drops the card once no row still waits.
 *
 * @param props - {@link PlacesReaskCardProps}.
 */
export function PlacesReaskCard({
  rows,
  onAllow,
  onNotNow,
  pending,
  answerContext,
  defaultExpanded = false,
  notConfirmed = {},
}: PlacesReaskCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const titleId = useId();
  const waiting = rows.filter((row) => row.answer === null).length;
  if (waiting === 0) return null;
  const shown = expanded ? rows : rows.slice(0, PLACES_GROUP_VISIBLE);
  const hidden = rows.length - shown.length;
  return (
    <section
      aria-labelledby={titleId}
      data-slot="places-reask-card"
      className="min-w-0 px-2 py-1.5"
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md border"
        >
          <Puzzle className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p id={titleId} className="text-foreground text-control text-xs font-semibold">
            {waiting === 1 ? '1 app needs a quick look' : `${waiting} apps need a quick look`}
          </p>
          <p className="text-foreground mt-0.5 text-xs leading-snug">
            They keep working. Each new place stays off until you allow it.
          </p>
          <ul className="mt-1.5 flex flex-col">
            {shown.map((row) => (
              <PlacesRow
                key={reaskKeyOf(row.approval)}
                row={row}
                onAllow={onAllow}
                onNotNow={onNotNow}
                pending={pending}
                notConfirmed={notConfirmed[row.approval.id] === row.approval.version}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground focus-ring mt-1 rounded-sm text-xs underline underline-offset-2"
            >
              Show {hidden} more
            </button>
          )}
          <ApprovalAnswerNote context={answerContext} />
        </div>
      </div>
    </section>
  );
}
