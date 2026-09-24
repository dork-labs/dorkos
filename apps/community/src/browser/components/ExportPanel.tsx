import { useCallback, useEffect, useState } from 'react';
import { Download, Shield, X } from 'lucide-react';
import type { CommunityWireExport } from '@dorkos/shared/community-wire';
import { request, tenantApiPath } from '../api.js';
import { describeReauthenticationError } from '../account-controls.js';
import {
  availableUntil,
  currentExport,
  EXPORT_FAILURE_TEXT,
  EXPORT_POLL_MS,
  exportInProgress,
  formatSize,
} from '../exports.js';

type Props = {
  scope: CommunityWireExport['scope'];
  /** Id prefix for this panel's fields, unique on the page. */
  idPrefix: string;
};

const PREPARING =
  "We're preparing your export. A large community can take a while. You can close this page; we'll keep going.";

/**
 * Start, follow and download one export. An export is prepared in the background: this panel
 * shows its progress (asking every five seconds), offers Cancel while it runs, and once it is
 * ready a Download link the browser can resume from its downloads list if it stops.
 */
export function ExportPanel({ scope, idPrefix }: Props) {
  const owner = scope === 'owner';
  const [current, setCurrent] = useState<CommunityWireExport | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const body = await request<{ exports: CommunityWireExport[] }>('/api/v1/exports');
    setCurrent(currentExport(body.exports, scope));
  }, [scope]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const id = current?.id;
  const inProgress = exportInProgress(current);
  useEffect(() => {
    if (!inProgress || !id) return;
    const timer = window.setInterval(() => {
      void request<{ export: CommunityWireExport }>(`/api/v1/exports/${id}`)
        .then((body) => setCurrent(body.export))
        .catch(() => undefined);
    }, EXPORT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [id, inProgress]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const body = await request<{ export: CommunityWireExport }>(
        owner ? '/api/v1/owner/export' : '/api/v1/me/export',
        'POST',
        owner ? { password } : {}
      );
      setCurrent(body.export);
      setPassword('');
    } catch (cause) {
      setError(describeReauthenticationError(cause, 'No export was started.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/exports/${current.id}/cancel`, 'POST', {});
      setCurrent(null);
    } catch (cause) {
      setError(describeReauthenticationError(cause, 'The export was not cancelled.'));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const fileName = owner ? 'community-export.zip' : 'my-community-data.zip';
  const startLabel = owner ? 'Export this community' : 'Download my data';
  const passwordId = `${idPrefix}-password`;

  return (
    <div className="export-panel">
      <p className="small muted">
        {owner
          ? "The export is a .zip. It has your community's messages, files, members, and settings."
          : 'The export is a .zip with your account, your messages and your agents’ activity, and your files.'}{' '}
        Messages posted after the export starts aren&rsquo;t included. Messages deleted while
        it&rsquo;s being prepared are left out or shown as deleted.
      </p>
      {inProgress && current && (
        <div className="export-progress">
          <p role="status" className="small">
            {PREPARING}
          </p>
          <progress
            aria-label="Export progress"
            value={current.progress.total === null ? undefined : current.progress.done}
            max={current.progress.total ?? undefined}
          />
          {current.progress.total !== null && (
            <p className="small muted">
              {current.progress.done.toLocaleString()} of {current.progress.total.toLocaleString()}{' '}
              messages and files
            </p>
          )}
          <button className="button" disabled={busy} onClick={() => void cancel()}>
            <X size={16} /> Cancel
          </button>
        </div>
      )}
      {current?.state === 'ready' && (
        <div className="export-ready">
          <a
            className="button primary"
            href={tenantApiPath(`/api/v1/exports/${current.id}/archive`)}
            download={fileName}
          >
            <Download size={16} /> Download
            {current.byteSize !== null ? ` (${formatSize(current.byteSize)})` : ''}
          </a>
          {current.expiresAt && (
            <p className="small muted">
              {availableUntil(current.expiresAt)} If a download stops, your browser can resume it
              from its downloads list.
            </p>
          )}
        </div>
      )}
      {current?.state === 'failed' && current.failureCode && (
        <p className="notice error" role="alert">
          {EXPORT_FAILURE_TEXT[current.failureCode]}
        </p>
      )}
      {!inProgress && current?.state !== 'ready' && (
        <>
          {owner && (
            <div className="field">
              <label htmlFor={passwordId}>Password</label>
              <input
                id={passwordId}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          <button
            className="button"
            disabled={busy || (owner && !password)}
            onClick={() => void start()}
          >
            {owner ? <Shield size={16} /> : <Download size={16} />}{' '}
            {current?.state === 'failed' ? 'Try again' : startLabel}
          </button>
        </>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
