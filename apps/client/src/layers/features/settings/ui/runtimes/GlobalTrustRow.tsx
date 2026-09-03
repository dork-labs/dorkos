/**
 * "Where new conversations stop for you" — the one shared trust setting,
 * beneath the cards (design decision 3, option A).
 *
 * The heading is deliberately NOT the design session's original "Where agents
 * stop for you". DOR-853 reserved the bare word "agent" for a named teammate in
 * the fleet, and this setting governs neither a teammate nor a fleet: it is
 * where a NEW CONVERSATION starts on the trust dial, whichever runtime it lands
 * on. The newer invariant outranks the older local copy, so the row says what it
 * actually governs (design §3 addendum).
 *
 * It answers the question once for every runtime; each card's `TrustRow` is the
 * override for the person who wants something narrower somewhere. That is why
 * this row is quiet: label and hint on the left, three stops on the right, and
 * nothing else unless something is running without asking.
 *
 * Presentational on purpose (design decision 7): stops in, a change out, no
 * query and no config write anywhere in it. The consent choreography around Full
 * autonomy is genuinely about the server — the config route refuses that write
 * without an acknowledgement — so it stays with the container, which holds the
 * single `useTrustStopWrites` call and the single `AutonomyConfirmDialog` for
 * the whole tab. A row that confirmed as well would be a second consent
 * contract.
 *
 * @module features/settings/ui/runtimes/GlobalTrustRow
 */
import { Zap } from 'lucide-react';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { resolveTrustStops } from '@/layers/shared/lib';
import {
  CANONICAL_TRUST_STOPS,
  SegmentedControl,
  SegmentedControlItem,
  TRUST_TONE_TEXT,
  TrustModeIcon,
} from '@/layers/shared/ui';
import { listRuntimes } from '../../lib/list-runtimes';
// The tab's own wording of the three stops, shared with each card's dial so the
// whole page asks the question in one voice (design §3).
import { SETTINGS_STOP_LABELS } from './stop-labels';

/** One runtime, as the standing-autonomy note needs to talk about it. */
export interface GlobalTrustRowRuntime {
  /** Runtime type id, e.g. `'claude-code'`. */
  runtime: string;
  /** What a person calls it. */
  label: string;
  /**
   * This runtime's override, or `null` when its card follows this row. Null is a
   * real state, never a silent copy of the shared value: the note has to be able
   * to tell an override at Full autonomy from a runtime that merely inherited it.
   */
  stop: PermissionStop | null;
}

/** What the global trust row needs to be told, and the two things it says back. */
export interface GlobalTrustRowProps {
  /**
   * The shared choice, or `null` for "no preference — each runtime decides".
   * A three-position control has no way to draw an absence, so `null` renders as
   * {@link GlobalTrustRowProps.effectiveStop}, which is what a person is looking
   * at anyway.
   */
  stop: PermissionStop | null;
  /** The stop `null` resolves to on the default runtime — the effective answer. */
  effectiveStop: PermissionStop;
  /**
   * Every runtime with a card, in the order the tab lists them, carrying its
   * override. Only the standing-autonomy note reads this; the control itself is
   * runtime-neutral.
   */
  runtimes: readonly GlobalTrustRowRuntime[];
  /** Set the shared stop. This row never reports `null` — it has no such position. */
  onChange: (stop: PermissionStop) => void;
  /** Set or clear one runtime's override. `null` returns it to this row's choice. */
  onChangeRuntime: (runtime: string, stop: PermissionStop | null) => void;
}

/**
 * How much a new conversation may do before it checks with you, answered once
 * for every runtime.
 *
 * Two things are load-bearing about the shape:
 *
 * - **One control, not three.** A person who wants "always Full autonomy" says
 *   it once; the cards carry the overrides, so this row stays a single line and
 *   the page does not ask the same question three times.
 * - **Autonomy says so quietly and permanently.** A person whose sessions all
 *   start without asking should be able to find that out here, months later,
 *   without remembering they set it — and the note fires on the EFFECTIVE
 *   resolution, because a card can sit at Full autonomy while this row reads
 *   Asks before acting and the server gates that write identically.
 *
 * @param props - The stored stop, what it resolves to, the runtimes to check for
 *   overrides, and the two change handlers.
 */
export function GlobalTrustRow({
  stop,
  effectiveStop,
  runtimes,
  onChange,
  onChangeRuntime,
}: GlobalTrustRowProps) {
  const selected = stop ?? effectiveStop;
  // Read from the shared descriptors rather than a local list, so this row offers
  // exactly the stops the product defines, in the product's order.
  const stops = resolveTrustStops(CANONICAL_TRUST_STOPS);
  // Every runtime whose own card put it at Full autonomy, whatever this row says.
  const overriddenToAutonomy = runtimes.filter((entry) => entry.stop === 'autonomy');
  const sharedAtAutonomy = selected === 'autonomy';

  return (
    <section className="@container/trust-row flex flex-col gap-2" data-testid="global-trust-row">
      {/* A CONTAINER query, not a viewport one. The three stop words are ~400px
          of control, and Settings is a 672px dialog with a 180px sidebar — so on
          a desktop where `sm:` says "side by side", the label column was left
          ~40px and broke to one word per line. What decides this layout is the
          space this row is in, which is what the query asks: stacked until both
          halves genuinely fit (the same shape a phone gets), side by side in a
          fullscreened dialog or any wider host. */}
      <div className="flex flex-col gap-3 @2xl/trust-row:flex-row @2xl/trust-row:items-center @2xl/trust-row:justify-between @2xl/trust-row:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-medium">Where new conversations stop for you</p>
          <p className="text-muted-foreground text-xs">
            Every card above follows this unless it says otherwise.
          </p>
        </div>

        {/* Full width while stacked; its own width, and no squeezing, beside the
            label (design §6). */}
        <SegmentedControl
          aria-label="Where new conversations stop for you"
          className="w-full @2xl/trust-row:w-auto @2xl/trust-row:shrink-0"
          value={selected}
          onValueChange={(next) => onChange(next as PermissionStop)}
        >
          {stops.map(({ stop: position, mode }) => (
            <SegmentedControlItem
              key={position}
              value={position}
              aria-label={SETTINGS_STOP_LABELS[position]}
            >
              <TrustModeIcon descriptor={mode} className="size-(--size-icon-xs) shrink-0" />
              <span className="truncate">{SETTINGS_STOP_LABELS[position]}</span>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      {/* Findable, not buried — and green, because a person who set this got what
          they asked for. The note exists so they can find it cold months later,
          not to tell them off. Kept under its old test id so the assertions that
          already guard this promise keep guarding it. */}
      {(sharedAtAutonomy || overriddenToAutonomy.length > 0) && (
        <p
          className={`flex items-start gap-1.5 px-1 text-xs ${TRUST_TONE_TEXT.power}`}
          data-testid="default-trust-stop-standing-note"
        >
          <Zap className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            {sharedAtAutonomy
              ? 'New sessions run at full power'
              : `New sessions on ${listRuntimes(overriddenToAutonomy)} run at full power`}
            .{' '}
            <button
              type="button"
              className="focus-ring rounded-sm underline underline-offset-2"
              onClick={() => {
                // Undo exactly what is set: the shared choice when it is the one
                // at autonomy, plus every override that is.
                if (sharedAtAutonomy) onChange('ask');
                for (const entry of overriddenToAutonomy) onChangeRuntime(entry.runtime, null);
              }}
            >
              change
            </button>
          </span>
        </p>
      )}
    </section>
  );
}
