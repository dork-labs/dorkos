import { Sparkles } from 'lucide-react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useAppStore } from '@/layers/shared/model';
import { permissionModeLabel, resolveTrustStops } from '@/layers/shared/lib';
import { compactStatusValue } from '../lib/status-labels';
import { MakeDefaultStopLine, type MakeDefaultStopLineProps } from './MakeDefaultStopLine';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  PermissionModeScopeNote,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TrustDial,
  TrustModeIcon,
  trustToneAccent,
} from '@/layers/shared/ui';

/** Copy shown in the tooltip when a refinement is hidden because the model can't run it. */
const AUTO_UNSUPPORTED_TOOLTIP = 'Auto mode requires Opus 4.6+ or Sonnet 4.6';

interface PermissionModeItemProps {
  /**
   * The session's current mode id — any id the runtime declares (DOR-811),
   * wider than the shared `PermissionMode` enum's known names. Matches
   * `TrustDial.mode`, which this component renders it through unchanged.
   */
  mode: string;
  /** Matches `TrustDial.onChangeMode` — see {@link mode} (DOR-820). */
  onChangeMode: (mode: string) => void;
  /** When true, the selector is disabled and shows a tooltip explaining why. */
  disabled?: boolean;
  /**
   * Runtime whose capability profile drives the dial. The render site owns
   * resolution (the session row's server-authoritative runtime once started, the
   * pending pre-launch selection before that — see `useRuntimeChip`). Nullish
   * falls back to the server-default runtime. Deliberately NOT resolved here
   * from a session id: the runtime-type endpoint infers-on-miss and a
   * forever-cached pre-launch fetch could pin the wrong runtime's modes for the
   * session's lifetime.
   */
  runtime?: string | null;
  /**
   * Whether the active model supports the `'auto'` permission mode. When false,
   * `'auto'` is filtered out and an explanatory line takes its place inside the
   * middle stop. `undefined` is treated as unsupported (conservative default
   * while models load).
   */
  modelSupportsAutoMode?: boolean;
  /**
   * True while a way of working (Plan) holds the session. The dial still shows
   * what is happening, but its stops cannot move until Plan is switched off.
   */
  planActive?: boolean;
  /**
   * Say it in as few pixels as possible — set below the status line's widest
   * tier. Mode labels come from the runtime's own descriptors, so their length is
   * not DorkOS's to promise; this bounds them.
   */
  compact?: boolean;
  /**
   * The offer to make the stop just chosen the default for every new session
   * (spec `trust-dial`, decision 6C), or `null` on a surface that has no config
   * to write.
   *
   * Passed in whole rather than derived here: whether an offer is warranted
   * depends on what the effective default already is, and on an answer this
   * session gave earlier — neither of which a picker should be reading.
   */
  makeDefault?: MakeDefaultStopLineProps | null;
  /**
   * Told whenever the picker opens or closes.
   *
   * The caller needs it because the offer above has TWO homes and only one may
   * speak at a time: inside this popover while it is open, and floating over the
   * status strip once it is not. Entering Full autonomy opens a modal dialog
   * whose focus grab closes this popover (observed in a browser, 2026-08-01), so
   * the offer that follows would otherwise be drawn into an unmounted tree.
   */
  onOpenChange?: (open: boolean) => void;
}

/**
 * How much this agent may do without asking — the word in the status line, and
 * the Trust Dial behind it.
 *
 * The line's job is the temperature: the current mode's stop icon, the runtime's
 * own word for it, green when the session is at full power (spec `trust-dial`,
 * decision 3A — the app-wide banner that used to shout the same fact is gone, so
 * this is the signal). The other stops keep the line's own colour and say what
 * they are with the stop icon's padlock; red is not spent here at all, so it
 * still means something where the product does spend it. Everything about
 * *changing* it is in {@link TrustDial}, one popover away.
 *
 * While a way of working (Plan) holds the session, this item has no trust stop
 * to report — see the caller (`status-item-nodes.tsx`), which omits it from the
 * line entirely rather than have it repeat the composer's dedicated Plan switch
 * (DOR-1236, spec `trust-dial` decision 1). This component stays simple: it
 * shows whatever mode it is given, in the runtime's own words.
 *
 * When `caps.permissionModes.supported === false`, the whole item is hidden.
 */
