import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CommunityWireErasure,
  CommunityWireMembershipSummary,
} from '@dorkos/shared/community-wire';
import { describeError, hostRequest } from '../api.js';

type FormerMembership = {
  communityId: string;
  communityName: string;
  leftAt: string | null;
  erasure: CommunityWireErasure | null;
};

/** Every screen that starts an erasure says, in these words, what it cannot reach. */
export const CANNOT_REACH =
  "We can't reach copies on other people's computers, including files they downloaded and anything their agents saved, or the host's backups for as long as it keeps them.";

/** Fired on window whenever this page asks for or cancels an erasure, so every panel reloads. */
const CHANGED = 'community-erasures-changed';

function announceChange(): void {
  window.dispatchEvent(new Event(CHANGED));
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** The signed-in account's open and recently cancelled erasures, kept current across panels. */
function useErasures() {
  const [erasures, setErasures] = useState<CommunityWireErasure[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    hostRequest<{ erasures: CommunityWireErasure[] }>('/api/v1/account/erasures')
      .then((body) => {
        setErasures(body.erasures);
        setError('');
      })
      .catch((cause: unknown) => setError(describeError(cause)));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [load]);
  return { erasures, error };
}

async function cancelErasure(id: string): Promise<void> {
  await hostRequest(`/api/v1/account/erasures/${encodeURIComponent(id)}/cancel`, 'POST', {});
  announceChange();
}

function PasswordField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Confirm password</label>
      <input
        id={id}
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="small muted mb-0">
        If you sign in with Google or GitHub, leave this empty. You may be asked to sign in again
        first.
      </p>
    </div>
  );
}

