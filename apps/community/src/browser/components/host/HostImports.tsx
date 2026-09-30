import { Button, Input, Label, Notice } from '@dork-labs/ui';
import { FileUp } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RequestError, describeError, request } from '../../api.js';
import { sha256OfFile } from '../../sha256.js';

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
  shortened: number;
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

/** A count with its noun, singular for one; `plural` when adding an s is wrong. */
function count(value: number, noun: string, plural = `${noun}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? noun : plural}`;
}

/** A byte size in the largest unit that keeps it above one. */
function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024).toLocaleString()} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

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
  const fileInput = useRef<HTMLInputElement>(null);

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
      if (fileInput.current) fileInput.current.value = '';
      onStarted();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel mt-4" aria-labelledby="host-import-title">
      <h2 id="host-import-title">Move a community here</h2>
      <p className="small muted">
        Import a community’s history and files from its owner’s export. Everyone joins again
        afterwards, and the owner claims it with a link.
      </p>
      <form onSubmit={(event) => void start(event)}>
        <div className="field">
          <Label htmlFor="host-import-name">Name of the moved community</Label>
          <Input
            id="host-import-name"
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="field">
          <Button
            asChild
            variant="outline"
            className={`justify-self-start ${busy ? 'pointer-events-none opacity-50' : ''}`}
          >
            {/* The input is invisible; Button shows its keyboard focus on the label around it. */}
            <Label className="relative">
              <FileUp size={16} /> {file ? 'Choose another file' : 'Choose export file'}
              <input
                ref={fileInput}
                // Laid over the whole button, border included, and invisible: the target to tap
                // is the button itself.
                className="absolute -inset-px cursor-pointer opacity-0"
                type="file"
                accept=".zip,application/zip"
                disabled={busy}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Label>
          </Button>
          <span className="hint">
            {file
              ? `${file.name} will be sent when the import starts.`
              : 'Leave empty to get upload details for whoever has the file.'}
          </span>
        </div>
        <Button type="submit" variant="default" disabled={busy}>
          Start import
        </Button>
      </form>
      {error && (
        <Notice role="alert" tone="error" className="mt-3">
          {error}
        </Notice>
      )}
      <p className="small mt-3" aria-live="polite">
        {message}
      </p>
      {link && (
        <Notice tone="info" className="mt-3">
          <strong>Upload details</strong>
          <p className="small">
            Shown once. Send the export with <code>PUT</code> to this address, with the token as a
            bearer credential, its size in <code>Content-Length</code>, and its SHA-256 in{' '}
            <code>X-Archive-SHA256</code>. The token works for 24 hours.
          </p>
          <div className="field">
            <Label htmlFor="host-import-url">Upload address</Label>
            <Input id="host-import-url" readOnly value={link.url} />
          </div>
          <div className="field mb-0">
            <Label htmlFor="host-import-token">Upload token</Label>
            <Input id="host-import-token" readOnly value={link.token} />
          </div>
        </Notice>
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

  if (!current)
    return error ? (
      <Notice role="alert" tone="error">
        {error}
      </Notice>
    ) : null;
  const report = current.report;
  return (
    <div className="mt-3" role="group" aria-label="Import">
      <p className="small mb-1" aria-live="polite">
        <strong>Import:</strong> {STATES[current.state]}
      </p>
      {current.failureCode && (
        <Notice tone="error" className="mb-2">
          {FAILURES[current.failureCode] ?? 'The import could not finish.'}
        </Notice>
      )}
      {report && (
        <p className="small muted">
          {count(report.channels, 'channel')}, {count(report.entries, 'message')},{' '}
          {count(report.attachments, 'file')} ({size(report.attachmentBytes)}),{' '}
          {count(report.historicalMembers, 'past member')},{' '}
          {count(report.historicalAgents, 'past agent')}.
          {report.shortened > 0 &&
            ` ${count(report.shortened, 'channel name or description', 'channel names or descriptions')} ${
              report.shortened === 1 ? 'was' : 'were'
            } too long for this host and ${current.state === 'ready' ? 'have been' : 'will be'} shortened.`}
        </p>
      )}
      <div className="row flex-wrap gap-2">
        {current.state === 'validated' && (
          <Button variant="default" disabled={busy} onClick={() => void act('commit')}>
            Import now
          </Button>
        )}
        {['awaiting_upload', 'validating', 'validated', 'restoring'].includes(current.state) && (
          <Button variant="outline" disabled={busy} onClick={() => void act('cancel')}>
            Cancel import
          </Button>
        )}
      </div>
      {error && (
        <Notice role="alert" tone="error" className="mt-2">
          {error}
        </Notice>
      )}
    </div>
  );
}
