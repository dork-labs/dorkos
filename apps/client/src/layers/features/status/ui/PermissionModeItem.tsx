import { Shield, ShieldCheck, ShieldOff, ClipboardList } from 'lucide-react';
import type { PermissionMode } from '@dorkos/shared/types';
import type { LucideIcon } from 'lucide-react';
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

const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  icon: LucideIcon;
  description: string;
}[] = [
  { value: 'default', label: 'Default', icon: Shield, description: 'Prompt for each tool call' },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    icon: ShieldCheck,
    description: 'Auto-approve file edits',
  },
  {
    value: 'plan',
    label: 'Plan Mode',
    icon: ClipboardList,
    description: 'Research only, no edits',
  },
  {
    value: 'bypassPermissions',
    label: 'Bypass All',
    icon: ShieldOff,
    description: 'Auto-approve everything',
  },
];

interface PermissionModeItemProps {
  mode: PermissionMode;
  onChangeMode: (mode: PermissionMode) => void;
  /** When true, the selector is disabled and shows a tooltip explaining why. */
  disabled?: boolean;
}

/** Status bar item with a dropdown to view and change the permission mode. */
export function PermissionModeItem({ mode, onChangeMode, disabled }: PermissionModeItemProps) {
  const current = PERMISSION_MODES.find((m) => m.value === mode) ?? PERMISSION_MODES[0];
  const Icon = current.icon;
  const isDangerous = mode === 'bypassPermissions';

  const trigger = (
    <button
      disabled={disabled}
      className={`hover:text-foreground inline-flex items-center gap-1 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${isDangerous ? 'text-red-500' : ''}`}
    >
      <Icon className="size-(--size-icon-xs)" />
      <span>{current.label}</span>
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
      <ResponsiveDropdownMenuTrigger asChild>
        {trigger}
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent side="top" align="start" className="w-56">
        <ResponsiveDropdownMenuLabel>Permission Mode</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup
          value={mode}
          onValueChange={(v) => onChangeMode(v as PermissionMode)}
        >
          {PERMISSION_MODES.map((m) => {
            const isWarn = m.value === 'bypassPermissions';
            return (
              <ResponsiveDropdownMenuRadioItem
                key={m.value}
                value={m.value}
                icon={m.icon}
                description={m.description}
                className={isWarn ? 'text-red-500' : ''}
              >
                {m.label}
              </ResponsiveDropdownMenuRadioItem>
            );
          })}
        </ResponsiveDropdownMenuRadioGroup>
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}
