import { Shield } from 'lucide-react';
import {
  Badge,
  Switch,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  CollapsibleFieldCard,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui';
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';
import type { PermissionMode } from '@dorkos/shared/schemas';

/** Options for the session strategy selector with human-readable descriptions. */
const SESSION_STRATEGIES: { value: SessionStrategy; label: string; description: string }[] = [
  {
    value: 'per-chat',
    label: 'Per Chat',
    description:
      'One session per chat/conversation. Messages from the same chat resume the same session.',
  },
  {
    value: 'per-user',
    label: 'Per User',
    description: 'One session per user. All messages from a user share a session across chats.',
  },
  {
    value: 'stateless',
    label: 'Stateless',
    description: 'Every message starts a new session. No conversation history.',
  },
];

/** Human-readable labels and descriptions for each permission mode. */
const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Agent asks for approval before using any tools',
  },
  {
    value: 'plan',
    label: 'Plan Only',
    description: 'Agent can read files but asks before making changes',
  },
  {
    value: 'acceptEdits',
    label: 'Accept Edits',
    description: 'Agent can read and write files; asks before running shell commands',
  },
  {
    value: 'bypassPermissions',
    label: 'Full Access',
    description: 'Agent can use all tools without asking for approval',
  },
];

export interface BindingAdvancedSectionProps {
  strategy: SessionStrategy;
  onStrategyChange: (value: SessionStrategy) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (value: string) => void;
  bypassWarningOpen: boolean;
  onBypassWarningOpenChange: (open: boolean) => void;
  onBypassConfirm: () => void;
  canInitiate: boolean;
  onCanInitiateChange: (value: boolean) => void;
  canReply: boolean;
  onCanReplyChange: (value: boolean) => void;
  canReceive: boolean;
  onCanReceiveChange: (value: boolean) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasChanges: boolean;
}

/**
 * Collapsible "Advanced" section for the binding dialog.
 *
 * Renders the session strategy selector, permission mode selector,
 * bypass-permissions security warning dialog, and per-direction permission toggles
 * (canInitiate, canReply, canReceive).
 */
export function BindingAdvancedSection({
  strategy,
  onStrategyChange,
  permissionMode,
  onPermissionModeChange,
  bypassWarningOpen,
  onBypassWarningOpenChange,
  onBypassConfirm,
  canInitiate,
  onCanInitiateChange,
  canReply,
  onCanReplyChange,
  canReceive,
  onCanReceiveChange,
  open,
  onOpenChange,
  hasChanges,
}: BindingAdvancedSectionProps) {
  const selectedStrategy = SESSION_STRATEGIES.find((s) => s.value === strategy);
  const selectedPermissionMode = PERMISSION_MODES.find((m) => m.value === permissionMode);

  return (
    <>
      <CollapsibleFieldCard
        open={open}
        onOpenChange={onOpenChange}
        trigger="Advanced"
        badge={
          hasChanges ? (
            <Badge variant="secondary" className="text-xs">
              Modified
            </Badge>
          ) : undefined
        }
      >
        {/* Session strategy selector */}
        <div className="space-y-1.5 px-4 py-3">
          <Label htmlFor="binding-session-strategy">Session Strategy</Label>
          <Select value={strategy} onValueChange={(v) => onStrategyChange(v as SessionStrategy)}>
            <SelectTrigger id="binding-session-strategy" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedStrategy && (
            <p className="text-muted-foreground text-xs">{selectedStrategy.description}</p>
          )}
        </div>

        {/* Permission mode selector */}
        <div className="space-y-1.5 px-4 py-3">
          <Label htmlFor="binding-permission-mode">Permission Mode</Label>
          <Select value={permissionMode} onValueChange={onPermissionModeChange}>
            <SelectTrigger id="binding-permission-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERMISSION_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedPermissionMode && (
            <p className="text-muted-foreground text-xs">{selectedPermissionMode.description}</p>
          )}
        </div>

        {/* Message direction toggles */}
        <div className="space-y-2.5 px-4 py-3">
          <p className="text-muted-foreground text-xs font-medium">Message Direction</p>
          <div className="flex cursor-pointer items-center justify-between gap-3">
            <Label
              htmlFor="perm-initiate"
              className="flex cursor-pointer items-center gap-1.5 text-xs font-normal"
            >
              <Shield className="text-muted-foreground size-3" />
              Agent can initiate messages
            </Label>
            <Switch
              id="perm-initiate"
              checked={canInitiate}
              onCheckedChange={onCanInitiateChange}
              aria-label="Agent can initiate messages"
            />
          </div>
          <div className="flex cursor-pointer items-center justify-between gap-3">
            <Label htmlFor="perm-reply" className="cursor-pointer text-xs font-normal">
              Agent can reply to messages
            </Label>
            <Switch
              id="perm-reply"
              checked={canReply}
              onCheckedChange={onCanReplyChange}
              aria-label="Agent can reply to messages"
            />
          </div>
          <div className="flex cursor-pointer items-center justify-between gap-3">
            <Label htmlFor="perm-receive" className="cursor-pointer text-xs font-normal">
              Agent receives inbound messages
            </Label>
            <Switch
              id="perm-receive"
              checked={canReceive}
              onCheckedChange={onCanReceiveChange}
              aria-label="Agent receives inbound messages"
            />
          </div>
        </div>
      </CollapsibleFieldCard>

      {/* bypassPermissions security warning */}
      <AlertDialog open={bypassWarningOpen} onOpenChange={onBypassWarningOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Full Access?</AlertDialogTitle>
            <AlertDialogDescription>
              Any user who can send messages through this adapter (e.g., members of your Slack
              workspace) will be able to trigger unrestricted agent actions, including file system
              access and command execution.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onBypassConfirm}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Enable Full Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
