import { useCallback, useEffect, useRef, useState } from 'react';
import { RequestError, describeError, request } from '../api.js';
import { sha256OfFile } from '../sha256.js';

type ImportState =
  'awaiting_upload' | 'validating' | 'validated' | 'restoring' | 'ready' | 'failed' | 'cancelled';
type Report = {
  channels: number;
  entries: number;
  attachments: number;
  historicalMembers: number;
  historicalAgents: number;
  attachmentBytes: number;
  fitsStorageLimit: boolean;
};
type HostImport = {
  importId: string;
  communityId: string | null;
  state: ImportState;
  report: Report | null;
  failureCode: string | null;
  uploadExpiresAt: string;
  maxArchiveBytes: number;
};

const FAILURES: Record<string, string> = {
  IMPORT_ARCHIVE_INVALID: 'The file is damaged or is not a community export.',
  IMPORT_NOT_OWNER_EXPORT: 'This is a personal export. Ask the owner for the community export.',
  IMPORT_VERSION_UNSUPPORTED: 'This export comes from a version this host cannot read.',
  IMPORT_TOO_LARGE: 'This export is larger than an import can take.',
  STORAGE_LIMIT_REACHED: 'The files do not fit this community’s file space limit.',
  IMPORT_CHECKSUM_MISMATCH: 'A file inside the export does not match. Export it again.',
  IMPORT_STORAGE_UNAVAILABLE: 'This host could not store the files. Try again later.',
};

const STATES: Record<ImportState, string> = {
  awaiting_upload: 'Waiting for the export file',
  validating: 'Checking the export',
  validated: 'Checked. Ready to import.',
  restoring: 'Importing',
  ready: 'Imported. Send an owner claim to finish.',
  failed: 'Import failed',
  cancelled: 'Cancelled',
};

/** Send an export file to an import with this browser's host session. */
async function uploadExport(importId: string, file: File): Promise<void> {
  const response = await fetch(`/api/v1/imports/${importId}/archive`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/zip', 'x-archive-sha256': await sha256OfFile(file) },
    body: file,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new RequestError(
      response.status,
      body.code ?? 'UNAVAILABLE',
      body.message ?? 'The upload did not finish.'
    );
  }
}

/**
 * Bring a community in from another host: name it, choose its owner's export file, and send
 * it. The new community appears in the list below while it is checked and imported.
 */
export function HostImportForm({ onStarted }: { onStarted: () => void }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState<{ url: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const attempt = useRef<string | null>(null);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      attempt.current ??= crypto.randomUUID();
      const created = await request<{
        import: HostImport;
        uploadToken: string | null;
      }>('/api/v1/host/imports', 'POST', { idempotencyKey: attempt.current, name: name.trim() });
      attempt.current = null;
      if (created.uploadToken)
        setLink({
          url: `${window.location.origin}/api/v1/imports/${created.import.importId}/archive`,
          token: created.uploadToken,
        });
      if (file) {
        setMessage('Sending the export…');
        await uploadExport(created.import.importId, file);
        setMessage('Export received. It is being checked now.');
      } else {
        setMessage('Import started. Send the export with the upload details below.');
      }
      setName('');
      setFile(null);
      onStarted();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Move a community here</h2>
      <p className="small muted">
        Import a community’s history and files from its owner’s export. Everyone joins again
        afterwards, and the owner claims it with a link.
      </p>
      <form onSubmit={(event) => void start(event)}>
        <div className="field">
          <label htmlFor="host-import-name">Name</label>
          <input
            id="host-import-name"
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="host-import-file">Export file (.zip)</label>
          <input
            id="host-import-file"
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <span className="hint">Leave empty to get upload details for whoever has the file.</span>
        </div>
        <button className="button primary" disabled={busy}>
          Start import
        </button>
      </form>
      {error && (
        <p role="alert" className="notice error small mt-3">
          {error}
        </p>
      )}
      <p className="small mt-3" aria-live="polite">
        {message}
      </p>
      {link && (
        <div className="notice mt-3">
          <strong>Upload details</strong>
          <p className="small">
            Shown once. Send the export with <code>PUT</code> to this address, with the token as a
            bearer credential, its size in <code>Content-Length</code>, and its SHA-256 in{' '}
            <code>X-Archive-SHA256</code>. The token works for 24 hours.
          </p>
          <div className="field">
            <label htmlFor="host-import-url">Upload address</label>
            <input id="host-import-url" readOnly value={link.url} />
          </div>
          <div className="field mb-0">
            <label htmlFor="host-import-token">Upload token</label>
            <input id="host-import-token" readOnly value={link.token} />
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * One import's progress on its community's record: where it stands, what the export holds
 * once checked, and the actions that fit (commit a checked import, cancel an unfinished one).
 */
export function HostImportStatus({
  importId,
  onChanged,
}: {
  importId: string;
  onChanged: () => void;
}) {
  const [current, setCurrent] = useState<HostImport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCurrent(await request<HostImport>(`/api/v1/host/imports/${importId}`));
      setError('');
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [importId]);
  useEffect(() => {
    void load();
  }, [load]);
  const working = current?.state === 'validating' || current?.state === 'restoring';
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void load(), 3_000);
    return () => window.clearInterval(timer);
  }, [working, load]);

  async function act(action: 'commit' | 'cancel') {
    setBusy(true);
    setError('');
    try {
      setCurrent(
        await request<HostImport>(`/api/v1/host/imports/${importId}/${action}`, 'POST', {})
      );
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!current) return error ? <p className="small notice error">{error}</p> : null;
  const report = current.report;
  return (
    <div className="mt-3" aria-label="Import">
      <p className="small mb-1" aria-live="polite">
        <strong>Import:</strong> {STATES[current.state]}
      </p>
      {current.failureCode && (
        <p className="small notice error">
          {FAILURES[current.failureCode] ?? 'The import could not finish.'}
        </p>
      )}
      {report && (
        <p className="small muted">
          {report.channels.toLocaleString()} channels, {report.entries.toLocaleString()} messages,{' '}
          {report.attachments.toLocaleString()} files (
          {(report.attachmentBytes / 1024 / 1024).toFixed(1)} MiB),{' '}
          {report.historicalMembers.toLocaleString()} past members,{' '}
          {report.historicalAgents.toLocaleString()} past agents.
        </p>
      )}
      <div className="row flex-wrap gap-2">
        {current.state === 'validated' && (
          <button className="button primary" disabled={busy} onClick={() => void act('commit')}>
            Import now
          </button>
        )}
        {['awaiting_upload', 'validating', 'validated', 'restoring'].includes(current.state) && (
          <button className="button" disabled={busy} onClick={() => void act('cancel')}>
            Cancel import
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="notice error small mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
