import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, request } from '../api.js';
import { FocusDialog } from './CommunityAdministration.js';

type Scope =
  'communities:read' | 'communities:write' | 'communities:lifecycle' | 'communities:import';
type HostApiKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: Scope[];
  issuedVia: 'browser' | 'command';
  issuedByOperator: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
type SecretHandoff = { key: HostApiKey; secret: string; previousKeyExpiresAt: string | null };
type Confirmation = { key: HostApiKey; action: 'rotate' | 'revoke' };

// Import keys are offered here once importing ships; the command line can already issue them.
const SCOPES: { scope: Scope; label: string; detail: string }[] = [
  {
    scope: 'communities:read',
    label: 'Read community records',
    detail: 'List communities and read their status.',
  },
  {
    scope: 'communities:write',
    label: 'Create communities',
    detail: 'Create unclaimed communities, send owner claims, and abandon unclaimed ones.',
  },
  {
    scope: 'communities:lifecycle',
    label: 'Suspend and resume',
    detail: 'Suspend a community or resume it.',
  },
];

function describeState(key: HostApiKey, now: number): string {
  if (key.revokedAt) return `Revoked ${new Date(key.revokedAt).toLocaleDateString()}`;
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return 'Expired';
  if (key.expiresAt) return `Expires ${new Date(key.expiresAt).toLocaleString()}`;
  return 'Never expires';
}

/** Show a new key's secret once, with a copy button, and say plainly it will not be shown again. */
function SecretReveal({ handoff }: { handoff: SecretHandoff }) {
  const input = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(handoff.secret);
      setCopy('copied');
    } catch {
      // Clipboard access can be refused; select the key so the person can copy it by hand.
      setCopy('failed');
      input.current?.focus();
      input.current?.select();
    }
  }
  return (
    <div className="notice mt-4">
      <strong>Copy your new key now</strong>
      <p className="small">
        This is the only time the key for “{handoff.key.label}” is shown. Store it where your
        program keeps its secrets. Anyone who has it can do what its permissions allow.
        {handoff.previousKeyExpiresAt &&
          ` The key it replaces stops working ${new Date(handoff.previousKeyExpiresAt).toLocaleString()}.`}
      </p>
      <div className="field mb-2">
        <label htmlFor="host-api-key-secret">API key</label>
        <div className="row">
          <input
            id="host-api-key-secret"
            ref={input}
            className="min-w-0 flex-1 font-mono"
            readOnly
            value={handoff.secret}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="button shrink-0" type="button" onClick={() => void copySecret()}>
            {copy === 'copied' ? 'Copied' : 'Copy key'}
          </button>
        </div>
      </div>
      <p className="small mb-0" aria-live="polite">
        {copy === 'copied'
          ? 'Key copied.'
          : copy === 'failed'
            ? 'This browser blocked copying. Copy the selected key by hand.'
            : ''}
      </p>
    </div>
  );
}

/**
 * Issue, rotate, and revoke host API keys: credentials for programs that manage communities on
 * this host. A key can never read what happens inside a community.
 */