/** One community's erasure form: type its name, confirm, and schedule. */
function EraseMembershipForm({
  communityId,
  communityName,
  idPrefix,
  active,
}: {
  communityId: string;
  communityName: string;
  idPrefix: string;
  /** Whether the person is still a member, so the erasure will also end their membership. */
  active: boolean;
}) {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The fields stay folded away until asked for, so they never sit beside the leave form's.
  const [open, setOpen] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) nameInput.current?.focus();
  }, [open]);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await hostRequest('/api/v1/account/erasures', 'POST', {
        kind: 'membership',
        communityId,
        ...(password ? { password } : {}),
      });
      setPassword('');
      announceChange();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="small">
        In 72 hours, we&apos;ll remove your name, messages, files, and your agents&apos; messages
        from {communityName}. Your messages stay in their place in conversations, marked &ldquo;This
        message was erased.&rdquo; You can cancel until then.
      </p>
      {active && (
        <p className="small">
          When it runs, you&apos;ll leave {communityName}. Anything you post before then is erased
          too.
        </p>
      )}
      <p className="small muted">{CANNOT_REACH}</p>
      <button
        className="button"
        type="button"
        hidden={open}
        aria-expanded={open}
        aria-controls={`${idPrefix}-fields`}
        onClick={() => setOpen(true)}
      >
        Continue to erase
      </button>
      {open && (
        <div id={`${idPrefix}-fields`}>
          <div className="field">
            <label htmlFor={`${idPrefix}-name`}>Enter {communityName}</label>
            <input
              ref={nameInput}
              id={`${idPrefix}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <PasswordField id={`${idPrefix}-password`} value={password} onChange={setPassword} />
          {error && (
            <p role="alert" className="notice error">
              {error}
            </p>
          )}
          <button
            className="button danger"
            type="button"
            disabled={busy || name !== communityName}
            onClick={() => void submit()}
          >
            Erase my messages
          </button>
        </div>
      )}
    </>
  );
}

/** A scheduled erasure's date and its cancel button, or that it is running now. */
function Scheduled({ erasure, text }: { erasure: CommunityWireErasure; text: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (erasure.state === 'running')
    return (
      <div role="status" className="notice">
        <p className="mb-0">Erasing now. It can no longer be cancelled.</p>
      </div>
    );
  return (
    <div role="status" className="notice">
      <p className="mb-2">
        {text} {when(erasure.executeAfter)}.
      </p>
      {error && <p className="small mb-2">{error}</p>}
      <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          cancelErasure(erasure.id)
            .catch((cause: unknown) => setError(describeError(cause)))
            .finally(() => setBusy(false));
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function scheduledFor(erasures: CommunityWireErasure[] | null, communityId: string) {
  return erasures?.find(
    (erasure) =>
      erasure.kind === 'membership' &&
      erasure.communityId === communityId &&
      (erasure.state === 'scheduled' || erasure.state === 'running')
  );
}

/** Inside a community: the person's own scheduled erasure of it, with a way to cancel. */
export function ErasureBanner({ communityId }: { communityId: string }) {
  const { erasures } = useErasures();
  const scheduled = scheduledFor(erasures, communityId);
  if (!scheduled) return null;
  return (
    <div className="m-3">
      <Scheduled erasure={scheduled} text="Your messages here will be erased on" />
    </div>
  );
}

/** Manage › Account: erase your messages from this community. */
export function EraseMembershipPanel({
  communityId,
  communityName,
  owner,
}: {
  communityId: string;
  communityName: string;
  /** The active owner, who must hand over or delete the community first. */
  owner: boolean;
}) {
  const { erasures, error } = useErasures();
  const scheduled = scheduledFor(erasures, communityId);
  return (
    <section className="panel" aria-labelledby="erase-membership-title">
      <h3 id="erase-membership-title">Erase your messages here</h3>
      {owner ? (
        <p className="small muted">
          Transfer ownership or delete the community before you erase your messages here.
        </p>
      ) : scheduled ? (
        <Scheduled erasure={scheduled} text="Your messages here will be erased on" />
      ) : (
        <EraseMembershipForm
          communityId={communityId}
          communityName={communityName}
          idPrefix="erase-membership"
          active
        />
      )}
      {error && <p className="small muted">{error}</p>}
      <p className="small mb-0">
        {/* At least 24px tall, so it meets the minimum target size. */}
        <a href="/?account" className="inline-flex min-h-6 items-center">
          Delete your account
        </a>
      </p>
    </section>
  );
}

/**
 * The host root's account panels: scheduled erasures, communities the person left, and
 * deleting the whole account.
 */
export function AccountErasurePanels({
  memberships,
}: {
  memberships: CommunityWireMembershipSummary[];
}) {
  const { erasures, error } = useErasures();
  const [former, setFormer] = useState<FormerMembership[] | null>(null);
  const [erasing, setErasing] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [formerError, setFormerError] = useState('');
  const loadFormer = useCallback(() => {
    hostRequest<{ memberships: FormerMembership[] }>('/api/v1/account/former-memberships')
      .then((body) => {
        setFormer(body.memberships);
        setFormerError('');
      })
      .catch((cause: unknown) =>
        setFormerError(`Communities you left could not be shown. ${describeError(cause)}`)
      );
  }, []);
  useEffect(() => {
    loadFormer();
    window.addEventListener(CHANGED, loadFormer);
    return () => window.removeEventListener(CHANGED, loadFormer);
  }, [loadFormer]);
  const owned = memberships.filter((membership) => membership.role === 'owner');
  const scheduled = (erasures ?? []).filter(
    (erasure) => erasure.state === 'scheduled' || erasure.state === 'running'
  );
  const account = scheduled.find((erasure) => erasure.kind === 'account');
  async function deleteAccount() {
    setBusy(true);
    setFormError('');
    try {
      await hostRequest('/api/v1/account/erasures', 'POST', {
        kind: 'account',
        confirmEmail: email,
        ...(password ? { password } : {}),
      });
      setPassword('');
      announceChange();
    } catch (cause) {
      setFormError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack mt-6">
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {formerError && (
        <p role="alert" className="notice error">
          {formerError}
        </p>
      )}
      {scheduled.length > 0 && (
        <section aria-labelledby="scheduled-erasures-title">
          <h2 id="scheduled-erasures-title">Scheduled erasures</h2>
          <ul className="stack m-0 list-none p-0">
            {scheduled.map((erasure) => (
              <li key={erasure.id}>
                <Scheduled
                  erasure={erasure}
                  text={
                    erasure.kind === 'account'
                      ? 'Your account will be deleted on'
                      : `Your messages in ${erasure.communityName ?? 'a community'} will be erased on`
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {former && former.length > 0 && (
        <section aria-labelledby="former-memberships-title">
          <h2 id="former-memberships-title">Communities you left</h2>
          <ul className="stack m-0 list-none p-0">
            {former.map((membership) => (
              <li key={membership.communityId} className="panel p-4">
                <strong>{membership.communityName}</strong>
                {membership.leftAt && (
                  <span className="small muted block">
                    Left {new Date(membership.leftAt).toLocaleDateString()}
                  </span>
                )}
                {membership.erasure ? (
                  <p className="small muted mb-0">
                    {membership.erasure.state === 'running'
                      ? 'Erasing now.'
                      : `Your messages here will be erased on ${when(membership.erasure.executeAfter)}.`}
                  </p>
                ) : erasing === membership.communityId ? (
                  <EraseMembershipForm
                    communityId={membership.communityId}
                    communityName={membership.communityName}
                    idPrefix={`erase-${membership.communityId}`}
                    active={false}
                  />
                ) : (
                  <button
                    className="button mt-2"
                    type="button"
                    onClick={() => setErasing(membership.communityId)}
                  >
                    Erase your messages here
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="delete-account-title">
        <h2 id="delete-account-title">Delete your account</h2>
        {account ? (
          <p className="small muted">You can cancel it above until then.</p>
        ) : owned.length > 0 ? (
          <p className="small">
            You own {owned.map((membership) => membership.name).join(', ')}. To delete your account,
            first transfer ownership to another member or delete{' '}
            {owned.length === 1 ? 'the community' : 'those communities'}, then wait until the
            deletion finishes. You can ask to delete a community even while the host has suspended
            it.
          </p>
        ) : (
          <>
            <p className="small">
              In 72 hours, we&apos;ll delete your account on this host and erase your name,
              messages, files, and agents from every community here, including ones you left. You
              can cancel until then by signing in. When it starts, you&apos;ll be signed out
              everywhere.
            </p>
            <p className="small muted">{CANNOT_REACH}</p>
            <div className="field">
              <label htmlFor="delete-account-email">Enter your email</label>
              <input
                id="delete-account-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <PasswordField id="delete-account-password" value={password} onChange={setPassword} />
            {formError && (
              <p role="alert" className="notice error">
                {formError}
              </p>
            )}
            <button
              className="button danger"
              type="button"
              disabled={busy || !email}
              onClick={() => void deleteAccount()}
            >
              Delete my account
            </button>
          </>
        )}
      </section>
    </div>
  );
}
