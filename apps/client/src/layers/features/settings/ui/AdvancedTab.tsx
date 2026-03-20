import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, FieldCard, FieldCardContent, SettingRow, Switch } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { ResetDialog } from './ResetDialog';
import { RestartDialog } from './RestartDialog';

interface AdvancedTabProps {
  onResetComplete: () => void;
  onRestartComplete: () => void;
}

/** Settings danger zone with reset and restart actions. */
export function AdvancedTab({ onResetComplete, onRestartComplete }: AdvancedTabProps) {
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const enableCrossClientSync = useAppStore((s) => s.enableCrossClientSync);
  const setEnableCrossClientSync = useAppStore((s) => s.setEnableCrossClientSync);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const setEnableMessagePolling = useAppStore((s) => s.setEnableMessagePolling);

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Background Updates</h3>
      <p className="text-muted-foreground text-xs">
        Messages stream in live while someone is responding. These settings add extra updates for
        multi-window setups and unattended agents.
      </p>
      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Multi-window sync"
            description="Keep multiple DorkOS windows and the Obsidian plugin in sync"
          >
            <Switch checked={enableCrossClientSync} onCheckedChange={setEnableCrossClientSync} />
          </SettingRow>

          <SettingRow
            label="Background refresh"
            description="Check for new messages periodically, even when no one is responding"
          >
            <Switch checked={enableMessagePolling} onCheckedChange={setEnableMessagePolling} />
          </SettingRow>
        </FieldCardContent>
      </FieldCard>

      <div className="flex items-center gap-2">
        <TriangleAlert className="text-destructive size-4" />
        <h3 className="text-destructive text-sm font-semibold">Danger Zone</h3>
      </div>
      <FieldCard className="border-destructive/50">
        <FieldCardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Reset All Data</p>
              <p className="text-muted-foreground text-xs">
                Permanently delete all DorkOS data and restart the server.
              </p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setResetDialogOpen(true)}>
              Reset
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

      <ResetDialog
        open={resetDialogOpen}
        onOpenChange={setResetDialogOpen}
        onResetComplete={onResetComplete}
      />
      <RestartDialog
        open={restartDialogOpen}
        onOpenChange={setRestartDialogOpen}
        onRestartComplete={onRestartComplete}
      />
    </div>
  );
}
