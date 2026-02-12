import { Shield, ShieldCheck, ShieldOff, ClipboardList } from 'lucide-react';
import type { PermissionMode } from '@lifeos/shared/types';
import type { LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../ui/dropdown-menu';

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
}

export function PermissionModeItem({ mode, onChangeMode }: PermissionModeItemProps) {
  const current = PERMISSION_MODES.find((m) => m.value === mode) ?? PERMISSION_MODES[0];
  const Icon = current.icon;
  const isDangerous = mode === 'bypassPermissions';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`inline-flex items-center gap-1 hover:text-foreground transition-colors duration-150 ${isDangerous ? 'text-red-500' : ''}`}
        >
          <Icon className="size-[--size-icon-xs]" />
          <span>{current.label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel>Permission Mode</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={mode} onValueChange={(v) => onChangeMode(v as PermissionMode)}>
          {PERMISSION_MODES.map((m) => {
            const MIcon = m.icon;
            const isWarn = m.value === 'bypassPermissions';
            return (
              <DropdownMenuRadioItem
                key={m.value}
                value={m.value}
                className={isWarn ? 'text-red-500' : ''}
              >
                <div className="flex items-center gap-2">
                  <MIcon className="size-[--size-icon-xs] shrink-0" />
                  <div className="text-left">
                    <div>{m.label}</div>
                    <div className="text-[10px] text-muted-foreground">{m.description}</div>
                  </div>
                </div>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
