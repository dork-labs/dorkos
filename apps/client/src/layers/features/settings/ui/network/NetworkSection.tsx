/**
 * The Network card in Settings → Server: which company certificates the
 * desktop app trusts (DOR-3361).
 *
 * Some company networks inspect every TLS connection, and the app reaches the
 * internet there only if it trusts the company's own certificate authority.
 * The file is chosen here and nowhere else: the packaged app ignores
 * `NODE_EXTRA_CA_CERTS`, which anything running as the user could set. The
 * path is written to `network.extraCaCertsPath` through `PATCH /api/config`,
 * which refuses agents (operator-only).
 *
 * **Choose…** opens the desktop app's own file dialog. In a browser, where no
 * page can read a file's path, the path is typed instead. **Stop using this
 * file** clears it with no confirm: choosing again undoes it.
 *
 * Everything the row says is what the app loaded when it started, as the
 * server reports it, never a fresh read of the file. A choice made since then
 * says a restart is due, with a Restart button when the app can restart itself.
 * Outside the desktop app the server reports no status and this card draws
 * nothing.
 *
 * @module features/settings/ui/network/NetworkSection
 */
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import type { ServerConfig } from '@dorkos/shared/types';
import { Badge, Button, CollapsibleFieldCard, PathInput, SettingRow } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import {
  cn,
  getCertificateFilePicker,
  type CertificateFilePicker,
  getDesktopAdmin,
  restartDorkOS,
  truncateMiddle,
} from '@/layers/shared/lib';
import { configKeys } from '@/layers/entities/config';
import {
  ABSOLUTE_PATH,
  certificateCount,
  companyCertificatesRow,
  restartLine,
  type CompanyCertificatesRow,
} from '../../lib/company-certificates';

/** Full width at 44px on a phone, natural size from `sm` up. */
const PHONE_BUTTON = 'max-sm:min-h-11 max-sm:w-full';

/** What the desktop window offers this card: its file dialog, and whether it can restart. */
export interface NetworkSectionDesktop {
  /** Opens the native file dialog, or `null` where there is none (a browser). */
  picker: CertificateFilePicker | null;
  /** Whether the app can restart itself from here. */
  canRestart: boolean;
}

/**
 * The Network card. Draws nothing outside the desktop app.
 *
 * @param props.config - The server config, whose `network` block it reads.
 * @param props.desktop - What the desktop window offers; read from the window
 *   when omitted. The Dev Playground passes one to show the desktop row in a browser.
 */