export function PermissionModeItem({
  mode,
  onChangeMode,
  disabled,
  runtime,
  modelSupportsAutoMode,
  planActive,
  compact,
  makeDefault,
  onOpenChange,
}: PermissionModeItemProps) {
  // Static per-runtime lookup — nullish runtime (no session context, or the
  // display runtime is still resolving) falls back to the server default.
  const caps = useCapabilitiesForRuntime(runtime);
  // The ask stop's quiet unlock affordance points here: the Control Center is
  // where a person opens up power for new sessions (spec `full-power-defaults`
  // §6). Read unconditionally, before the early returns below.
  const setControlCenterOpen = useAppStore((s) => s.setControlCenterOpen);

  // Hide the item entirely when the runtime does not support permission modes at
  // all (some runtimes have no notion of one).
  if (caps && !caps.permissionModes.supported) {
    return null;
  }

  const allDescriptors: PermissionModeDescriptor[] = caps?.permissionModes.values ?? [];
  // Gate 'auto' on the active model: when the model can't run it, the dial never
  // sees it, so it can offer neither the refinement nor a stop built on it.
  const autoFiltered = !modelSupportsAutoMode && allDescriptors.some((d) => d.id === 'auto');
  const descriptors = autoFiltered ? allDescriptors.filter((d) => d.id !== 'auto') : allDescriptors;
  const currentDescriptor = descriptors.find((d) => d.id === mode);
  // No descriptor (capabilities still loading, or a mode the runtime does not
  // enumerate) falls back to the shared names, so the line and the session row
  // never call the same mode two different things.
  const fullLabel = currentDescriptor?.label ?? permissionModeLabel(mode);
  const currentLabel = compact ? compactStatusValue(fullLabel) : fullLabel;
  // Green when the session is at full power, and nothing otherwise: the word
  // keeps the line's own colour at every other stop, and the padlock on the
  // stop icon is what marks the limited ones. Divergence is deliberately silent
  // here — see `trustToneAccent`.
  const toneAccent = trustToneAccent(currentDescriptor);
  // The hidden refinement is only worth mentioning where it would have been —
  // beside the stop that holds it.
  // `mode === 'auto'` matters as much as the stop: a session ALREADY in auto on a
  // model that cannot run it has no selected stop at all, and that is exactly the
  // person who needs the reason — the dial says the mode is not one of the stops,
  // and this says why it went away.
  const selectedStop = resolveTrustStops(descriptors).find((s) => s.mode.id === mode)?.stop;
  const showAutoHint = autoFiltered && (selectedStop === 'act' || mode === 'auto');

  const trigger = (
    <button
      disabled={disabled}
      // The full label stays the accessible name: a bounded value is a smaller
      // drawing of the same state, never a different answer to "what mode is on?".
      aria-label={`Permissions: ${fullLabel}`}
      className={`hover:text-foreground inline-flex min-w-0 items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${toneAccent}`}
    >
      <TrustModeIcon descriptor={currentDescriptor} className="size-(--size-icon-xs) shrink-0" />
      <span className="truncate">{currentLabel}</span>
    </button>
  );

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{trigger}</span>
        </TooltipTrigger>
        <TooltipContent side="top">Send a message first</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ResponsivePopover onOpenChange={onOpenChange}>
      <ResponsivePopoverTrigger asChild>{trigger}</ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side="top"
        align="start"
        className="w-80 p-3"
        aria-label="Permissions"
      >
        <ResponsivePopoverTitle>Permissions</ResponsivePopoverTitle>
        <TrustDial
          mode={mode}
          descriptors={descriptors}
          onChangeMode={onChangeMode}
          planActive={planActive}
          onUnlock={() => setControlCenterOpen(true)}
        />
        {/* Directly under the dial, in a row that is always there: the offer
            arrives while a person is still pointing at the control, so it must
            not move what they are pointing at. The caller withholds this one
            while the popover is shut — see `onOpenChange`. */}
        {makeDefault && <MakeDefaultStopLine {...makeDefault} />}
        {showAutoHint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                data-testid="auto-unsupported-hint"
                className="text-muted-foreground mt-2 flex items-center gap-1.5 px-1 text-3xs"
              >
                <Sparkles className="size-(--size-icon-xs) shrink-0" />
                Auto unavailable on this model
              </p>
            </TooltipTrigger>
            <TooltipContent side="top">{AUTO_UNSUPPORTED_TOOLTIP}</TooltipContent>
          </Tooltip>
        )}
        {/* Sits under the dial, so it reads as a note about the choice just made
            rather than as part of any one stop. */}
        <PermissionModeScopeNote mode={mode} descriptor={currentDescriptor} className="mt-2 px-1" />
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
