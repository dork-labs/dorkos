import { Button, Input, Label, Notice } from '@dork-labs/ui';
import { useCallback, useRef, useState } from 'react';
import { describeError, request } from '../api.js';
import { describeReauthenticationError } from '../account-controls.js';
import {
  categoryLabel,
  defaultNotify,
  EVIDENCE_WORDING,
  hostTargetLabel,
  TAKEDOWN_CATEGORIES,
  type HostTakedown,
  type TakedownCategory,
} from './takedowns.js';
import { FocusDialog } from '../components/CommunityAdministration.js';

type TargetKind = 'entry' | 'attachment' | 'icon';
type Page = { takedowns: HostTakedown[]; nextAfter: string | null; evidenceStore: boolean };

const PAGE_SIZE = 20;
const DEFAULT_CATEGORY: TakedownCategory = 'illegal_content';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TARGETS: { value: TargetKind; label: string; idLabel?: string }[] = [
  { value: 'entry', label: 'A message', idLabel: 'Message ID' },
  { value: 'attachment', label: 'A file', idLabel: 'File ID' },
  { value: 'icon', label: 'The community icon' },
];

/** The fields of a host community record the takedown section needs. */
export type TakedownCommunity = {
  id: string;
  name: string;
  legalHold: { since: string; reference: string | null } | null;
};

/**
 * One community's takedowns on the host page: take down a message, a file, or the icon by its
 * ID, and see where each takedown's copy for the authorities stands. Nothing here reads or shows
 * content; a takedown names content only by its ID.
 */
