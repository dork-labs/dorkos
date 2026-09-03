import { useState } from 'react';
import { Button, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { ResetDialog } from './ResetDialog';
import { ResetSettingsDialog } from './ResetSettingsDialog';
import { RestartDialog } from './RestartDialog';

/**
 * Settings → Danger zone — the three actions you cannot take back by hand.
 *
 * This tab used to be "Advanced", which is not a category but the absence of
 * one: a polling switch, the message-box switch, four logging fields and these
 * three buttons in one flat stack. Every other section found a real home
 * (DOR-1758) — the message box and background refresh on Preferences, logging on
 * Server — so what is left is the danger zone, and the tab is named after it.
 * A tab whose icon and name predict its contents is the whole point.
 */
export function DangerZoneTab() {
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetSettingsDialogOpen, setResetSettingsDialogOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const setRestartOverlayOpen = useAppStore((s) => s.setRestartOverlayOpen);

  return (
    <div className="space-y-4">
      {/* No heading of its own: the dialog draws the panel's "Danger zone"
          header, and repeating it a few pixels below is the duplication
          DOR-918 removed everywhere else. */}
      <FieldCard className="border-destructive/50">
        <FieldCardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Reset All Settings</p>
              <p className="text-muted-foreground text-xs">
                Put the theme, text, toggles, and panel layouts on this device back to how they
                shipped. Your projects, agents, and chats stay.
              </p>
            </div>
            {/* Both resets say what they reset: two adjacent buttons reading
                just "Reset" would leave the destructive one indistinguishable
                from the recoverable one, in the accessibility tree as much as
                on screen. */}
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setResetSettingsDialogOpen(true)}
            >
              Reset Settings
            </Button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Reset All Data</p>
              <p className="text-muted-foreground text-xs">
                Permanently delete all DorkOS data and restart the server.
              </p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setResetDialogOpen(true)}>
              Reset Data
            </Button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Restart Server</p>
              <p className="text-muted-foreground text-xs">
                Restart the DorkOS server process. Active sessions will be interrupted.
              </p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setRestartDialogOpen(true)}>
              Restart
            </Button>
          </div>
        </FieldCardContent>
      </FieldCard>

      <ResetSettingsDialog
        open={resetSettingsDialogOpen}
        onOpenChange={setResetSettingsDialogOpen}
      />
      <ResetDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        onResetComplete={() => setRestartOverlayOpen(true)}
      />
      <RestartDialog
        open={restartDialogOpen}
        onOpenChange={setRestartDialogOpen}
        onRestartComplete={() => setRestartOverlayOpen(true)}
      />
    </div>
  );
}
