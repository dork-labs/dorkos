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
 * The status line is what the app actually loaded when it started, as the
 * server reports it, never a fresh read of the file. A path saved since then
 * says it needs a restart. Outside the desktop app the server reports no
 * status, the setting does nothing, and this card draws nothing.
 *
 * @module features/settings/ui/network/NetworkSection
 */
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { CollapsibleFieldCard, PathInput, SettingRow } from '@/layers/shared/ui';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { ABSOLUTE_PATH, companyCertificatesStatusLine } from '../../lib/company-certificates';

/** The Network card. Draws nothing outside the desktop app. */
export function NetworkSection({ config }: { config: ServerConfig }) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const saved = config.network?.extraCaCertsPath ?? null;
  // Open when it has something to say: a file is set, or the variable was ignored.
  const [open, setOpen] = useState(
    () => saved !== null || config.network?.companyCertificates?.outcome === 'ignored-env'
  );
  const [draft, setDraft] = useState(saved ?? '');
  const [error, setError] = useState<string | null>(null);

  // A save elsewhere (another window) moves the field with it.
  useEffect(() => setDraft(saved ?? ''), [saved]);

  const save = useCallback(async () => {
    const next = draft.trim() || null;
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
  }, [draft, saved, transport, queryClient]);

  const status = config.network?.companyCertificates;
  if (!status) return null;
  const line = companyCertificatesStatusLine(status, saved);
  const loaded = status.outcome === 'added' && status.path === saved;

  return (
    <CollapsibleFieldCard
      open={open}
      onOpenChange={setOpen}
      trigger="Network"
      badge={
        loaded ? (
          <span className="text-muted-foreground text-xs">{status.added} trusted</span>
        ) : undefined
      }
    >
      <SettingRow
        label="Company certificates"
        description="For company networks that check web traffic. Applies after a restart."
        orientation="vertical"
      >
        <PathInput
          value={draft}
          onChange={setDraft}
          onBlur={() => void save()}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') void save();
          }}
          placeholder="/path/to/company-ca.pem"
          aria-label="Company certificates file"
          aria-invalid={error ? true : undefined}
        />
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : line ? (
          <p
            className={line.problem ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
            data-testid="company-certificates-status"
          >
            {line.text}
          </p>
        ) : null}
      </SettingRow>
    </CollapsibleFieldCard>
  );
}
