/**
 * "New sessions start in" — one dial for how much a new conversation may do
 * without asking, the per-runtime truth beneath it, and the overrides behind a
 * disclosure (spec `trust-dial`, decision 6B).
 *
 * Presentational on purpose: stops in, changes out, no query and no config write
 * anywhere in it. That is what lets the dev playground render the real thing,
 * and it keeps the consent choreography — which is genuinely about the server —
 * in the card that owns the write.
 *
 * @module features/settings/ui/execution-defaults/DefaultTrustStopSection
 */
import { useState } from 'react';
import { ChevronRight, ShieldOff } from 'lucide-react';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { cn, isDivergent, resolveTrustStops } from '@/layers/shared/lib';
import { Button, CANONICAL_TRUST_STOPS, TrustDial } from '@/layers/shared/ui';

/** One runtime, as this section needs to talk about it. */
export interface DefaultTrustStopRuntime {
  /** Runtime type id, e.g. `'claude-code'`. */
  runtime: string;
  /** What a person calls it. */
  label: string;
  /**
   * This runtime's override, or `null` when it follows the global choice. Null
   * is a real state with its own row, never a silent copy of the global value:
   * a row showing "Act" because the global says Act, with no way to tell that
   * from an override that happens to match, is a setting nobody can reason about.
   */
  stop: PermissionStop | null;
  /** Every mode this runtime declares, in its declared order. */
  descriptors: readonly PermissionModeDescriptor[];
}

export interface DefaultTrustStopSectionProps {
  /**
   * The global choice, or `null` for "no preference — each runtime decides".
   * The dial has no way to draw an absence, so `null` renders as the stop the
   * runtimes would actually take, which is what a person is looking at anyway.
   */
  stop: PermissionStop | null;
  /** The stop `null` resolves to on the default runtime — the effective answer. */
  effectiveStop: PermissionStop;
  /** Every runtime with a settings section, in the order the card lists them. */
  runtimes: readonly DefaultTrustStopRuntime[];
  /** Set the global stop. */
  onChangeGlobal: (stop: PermissionStop) => void;
  /** Set or clear one runtime's override. `null` returns it to the global choice. */
  onChangeRuntime: (runtime: string, stop: PermissionStop | null) => void;
}

/**
 * The stop each runtime would actually take, and the mode it lands on there.
 *
 * The whole translation is {@link resolveTrustStops} — the same function the
 * dial itself renders from and the server resolves a seed with, so the sentence
 * this section prints is the sentence the session will keep.
 *
 * A runtime that declares no mode at the chosen stop gets `mode: undefined`,
 * which the caption says out loud rather than rounding to a neighbour.
 *
 * @internal
 */
function resolveConsequence(
  entry: DefaultTrustStopRuntime,
  globalStop: PermissionStop
): { stop: PermissionStop; mode: PermissionModeDescriptor | undefined; overridden: boolean } {
  const stop = entry.stop ?? globalStop;
  return {
    stop,
    mode: resolveTrustStops(entry.descriptors).find((s) => s.stop === stop)?.mode,
    overridden: entry.stop !== null,
  };
}

/**
 * How much a NEW conversation may do without asking, answered once.
 *
 * Three things are load-bearing about the shape, and all three are decision 6's:
 *
 * - **One dial, not three.** A person who wants "always Full autonomy" says it
 *   once; the per-runtime rows exist for the person who wants something narrower
 *   somewhere, and they are behind a disclosure because most people never do.
 * - **The caption is the truth-teller.** The stop words are fixed across
 *   runtimes, so what the chosen stop MEANS on each one is spelled out beneath
 *   the dial in that runtime's own promise — in amber where the runtime asks
 *   less often than the stop pledged (Codex's workspace-write is the case).
 * - **Autonomy says so quietly and permanently.** A person whose sessions all
 *   start without asking should be able to find that out without remembering
 *   they set it.
 *
 * @param props - The stored stops, the runtimes to describe, and the two writers.
 */
export function DefaultTrustStopSection({
  stop,
  effectiveStop,
  runtimes,
  onChangeGlobal,
  onChangeRuntime,
}: DefaultTrustStopSectionProps) {
  const [showPerRuntime, setShowPerRuntime] = useState(false);
  const selected = stop ?? effectiveStop;

  return (
    <section className="flex flex-col gap-2" data-testid="default-trust-stop">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">New sessions start in</p>
        <p className="text-muted-foreground text-xs">
          How much a new conversation may do before it checks with you. Running ones keep their
          settings.
        </p>
      </div>

      <TrustDial
        mode={selected}
        descriptors={CANONICAL_TRUST_STOPS}
        onChangeMode={(next) => onChangeGlobal(next as PermissionStop)}
      />

      {/* The living caption: one line per runtime, in that runtime's own words.
          Under the dial rather than inside it, because the dial's own caption is
          the canonical promise and these are the consequences of taking it. */}
      <ul className="flex flex-col gap-1 px-1" data-testid="default-trust-stop-consequences">
        {runtimes.map((entry) => {
          const { mode, overridden } = resolveConsequence(entry, selected);
          return (
            <li
              key={entry.runtime}
              className={cn(
                'text-xs leading-relaxed',
                mode && isDivergent(mode)
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
              )}
            >
              <span className="text-foreground font-medium">{entry.label}</span>{' '}
              {mode
                ? mode.promise
                : `has no such setting — new sessions start where ${entry.label} starts them.`}
              {overridden && <span className="text-muted-foreground"> (set for this runtime)</span>}
            </li>
          );
        })}
      </ul>

      {/* Findable, not buried: a person whose every session runs without asking
          should be able to see that here, months later, without remembering. */}
      {selected === 'autonomy' && (
        <p
          className="flex items-start gap-1.5 px-1 text-xs text-red-600 dark:text-red-400"
          data-testid="default-trust-stop-standing-note"
        >
          <ShieldOff className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            New sessions run without asking —{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => onChangeGlobal('ask')}
            >
              change
            </button>
          </span>
        </p>
      )}

      <button
        type="button"
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start px-1 text-xs"
        aria-expanded={showPerRuntime}
        onClick={() => setShowPerRuntime((open) => !open)}
        data-testid="default-trust-stop-disclosure"
      >
        <ChevronRight
          className={cn('size-3 transition-transform', showPerRuntime && 'rotate-90')}
          aria-hidden
        />
        Customize per runtime
      </button>

      {showPerRuntime && (
        <div className="flex flex-col gap-4 px-1 pt-1" data-testid="default-trust-stop-per-runtime">
          {runtimes.map((entry) => {
            const { stop: resolved, overridden } = resolveConsequence(entry, selected);
            return (
              <div key={entry.runtime} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{entry.label}</p>
                  {overridden ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => onChangeRuntime(entry.runtime, null)}
                    >
                      Use the setting above
                    </Button>
                  ) : (
                    <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
                      Follows the setting above
                    </span>
                  )}
                </div>
                {/* THAT runtime's own descriptors, so the stops it cannot take
                    are absent and the caption is its own sentence. */}
                <TrustDial
                  mode={
                    resolveTrustStops(entry.descriptors).find((s) => s.stop === resolved)?.mode
                      .id ?? ''
                  }
                  descriptors={entry.descriptors}
                  strandsWorkingMode
                  strandedNote={`${entry.label} has no setting at this stop, so new sessions start where it starts them.`}
                  onChangeMode={(next) => {
                    const picked = entry.descriptors.find((d) => d.id === next);
                    if (picked) onChangeRuntime(entry.runtime, picked.stop);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
