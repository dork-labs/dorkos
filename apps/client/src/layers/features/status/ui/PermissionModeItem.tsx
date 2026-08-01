import { Sparkles } from 'lucide-react';
import type { PermissionMode } from '@dorkos/shared/types';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { permissionModeLabel, resolveTrustStops, warnTier } from '@/layers/shared/lib';
import { compactStatusValue } from '../lib/status-labels';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  PermissionModeScopeNote,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
import { TrustDial, TrustModeIcon } from './TrustDial';

/** Copy shown in the tooltip when a refinement is hidden because the model can't run it. */
const AUTO_UNSUPPORTED_TOOLTIP = 'Auto mode requires Opus 4.6+ or Sonnet 4.6';

/**
 * Whether a declared mode is marked red here.
 *
 * Only the `'danger'` tier — a mode that never asks about anything, anywhere.
 * `'caution'` (never asks, but bounded, like Codex's workspace-write) gets the
 * caption's amber inside the dial instead; giving it the same red as full
 * autonomy would make two very different promises look identical.
 *
 * A mode with no descriptor yet — capabilities still loading, or a mode this
 * runtime no longer declares — is not marked, matching every other item on this
 * line: data hasn't arrived, so no claim.
 *
 * @param descriptor - The mode as its runtime declared it, if resolved.
 */
function isMarkedDangerous(descriptor: PermissionModeDescriptor | undefined): boolean {
  return descriptor !== undefined && warnTier(descriptor) === 'danger';
}

interface PermissionModeItemProps {
  mode: PermissionMode;
  onChangeMode: (mode: PermissionMode) => void;
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
}

/**
 * How much this agent may do without asking — the word in the status line, and
 * the Trust Dial behind it.
 *
 * The line's job is the temperature: the current mode's stop icon, the runtime's
 * own word for it, red only when the mode never asks about anything, anywhere
 * (spec `trust-dial`, decision 3A — the app-wide banner that used to shout the
 * same fact is gone, so this is the signal). Everything about *changing* it is
 * in {@link TrustDial}, one popover away.
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
}: PermissionModeItemProps) {
  // Static per-runtime lookup — nullish runtime (no session context, or the
  // display runtime is still resolving) falls back to the server default.
  const caps = useCapabilitiesForRuntime(runtime);

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
  const currentIsDangerous = isMarkedDangerous(currentDescriptor);
  // The hidden refinement is only worth mentioning where it would have been —
  // beside the stop that holds it.
  const selectedStop = resolveTrustStops(descriptors).find((s) => s.mode.id === mode)?.stop;
  const showAutoHint = autoFiltered && selectedStop === 'act';

  const trigger = (
    <button
      disabled={disabled}
      // The full label stays the accessible name: a bounded value is a smaller
      // drawing of the same state, never a different answer to "what mode is on?".
      aria-label={`Permissions: ${fullLabel}`}
      className={`hover:text-foreground inline-flex min-w-0 items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${currentIsDangerous ? 'text-red-500' : ''}`}
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
    <ResponsivePopover>
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
          onChangeMode={(next) => onChangeMode(next as PermissionMode)}
          planActive={planActive}
        />
        {showAutoHint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                data-testid="auto-unsupported-hint"
                className="text-muted-foreground mt-2 flex items-center gap-1.5 px-1 text-[10px]"
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
