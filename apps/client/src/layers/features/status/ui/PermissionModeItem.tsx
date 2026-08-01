import {
  Shield,
  ShieldCheck,
  ShieldOff,
  ClipboardList,
  Lock,
  Sparkles,
  Check,
  XCircle,
  Cog,
} from 'lucide-react';
import type { PermissionMode } from '@dorkos/shared/types';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { LucideIcon } from 'lucide-react';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { permissionModeLabel, warnTier } from '@/layers/shared/lib';
import { compactStatusValue } from '../lib/status-labels';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  PermissionModeScopeNote,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';

// Icons keyed by permission-mode id, and the last id-keyed table left here.
// It survives this change on purpose: the Trust Dial gives icons to the three
// STOPS rather than to individual modes, and moving them is that PR's job
// (spec `trust-dial`, decision 1). Until then an unrecognised id falls back to
// the default icon rather than crashing.
//
// Its sibling `MODE_WARN` is gone: which modes read as dangerous now comes from
// what the runtime declared they do (`warnTier`), not from a list kept here.
const MODE_ICONS: Record<string, LucideIcon> = {
  default: Shield,
  acceptEdits: ShieldCheck,
  plan: ClipboardList,
  dontAsk: Lock,
  bypassPermissions: ShieldOff,
  auto: Sparkles,
  'always-allow': Check,
  'always-deny': XCircle,
  scripted: Cog,
};

const DEFAULT_ICON: LucideIcon = Shield;

/**
 * Whether a declared mode is marked red here.
 *
 * Only the `'danger'` tier — a mode that never asks about anything, anywhere.
 * `'caution'` (never asks, but bounded, like Codex's workspace-write) gets its
 * own amber treatment beside the caption when the Trust Dial lands; giving it
 * the same red as full autonomy today would make two very different promises
 * look identical.
 *
 * A mode with no descriptor yet — capabilities still loading — is not marked,
 * matching every other item on this line: data hasn't arrived, so no claim.
 *
 * @param descriptor - The mode as its runtime declared it, if resolved.
 */
function isMarkedDangerous(descriptor: PermissionModeDescriptor | undefined): boolean {
  return descriptor !== undefined && warnTier(descriptor) === 'danger';
}

// Small inline tags shown next to a mode's label in the dropdown. Used to flag
// research-preview modes (e.g. 'auto') without crowding the descriptor copy.
const MODE_TAGS: Record<string, string> = {
  auto: 'Preview',
};

/** Copy shown in the tooltip when 'auto' is hidden because the model can't run it. */
const AUTO_UNSUPPORTED_TOOLTIP = 'Auto mode requires Opus 4.6+ or Sonnet 4.6';

interface PermissionModeItemProps {
  mode: PermissionMode;
  onChangeMode: (mode: PermissionMode) => void;
  /** When true, the selector is disabled and shows a tooltip explaining why. */
  disabled?: boolean;
  /**
   * Runtime whose capability profile drives the mode list. The render site
   * owns resolution (the session row's server-authoritative runtime once
   * started, the pending pre-launch selection before that — see
   * `useRuntimeChip`). Nullish falls back to the server-default runtime.
   * Deliberately NOT resolved here from a session id: the runtime-type
   * endpoint infers-on-miss and a forever-cached pre-launch fetch could pin
   * the wrong runtime's mode list for the session's lifetime.
   */
  runtime?: string | null;
  /**
   * Whether the active model supports the `'auto'` permission mode. When false,
   * `'auto'` is filtered out of the dropdown and an explanatory tooltip is shown.
   * `undefined` is treated as unsupported (conservative default while models load).
   */
  modelSupportsAutoMode?: boolean;
  /**
   * Say it in as few pixels as possible — set below the status line's widest
   * tier. Mode labels come from the runtime's own descriptors, so their length is
   * not DorkOS's to promise; this bounds them.
   */
  compact?: boolean;
}