export function HostTakedowns({ community }: { community: TakedownCommunity }) {
  const [page, setPage] = useState<Page | null>(null);
  const [kind, setKind] = useState<TargetKind>('entry');
  const [targetId, setTargetId] = useState('');
  const [category, setCategory] = useState<TakedownCategory>(DEFAULT_CATEGORY);
  const [reference, setReference] = useState('');
  const [notify, setNotify] = useState(defaultNotify(DEFAULT_CATEGORY));
  const [password, setPassword] = useState('');
  const [releasing, setReleasing] = useState<HostTakedown | null>(null);
  const [releasePassword, setReleasePassword] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const prefix = `takedown-${community.id}`;
  const target = TARGETS.find((item) => item.value === kind)!;
  const trimmedId = targetId.trim();
  const ready = kind === 'icon' || UUID.test(trimmedId);

  const load = useCallback(
    async (after: string | null = null) => {
      const query = new URLSearchParams({ communityId: community.id, limit: String(PAGE_SIZE) });
      if (after) query.set('after', after);
      const body = await request<Page>(`/api/v1/host/takedowns?${query.toString()}`);
      setPage((current) =>
        after && current ? { ...body, takedowns: [...current.takedowns, ...body.takedowns] } : body
      );
    },
    [community.id]
  );
  const reload = useCallback(async () => {
    setError('');
    try {
      await load();
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [load]);

  async function run(work: () => Promise<void>, success: string, unchanged: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (cause) {
      setError(describeReauthenticationError(cause, unchanged));
      setBusy(false);
      return false;
    }
    // The change is made: say so, even if reading the list back fails.
    setMessage(success);
    try {
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
    return true;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return;
    const body = {
      target:
        kind === 'entry'
          ? { kind, entryId: trimmedId }
          : kind === 'attachment'
            ? { kind, attachmentId: trimmedId }
            : { kind },
      category,
      reference: reference.trim() || null,
      notify,
    };
    // A retry of the same request (a lost answer, a wrong password) reuses its key, so the
    // server never takes the same thing down twice.
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    const key = attempt.current.key;
    const done = await run(
      async () => {
        await request(`/api/v1/host/communities/${community.id}/takedowns`, 'POST', {
          ...body,
          idempotencyKey: key,
          password,
        });
      },
      `Taken down. Members of ${community.name} no longer see it.`,
      'Nothing was taken down.'
    );
    setPassword('');
    if (done) {
      // The next case starts clean: a reason or tell box changed by hand never carries over.
      attempt.current = null;
      setTargetId('');
      setReference('');
      setCategory(DEFAULT_CATEGORY);
      setNotify(defaultNotify(DEFAULT_CATEGORY));
    }
  }

  async function retry(takedown: HostTakedown) {
    await run(
      () => request(`/api/v1/host/takedowns/${takedown.id}/evidence/retry`, 'POST', {}),
      'Saving the copy again.',
      'Nothing changed.'
    );
  }

  function closeRelease() {
    setReleasing(null);
    setReleasePassword('');
    setDialogError('');
  }

  async function release() {
    if (!releasing) return;
    setBusy(true);
    setDialogError('');
    setMessage('');
    try {
      await request(`/api/v1/host/takedowns/${releasing.id}/release-held`, 'POST', {
        password: releasePassword,
      });
      closeRelease();
      await load();
      setMessage('Released. The kept copy will be deleted.');
    } catch (cause) {
      setDialogError(describeReauthenticationError(cause, 'Nothing was released.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="mt-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !page) void reload();
      }}
    >
      <summary className="small cursor-pointer">Take down content</summary>
      <section className="mt-2" aria-label={`${community.name} takedowns`}>
        {error && (
          <Notice role="alert" tone="error" className="small mb-3">
            {error}
          </Notice>
        )}
        {message && (
          <Notice role="status" tone="success" className="small mb-3">
            {message}
          </Notice>
        )}
        {!page && !error && <p className="small muted">Loading takedowns…</p>}
        {page && (
          <>
            {!page.evidenceStore && (
              <Notice tone="info" className="small mb-3">
                <strong>
                  Takedowns won’t keep a copy for the authorities. Set an evidence store first if
                  you need one.
                </strong>
              </Notice>
            )}
            <p className="small muted">
              Use the IDs from a report. Members stop seeing it at once. You never see what it said.
            </p>
            <form
              onSubmit={(event) => void submit(event)}
              aria-label={`Take down in ${community.name}`}
            >
              <div className="field">
                <Label htmlFor={`${prefix}-kind`}>What to take down</Label>
                <select
                  id={`${prefix}-kind`}
                  value={kind}
                  onChange={(event) => setKind(event.target.value as TargetKind)}
                >
                  {TARGETS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              {target.idLabel && (
                <div className="field">
                  <Label htmlFor={`${prefix}-id`}>{target.idLabel}</Label>
                  <Input
                    id={`${prefix}-id`}
                    className="font-mono"
                    value={targetId}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    aria-describedby={`${prefix}-id-hint`}
                    onChange={(event) => setTargetId(event.target.value)}
                  />
                  <span id={`${prefix}-id-hint`} className="hint">
                    {trimmedId && !ready
                      ? 'That is not an ID. It looks like 0b6c1a52-7e1f-4d0e-9a53-3c1e2b7f9d10.'
                      : 'The report link gives it as “entry” for a message, “attachment” for a file.'}
                  </span>
                </div>
              )}
              <div className="field">
                <Label htmlFor={`${prefix}-category`}>Reason</Label>
                <select
                  id={`${prefix}-category`}
                  value={category}
                  onChange={(event) => {
                    const next = event.target.value as TakedownCategory;
                    setCategory(next);
                    setNotify(defaultNotify(next));
                  }}
                >
                  {TAKEDOWN_CATEGORIES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <Label htmlFor={`${prefix}-reference`}>Your case number (optional)</Label>
                <Input
                  id={`${prefix}-reference`}
                  value={reference}
                  maxLength={64}
                  pattern="[A-Za-z0-9._:\-]{1,64}"
                  autoComplete="off"
                  aria-describedby={`${prefix}-reference-hint`}
                  onChange={(event) => setReference(event.target.value)}
                />
                <span id={`${prefix}-reference-hint`} className="hint">
                  Letters, numbers, and . _ : - only. The owner and the author see it.
                </span>
              </div>
              <div className="mb-4">
                <Label className="flex min-h-11 items-center gap-3 md:min-h-0">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={notify}
                    aria-describedby={`${prefix}-notify-hint`}
                    onChange={(event) => setNotify(event.target.checked)}
                  />
                  Tell the owner and the author
                </Label>
                <span id={`${prefix}-notify-hint`} className="small muted mt-1 block pl-7">
                  {category === 'child_safety'
                    ? 'Off for child safety: telling the uploader can warn someone under investigation.'
                    : 'They see the reason and your case number, never who reported it.'}
                </span>
              </div>
              <div className="field">
                <Label htmlFor={`${prefix}-password`}>Your password</Label>
                <Input
                  id={`${prefix}-password`}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  required
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              <Button type="submit" variant="destructive" disabled={busy || !ready || !password}>
                Take down
              </Button>
            </form>
            <h3 className="mt-8 mb-2 text-base">Takedowns</h3>
            {page.takedowns.length === 0 ? (
              <p className="small muted">Nothing has been taken down here.</p>
            ) : (
              <ul className="stack m-0 list-none p-0">
                {page.takedowns.map((takedown) => (
                  <TakedownRow
                    key={takedown.id}
                    takedown={takedown}
                    evidenceStore={page.evidenceStore}
                    legalHold={community.legalHold !== null}
                    busy={busy}
                    onRetry={() => void retry(takedown)}
                    onRelease={() => setReleasing(takedown)}
                  />
                ))}
              </ul>
            )}
            {page.nextAfter && (
              <Button
                variant="outline"
                className="mt-3"
                disabled={busy}
                onClick={() =>
                  void load(page.nextAfter).catch((cause: unknown) =>
                    setError(describeError(cause))
                  )
                }
              >
                Show older takedowns
              </Button>
            )}
          </>
        )}
      </section>
      {releasing && (
        <FocusDialog title="Release the kept copy?" onClose={closeRelease} error={dialogError}>
          <p>
            What this server kept for {hostTargetLabel(releasing.target).toLowerCase()} is deleted
            without a copy for the authorities. This can’t be undone.
          </p>
          <div className="field">
            <Label htmlFor={`${prefix}-release-password`}>Your password</Label>
            <Input
              id={`${prefix}-release-password`}
              type="password"
              autoComplete="current-password"
              value={releasePassword}
              onChange={(event) => setReleasePassword(event.target.value)}
            />
          </div>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={closeRelease}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !releasePassword}
              onClick={() => void release()}
            >
              Release and delete
            </Button>
          </div>
        </FocusDialog>
      )}
    </details>
  );
}

/** One takedown: what, why, when, whether people were told, and where its copy stands. */
function TakedownRow({
  takedown,
  evidenceStore,
  legalHold,
  busy,
  onRetry,
  onRelease,
}: {
  takedown: HostTakedown;
  evidenceStore: boolean;
  legalHold: boolean;
  busy: boolean;
  onRetry: () => void;
  onRelease: () => void;
}) {
  const state = takedown.evidence.state;
  const held = state === 'held_on_primary';
  const label = hostTargetLabel(takedown.target);
  return (
    <li className="panel-alt p-3" aria-label={`${label} takedown`}>
      <p className="small mb-1 [overflow-wrap:anywhere]">
        <strong>{label}</strong>
      </p>
      <p className="small muted mb-1">
        {categoryLabel(takedown.category)}
        {takedown.reference ? ` (${takedown.reference})` : ''} ·{' '}
        <time dateTime={takedown.createdAt}>{new Date(takedown.createdAt).toLocaleString()}</time> ·{' '}
        {takedown.notify ? 'Owner and author told' : 'Owner and author not told'}
      </p>
      <p className="small mb-0">
        {EVIDENCE_WORDING[state]}
        {takedown.evidence.overdue && (
          <strong className="ml-1">· Overdue: check the evidence store.</strong>
        )}
      </p>
      {held && legalHold && (
        <p className="small muted mt-1 mb-0">
          It can’t be released while this community is under a legal hold.
        </p>
      )}
      {(state === 'failed' || (held && evidenceStore) || (held && !legalHold)) && (
        <div className="row mt-2 flex-wrap gap-2">
          {state === 'failed' && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
              Try again
            </Button>
          )}
          {held && evidenceStore && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>
              Save the copy now
            </Button>
          )}
          {held && !legalHold && (
            <Button variant="outline" size="sm" disabled={busy} onClick={onRelease}>
              Release
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
