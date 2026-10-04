/**
 * Confirm unlinking a dev link (DOR-2696): the package stops running from the
 * person's folder, and either its installed copy comes back or it is removed.
 * The folder itself is never touched. Also the first step of "Install published
 * version", which unlinks before the normal install dialog opens.
 *
 * @module features/marketplace/ui/UnlinkDialog
 */
import { toast } from 'sonner';
import type { DevUnlinkResult } from '@dorkos/shared/marketplace-schemas';
import {
  Button,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { humanizePackageName } from '@/layers/shared/lib';
import { useUnlinkDevLink } from '@/layers/entities/marketplace';
import { unlinkOutcomeCopy } from '../lib/dev-links';

/** The dev link a person asked to unlink, and why. */
export interface UnlinkTarget {
  /** The package name. */
  name: string;
  /** `global` or `project`. */
  scope: 'global' | 'project';
  /** The project, for a project dev link. */
  projectPath?: string;
  /** Whether an installed copy is set aside and comes back. */
  parked: boolean;
  /**
   * `install` when this unlink is the first half of "Install published
   * version": the install dialog opens next.
   */
  then?: 'install';
}

/** Props for {@link UnlinkDialog}. */
export interface UnlinkDialogProps {
  /** The dev link to unlink, or `null` when closed. */
  target: UnlinkTarget | null;
  /** Close without unlinking, or after it is done. */
  onClose: () => void;
  /** Called once the unlink succeeded, with what it did. */
  onUnlinked?: (target: UnlinkTarget, result: DevUnlinkResult) => void;
}

/**
 * The unlink confirmation. Says before the click what comes back, and after it
 * exactly what happened, never more.
 */
export function UnlinkDialog({ target, onClose, onUnlinked }: UnlinkDialogProps) {
  const unlink = useUnlinkDevLink();
  const name = target ? humanizePackageName(target.name) : '';
  const installing = target?.then === 'install';

  async function handleUnlink() {
    if (!target) return;
    try {
      const result = await unlink.mutateAsync({
        name: target.name,
        scope: target.scope,
        ...(target.projectPath !== undefined && { projectPath: target.projectPath }),
      });
      if (installing && result.restored === 'removed' && !result.parkedLeftAt) {
        // Whatever unlink found in the link's place is still said: the install
        // that follows lands in that same slot.
        toast.success(`${name} unlinked.`, {
          description: result.leftInPlace
            ? 'Something else was in its place. It was left as it is.'
            : 'It’s not installed until you finish the install.',
        });
      } else {
        const copy = unlinkOutcomeCopy(name, result);
        toast.success(copy.title, copy.description ? { description: copy.description } : undefined);
      }
      onUnlinked?.(target, result);
      onClose();
    } catch (err) {
      toast.error(`Couldn’t unlink ${name}`, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }

  return (
    <ResponsiveDialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="!min-h-0 sm:max-w-md">
        {target && (
          <>
            <ResponsiveDialogHeader className="text-left">
              <ResponsiveDialogTitle className="text-left">
                {installing ? `Install the published ${name}?` : `Unlink ${name}?`}
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription className="text-left">
                {installing
                  ? `${name} is unlinked first. Your folder is not touched.`
                  : target.parked
                    ? 'Your installed copy comes back.'
                    : `${name} is removed. Your folder is not touched.`}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
            <ResponsiveDialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={unlink.isPending}>
                Cancel
              </Button>
              <Button onClick={() => void handleUnlink()} disabled={unlink.isPending}>
                {unlink.isPending ? 'Unlinking…' : installing ? 'Unlink and install' : 'Unlink'}
              </Button>
            </ResponsiveDialogFooter>
          </>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
