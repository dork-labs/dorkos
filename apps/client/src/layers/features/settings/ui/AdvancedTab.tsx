import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Separator } from '@/layers/shared/ui';
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

  return (
    <div className="space-y-6">
      <div className="border-destructive/50 space-y-4 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <TriangleAlert className="text-destructive size-4" />
          <h3 className="text-destructive text-sm font-semibold">Danger Zone</h3>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Reset All Data</p>
            <p className="text-muted-foreground text-xs">
              Permanently delete all DorkOS data and restart the server.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setResetDialogOpen(true)}
          >
            Reset
          </Button>
        </div>

        <Separator />

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">Restart Server</p>
            <p className="text-muted-foreground text-xs">
              Restart the DorkOS server process. Active sessions will be interrupted.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setRestartDialogOpen(true)}
          >
            Restart
          </Button>
        </div>
      </div>

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
