import { useState } from 'react';
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
  PermissionModeScopeNote,
  TrustDial,
  UnattendedAutonomyDialog,
} from '@/layers/shared/ui';
import { needsConsentRitual, permissionModeLabel } from '@/layers/shared/lib';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import type { SessionStrategy } from '@dorkos/shared/relay-schemas';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
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

/**
 * The runtime a binding's turns actually run on.
 *
 * **This is an assumption, and it is narrow on purpose.** A relay binding names
 * an agent, not a runtime, and nothing in the binding record carries one. What
 * decides is the relay: an inbound message is handled by the Claude Code adapter
 * (`packages/relay/src/adapters/claude-code/agent-handler.ts`), which passes the
 * binding's `permissionMode` straight to that runtime. So the honest profile to
 * render a binding's dial from is Claude Code's, whatever the server's default
 * runtime happens to be.
 *
 * **Where this breaks:** the day the relay grows a second runtime adapter, or
 * routes a binding by the agent's own runtime. At that point the dial here would
 * show Claude Code's stops for a turn Codex is about to run — which is exactly
 * the per-runtime dishonesty this screen was fixed to end. The fix then is to
 * resolve the runtime from the binding (or its agent) and pass it in, not to
 * widen this constant.
 */
export const BINDING_RUNTIME = 'claude-code';

export interface BindingAdvancedSectionProps {
  strategy: SessionStrategy;
  onStrategyChange: (value: SessionStrategy) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (value: string) => void;
  canInitiate: boolean;
  onCanInitiateChange: (value: boolean) => void;
  canReply: boolean;
  onCanReplyChange: (value: boolean) => void;
  canReceive: boolean;
  onCanReceiveChange: (value: boolean) => void;
  notifyOnTaskComplete: boolean;
  onNotifyOnTaskCompleteChange: (value: boolean) => void;
  /**
   * When true, no chat session exists yet for this integration — show the
   * one-time "message your bot once" activation hint (bots can't text first).
   */
  notifyBootstrapHint?: boolean;
  /**
   * When this binding is bridged to a channel, its history lives in the room,
   * not in a per-chat session — so the session-strategy selector is hidden and
   * a one-line explanation takes its place (chats-as-channels spec §7.2).
   */
  bridged?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasChanges: boolean;
}

/**
 * Collapsible "Advanced" section for the binding dialog.
 *
 * Renders the session strategy selector, the Trust Dial, and the per-direction
 * message toggles (canInitiate, canReply, canReceive).
 *
 * ## Why the mode list here is gone
 *
 * This screen used to answer "how much may this agent do?" from four hand-written
 * entries. Two of them were false on Codex ("asks before running shell commands"
 * describes a runtime that can pause mid-turn; Codex cannot), and one — Plan —
 * was not a level of trust at all but a way of working, offered to runtimes that
 * have no such mode. It now renders {@link TrustDial}, which derives every word
 * on screen from what the runtime declared (spec `trust-dial`).
 *
 * The choice is owned here rather than by the dialog around it, because the two
 * things guarding it — which runtime's profile the dial is built from, and the
 * confirmation the autonomy stop needs — are both facts about the permission
 * mode and nothing else.
 */
