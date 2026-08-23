import { CalendarClock, Cable, ChevronRight, Cpu, MessagesSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useOverridesLedger, type OverrideKind } from '../model/use-overrides-ledger';

/** One glyph per surface a row can open. */
const KIND_ICON: Record<OverrideKind, LucideIcon> = {
  runtime: Cpu,
  session: MessagesSquare,
  task: CalendarClock,
  binding: Cable,
};

/**
 * The overrides ledger — the honesty section (spec `full-power-defaults`, D7).
 *
 * Everything that does not simply follow the global dial: a runtime with its own
 * default, a live session at a different stop, and any task or integration whose
 * power diverges from the global one. Each row deep-links to the surface that
 * owns it. Composed from {@link useOverridesLedger}, which reads only queries
 * that already exist.
 *
 * The scope line at the top states the ladder plainly: the dial governs new
 * sessions; a running one keeps what it has, and nothing here is touched by
 * moving the dial.
 */
export function OverridesLedger() {
  const { rows, isEmpty, isResolving } = useOverridesLedger();

  return (
    <section className="flex flex-col gap-2" data-testid="control-center-overrides">
      <div>
        <p className="text-sm font-medium">Exceptions</p>
        <p className="text-muted-foreground text-xs">
          These run at their own power, not the dial above. Moving the dial changes new sessions
          only; nothing here is touched.
        </p>
      </div>

      {isResolving ? (
        <p className="text-muted-foreground px-1 text-xs">Checking…</p>
      ) : isEmpty ? (
        <p data-testid="overrides-ledger-empty" className="text-muted-foreground px-1 text-xs">
          Everything follows your dial. A conversation open in another project isn’t counted here.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => {
            const Icon = KIND_ICON[row.kind];
            return (
              <li key={row.key}>
                <button
                  type="button"
                  data-testid={`override-row-${row.kind}`}
                  onClick={() => row.onOpen?.()}
                  disabled={!row.onOpen}
                  aria-label={`${row.name} — ${row.detail}. Open.`}
                  className="focus-ring hover:bg-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-60"
                >
                  <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="text-muted-foreground shrink-0">{row.detail}</span>
                  <ChevronRight
                    className="text-muted-foreground/60 size-3.5 shrink-0"
                    aria-hidden
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
