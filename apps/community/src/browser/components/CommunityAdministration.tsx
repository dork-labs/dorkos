import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, ImagePlus, Trash2 } from 'lucide-react';
import { describeError, download, RequestError, request, tenantApiPath } from '../api.js';
import type { Member } from '../types.js';

type Settings = {
  communityId: string;
  name: string;
  description: string | null;
  admissionPolicy: 'invite_only' | 'closed';
  hasIcon: boolean;
  settingsVersion: number;
  lifecycle: 'pending_owner' | 'active' | 'archived' | 'suspended' | 'deletion_pending';
  lifecycleVersion: number;
};
type DeletionStatus = {
  communityId: string;
  lifecycle: 'active' | 'archived' | 'deletion_pending';
  lifecycleVersion: number;
  deleteAfter: string | null;
  state: 'waiting' | 'deleting' | 'retrying' | null;
  attempts: number;
};
type Conflict = { code?: string; message?: string; current?: Settings };
type DialogKind = 'archive' | 'restore' | 'delete' | 'cancel-delete';

async function settingsRequest<T>(method: 'GET' | 'PATCH', body?: unknown, etag?: string) {
  const response = await fetch(tenantApiPath('/api/v1/settings'), {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(etag ? { 'if-match': etag } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let error: Conflict = {};
    try {
      error = (await response.json()) as Conflict;
    } catch {
      /* Keep the safe fallback. */
    }
    const cause = new RequestError(
      response.status,
      error.code ?? 'UNAVAILABLE',
      error.message ?? 'Something went wrong. Try again.'
    );
    Object.assign(cause, { current: error.current });
    throw cause;
  }
  return { body: (await response.json()) as T, etag: response.headers.get('etag') };
}

async function mutationError(response: Response, fallback: string) {
  let error: Conflict = {};
  try {
    error = (await response.json()) as Conflict;
  } catch {
    /* Keep the safe fallback. */
  }
  const cause = new RequestError(
    response.status,
    error.code ?? 'UNAVAILABLE',
    error.message ?? fallback
  );
  Object.assign(cause, { current: error.current });
  return cause;
}

/** Keep keyboard focus inside one destructive confirmation and restore it on close. */
export function FocusDialog({
  title,
  children,
  onClose,
  error,
}: {
  title: string;
  error?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const root = panel.current;
    root?.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !root) return;
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>('button, input, select, textarea')
      ).filter((control) => !control.hasAttribute('disabled'));
      if (controls.length === 0) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="admin-dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        className="admin-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 id={titleId}>{title}</h3>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

function formatDeadline(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'the scheduled deadline';
}

function formatRemaining(value: string | null, now: number) {
  if (!value) return 'waiting for a deletion deadline';
  const remaining = Math.max(0, new Date(value).getTime() - now);
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return remaining === 0 ? 'deletion can begin now' : `${days}d ${hours}h ${minutes}m remaining`;
}

/** Present role-authorized community identity, access, archive, export, and deletion controls. */
export function CommunityAdministration({
  memberRole,
  onChanged,
  onOpenPeople,
}: {
  memberRole: Member['role'];
  onChanged: () => void;
  onOpenPeople: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [deletion, setDeletion] = useState<DeletionStatus | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [admissionPolicy, setAdmissionPolicy] = useState<'invite_only' | 'closed'>('invite_only');
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [password, setPassword] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [confirmIdSuffix, setConfirmIdSuffix] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const owner = memberRole === 'owner';
  const editor = owner || memberRole === 'admin';

  const adoptSettings = useCallback((current: Settings, resetDrafts: boolean) => {
    setSettings(current);
    setEtag(`"${current.settingsVersion}"`);
    if (resetDrafts) {
      setName(current.name);
      setDescription(current.description ?? '');
      setAdmissionPolicy(current.admissionPolicy);
    }
  }, []);
  const refresh = useCallback(async () => {
    try {
      const response = await settingsRequest<Settings>('GET');
      adoptSettings(response.body, true);
      setEtag(response.etag ?? `"${response.body.settingsVersion}"`);
      setDeletion(null);
      setError('');
    } catch (cause) {
      if (owner && cause instanceof RequestError && cause.code === 'COMMUNITY_DELETION_PENDING') {
        try {
          setDeletion(await request<DeletionStatus>('/api/v1/owner/deletion'));
          setError('');
          return;
        } catch (statusCause) {
          setError(describeError(statusCause));
          return;
        }
      }
      setError(describeError(cause));
    }
  }, [adoptSettings, owner]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!deletion?.deleteAfter) return;
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [deletion?.deleteAfter]);

  function resetDialog() {
    setDialog(null);
    setPassword('');
    setConfirmName('');
    setConfirmIdSuffix('');
  }
  async function perform(
    work: () => Promise<void>,
    success: string,
    refreshAfter = true,
    notifyShell = true
  ) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      if (refreshAfter) await refresh();
      if (notifyShell) onChanged();
      setMessage(success);
      resetDialog();
    } catch (cause) {
      const current = (cause as RequestError & { current?: Settings }).current;
      if (cause instanceof RequestError && cause.code === 'STATE_CONFLICT' && current) {
        adoptSettings(current, false);
        setError(
          'These settings changed elsewhere. Your edits are still here; review them and save again.'
        );
      } else {
        setError(describeError(cause));
      }
    } finally {
      setBusy(false);
    }
  }
  async function savePresentation(event: React.FormEvent) {
    event.preventDefault();
    if (!etag) return;
    await perform(
      async () => {
        const response = await settingsRequest<Settings>(
          'PATCH',
          owner ? { name, description: description || null } : { description: description || null },
          etag
        );
        adoptSettings(response.body, true);
        setEtag(response.etag ?? `"${response.body.settingsVersion}"`);
      },
      'Presentation saved.',
      false
    );
  }
  async function saveAccess(event: React.FormEvent) {
    event.preventDefault();
    if (!etag) return;
    await perform(
      async () => {
        const response = await settingsRequest<Settings>('PATCH', { admissionPolicy }, etag);
        adoptSettings(response.body, true);
        setEtag(response.etag ?? `"${response.body.settingsVersion}"`);
      },
      'Access saved.',
      false
    );
  }
  async function updateIcon(file: File) {
    if (!etag) return;
    await perform(
      async () => {
        const response = await fetch(tenantApiPath('/api/v1/settings/icon'), {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': file.type, 'if-match': etag },
          body: file,
        });
        if (!response.ok) throw await mutationError(response, 'The icon could not be saved.');
        adoptSettings((await response.json()) as Settings, false);
        setEtag(response.headers.get('etag'));
      },
      'Icon saved.',
      false
    );
  }
  async function removeIcon() {
    if (!etag) return;
    await perform(
      async () => {
        const response = await fetch(tenantApiPath('/api/v1/settings/icon'), {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'if-match': etag },
        });
        if (!response.ok) throw await mutationError(response, 'The icon could not be removed.');
        adoptSettings((await response.json()) as Settings, false);
        setEtag(response.headers.get('etag'));
      },
      'Icon removed.',
      false
    );
  }
  async function exportCommunity() {
    await perform(
      async () => {
        const body = await request<{ archiveId: string }>('/api/v1/owner/export', 'POST', {
          password,
        });
        await download(`/api/v1/exports/${body.archiveId}`, 'community-export.zip');
      },
      'Your community export is ready.',
      false
    );
    setPassword('');
  }
  async function submitLifecycle() {
    if (!settings || (dialog !== 'archive' && dialog !== 'restore')) return;
    const action = dialog;
    await perform(
      async () => {
        const next = await request<Settings>('/api/v1/owner/lifecycle', 'POST', {
          action,
          lifecycleVersion: settings.lifecycleVersion,
          password,
          ...(action === 'archive' ? { confirmName } : {}),
        });
        adoptSettings(next, true);
      },
      action === 'archive' ? `${settings.name} is archived.` : `${settings.name} is active again.`,
      false
    );
  }
  async function requestDeletion() {
    if (!settings) return;
    await perform(
      async () => {
        const next = await request<DeletionStatus>('/api/v1/owner/deletion', 'POST', {
          lifecycleVersion: settings.lifecycleVersion,
          password,
          confirmName,
          confirmIdSuffix,
        });
        setDeletion(next);
      },
      `${settings.name} is scheduled for deletion.`,
      false,
      false
    );
  }
  async function cancelDeletion() {
    if (!deletion) return;
    await perform(
      async () => {
        await request('/api/v1/owner/deletion/cancel', 'POST', {
          lifecycleVersion: deletion.lifecycleVersion,
          password,
        });
        setDeletion(null);
        await refresh();
      },
      'Deletion cancelled. The community remains archived.',
      false,
      false
    );
  }

  if (!settings && !deletion && !error)
    return (
      <div role="status" className="panel p-6">
        Loading community settings…
      </div>
    );
  if (!settings && !deletion)
    return (
      <div className="panel p-6">
        <p role="alert" className="notice error">
          {error}
        </p>
        <button className="button" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  if (deletion)
    return (
      <div className="settings-grid" aria-label="Community administration">
        {error && !dialog && (
          <div role="alert" className="notice error admin-full-width">
            {error}
          </div>
        )}
        {message && (
          <div role="status" className="notice success admin-full-width">
            {message}
          </div>
        )}
        <section className="panel admin-full-width">
          <h3>Deletion scheduled</h3>
          <p>
            This community is unavailable and will be permanently deleted after{' '}
            <strong>{formatDeadline(deletion.deleteAfter)}</strong>.
          </p>
          <p role="timer" className="eyebrow">
            {formatRemaining(deletion.deleteAfter, clock)}
          </p>
          <p className="small muted">
            Cleanup is {deletion.state ?? 'waiting'}
            {deletion.attempts ? ` after ${deletion.attempts} attempts` : ''}. Cancelling keeps the
            community archived and does not restore old credentials.
          </p>
          <button className="button" onClick={() => setDialog('cancel-delete')}>
            Cancel deletion
          </button>
        </section>
        {dialog === 'cancel-delete' && (
          <FocusDialog title="Cancel community deletion?" onClose={resetDialog} error={error}>
            <p>
              The community will return as an archive. People can read history after reconnecting.
            </p>
            <label className="field" htmlFor="cancel-delete-password">
              Password
              <input
                id="cancel-delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <div className="row justify-end gap-2">
              <button className="button" onClick={resetDialog}>
                Keep deletion scheduled
              </button>
              <button
                className="button primary"
                disabled={busy || !password}
                onClick={() => void cancelDeletion()}
              >
                Cancel deletion
              </button>
            </div>
          </FocusDialog>
        )}
      </div>
    );

  const current = settings!;
  const editable = editor && current.lifecycle === 'active';
  return (
    <div className="settings-grid" aria-label="Community administration">
      {error && !dialog && (
        <div role="alert" className="notice error admin-full-width">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="notice success admin-full-width">
          {message}
        </div>
      )}
      {current.lifecycle === 'archived' && (
        <section className="panel admin-full-width">
          <h3>Archived</h3>
          <p className="muted">
            History is read-only. Fresh read-only connections are available; existing connections
            and credentials remain revoked.
          </p>
        </section>
      )}
      {editor && (
        <section className="panel">
          <h3>Presentation</h3>
          <form onSubmit={(event) => void savePresentation(event)}>
            {owner && (
              <label className="field" htmlFor="community-title">
                Name
                <input
                  id="community-title"
                  value={name}
                  maxLength={80}
                  disabled={!editable || busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            <label className="field" htmlFor="community-description">
              Description
              <textarea
                id="community-description"
                value={description}
                maxLength={1000}
                disabled={!editable || busy}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <div className="field">
              <span>Icon</span>
              {current.hasIcon && (
                <img
                  className="community-icon-preview"
                  src={tenantApiPath('/api/v1/icon')}
                  alt="Current community icon"
                />
              )}
              <div className="row flex-wrap gap-2">
                <label className={`button ${!editable || busy ? 'disabled' : ''}`}>
                  <ImagePlus size={16} /> {current.hasIcon ? 'Replace icon' : 'Upload icon'}
                  <input
                    className="sr-only"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    disabled={!editable || busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void updateIcon(file);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                {current.hasIcon && (
                  <button
                    className="button"
                    type="button"
                    disabled={!editable || busy}
                    onClick={() => void removeIcon()}
                  >
                    <Trash2 size={16} /> Remove icon
                  </button>
                )}
              </div>
              <span className="small muted">PNG, JPEG, GIF, or WebP up to 2 MiB.</span>
            </div>
            <button className="button primary" disabled={!editable || busy}>
              Save presentation
            </button>
          </form>
        </section>
      )}
      {owner && (
        <section className="panel">
          <h3>Access</h3>
          <form onSubmit={(event) => void saveAccess(event)}>
            <p className="small muted">
              Closing access revokes every open invitation and pending admission.
            </p>
            <label className="field" htmlFor="community-admission">
              Admission policy
              <select
                id="community-admission"
                value={admissionPolicy}
                disabled={!editable || busy}
                onChange={(event) =>
                  setAdmissionPolicy(event.target.value as 'invite_only' | 'closed')
                }
              >
                <option value="invite_only">Invite only</option>
                <option value="closed">Closed</option>
              </select>
            </label>
            <button className="button primary" disabled={!editable || busy}>
              Save access
            </button>
          </form>
          <p className="small muted mb-0">Community ID: {current.communityId}</p>
        </section>
      )}
      {editor && (
        <section className="panel">
          <h3>People</h3>
          <p className="muted">Review members, roles, and channel access.</p>
          <button className="button" onClick={onOpenPeople}>
            Open people
          </button>
        </section>
      )}
      {owner && (
        <section className="panel">
          <h3>Export</h3>
          <p className="muted">
            Download a fresh snapshot before a lifecycle change. An export is not a server backup.
          </p>
          <label className="field" htmlFor="export-password">
            Password
            <input
              id="export-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            className="button"
            disabled={busy || !password}
            onClick={() => void exportCommunity()}
          >
            <Download size={16} /> Export community
          </button>
        </section>
      )}
      {owner && (
        <section className="panel admin-full-width">
          <h3>Danger zone</h3>
          <p className="small muted">
            Archive preserves history. Deletion permanently removes this community after seven days.
          </p>
          <div className="row flex-wrap gap-2">
            <button
              className="button danger"
              onClick={() => setDialog(current.lifecycle === 'archived' ? 'restore' : 'archive')}
            >
              {current.lifecycle === 'archived' ? 'Restore community' : 'Archive community'}
            </button>
            <button className="button danger" onClick={() => setDialog('delete')}>
              Schedule deletion
            </button>
          </div>
        </section>
      )}
      {(dialog === 'archive' || dialog === 'restore') && (
        <FocusDialog
          title={dialog === 'archive' ? `Archive ${current.name}?` : `Restore ${current.name}?`}
          onClose={resetDialog}
          error={error}
        >
          <p>
            {dialog === 'archive'
              ? 'Posting, invites, agents, and current connections will stop. History stays available.'
              : 'Posting becomes available again. Revoked credentials and agents stay inactive.'}
          </p>
          {dialog === 'archive' && (
            <label className="field" htmlFor="archive-name">
              Type {current.name}
              <input
                id="archive-name"
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
              />
            </label>
          )}
          <label className="field" htmlFor="lifecycle-password">
            Password
            <input
              id="lifecycle-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="row justify-end gap-2">
            <button className="button" onClick={resetDialog}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy || !password || (dialog === 'archive' && confirmName !== current.name)}
              onClick={() => void submitLifecycle()}
            >
              {dialog === 'archive' ? 'Archive community' : 'Restore community'}
            </button>
          </div>
        </FocusDialog>
      )}
      {dialog === 'delete' && (
        <FocusDialog
          title={`Permanently delete ${current.name}?`}
          onClose={resetDialog}
          error={error}
        >
          <p>
            Access ends immediately. After seven days, the community and its files are permanently
            removed.
          </p>
          <p className="small">
            <strong>Export first if you need a copy.</strong> You can still delete if an export
            fails.
          </p>
          <label className="field" htmlFor="delete-name">
            Type {current.name}
            <input
              id="delete-name"
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
            />
          </label>
          <label className="field" htmlFor="delete-id">
            Type the final eight characters: {current.communityId.slice(-8)}
            <input
              id="delete-id"
              value={confirmIdSuffix}
              onChange={(event) => setConfirmIdSuffix(event.target.value)}
            />
          </label>
          <label className="field" htmlFor="delete-password">
            Password
            <input
              id="delete-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="row justify-end gap-2">
            <button className="button" onClick={resetDialog}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={
                busy ||
                !password ||
                confirmName !== current.name ||
                confirmIdSuffix !== current.communityId.slice(-8)
              }
              onClick={() => void requestDeletion()}
            >
              Schedule permanent deletion
            </button>
          </div>
        </FocusDialog>
      )}
    </div>
  );
}
