import { Button, Input, Label, Notice } from '@dork-labs/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  COMMUNITY_OWNER_REPLACEMENT_REFERENCE_PATTERN,
  type CommunityAdminHostCapabilitiesSchema,
} from '@dorkos/shared/community-admin-wire';
import type { z } from 'zod';
import { describeError, request } from '../api.js';
import { CopyableLink } from '../connect/CopyableLink.js';
import { FocusDialog } from '../components/CommunityAdministration.js';
import {
  activeCooldown,
  cooldownSentence,
  hostRowSentence,
  REASON_LABELS,
  replacementDate,
  type HostReplacement,
  type ReplacementReason,
} from './copy.js';

/** What this host can do: send mail, and sign people in through its own sign-in service. */
export type HostCapabilities = z.infer<typeof CommunityAdminHostCapabilitiesSchema>;

/**
 * What the host page needs to know before offering Replace the owner: whether this host sends
 * mail and has single sign-on, and whether the signed-in operator has a password to confirm
 * with (one who signs in only through single sign-on does not). Read once per page.
 */
export function useReplacementAbilities(): {
  capabilities: HostCapabilities | null;
  hasPassword: boolean;
} {
  const [capabilities, setCapabilities] = useState<HostCapabilities | null>(null);
  const [hasPassword, setHasPassword] = useState(true);
  useEffect(() => {
    let active = true;
    request<HostCapabilities>('/api/v1/host/capabilities').then(
      (body) => active && setCapabilities(body),
      () => {}
    );
    request<{ password: boolean }>('/api/v1/account/sign-in-methods').then(
      (body) => active && setHasPassword(body.password),
      () => {}
    );
    return () => {
      active = false;
    };
  }, []);
  return { capabilities, hasPassword };
}

/** The fields of a host community record this section reads. */
export type ReplaceableCommunity = {
  id: string;
  name: string;
  lifecycle: string;
  lifecycleVersion: number;
  /** The open request, if any, from the host projection. */
  ownerReplacement: {
    replacementId: string;
    state: 'notifying' | 'waiting' | 'claimable';
    claimableAfter: string | null;
  } | null;
};

const OPEN_STATES = new Set(['notifying', 'waiting', 'claimable']);
/** The lifecycles a host can ask to replace an owner in. */
const REPLACEABLE = new Set(['active', 'archived', 'held']);
const REASONS: ReplacementReason[] = ['owner_left_group', 'owner_unreachable', 'other'];

/** Why the host can't ask right now, or null when it can. */
function blockedSentence(
  capabilities: HostCapabilities,
  hasPassword: boolean,
  replacements: HostReplacement[]
): string | null {
  if (!capabilities.mail)
    return 'This host can’t send email, so it can’t give the owner notice. Set up mail first.';
  if (!hasPassword) return 'Use a host API key with the ownership scope to do this.';
  const cooldown = activeCooldown(replacements, Date.now());
  return cooldown ? cooldownSentence(cooldown) : null;
}

/** The claim link, shown once, with what to do with it. */
function ClaimLinkReveal({ link, reissued }: { link: string; reissued: boolean }) {
  return (
    <Notice tone="info" className="mt-3" role="status">
      <strong>
        Send this link to the new owner. It works only after the waiting period, and only once.
      </strong>
      {reissued && <p className="small mb-0">The link you sent before no longer works.</p>}
      <CopyableLink label="Link for the new owner" link={link} />
      <p className="small muted mb-0">It won’t be shown again.</p>
    </Notice>
  );
}

/**
 * The Owner part of a host community record: every request to replace the owner with its state
 * in words, Cancel and Send the claim link again on an open one, and Replace the owner. Only
 * ids, states, dates, the reason and the host's own reference; never who the owner is.
 */
