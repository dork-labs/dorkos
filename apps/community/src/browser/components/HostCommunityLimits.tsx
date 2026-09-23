import { useCallback, useState } from 'react';
import { RequestError, describeError, request } from '../api.js';

type Usage = {
  activeMembers: number;
  storage: { countedBytes: number };
  limits: {
    maxActiveMembers: number | null;
    maxStorageBytes: number | null;
    limitsVersion: number;
  };
};

const MiB = 1024 * 1024;

/** A byte limit as the MiB field shows it: at most two decimals, never a long fraction. */
function mibField(bytes: number | null): string {
  return bytes === null ? '' : String(Number((bytes / MiB).toFixed(2)));
}

function formatMiB(bytes: number): string {
  const value = bytes / MiB;
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString()} MiB`;
}

/**
 * One community's host-set limits: members and file space, each beside current use. Empty means
 * no limit. Lowering a limit below current use removes nothing; it only stops further growth.
 */
export function HostCommunityLimits({ communityId, name }: { communityId: string; name: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [members, setMembers] = useState('');
  const [storage, setStorage] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const body = await request<Usage>(`/api/v1/host/communities/${communityId}/usage`);
      setUsage(body);
      setMembers(body.limits.maxActiveMembers?.toString() ?? '');
      setStorage(mibField(body.limits.maxStorageBytes));
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [communityId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!usage) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(`/api/v1/host/communities/${communityId}/limits`, 'PUT', {
        limitsVersion: usage.limits.limitsVersion,
        maxActiveMembers: members.trim() === '' ? null : Number(members),
        // An untouched field keeps the exact stored bytes rather than its rounded display.
        maxStorageBytes:
          storage.trim() === ''
            ? null
            : storage === mibField(usage.limits.maxStorageBytes)
              ? usage.limits.maxStorageBytes
              : Math.round(Number(storage) * MiB),
      });
      await load();
      setMessage('Limits saved.');
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 409) {
        // Someone else changed these limits: show theirs, and let the person decide again.
        await load();
        setError('These limits were changed elsewhere. Check the current values and save again.');
        return;
      }
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  const membersId = `limit-members-${communityId}`;
  const storageId = `limit-storage-${communityId}`;
  return (
    <details
      className="mt-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !usage) void load();
      }}
    >
      <summary className="small cursor-pointer">Limits</summary>
      {error && (
        <p role="alert" className="notice error small mt-2">
          {error}
        </p>
      )}
      {!usage && !error && <p className="small muted mt-2">Loading use…</p>}
      {usage && (
        <form className="mt-2" onSubmit={(event) => void save(event)} aria-label={`${name} limits`}>
          <div className="field">
            <label htmlFor={membersId}>Most members</label>
            <input
              id={membersId}
              type="number"
              inputMode="numeric"
              min={1}
              max={1_000_000}
              step={1}
              placeholder="No limit"
              value={members}
              onChange={(event) => setMembers(event.target.value)}
            />
            <span className="hint">
              {usage.activeMembers.toLocaleString()} now. Leave empty for no limit.
            </span>
          </div>
          <div className="field">
            <label htmlFor={storageId}>Most file space (MiB)</label>
            <input
              id={storageId}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder="No limit"
              value={storage}
              onChange={(event) => setStorage(event.target.value)}
            />
            <span className="hint">
              {formatMiB(usage.storage.countedBytes)} used now. Exports never count.
            </span>
          </div>
          <p className="small muted">
            A lower limit removes nothing. It only stops new members or files once it is reached.
          </p>
          <button className="button" disabled={busy}>
            Save limits
          </button>
          <span className="small ml-2" aria-live="polite">
            {message}
          </span>
        </form>
      )}
    </details>
  );
}
