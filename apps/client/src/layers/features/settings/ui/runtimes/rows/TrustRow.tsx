/**
 * The trust row of a runtime card — where THIS runtime stops for you, and the
 * way back to the one shared setting.
 *
 * Presentational on purpose (design decision 7): stops in, a change out, no
 * query and no config write anywhere in it. The consent choreography around
 * Full autonomy is genuinely about the server, so it stays with the container
 * that owns the write.
 *
 * @module features/settings/ui/runtimes/rows/TrustRow
 */
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { needsConsentRitual, resolveTrustStops } from '@/layers/shared/lib';
import { Button, PermissionModeScopeNote, TrustDial } from '@/layers/shared/ui';
import { SETTINGS_STOP_LABELS } from '../stop-labels';

/** What the trust row needs to be told, and the one thing it says back. */
export interface TrustRowProps {
  /** Runtime type id, e.g. `'claude-code'`. Scopes the row's test ids per card. */
  runtimeType: string;
  /** What a person calls the runtime. */
  runtimeLabel: string;
  /** Every mode this runtime declares, in its declared order. */
  descriptors: readonly PermissionModeDescriptor[];
  /**
   * This runtime's override, or `null` when it follows the global choice. Null
   * is a real state with its own affordance, never a silent copy of the global
   * value: a row reading "Act" because the global says Act, with no way to tell
   * that from an override that happens to match, is a setting nobody can reason
   * about.
   */
  stop: PermissionStop | null;
  /** The stop the global row is set to — what `null` above resolves through. */
  globalStop: PermissionStop;
  /** Set or clear this runtime's override. `null` returns it to the global choice. */
  onChange: (stop: PermissionStop | null) => void;
  /**
   * Freeze the dial and the way back to the shared setting. For the window where
   * the runtime has not said where its settings live, which is the same window
   * in which `useTrustStopWrites` has no section to write this stop into.
   */
  disabled?: boolean;
}

/**
 * Where this runtime stops for you.
 *
 * The dial is rendered from THAT runtime's own declared modes, so the stops it
 * cannot take are absent and the caption beneath it is the runtime's own
 * sentence rather than copy written in Settings.
 *
 * `strandsWorkingMode` is passed because a settings form has no Plan switch: a
 * stored way of working would otherwise freeze a control nobody on this screen
 * can unfreeze (DOR-496).
 *
 * @param props - The runtime's modes, its override, the global stop, and the
 *   change handler.
 */
export function TrustRow({
  runtimeType,
  runtimeLabel,
  descriptors,
  stop,
  globalStop,
  onChange,
  disabled,
}: TrustRowProps) {
  const overridden = stop !== null;
  const resolved = stop ?? globalStop;
  // The descriptor, not just its id: the scope note below decides from what the
  // mode DOES (`needsConsentRitual`), which is the only way a runtime that files
  // a never-asking mode at the MIDDLE stop still gets the note (Codex).
  const resolvedMode = resolveTrustStops(descriptors).find((s) => s.stop === resolved)?.mode;
  const mode = resolvedMode?.id ?? '';
  // Whether the row beneath the cards is already saying this, for THIS stop.
  //
  // It is not "am I inheriting?", and getting that wrong is what the re-review
  // caught. The shared row renders from the CANONICAL descriptor for a stop and
  // this row renders from the RUNTIME's, and the two disagree exactly where the
  // sentence matters most: canonical `act` asks when risky, so the row below
  // stays quiet there, while Codex's `acceptEdits` at the same stop never asks
  // at all. Suppressing on "inheriting" alone therefore silenced both of them
  // on the DOR-816 case, leaving "Codex cannot stop to ask you first." with
  // nothing underneath.
  //
  // The canonical stops only ever earn the sentence at `autonomy`, so that is
  // the one stop the row below can be relied on to cover — and only when it is
  // the stop this card is actually showing, which is either inheritance or an
  // override that agrees with the shared setting. Anything else, the card says
  // it itself. Counted end to end in `__tests__/scope-note-placement.test.tsx`.
  const sharedRowSaysIt = resolved === 'autonomy' && (stop === null || stop === globalStop);
  const saysScope =
    resolvedMode !== undefined && needsConsentRitual(resolvedMode) && !sharedRowSaysIt;

  return (
    <section className="flex flex-col gap-1.5" data-testid={`runtime-trust-${runtimeType}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Where it stops for you</p>
        {overridden ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            Use the setting above
          </Button>
        ) : (
          <span
            className="text-muted-foreground text-3xs tracking-wide uppercase"
            data-testid={`runtime-trust-global-${runtimeType}`}
          >
            Global setting
          </span>
        )}
      </div>

      {/* A runtime that has not answered yet gets the same one-liner the binding
          and task dials give it, rather than a label over nothing. */}
      {descriptors.length === 0 ? (
        <p
          data-testid={`runtime-trust-unavailable-${runtimeType}`}
          className="text-muted-foreground px-1 text-xs leading-relaxed"
        >
          {runtimeLabel} hasn’t said what it can do, so there is nothing to choose from yet. New
          sessions start where it starts them.
        </p>
      ) : (
        <TrustDial
          mode={mode}
          descriptors={descriptors}
          // The tab's one vocabulary, so this dial and the global row beneath the
          // cards word the same three stops the same way (design §3).
          stopLabels={SETTINGS_STOP_LABELS}
          disabled={disabled === true}
          strandsWorkingMode
          strandedNote={`${runtimeLabel} has no setting at this stop, so new sessions start where it starts them.`}
          onChangeMode={(next) => {
            const picked = descriptors.find((d) => d.id === next);
            if (picked) onChange(picked.stop);
          }}
        />
      )}

      {/* What this stop does NOT buy, on the card that sets it (DOR-2102).
          Settings was the last picker without it, and it is the one that matters
          most: a person with a standing acknowledgement never sees the consent
          dialog that used to be the only place this sentence appeared, so
          choosing Full autonomy here said nothing about DorkOS's own cards at
          all.

          Drawn unless the row beneath the cards is demonstrably already saying
          it for this stop — see `sharedRowSaysIt` above for why that is a
          narrower question than "is this card inheriting?". Getting it wrong in
          either direction is a real defect: too eager prints the same paragraph
          once per runtime on the shipped full-power default, too shy drops it
          from the one case it was widened to cover. */}
      {saysScope && (
        <PermissionModeScopeNote mode={mode} descriptor={resolvedMode} className="px-1" />
      )}
    </section>
  );
}
