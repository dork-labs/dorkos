/**
 * The four things you can do to an agent you manage, and the confirmations two
 * of them need (spec `profile-unification` §1.2).
 *
 * Ported from the retired `AgentManagementMenu`, whose step machine and
 * wording this keeps: the same three confirmations, the same undo on
 * unregister, the same type-the-name gate on delete. What changed is the way in
 * — a dialog of action cards became four items in the profile's kebab, because
 * a menu of cards explaining what a menu item would have done is a menu twice.
 *
 * @module features/profile/ui/ProfileAgentActions
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  Button,
  Input,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import {
  useClearDenial,
  useDeleteAgentData,
  useDeniedAgents,
  useDenyAgent,
  useRegisterAgent,
  useUnregisterAgent,
} from '@/layers/entities/mesh';

/** Which confirmation is open, or `null` for none. */
export type ProfileAgentStep = 'block' | 'unregister' | 'delete' | null;

export interface ProfileAgentActionsProps {
  /** The agent being acted on. */
  member: TeamMember;
  /** Where the agent lives — what block and unblock are keyed on. */
  projectPath: string;
  /** Which confirmation to show. */
  step: ProfileAgentStep;
  /** Close, or switch to another confirmation. */
  onStepChange: (step: ProfileAgentStep) => void;
}

/**
 * Whether this agent's location is currently hidden from discovery.
 *
 * Exported so the kebab can label its item "Block" or "Unblock" without
 * duplicating the lookup the dialog does.
 *
 * **Asks for nothing without a path.** `GET /api/mesh/denied` is a question
 * about an agent's folder, and it was being asked on "You" — a profile with no
 * folder and no Block item to label. Callers that only offer blocking on some
 * relationships pass `null` on the others.
 *
 * @param projectPath - The agent's project directory, or `null` to ask nothing.
 */
export function useIsAgentBlocked(projectPath: string | null): boolean {
  const { data } = useDeniedAgents(projectPath !== null);
  if (projectPath === null) return false;
  return data?.denied?.some((entry) => entry.path === projectPath) ?? false;
}

/**
 * The confirmations behind the kebab's three consequential items.
 *
 * Rendered by the menu rather than triggered from it, because a dropdown item
 * unmounts the moment it is chosen — the dialog has to outlive the menu that
 * opened it.
 */
export function ProfileAgentActions({
  member,
  projectPath,
  step,
  onStepChange,
}: ProfileAgentActionsProps) {
  const [typed, setTyped] = useState('');
  const unregisterAgent = useUnregisterAgent();
  const registerAgent = useRegisterAgent();
  const denyAgent = useDenyAgent();
  const clearDenial = useClearDenial();
  const deleteAgentData = useDeleteAgentData();
  const isBlocked = useIsAgentBlocked(projectPath);

  const name = member.displayName;
  const agentId = member.agent?.manifestId ?? null;

  function close() {
    onStepChange(null);
    setTyped('');
  }

  function block() {
    if (isBlocked) {
      clearDenial.mutate(projectPath, {
        onSuccess: () => {
          toast.success(`${name} unblocked`);
          close();
        },
      });
      return;
    }
    denyAgent.mutate(
      { path: projectPath, reason: 'Blocked from its profile' },
      {
        onSuccess: () => {
          toast.success(`${name} blocked`);
          close();
        },
      }
    );
  }

  function unregister() {
    if (agentId === null) return;
    unregisterAgent.mutate(agentId, {
      onSuccess: () => {
        toast(`${name} unregistered`, {
          action: { label: 'Undo', onClick: () => registerAgent.mutate({ path: projectPath }) },
          duration: 5000,
        });
        close();
      },
    });
  }

  function remove() {
    if (agentId === null) return;
    deleteAgentData.mutate(agentId, {
      onSuccess: () => {
        // A completed delete, not a failure — bare like its unregister
        // sibling above, minus the Undo action this one cannot honestly offer.
        toast(`Deleted ${name} and all its data`);
        close();
      },
    });
  }

  return (
    <ResponsiveDialog open={step !== null} onOpenChange={(open) => !open && close()}>
      <ResponsiveDialogContent className="min-h-0 sm:max-w-md">
        {step === 'block' && (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>
                {isBlocked ? `Unblock ${name}?` : `Block ${name}?`}
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {isBlocked
                  ? 'This agent’s folder becomes eligible for discovery again the next time DorkOS scans.'
                  : 'This agent’s folder will be hidden from future scans. If you unregister it later, it won’t come back automatically. You can unblock it at any time.'}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </ResponsiveDialogClose>
              <Button variant={isBlocked ? 'default' : 'destructive'} onClick={block}>
                {isBlocked ? 'Unblock' : 'Block'}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}

        {step === 'unregister' && (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>Unregister {name}?</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                It disappears from your team and any schedules it has are paused. Your project files
                stay exactly as they are, and a re-scan brings it back.
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </ResponsiveDialogClose>
              <Button onClick={unregister}>Unregister</Button>
            </ResponsiveDialogFooter>
          </>
        )}

        {step === 'delete' && (
          <>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>Delete {name}?</ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                This permanently erases {name}’s personality, custom rules and settings. Your
                project files at {projectPath} are not touched. This cannot be undone.
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogBody>
              <div className="space-y-2">
                <label htmlFor="profile-delete-confirm" className="text-sm font-medium">
                  Type <strong>{name}</strong> to confirm
                </label>
                <Input
                  id="profile-delete-confirm"
                  data-testid="delete-confirm-input"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={name}
                  autoComplete="off"
                />
              </div>
            </ResponsiveDialogBody>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </ResponsiveDialogClose>
              <Button variant="destructive" disabled={typed !== name} onClick={remove}>
                Delete agent and data
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
