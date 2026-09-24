import { useState } from 'react';
import type { PermissionException, PermissionState } from '@dorkos/shared/permissions';
import {
  Button,
  Checkbox,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { STATE_LABEL } from '../lib/permission-copy';

/** Props for {@link ApplyToOverridesDialog}. */
export interface ApplyToOverridesDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close without writing anything; the switch returns to where it was. */
  onCancel: () => void;
  /** What is changing, e.g. "Rooms". */
  subject: string;
  /** The new default, or a preset name. */
  next: PermissionState | string;
  /** The agents set differently for this subject. */
  agents: readonly PermissionException[];
  /** How many agents follow the default today and so change with it. */
  affectedCount: number;
  /** Write the default only; the agents set differently keep their settings. */
  onKeep: () => void;
  /** Write the default and bring the chosen agents along. */
  onUpdate: (agentIds: string[]) => void;
  /** Disable the buttons while the write is in flight. */
  pending?: boolean;
}

/**
 * The question a default change asks when some agents are set differently:
 * keep their settings, or bring the chosen ones along to the new default.
 *
 * Nothing is pre-checked, ever — a floor area going up included — so no agent
 * is moved without a person naming it. One component for every area and for
 * the preset switch. A bottom sheet on a phone (via `ResponsiveDialog`).
 *
 * @param props - See {@link ApplyToOverridesDialogProps}.
 */
export function ApplyToOverridesDialog({
  open,
  onCancel,
  subject,
  next,
  agents,
  affectedCount,
  onKeep,
  onUpdate,
  pending = false,
}: ApplyToOverridesDialogProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const nextLabel = next in STATE_LABEL ? STATE_LABEL[next as PermissionState] : next;
  const count = agents.length;

  const toggle = (agentId: string, on: boolean) => {
    const copy = new Set(selected);
    if (on) copy.add(agentId);
    else copy.delete(agentId);
    setSelected(copy);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          setSelected(new Set());
          onCancel();
        }
      }}
    >
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {subject} will be set to {nextLabel} for everyone.
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {count === 1 ? '1 agent is' : `${count} agents are`} set differently. Choose any you
            want to follow the new setting.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3">
          <ul className="space-y-2" aria-label="Agents set differently">
            {agents.map((agent) => {
              const id = `apply-${agent.agentId}`;
              return (
                <li key={agent.agentId} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={selected.has(agent.agentId)}
                    onCheckedChange={(value) => toggle(agent.agentId, value === true)}
                  />
                  <Label htmlFor={id} className="text-sm font-normal">
                    {agent.agentName}: {STATE_LABEL[agent.state]}
                    {agent.action ? ' (one action)' : ''}
                  </Label>
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground text-sm">
            This affects {affectedCount} {affectedCount === 1 ? 'agent' : 'agents'} now.
          </p>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setSelected(new Set());
              onKeep();
            }}
            disabled={pending}
          >
            Keep their settings
          </Button>
          <Button
            onClick={() => {
              const ids = [...selected];
              setSelected(new Set());
              onUpdate(ids);
            }}
            disabled={pending || selected.size === 0}
          >
            Update selected
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
