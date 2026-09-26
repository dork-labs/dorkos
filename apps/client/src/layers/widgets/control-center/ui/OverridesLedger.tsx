import {
  CalendarClock,
  Cable,
  ChevronRight,
  Cpu,
  MessagesSquare,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useOverridesLedger, type OverrideKind } from '../model/use-overrides-ledger';

/** One glyph per surface a row can open. */
const KIND_ICON: Record<OverrideKind, LucideIcon> = {
  runtime: Cpu,
  session: MessagesSquare,
  task: CalendarClock,
  binding: Cable,
  'agent-permission': ShieldCheck,
};

/**
 * The overrides ledger — the honesty section (spec `full-power-defaults`, D7).
 *
 * Everything that does not simply follow the preset: a runtime with its own
 * default, a live session at a different stop, any task or integration whose
 * power diverges from the global one, and any agent with a permission of its
 * own. Each row deep-links to the surface that owns it; an agent's permission
 * also has a one-tap Reset, the ledger's only reset, because it is the only kind
 * a person can put back without choosing a new value. Composed from
 * {@link useOverridesLedger}, which reads only queries that already exist.
 *
 * The scope line at the top states the ladder plainly: the preset governs new
 * sessions and agents with no setting of their own; nothing here is touched by
 * choosing one.
 */
export function OverridesLedger() {
  const { rows, isEmpty, isResolving, permissionsUnreadable } = useOverridesLedger();

  return (
    <section className="flex flex-col gap-2" data-testid="control-center-overrides">
      <div>
        <p className="text-sm font-medium">Exceptions</p>
        <p className="text-muted-foreground text-xs">
          These don’t follow the preset above. Choosing a preset leaves them as they are.
        </p>
      </div>

      {isResolving ? (
        <p className="text-muted-foreground px-1 text-xs">Checking…</p>
      ) : isEmpty ? (
        <p data-testid="overrides-ledger-empty" className="text-muted-foreground px-1 text-xs">
          Everything follows your preset. A conversation open in another project isn’t counted here.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => {
            const Icon = KIND_ICON[row.kind];
            return (
              <li key={row.key} className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid={`override-row-${row.kind}`}
                  onClick={() => row.onOpen?.()}
                  disabled={!row.onOpen}
                  aria-label={`${row.name}: ${row.detail}. Open.`}
                  className="focus-ring hover:bg-accent/60 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-60"
                >
                  <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="text-muted-foreground shrink-0">{row.detail}</span>
                  <ChevronRight
                    className="text-muted-foreground/60 size-3.5 shrink-0"
                    aria-hidden
                  />
                </button>
                {row.onReset ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={row.resetting}
                    aria-label={`Reset ${row.name}: ${row.detail}`}
                    onClick={row.onReset}
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    Reset
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {permissionsUnreadable ? (
        <p
          data-testid="overrides-ledger-permissions-error"
          className="text-muted-foreground px-1 text-xs"
        >
          Couldn’t read which agents have permissions of their own, so they aren’t listed here.
          Settings → Permissions shows them.
        </p>
      ) : null}
    </section>
  );
}
