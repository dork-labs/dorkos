/**
 * The three hosted-community dialogs, mounted together by whoever offers the
 * entry points (the community switcher).
 *
 * @module features/community-hosting/ui/CommunityHostingDialogs
 */
import type { CommunityHostingEntry } from '../model/use-community-hosting-entry';
import { HostedCommunitiesDialog } from './HostedCommunitiesDialog';
import { MoveCommunityDialog } from './MoveCommunityDialog';
import { StartCommunityDialog } from './StartCommunityDialog';

/** Which hosted-community dialog is open, if any. */
export type CommunityHostingDialog =
  { kind: 'start' } | { kind: 'move'; moveId: string | null } | { kind: 'hosted' } | null;

/** Props for {@link CommunityHostingDialogs}. */
export interface CommunityHostingDialogsProps {
  /** The entry state, or `null` when unlinked (then nothing mounts). */
  entry: CommunityHostingEntry | null;
  dialog: CommunityHostingDialog;
  onDialogChange: (dialog: CommunityHostingDialog) => void;
  /** What a new community will call this DorkOS. */
  installName: string;
  /** Runs once this DorkOS is connected to a new community, with its local ref. */
  onConnected: (ref: string) => void;
}

/** Mount whichever hosted-community dialog is open. Nothing at all while unlinked. */
export function CommunityHostingDialogs({
  entry,
  dialog,
  onDialogChange,
  installName,
  onConnected,
}: CommunityHostingDialogsProps) {
  if (entry === null) return null;
  const close = (open: boolean) => {
    if (!open) onDialogChange(null);
  };
  return (
    <>
      <StartCommunityDialog
        open={dialog?.kind === 'start'}
        onOpenChange={close}
        installName={installName}
        allowance={entry.allowance}
        onConnected={onConnected}
      />
      <MoveCommunityDialog
        key={dialog?.kind === 'move' ? (dialog.moveId ?? 'new') : 'closed'}
        open={dialog?.kind === 'move'}
        onOpenChange={close}
        installName={installName}
        resumeMoveId={dialog?.kind === 'move' ? dialog.moveId : null}
        onConnected={onConnected}
      />
      <HostedCommunitiesDialog
        open={dialog?.kind === 'hosted'}
        onOpenChange={close}
        installName={installName}
        onOpenMove={(moveId) => onDialogChange({ kind: 'move', moveId })}
        onConnected={onConnected}
      />
    </>
  );
}