export function BindingAdvancedSection({
  strategy,
  onStrategyChange,
  permissionMode,
  onPermissionModeChange,
  canInitiate,
  onCanInitiateChange,
  canReply,
  onCanReplyChange,
  canReceive,
  onCanReceiveChange,
  notifyOnTaskComplete,
  onNotifyOnTaskCompleteChange,
  notifyBootstrapHint,
  bridged,
  open,
  onOpenChange,
  hasChanges,
}: BindingAdvancedSectionProps) {
  const selectedStrategy = SESSION_STRATEGIES.find((s) => s.value === strategy);
  const caps = useCapabilitiesForRuntime(BINDING_RUNTIME);
  const descriptors = caps?.permissionModes.values ?? [];
  const currentDescriptor = descriptors.find((d) => d.id === permissionMode);
  // The runtime's own word for the mode wherever it declared one; the client's
  // id table only where it did not.
  const modeLabel = currentDescriptor?.label ?? permissionModeLabel(permissionMode);
  const [pendingAutonomy, setPendingAutonomy] = useState<PermissionModeDescriptor | null>(null);

  /**
   * Apply a stop, asking first at any stop that stops the asking.
   *
   * The rule is `needsConsentRitual` — the same one the server's door applies —
   * rather than a stop comparison, so a runtime that files a mode that never
   * asks at the MIDDLE stop is caught here too (DOR-816). That matters more on
   * this screen than on a session's: an integration nobody is watching sets the
   * agent off, and there is no one to notice it did not ask.
   *
   * Unlike a session's dial, this is not remembered: there is no session to
   * remember it for, and a binding is configured rarely enough that a second
   * question costs nothing.
   */
  function handleChangeMode(next: string) {
    const descriptor = descriptors.find((d) => d.id === next);
    if (descriptor && needsConsentRitual(descriptor)) {
      setPendingAutonomy(descriptor);
      return;
    }
    onPermissionModeChange(next);
  }

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
        {/* Session strategy selector — replaced by a note once bridged (§7.2) */}
        {bridged ? (
          <div className="space-y-1.5 px-4 py-3">
            <Label>Session Strategy</Label>
            <p className="text-muted-foreground text-xs">
              A bridged chat keeps its history in the channel, so it does not use a session
              strategy.
            </p>
          </div>
        ) : (
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
        )}

        {/* How much this agent may do without asking — the Trust Dial */}
        <div className="space-y-2 px-4 py-3">
          <p className="text-muted-foreground text-xs font-medium">Permissions</p>
          {descriptors.length === 0 ? (
            // No profile in hand — one round trip on a cold open, and forever
            // under a test-mode boot, where `claude-code` is never registered.
            // A heading over an empty caption and a note about a control that is
            // not there says nothing; this says what the binding is set to and
            // why it cannot be changed yet.
            <p
              data-testid="trust-dial-unavailable"
              className="text-muted-foreground px-1 text-xs leading-relaxed"
            >
              This integration is set to “{modeLabel}”. The agent behind it hasn’t said what it can
              do, so there is nothing to choose from yet — saving keeps it as it is.
            </p>
          ) : (
            <>
              <TrustDial
                mode={permissionMode}
                descriptors={descriptors}
                onChangeMode={handleChangeMode}
                // A binding has no Plan switch. One saved at `plan` is kept and
                // named, not frozen behind a control this screen does not have.
                strandsWorkingMode
                strandedNote={
                  <>
                    This integration is set to “{modeLabel}”, which is not one of these. Saving
                    keeps it as it is — pick a stop to change it.
                  </>
                }
              />
              <PermissionModeScopeNote
                mode={permissionMode}
                {...(currentDescriptor ? { descriptor: currentDescriptor } : {})}
                className="px-1"
              />
            </>
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

        {/* Task-completion notifications (DOR-240) */}
        <div className="space-y-2.5 px-4 py-3">
          <p className="text-muted-foreground text-xs font-medium">Notifications</p>
          <div className="flex cursor-pointer items-center justify-between gap-3">
            <Label htmlFor="notify-task-complete" className="cursor-pointer text-xs font-normal">
              Message me when tasks finish
            </Label>
            <Switch
              id="notify-task-complete"
              checked={notifyOnTaskComplete}
              onCheckedChange={onNotifyOnTaskCompleteChange}
              aria-label="Message me when tasks finish"
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Get a message here when a scheduled task on this agent finishes. Failures always come
            through; turn this off to skip the ones that succeed. Requires “Agent can initiate
            messages”.
          </p>
          {notifyBootstrapHint && (
            <p className="text-muted-foreground text-xs">
              Message your bot once to activate notifications — bots can’t text you first.
            </p>
          )}
        </div>
      </CollapsibleFieldCard>

      {/* The one stop nobody is watching. */}
      <UnattendedAutonomyDialog
        descriptor={pendingAutonomy}
        consequence={
          <>
            At a stop that asks, an action this agent needs permission for waits for an answer:
            where your integration can show buttons, it arrives in the chat as Approve and Deny, and
            only the people on the approver list may answer. Either way an ask nobody answers is
            refused after 10 minutes and the agent carries on without it. Here nothing is asked at
            all — anyone who can send a message through this integration sets off whatever the agent
            decides to do.
          </>
        }
        onCancel={() => setPendingAutonomy(null)}
        onConfirm={() => {
          if (pendingAutonomy) onPermissionModeChange(pendingAutonomy.id);
          setPendingAutonomy(null);
        }}
      />
    </>
  );
}
