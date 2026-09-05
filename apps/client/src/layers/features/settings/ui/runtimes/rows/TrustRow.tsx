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
import { resolveTrustStops } from '@/layers/shared/lib';
import { Button, TrustDial } from '@/layers/shared/ui';
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
  const mode = resolveTrustStops(descriptors).find((s) => s.stop === resolved)?.mode.id ?? '';

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
    </section>
  );
}
