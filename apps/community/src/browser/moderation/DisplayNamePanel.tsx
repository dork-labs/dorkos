import { Button, Input, Label, Notice } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { describeError, request } from '../api.js';
import type { Member } from '../types.js';

/** The longest display name, as the server accepts it. */
export const DISPLAY_NAME_MAX = 128;

/**
 * Change the name this person goes by in this space. Names of the space's agents, and names the
 * owner reserved, are refused by the server with a plain reason. Messages already sent keep the
 * name they were sent under.
 */
export function DisplayNamePanel({ me, onChanged }: { me: Member; onChanged: () => void }) {
  const id = useId();
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request('/api/v1/me', 'PATCH', { displayName: name.trim() });
      setMessage('Name changed. New messages use it.');
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Your name here</h3>
      {error && (
        <Notice tone="error" className="mb-3" role="alert">
          {error}
        </Notice>
      )}
      {message && (
        <Notice tone="success" className="mb-3" role="status">
          {message}
        </Notice>
      )}
      <form onSubmit={(event) => void save(event)}>
        <div className="field">
          <Label htmlFor={`${id}-name`}>Display name</Label>
          <Input
            id={`${id}-name`}
            maxLength={DISPLAY_NAME_MAX}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !name.trim() || name.trim() === me.displayName}
        >
          Save name
        </Button>
      </form>
    </section>
  );
}
