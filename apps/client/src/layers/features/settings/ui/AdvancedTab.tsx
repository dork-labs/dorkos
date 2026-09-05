import { useState, useCallback } from 'react';
import { Copy, TriangleAlert } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCopyFeedback } from '@/layers/shared/lib';
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
import { useComposerRichText, useUpdateComposerPrefs } from '@/layers/entities/config';
import { ResetDialog } from './ResetDialog';
import { ResetSettingsDialog } from './ResetSettingsDialog';
import { RestartDialog } from './RestartDialog';
import { configKeys } from '@/layers/entities/config';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Settings danger zone with reset and restart actions. */
export function AdvancedTab() {
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetSettingsDialogOpen, setResetSettingsDialogOpen] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const setEnableMessagePolling = useAppStore((s) => s.setEnableMessagePolling);
  const setRestartOverlayOpen = useAppStore((s) => s.setRestartOverlayOpen);

  const transport = useTransport();
  const queryClient = useQueryClient();

  const richText = useComposerRichText();
  const { setRichText } = useUpdateComposerPrefs();

  const { data: config } = useQuery({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const logging = config?.logging;

  const updateLogging = useCallback(
    async (patch: Record<string, unknown>) => {
      const current = logging ?? { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 };
      await transport.updateConfig({ logging: { ...current, ...patch } });
      await queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
    [transport, queryClient, logging]
  );

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Background updates</h3>
      <p className="text-muted-foreground text-xs">
        Messages arrive live and stay in sync across your windows automatically. The switch below is
        an extra check, and only for work you started outside DorkOS.
      </p>
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Watch for agents you started somewhere else"
            description="Turn this on if work you started in a terminal takes a while to show up here."
            checked={enableMessagePolling}
            onCheckedChange={setEnableMessagePolling}
          />
        </FieldCardContent>
      </FieldCard>

      <h3 className="text-sm font-semibold">Message box</h3>
      <p className="text-muted-foreground text-xs">
        How the box you type messages into behaves. This applies to chat for now.
      </p>
      <FieldCard>
        <FieldCardContent>
          {/*
           * Formatting as you type is ON by default since the owner's
           * 2026-08-12 call, so this switch is no longer an opt-in — it is the
           * way out.
           *
           * That is why it stays visible. Someone whose message box misbehaves
           * can put it back without finding and hand-editing
           * `~/.dork/config.json`, and a kill-switch has to be reachable when
           * the thing it gates is what broke. With the feature on for everyone,
           * that reachability matters more than it did as an opt-in, not less.
           *
           * The fair counter-argument is that a switch here is a promise to
           * carry both fields forever. The exit plan answers it, unchanged in
           * shape: this row, the `richText` prop, `TextareaField` and the whole
           * plain path come out together. What that cleanup now waits on is the
           * nested-list serialize fix, not a default flip. Removing this row is
           * its obvious first move, not a discovery someone has to make.
           */}
          <SwitchSettingRow
            label="Format text as you type"
            description="See bold, headings, and lists take shape in the message box while you write."
            checked={richText}
            onCheckedChange={setRichText}
          />
        </FieldCardContent>
      </FieldCard>

      {logging && (
        <>
          <h3 className="text-sm font-semibold">Logging</h3>
          <p className="text-muted-foreground text-xs">
            Notes DorkOS keeps about what it did, in case something goes wrong. A new log level
            takes effect right away. The file settings apply to the next log file.
          </p>
          <FieldCard>
            <FieldCardContent>
              <SettingRow label="Log level" description="How much detail DorkOS writes down.">
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
                label="Biggest log file"
                description="How big one log file gets before DorkOS starts a new one."
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
                label="Old files kept"
                description="How many old log files to keep. Between 1 and 30."
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
        <h3 className="text-destructive text-sm font-semibold">Danger zone</h3>
      </div>
      <FieldCard className="border-destructive/50">
        <FieldCardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Reset all settings</p>
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
              Reset settings
            </Button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Reset all data</p>
              <p className="text-muted-foreground text-xs">
                Delete everything DorkOS has saved and start it again. You cannot undo this.
              </p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => setResetDialogOpen(true)}>
              Reset data
            </Button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">Restart DorkOS</p>
              <p className="text-muted-foreground text-xs">Anything running right now stops.</p>
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

/** Read-only row showing the log file location with click-to-copy. */
function LogLocationRow({ dorkHome }: { dorkHome: string }) {
  const { copied, failed, copy } = useCopyFeedback();
  const logPath = `${dorkHome}/logs`;

  function content() {
    if (copied) return <span className="text-xs">Copied</span>;
    if (failed) return <span className="text-destructive text-xs">Couldn&apos;t copy</span>;
    return (
      <>
        {/* Clipped at the front, so the folder name survives and the shared
            head is what goes. The `bdi` keeps the path reading left-to-right
            inside the rtl span; without it the leading `/` is claimed by the
            surrounding RTL paragraph and painted at the right-hand end, so
            `/Users/kai/.dork/logs` drew as `Users/kai/.dork/logs/`. That is the
            only edge at risk here: this value always ends in `/logs`, never in
            a neutral character (DOR-1686, idiom from `MessageSearchHitRow`). */}
        <span className="max-w-40 truncate font-mono text-xs" dir="rtl" title={logPath}>
          <bdi dir="ltr">{logPath}</bdi>
        </span>
        <Copy className="size-3 shrink-0" />
      </>
    );
  }

  return (
    <SettingRow label="Log location" description="Where DorkOS keeps these files.">
      <button
        type="button"
        onClick={() => void copy(logPath)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
      >
        {content()}
      </button>
    </SettingRow>
  );
}
