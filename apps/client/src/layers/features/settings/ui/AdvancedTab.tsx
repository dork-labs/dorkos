import { useState, useCallback } from 'react';
import { Copy, TriangleAlert } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TIMING } from '@/layers/shared/lib';
import {
  Button,
  FieldCard,
  FieldCardContent,
  Input,
  SettingRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { ResetDialog } from './ResetDialog';
import { RestartDialog } from './RestartDialog';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Settings danger zone with reset and restart actions. */
export function AdvancedTab() {
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const enableCrossClientSync = useAppStore((s) => s.enableCrossClientSync);
  const setEnableCrossClientSync = useAppStore((s) => s.setEnableCrossClientSync);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const setEnableMessagePolling = useAppStore((s) => s.setEnableMessagePolling);
  const setRestartOverlayOpen = useAppStore((s) => s.setRestartOverlayOpen);

  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const logging = config?.logging;

  const updateLogging = useCallback(
    async (patch: Record<string, unknown>) => {
      const current = logging ?? { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 };
      await transport.updateConfig({ logging: { ...current, ...patch } });
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    [transport, queryClient, logging]
  );

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Background Updates</h3>
      <p className="text-muted-foreground text-xs">
        Messages stream in live while someone is responding. These settings add extra updates for
        multi-window setups and unattended agents.
      </p>
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Multi-window sync"
            description="Keep multiple DorkOS windows and the Obsidian plugin in sync"
            checked={enableCrossClientSync}
            onCheckedChange={setEnableCrossClientSync}
          />

          <SwitchSettingRow
            label="Background refresh"
            description="Check for new messages periodically, even when no one is responding"
            checked={enableMessagePolling}
            onCheckedChange={setEnableMessagePolling}
          />
        </FieldCardContent>
      </FieldCard>

      {logging && (
        <>
          <h3 className="text-sm font-semibold">Logging</h3>
          <p className="text-muted-foreground text-xs">
            Server log verbosity and rotation. Changes take effect immediately for log level;
            rotation settings apply on next file rotation.
          </p>
          <FieldCard>
            <FieldCardContent>
              <SettingRow label="Log level" description="Server log verbosity">
                <Select value={logging.level} onValueChange={(v) => updateLogging({ level: v })}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                label="Max log file size"
                description="Size in KB before a log file is rotated"
              >
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={100}
                    max={10240}
                    value={logging.maxLogSizeKb}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (v >= 100 && v <= 10240) updateLogging({ maxLogSizeKb: v });
                    }}
                    className="w-24"
                  />
                  <span className="text-muted-foreground text-xs">KB</span>
                </div>
              </SettingRow>

              <SettingRow
                label="Rotated files kept"
                description="Number of old log files to retain (1-30)"
              >
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={logging.maxLogFiles}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 1 && v <= 30) updateLogging({ maxLogFiles: v });
                  }}
                  className="w-20"
                />
              </SettingRow>

              {config?.dorkHome && <LogLocationRow dorkHome={config.dorkHome} />}
            </FieldCardContent>
          </FieldCard>
        </>
      )}

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

/** Read-only row showing the log file location with click-to-copy. */
function LogLocationRow({ dorkHome }: { dorkHome: string }) {
  const [copied, setCopied] = useState(false);
  const logPath = `${dorkHome}/logs`;

  function handleCopy() {
    navigator.clipboard.writeText(logPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), TIMING.COPY_FEEDBACK_MS);
    });
  }

  return (
    <SettingRow label="Log location" description="Directory where server log files are stored">
      <button
        type="button"
        onClick={handleCopy}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
      >
        {copied ? (
          <span className="text-xs">Copied</span>
        ) : (
          <>
            <span className="max-w-40 truncate font-mono text-xs" dir="rtl" title={logPath}>
              {logPath}
            </span>
            <Copy className="size-3 shrink-0" />
          </>
        )}
      </button>
    </SettingRow>
  );
}
