/**
 * The identity row of a runtime card — who this runtime is, whether it can be
 * used, and whether it is the one new conversations start on.
 *
 * Private to {@link RuntimeCardView}; it exists so the card file stays one
 * readable screen rather than one long one. Presentational, like everything else
 * under `runtimes/`: it is told all four of those answers and reports clicks.
 *
 * @module features/settings/ui/runtimes/RuntimeCardHeader
 */
import type { ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Badge } from '@/layers/shared/ui';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';

/**
 * The quiet way back into a connected runtime's sign-in.
 *
 * `Ready` is a fingerprint check — it cannot see a stale key or an expired host
 * login — so a connected runtime keeps a small way to redo it. The card is told
 * WHICH flow can reopen; the word for it is a rendering decision and lives here,
 * so the two runtimes that reconnect and the one that re-picks a provider stay
 * spelled the same way everywhere.
 */
export interface RuntimeCardReconnect {
  /** `login` reads "Fix sign-in" (Claude, Codex); `provider-picker` reads "Change" (OpenCode). */
  kind: 'login' | 'provider-picker';
  /** Reopen the flow. The container owns the panel that then renders. */
  onOpen: () => void;
}

/** The trigger word and test-id namespace for each reconnect flow. */
const RECONNECT_LABELS: Record<RuntimeCardReconnect['kind'], { id: string; label: string }> = {
  login: { id: 'reconnect', label: 'Fix sign-in' },
  'provider-picker': { id: 'change', label: 'Change' },
};

/** Everything the header is told. */
export interface RuntimeCardHeaderProps {
  /** Runtime type id, e.g. `'claude-code'`. Scopes every test id on the card. */
  type: string;
  /** One line of identity beneath the name, or nothing when the card has none. */
  subtitle?: string | undefined;
  /** Whether the runtime can start a conversation right now. */
  ready: boolean;
  /** Whether new conversations start on this runtime. */
  isDefault: boolean;
  /** Make this the default. Absent means the card cannot offer it. */
  onMakeDefault?: (() => void) | undefined;
  /** The reconnect affordance for a ready runtime, or nothing to reopen. */
  reconnect?: RuntimeCardReconnect | undefined;
  /** Whether the card has a body worth opening — no body, no toggle. */
  toggleable: boolean;
  /** Whether the body is open. */
  expanded: boolean;
  /** Open or close the body. */
  onToggleExpanded: () => void;
  /** Id of the body this header controls, for `aria-controls`. */
  bodyId: string;
  /** The summary line (or the not-ready sentence) — part of the click target. */
  children?: ReactNode;
}

/**
 * Logo, name, subtitle, readiness, default marker — and the card's click target.
 *
 * The identity block IS the button (design §4: the header and summary open the
 * card), which keeps the whole region reachable from the keyboard as one control
 * and keeps every other control a SIBLING of it rather than a descendant. That
 * is why nothing here stops propagation: a control that is not inside the toggle
 * cannot fire it, so changing a model or fixing a sign-in can never collapse the
 * card by accident.
 *
 * @param props - Identity, state, and the two callbacks.
 */
export function RuntimeCardHeader({
  type,
  subtitle,
  ready,
  isDefault,
  onMakeDefault,
  reconnect,
  toggleable,
  expanded,
  onToggleExpanded,
  bodyId,
  children,
}: RuntimeCardHeaderProps) {
  const descriptor = getRuntimeDescriptor(type);
  const Icon = descriptor.icon;

  const identity = (
    <>
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--runtime-accent)]/10 text-[var(--runtime-accent)]"
      >
        <Icon size={24} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{descriptor.label}</span>
          {isDefault && (
            <Badge
              variant="outline"
              className="shrink-0 border-[var(--runtime-accent)]/40 bg-[var(--runtime-accent)]/10 text-[var(--runtime-accent)]"
              data-testid={`runtime-default-pill-${type}`}
            >
              Default
            </Badge>
          )}
        </span>
        {subtitle && <span className="text-muted-foreground truncate text-xs">{subtitle}</span>}
        {children}
      </span>
    </>
  );

  const trigger = reconnect ? RECONNECT_LABELS[reconnect.kind] : null;

  return (
    <div className="flex items-start gap-3 p-4">
      {toggleable ? (
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          className="focus-ring -m-1 flex min-w-0 flex-1 items-start gap-3 rounded-md p-1 text-left"
          data-testid={`runtime-card-toggle-${type}`}
        >
          {identity}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-3">{identity}</div>
      )}

      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {ready && (
          <span
            className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-emerald-500"
            data-testid={`runtime-ready-${type}`}
          >
            <Check className="size-3.5" />
            {/* The word is redundant next to the mark on a narrow screen, where
                the pill and Connect already say what state the card is in. */}
            <span className="hidden sm:inline">Ready</span>
          </span>
        )}
        {ready && trigger && (
          <button
            type="button"
            onClick={reconnect?.onOpen}
            className="focus-ring text-muted-foreground hover:text-foreground rounded-sm text-xs whitespace-nowrap underline-offset-2 transition-colors hover:underline"
            data-testid={`runtime-${trigger.id}-${type}`}
          >
            {trigger.label}
          </button>
        )}
        {!isDefault && onMakeDefault && (
          <button
            type="button"
            onClick={onMakeDefault}
            className="focus-ring text-muted-foreground hover:text-foreground hidden rounded-sm text-xs whitespace-nowrap underline-offset-2 transition-colors hover:underline sm:inline-flex"
            data-testid={`runtime-make-default-${type}`}
          >
            Make default
          </button>
        )}
        {toggleable && (
          /* A mouse affordance only: people click chevrons, but the identity
             button above already carries this control for the keyboard and the
             a11y tree, and two controls for one body would just say it twice. */
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={onToggleExpanded}
            className="text-muted-foreground hover:text-foreground rounded-sm transition-colors"
          >
            <ChevronDown className={cn('size-4 transition-transform', expanded && 'rotate-180')} />
          </button>
        )}
      </div>
    </div>
  );
}