export function HostApiKeys() {
  const [keys, setKeys] = useState<HostApiKey[] | null>(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['communities:read']);
  const [expiry, setExpiry] = useState('90');
  const [password, setPassword] = useState('');
  const [handoff, setHandoff] = useState<SecretHandoff | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [overlapMinutes, setOverlapMinutes] = useState('60');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const body = await request<{ keys: HostApiKey[] }>('/api/v1/host/api-keys');
      setKeys(body.keys);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const body = await request<SecretHandoff>('/api/v1/host/api-keys', 'POST', {
        label,
        scopes,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
        password,
      });
      setHandoff(body);
      setLabel('');
      setPassword('');
      await refresh();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function closeConfirmation() {
    setConfirmation(null);
    setConfirmPassword('');
    setDialogError('');
  }

  async function confirm() {
    if (!confirmation) return;
    const { key, action } = confirmation;
    setBusy(true);
    setDialogError('');
    setMessage('');
    try {
      if (action === 'rotate') {
        setHandoff(
          await request<SecretHandoff>(`/api/v1/host/api-keys/${key.id}/rotate`, 'POST', {
            overlapMinutes: Number(overlapMinutes),
            password: confirmPassword,
          })
        );
      } else {
        await request(`/api/v1/host/api-keys/${key.id}/revoke`, 'POST', {});
        setMessage(`Revoked “${key.label}”. Programs using it lose access now.`);
      }
      closeConfirmation();
      await refresh();
    } catch (cause) {
      setDialogError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();
  return (
    <section className="panel mt-4" aria-labelledby="host-api-keys-title">
      <h2 id="host-api-keys-title">API keys</h2>
      <p className="muted">
        Give a program its own key to manage communities on this host, instead of your password. A
        key can never read messages, files, or members, and it cannot create other keys.
      </p>
      {error && (
        <div role="alert" className="notice error mb-4">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="notice success mb-4">
          {message}
        </div>
      )}
      <form onSubmit={(event) => void issue(event)}>
        <div className="field">
          <label htmlFor="host-api-key-label">Key name</label>
          <input
            id="host-api-key-label"
            value={label}
            maxLength={80}
            required
            placeholder="Provisioning script"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <fieldset className="mb-4 border-0 p-0">
          <legend className="mb-2 text-[0.83rem] font-bold">What it can do</legend>
          <div className="grid gap-3">
            {SCOPES.map(({ scope, label: scopeLabel, detail }) => (
              <label key={scope} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((item) => item !== scope)
                    )
                  }
                />
                <span>
                  {scopeLabel}
                  <span className="small muted block">{detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="host-api-key-expiry">Expires</label>
          <select
            id="host-api-key-expiry"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          >
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
            <option value="never">Never</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="host-api-key-password">Your password</label>
          <input
            id="host-api-key-password"
            type="password"
            autoComplete="current-password"
            value={password}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button className="button primary" disabled={busy || scopes.length === 0}>
          Create key
        </button>
      </form>
      {handoff && <SecretReveal key={handoff.key.id} handoff={handoff} />}
      <h3 className="mt-8 mb-3">Keys on this host</h3>
      {keys === null ? (
        <p className="muted">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="muted">No keys yet.</p>
      ) : (
        <div className="stack">
          {keys.map((key) => {
            const live = !key.revokedAt && !(key.expiresAt && Date.parse(key.expiresAt) <= now);
            return (
              <article className="panel-alt p-4" key={key.id} aria-label={`${key.label} key`}>
                <div className="row justify-between">
                  <strong>{key.label}</strong>
                  <span className="small muted">{describeState(key, now)}</span>
                </div>
                <p className="small muted">
                  <span className="font-mono">{key.prefix}…</span> ·{' '}
                  {key.issuedByOperator
                    ? `Created by ${key.issuedByOperator}`
                    : 'Created from the command line'}{' '}
                  ·{' '}
                  {key.lastUsedAt
                    ? `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                    : 'Never used'}
                </p>
                <p className="small muted">
                  {key.scopes
                    .map((scope) => SCOPES.find((item) => item.scope === scope)?.label ?? scope)
                    .join(', ')}
                </p>
                {live && (
                  <div className="row flex-wrap gap-2">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => setConfirmation({ key, action: 'rotate' })}
                    >
                      Replace
                    </button>
                    <button
                      className="button danger"
                      disabled={busy}
                      onClick={() => setConfirmation({ key, action: 'revoke' })}
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {confirmation && (
        <FocusDialog
          title={
            confirmation.action === 'rotate'
              ? `Replace “${confirmation.key.label}”?`
              : `Revoke “${confirmation.key.label}”?`
          }
          error={dialogError}
          onClose={closeConfirmation}
        >
          {confirmation.action === 'rotate' ? (
            <>
              <p>
                You get a new key with the same permissions. The old key keeps working for the time
                you choose, so you can switch your program over without downtime.
              </p>
              <div className="field">
                <label htmlFor="host-api-key-overlap">Keep the old key working for</label>
                <select
                  id="host-api-key-overlap"
                  value={overlapMinutes}
                  onChange={(event) => setOverlapMinutes(event.target.value)}
                >
                  <option value="0">No time: stop it now</option>
                  <option value="60">1 hour</option>
                  <option value="1440">1 day</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="host-api-key-rotate-password">Your password</label>
                <input
                  id="host-api-key-rotate-password"
                  type="password"
                  autoComplete="current-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
            </>
          ) : (
            <p>
              Programs using “{confirmation.key.label}” ({confirmation.key.prefix}…) lose access
              right away. This cannot be undone.
            </p>
          )}
          <div className="row justify-end gap-2">
            <button className="button" onClick={closeConfirmation}>
              Cancel
            </button>
            <button
              className={confirmation.action === 'rotate' ? 'button primary' : 'button danger'}
              disabled={busy || (confirmation.action === 'rotate' && !confirmPassword)}
              onClick={() => void confirm()}
            >
              {confirmation.action === 'rotate' ? 'Replace key' : 'Revoke key'}
            </button>
          </div>
        </FocusDialog>
      )}
    </section>
  );
}