export function HostOwnerReplacement({
  community,
  capabilities,
  hasPassword,
  onChanged,
}: {
  community: ReplaceableCommunity;
  /** Null until the page has read them. */
  capabilities: HostCapabilities | null;
  /** Whether the signed-in host operator has a password to confirm a request with. */
  hasPassword: boolean;
  onChanged: () => Promise<void>;
}) {
  const [replacements, setReplacements] = useState<HostReplacement[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [claimLink, setClaimLink] = useState<{ link: string; reissued: boolean } | null>(null);
  const [dialog, setDialog] = useState<
    { kind: 'request' } | { kind: 'cancel' | 'resend'; replacementId: string } | null
  >(null);
  const [reason, setReason] = useState<ReplacementReason | null>(null);
  const [reference, setReference] = useState('');
  const [subject, setSubject] = useState('');
  const [password, setPassword] = useState('');
  const [dialogError, setDialogError] = useState('');
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  // Open from the start while a request is open; after that only the host opens or closes it.
  const [expanded, setExpanded] = useState(community.ownerReplacement !== null);

  const load = useCallback(async () => {
    setError('');
    try {
      const body = await request<{ replacements: HostReplacement[] }>(
        `/api/v1/host/communities/${community.id}/owner-replacements`
      );
      setReplacements(body.replacements);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [community.id]);

  function closeDialog() {
    setDialog(null);
    setDialogError('');
    setPassword('');
  }

  async function act(work: () => Promise<void>, done: string) {
    setBusy(true);
    setDialogError('');
    setMessage('');
    try {
      await work();
      closeDialog();
      await load();
      await onChanged();
      setMessage(done);
    } catch (cause) {
      setDialogError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function submitRequest(event: React.FormEvent) {
    event.preventDefault();
    const body = {
      lifecycleVersion: community.lifecycleVersion,
      reason: reason!,
      reference: reference.trim() === '' ? null : reference.trim(),
      claimant: { oidcSubject: capabilities?.oidc ? subject.trim() : null },
    };
    // A retry of the same request replays it rather than asking twice.
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    const idempotencyKey = attempt.current.key;
    void act(async () => {
      const created = await request<{ claimUrl: string | null; replayed: boolean }>(
        `/api/v1/host/communities/${community.id}/owner-replacements`,
        'POST',
        { ...body, idempotencyKey, password }
      );
      attempt.current = null;
      setReason(null);
      setReference('');
      setSubject('');
      setClaimLink(created.claimUrl ? { link: created.claimUrl, reissued: false } : null);
    }, 'Request sent. The owner is being told by email and in the community.');
  }

  const rows = replacements ?? [];
  const open = rows.find((row) => OPEN_STATES.has(row.state)) ?? null;
  const blocked = capabilities ? blockedSentence(capabilities, hasPassword, rows) : null;
  const canAsk = REPLACEABLE.has(community.lifecycle) && open === null;
  const referenceValid =
    reference.trim() === '' || COMMUNITY_OWNER_REPLACEMENT_REFERENCE_PATTERN.test(reference.trim());
  const id = (field: string) => `owner-replacement-${field}-${community.id}`;

  return (
    <details
      className="mt-3"
      open={expanded}
      onToggle={(event) => {
        const nowOpen = event.currentTarget.open;
        setExpanded(nowOpen);
        if (nowOpen && replacements === null) void load();
      }}
    >
      <summary className="small cursor-pointer">Owner</summary>
      <section className="mt-2" aria-label={`Owner of ${community.name}`}>
        {error && (
          <Notice role="alert" tone="error" className="small">
            {error}
          </Notice>
        )}
        {replacements === null && !error && <p className="small muted">Loading requests…</p>}
        {replacements !== null && (
          <>
            {rows.length === 0 && <p className="small">No change requested.</p>}
            {rows.length > 0 && (
              <ul className="stack small m-0 list-none p-0">
                {rows.map((row) => (
                  <li key={row.replacementId} className="panel-alt p-3">
                    <p className="mb-1">{hostRowSentence(row)}</p>
                    <p className="muted mb-0">
                      Asked on {replacementDate(row.requestedAt)} by {row.requestedBy.label}.{' '}
                      {REASON_LABELS[row.reason]}.
                      {row.reference !== null && <> Your reference: {row.reference}.</>}
                    </p>
                    {OPEN_STATES.has(row.state) && (
                      <div className="row mt-2 flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setDialog({ kind: 'cancel', replacementId: row.replacementId })
                          }
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            setDialog({ kind: 'resend', replacementId: row.replacementId })
                          }
                        >
                          Send the claim link again
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canAsk && (
              <div className="mt-3">
                <Button
                  variant="outline"
                  disabled={busy || capabilities === null || blocked !== null}
                  aria-describedby={blocked ? id('blocked') : undefined}
                  onClick={() => setDialog({ kind: 'request' })}
                >
                  Replace the owner
                </Button>
                {blocked && (
                  <p id={id('blocked')} className="small muted mt-1 mb-0">
                    {blocked}
                  </p>
                )}
              </div>
            )}
            <p className="small mt-2 mb-0" aria-live="polite">
              {message}
            </p>
            {claimLink && <ClaimLinkReveal link={claimLink.link} reissued={claimLink.reissued} />}
          </>
        )}
      </section>
      {dialog?.kind === 'request' && capabilities && (
        <FocusDialog
          title={`Replace the owner of ${community.name}?`}
          error={dialogError}
          onClose={closeDialog}
        >
          <p>
            The owner is told by email and in the community, and can keep ownership. If they don’t,
            the account named in the request can take ownership after the waiting period.
          </p>
          <form onSubmit={submitRequest}>
            <fieldset className="field">
              <legend>Reason</legend>
              {REASONS.map((value) => (
                <Label key={value} htmlFor={id(value)} className="flex items-start gap-3">
                  <input
                    id={id(value)}
                    type="radio"
                    name={id('reason')}
                    className="mt-1 size-4 shrink-0"
                    checked={reason === value}
                    onChange={() => setReason(value)}
                    required
                  />
                  <span>{REASON_LABELS[value]}</span>
                </Label>
              ))}
            </fieldset>
            <div className="field">
              <Label htmlFor={id('reference')}>Your reference (optional)</Label>
              <Input
                id={id('reference')}
                value={reference}
                maxLength={80}
                autoComplete="off"
                aria-invalid={!referenceValid}
                aria-describedby={id('reference-hint')}
                onChange={(event) => setReference(event.target.value)}
              />
              <span id={id('reference-hint')} className="hint">
                A ticket or case number: letters, digits, spaces, and . _ # -. The owner sees it;
                members don’t.
              </span>
            </div>
            {capabilities.oidc && (
              <div className="field">
                <Label htmlFor={id('subject')}>Sign-in ID of the new owner</Label>
                <Input
                  id={id('subject')}
                  value={subject}
                  maxLength={255}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  aria-describedby={id('subject-hint')}
                  onChange={(event) => setSubject(event.target.value)}
                />
                <span id={id('subject-hint')} className="hint">
                  The ID your sign-in service gives this person for this site. Only that account can
                  accept.
                </span>
              </div>
            )}
            <div className="field">
              <Label htmlFor={id('password')}>Your password</Label>
              <Input
                id={id('password')}
                type="password"
                autoComplete="current-password"
                value={password}
                required
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="row justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={busy || reason === null || !referenceValid}
              >
                Send the request
              </Button>
            </div>
          </form>
        </FocusDialog>
      )}
      {dialog?.kind === 'cancel' && (
        <FocusDialog title="Cancel this request?" error={dialogError} onClose={closeDialog}>
          <p>
            The owner will be told it was withdrawn. Another request within 30 days has the longer
            wait.
          </p>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={closeDialog}>
              Keep the request
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await request(
                    `/api/v1/host/communities/${community.id}/owner-replacements/${dialog.replacementId}/cancel`,
                    'POST',
                    {}
                  );
                  setClaimLink(null);
                }, 'Request withdrawn.')
              }
            >
              Cancel request
            </Button>
          </div>
        </FocusDialog>
      )}
      {dialog?.kind === 'resend' && (
        <FocusDialog title="Send the claim link again?" error={dialogError} onClose={closeDialog}>
          <p>The owner will be told that the link was sent again.</p>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const body = await request<{ claimUrl: string }>(
                    `/api/v1/host/communities/${community.id}/owner-replacements/${dialog.replacementId}/claim-token`,
                    'POST',
                    {}
                  );
                  setClaimLink({ link: body.claimUrl, reissued: true });
                }, 'A new claim link is ready. The owner is being told.')
              }
            >
              Send it again
            </Button>
          </div>
        </FocusDialog>
      )}
    </details>
  );
}
