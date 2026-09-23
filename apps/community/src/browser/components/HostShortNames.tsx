import { useCallback, useState } from 'react';
import { describeError, request } from '../api.js';

type Names = {
  communityId: string;
  current: string | null;
  retired: { shortName: string; retiredAt: string }[];
};

/**
 * One community's web address: its current short name, a field to set or change it, and the
 * retired names that still lead to it, each of which the host may release on purpose.
 */
export function HostShortNames({
  communityId,
  name,
  onChanged,
}: {
  communityId: string;
  name: string;
  onChanged: () => Promise<void>;
}) {
  const [names, setNames] = useState<Names | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const body = await request<Names>(`/api/v1/host/communities/${communityId}/short-names`);
      setNames(body);
      setDraft(body.current ?? '');
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [communityId]);

  async function act(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await load();
      await onChanged();
      setMessage(done);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const draftId = `short-name-${communityId}`;
  const address = (value: string) => `${window.location.origin}/${value}`;
  return (
    <details
      className="mt-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !names) void load();
      }}
    >
      <summary className="small cursor-pointer">Web address</summary>
      {error && (
        <p role="alert" className="notice error small mt-2">
          {error}
        </p>
      )}
      {!names && !error && <p className="small muted mt-2">Loading address…</p>}
      {names && (
        <form
          className="mt-2"
          aria-label={`${name} web address`}
          onSubmit={(event) => {
            event.preventDefault();
            void act(
              () =>
                request(`/api/v1/host/communities/${communityId}/short-name`, 'PUT', {
                  shortName: draft.trim() === '' ? null : draft,
                }),
              draft.trim() === '' ? 'Web address removed.' : 'Web address saved.'
            );
          }}
        >
          <div className="field">
            <label htmlFor={draftId}>Short name</label>
            <input
              id={draftId}
              value={draft}
              maxLength={32}
              placeholder="acme"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
            />
            <span className="hint">
              {names.current
                ? `People can open this community at ${address(names.current)}.`
                : 'No web address yet.'}{' '}
              3 to 32 lowercase letters, digits, and single hyphens, starting with a letter.
            </span>
          </div>
          <button className="button" disabled={busy}>
            Save address
          </button>
          <span className="small ml-2" aria-live="polite">
            {message}
          </span>
          {names.retired.length > 0 && (
            <div className="mt-3">
              <p className="small mb-1">Old addresses that still lead here</p>
              <ul className="stack small">
                {names.retired.map((retired) => (
                  <li key={retired.shortName} className="row justify-between">
                    <span className="font-mono">/{retired.shortName}</span>
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            request(
                              `/api/v1/host/communities/${communityId}/short-names/${retired.shortName}`,
                              'DELETE'
                            ),
                          `Released /${retired.shortName}. No community can take it during the cool-off.`
                        )
                      }
                    >
                      Release
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
      )}
    </details>
  );
}