export function NetworkSection({
  config,
  desktop,
}: {
  config: ServerConfig;
  desktop?: NetworkSectionDesktop;
}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const saved = config.network?.extraCaCertsPath ?? null;
  // Open when it has something to say: a file is set or still in use, or the variable was ignored.
  const [open, setOpen] = useState(() => {
    const outcome = config.network?.companyCertificates?.outcome;
    return saved !== null || outcome === 'added' || outcome === 'ignored-env';
  });
  const [draft, setDraft] = useState(saved ?? '');
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const picker = desktop ? desktop.picker : getCertificateFilePicker();
  const canRestart = desktop ? desktop.canRestart : getDesktopAdmin() !== null;

  // A save elsewhere (another window) moves the field with it.
  useEffect(() => setDraft(saved ?? ''), [saved]);

  const store = useCallback(
    async (next: string | null) => {
      if (next === saved) return;
      if (next && !ABSOLUTE_PATH.test(next)) {
        setError('Use the full path to the file.');
        return;
      }
      try {
        await transport.updateConfig({ network: { extraCaCertsPath: next } });
        setError(null);
        await queryClient.invalidateQueries({ queryKey: configKeys.all });
      } catch {
        setError('Couldn’t save. Change this on the computer DorkOS runs on.');
      }
    },
    [saved, transport, queryClient]
  );

  const choose = useCallback(async () => {
    if (!picker) return;
    try {
      const picked = await picker();
      if (picked) await store(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t open the file dialog. Try again.');
    }
  }, [picker, store]);

  const restart = useCallback(async () => {
    setRestarting(true);
    try {
      await restartDorkOS(transport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t restart DorkOS. Try again.');
      setRestarting(false);
    }
  }, [transport]);

  const status = config.network?.companyCertificates;
  if (!status) return null;
  const row = companyCertificatesRow(status, saved);
  const inUse = status.outcome === 'added' ? status.added : null;

  return (
    <CollapsibleFieldCard
      open={open}
      onOpenChange={setOpen}
      trigger="Network"
      badge={
        inUse !== null ? (
          <Badge variant="secondary" size="xs" data-testid="company-certificates-badge">
            {certificateCount(inUse)}
          </Badge>
        ) : undefined
      }
    >
      <SettingRow
        label="Company certificates"
        description="For company networks that check web traffic. Applies after a restart."
        orientation="vertical"
      >
        {!picker && (
          <PathInput
            value={draft}
            onChange={setDraft}
            onBlur={() => void store(draft.trim() || null)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') void store(draft.trim() || null);
            }}
            placeholder="/path/to/company-ca.pem"
            aria-label="Company certificates file"
            aria-invalid={error ? true : undefined}
          />
        )}
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : (
          <RowStatus
            row={row}
            saved={saved}
            restart={canRestart ? { onClick: () => void restart(), pending: restarting } : null}
          />
        )}
        <div className="flex gap-2 max-sm:flex-col">
          {picker && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={PHONE_BUTTON}
              onClick={() => void choose()}
            >
              Choose…
            </Button>
          )}
          {saved !== null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn('hover:text-destructive', PHONE_BUTTON)}
              onClick={() => void store(null)}
            >
              Stop using this file
            </Button>
          )}
        </div>
      </SettingRow>
    </CollapsibleFieldCard>
  );
}

/** The status under the setting: what is trusted now, or what a restart will change. */
function RowStatus({
  row,
  saved,
  restart,
}: {
  row: CompanyCertificatesRow;
  saved: string | null;
  restart: { onClick: () => void; pending: boolean } | null;
}): ReactNode {
  switch (row.kind) {
    case 'loaded':
      return (
        <div className="space-y-0.5" data-testid="company-certificates-status">
          <p className="text-muted-foreground text-xs">
            Trusting {row.count} extra {row.count === 1 ? 'certificate' : 'certificates'} from this
            file.
          </p>
          {/* Cut in the middle so the file's name stays: shorter on a phone. */}
          <p className="text-muted-foreground truncate font-mono text-xs" title={row.path}>
            <span className="max-sm:hidden">{truncateMiddle(row.path, 48)}</span>
            <span className="sm:hidden">{truncateMiddle(row.path, 26)}</span>
          </p>
        </div>
      );
    case 'restart': {
      // The old path only when it is not the one chosen now.
      const shown =
        row.stillUsing && row.stillUsing.path === saved ? { ...row, stillUsing: null } : row;
      return (
        <div
          className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch"
          data-testid="company-certificates-status"
        >
          <p className="text-status-warning-fg flex min-w-0 flex-1 items-start gap-1.5 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{restartLine(shown)}</span>
          </p>
          {restart && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={PHONE_BUTTON}
              disabled={restart.pending}
              onClick={restart.onClick}
            >
              {restart.pending ? 'Restarting…' : 'Restart'}
            </Button>
          )}
        </div>
      );
    }
    case 'problem':
      return (
        <p className="text-destructive text-xs" data-testid="company-certificates-status">
          {row.text}
        </p>
      );
    case 'ignored-env':
      return (
        <p className="text-muted-foreground text-xs" data-testid="company-certificates-status">
          <span className="font-mono">NODE_EXTRA_CA_CERTS</span> is ignored. Choose the file here
          instead.
        </p>
      );
    case 'none':
      return null;
  }
}
