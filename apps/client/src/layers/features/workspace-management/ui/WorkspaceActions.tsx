import { useState } from 'react';
import { Pin, PinOff, Trash2 } from 'lucide-react';
import {
  Button,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/layers/shared/ui';
import type { Workspace } from '@dorkos/shared/workspace';
import { usePinWorkspace, useRemoveWorkspace } from '../model/use-workspace-actions';

/**
 * Per-workspace pin + remove actions. Remove is a two-step, dirty-safe flow: a
 * normal confirm first, and — if the server refuses because the workspace has
 * uncommitted/unpushed work — an explicit force-confirm. Never a silent destroy.
 */
export function WorkspaceActions({ workspace }: { workspace: Workspace }) {
  const pin = usePinWorkspace();
  const remove = useRemoveWorkspace();
  const [open, setOpen] = useState(false);
  const [forceMode, setForceMode] = useState(false);

  const handleRemove = async (force: boolean) => {
    const result = await remove.mutateAsync({ id: workspace.id, force });
    if (!result.removed && result.blocked === 'dirty') {
      setForceMode(true); // re-prompt: this workspace has uncommitted work.
      return;
    }
    setOpen(false);
    setForceMode(false);
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        aria-label={workspace.pinned ? 'Unpin workspace' : 'Pin workspace'}
        onClick={() => pin.mutate({ id: workspace.id, pinned: !workspace.pinned })}
        disabled={pin.isPending}
      >
        {workspace.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
      </Button>

      <Button
        variant="ghost"
        size="sm"
        aria-label="Remove workspace"
        onClick={() => {
          setForceMode(false);
          setOpen(true);
        }}
      >
        <Trash2 className="size-4" />
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setForceMode(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {forceMode ? 'Force remove workspace?' : 'Remove workspace?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {forceMode
                ? `${workspace.key} has uncommitted or unpushed work. Force-removing deletes it permanently.`
                : `Remove the ${workspace.key} workspace? Its checkout will be deleted.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleRemove(forceMode);
              }}
              disabled={remove.isPending}
            >
              {forceMode ? 'Force remove' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