/**
 * Status bar item with a dropdown to view and change the permission mode.
 *
 * The list of selectable modes comes from the resolved runtime's declared
 * capabilities (`caps.permissionModes.values`). Icons and warn tints are kept
 * local — they are runtime-agnostic presentation, not data the backend owns.
 * When `caps.permissionModes.supported === false`, the entire item is hidden.
 */
export function PermissionModeItem({
  mode,
  onChangeMode,
  disabled,
  runtime,
  modelSupportsAutoMode,
  compact,
}: PermissionModeItemProps) {
  // Static per-runtime lookup — nullish runtime (no session context, or the
  // display runtime is still resolving) falls back to the server default.
  const caps = useCapabilitiesForRuntime(runtime);

  // Hide the picker entirely when the runtime does not support permission
  // modes at all (some runtimes have no notion of a permission mode).
  if (caps && !caps.permissionModes.supported) {
    return null;
  }

  const allDescriptors: PermissionModeDescriptor[] = caps?.permissionModes.values ?? [];
  // Gate 'auto' on the active model: when the model can't run it, hide the option
  // and surface an explanatory tooltip in its place.
  const autoFiltered = !modelSupportsAutoMode && allDescriptors.some((d) => d.id === 'auto');
  const descriptors = autoFiltered ? allDescriptors.filter((d) => d.id !== 'auto') : allDescriptors;
  const currentDescriptor = descriptors.find((d) => d.id === mode);
  // No descriptor yet (capabilities still loading, or a mode the runtime does
  // not enumerate) falls back to the shared names, so the picker and the session
  // row never call the same mode two different things.
  const fullLabel = currentDescriptor?.label ?? permissionModeLabel(mode);
  const currentLabel = compact ? compactStatusValue(fullLabel) : fullLabel;
  const CurrentIcon = MODE_ICONS[mode] ?? DEFAULT_ICON;
  const currentIsDangerous = isMarkedDangerous(currentDescriptor);

  const trigger = (
    <button
      disabled={disabled}
      // The full label stays the accessible name: a bounded value is a smaller
      // drawing of the same state, never a different answer to "what mode is on?".
      aria-label={`Permissions: ${fullLabel}`}
      className={`hover:text-foreground inline-flex min-w-0 items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${currentIsDangerous ? 'text-red-500' : ''}`}
    >
      <CurrentIcon className="size-(--size-icon-xs) shrink-0" />
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
    <ResponsiveDropdownMenu>
      <ResponsiveDropdownMenuTrigger asChild>{trigger}</ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        <ResponsiveDropdownMenuLabel>Permission Mode</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup
          value={mode}
          onValueChange={(v) => onChangeMode(v as PermissionMode)}
        >
          {descriptors.map((d) => {
            const Icon = MODE_ICONS[d.id] ?? DEFAULT_ICON;
            const warn = isMarkedDangerous(d);
            const tag = MODE_TAGS[d.id];
            return (
              <ResponsiveDropdownMenuRadioItem
                key={d.id}
                value={d.id}
                icon={Icon}
                description={d.description}
                className={warn ? 'text-red-500' : ''}
              >
                <span className="inline-flex items-center gap-1.5">
                  {d.label}
                  {tag && (
                    <span className="bg-muted text-muted-foreground rounded px-1 py-px text-[10px] font-medium tracking-wide uppercase">
                      {tag}
                    </span>
                  )}
                </span>
              </ResponsiveDropdownMenuRadioItem>
            );
          })}
        </ResponsiveDropdownMenuRadioGroup>
        {/* Sits under the list, so it reads as a note about the choice just made
            rather than as part of any one option. */}
        <PermissionModeScopeNote
          mode={mode}
          descriptor={currentDescriptor}
          className="px-2 py-1.5"
        />
        {autoFiltered && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p
                data-testid="auto-unsupported-hint"
                className="text-muted-foreground flex items-center gap-1.5 px-2 py-1.5 text-[10px]"
              >
                <Sparkles className="size-(--size-icon-xs) shrink-0" />
                Auto unavailable on this model
              </p>
            </TooltipTrigger>
            <TooltipContent side="top">{AUTO_UNSUPPORTED_TOOLTIP}</TooltipContent>
          </Tooltip>
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
