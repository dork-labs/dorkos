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
import { useActiveCapabilities, useDefaultCapabilities } from '@/layers/entities/runtime';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';

// Presentation metadata keyed by permission-mode id. Icons and warn flags are
// runtime-agnostic UX signals (e.g. "bypass-ish" modes get a red tint). If a
// runtime surfaces a mode id we don't recognise, we fall back to the default
// icon and warn=false rather than crashing.
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

const MODE_WARN: Record<string, boolean> = {
  bypassPermissions: true,
  auto: true,
  'always-allow': true,
};

const DEFAULT_ICON: LucideIcon = Shield;

// Built-in fallback labels for Claude's native modes — used only when we have
// no descriptor for the currently-selected mode id (e.g. the trigger needs to
// render a label while the dropdown's mode list comes from capabilities).
const FALLBACK_LABELS: Record<string, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass All',
  auto: 'Auto',
};

interface PermissionModeItemProps {
  mode: PermissionMode;
  onChangeMode: (mode: PermissionMode) => void;
  /** When true, the selector is disabled and shows a tooltip explaining why. */
  disabled?: boolean;
  /**
   * Session whose runtime capabilities drive the mode list. Pass the active
   * session's id in per-session UI; omit only on surfaces with no session
   * context (in which case we fall back to the server-default runtime).
   */
  sessionId?: string;
}

/**
 * Status bar item with a dropdown to view and change the permission mode.
 *
 * The list of selectable modes comes from the active session's runtime
 * capabilities (`caps.permissionModes.values`). Icons and warn tints are kept
 * local — they are runtime-agnostic presentation, not data the backend owns.
 * When `caps.permissionModes.supported === false`, the entire item is hidden.
 */
export function PermissionModeItem({
  mode,
  onChangeMode,
  disabled,
  sessionId,
}: PermissionModeItemProps) {
  // When a sessionId is provided we track that session's runtime; otherwise
  // fall back to the server default. Both hooks are safe to call — the one
  // that isn't "chosen" by sessionId simply won't fire a network request
  // (useActiveCapabilities short-circuits on undefined sessionId).
  const activeCaps = useActiveCapabilities(sessionId);
  const defaultCaps = useDefaultCapabilities();
  const caps = sessionId ? activeCaps : defaultCaps;

  // Hide the picker entirely when the runtime does not support permission
  // modes at all (some runtimes have no notion of a permission mode).
  if (caps && !caps.permissionModes.supported) {
    return null;
  }

  const descriptors: PermissionModeDescriptor[] = caps?.permissionModes.values ?? [];
  const currentDescriptor = descriptors.find((d) => d.id === mode);
  const currentLabel = currentDescriptor?.label ?? FALLBACK_LABELS[mode] ?? mode;
  const CurrentIcon = MODE_ICONS[mode] ?? DEFAULT_ICON;
  const currentIsDangerous = MODE_WARN[mode] ?? false;

  const trigger = (
    <button
      disabled={disabled}
      className={`hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${currentIsDangerous ? 'text-red-500' : ''}`}
    >
      <CurrentIcon className="size-(--size-icon-xs)" />
      <span>{currentLabel}</span>
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
            const warn = MODE_WARN[d.id] ?? false;
            return (
              <ResponsiveDropdownMenuRadioItem
                key={d.id}
                value={d.id}
                icon={Icon}
                description={d.description}
                className={warn ? 'text-red-500' : ''}
              >
                {d.label}
              </ResponsiveDropdownMenuRadioItem>
            );
          })}
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
