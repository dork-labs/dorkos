import { Button, Label, Notice, Textarea } from '@dork-labs/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { COMMUNITY_RULES_MAX_LENGTH, type CommunityWireRules } from '@dorkos/shared/community-wire';
import { describeError, request } from '../api.js';
import type { Member } from '../types.js';

/**
 * The space's rules, for owners and admins to write, and its reserved display names, for the
 * owner. Saving the rules makes a new version that every member accepts before their next post;
 * the person who saves them has accepted them.
 */
export function ConductSettings({ role }: { role: Member['role'] }) {
  const id = useId();
  const [rules, setRules] = useState<CommunityWireRules | null>(null);
  const [text, setText] = useState('');
  const [names, setNames] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const owner = role === 'owner';
  const load = useCallback(async () => {
    try {
      const current = await request<CommunityWireRules>('/api/v1/rules');
      setRules(current);
      setText(current.text ?? '');
      if (owner) {
        const reserved = await request<{ names: string[] }>('/api/v1/reserved-names');
        setNames(reserved.names.join('\n'));
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [owner]);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
      setMessage(success);
      await load();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  const saveRules = (next: string | null) =>
    run(
      () => request('/api/v1/rules', 'PUT', { text: next, expectedVersion: rules?.version ?? 0 }),
      next === null ? 'Rules removed.' : 'Rules saved. Members accept them before posting.'
    );
  const reserved = names
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Rules</h3>
      <p className="small muted">Members accept each new version before they post.</p>
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
      <div className="field">
        <Label htmlFor={`${id}-rules`}>Rules text</Label>
        <Textarea
          id={`${id}-rules`}
          aria-describedby={`${id}-rules-count`}
          maxLength={COMMUNITY_RULES_MAX_LENGTH}
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <span id={`${id}-rules-count`} className="hint">
          {rules?.version ? `Version ${rules.version}` : 'No rules yet'} · {text.length}/
          {COMMUNITY_RULES_MAX_LENGTH}
        </span>
      </div>
      <div className="row">
        <Button disabled={busy || !rules || !text.trim()} onClick={() => void saveRules(text)}>
          Save rules
        </Button>
        {rules?.text && (
          <Button variant="outline" disabled={busy} onClick={() => void saveRules(null)}>
            Remove rules
          </Button>
        )}
      </div>
      {owner && (
        <>
          <h3 className="mt-6">Reserved names</h3>
          <p className="small muted">Only the owner and admins can use these display names.</p>
          <div className="field">
            <Label htmlFor={`${id}-names`}>One name per line</Label>
            <Textarea
              id={`${id}-names`}
              rows={4}
              value={names}
              onChange={(event) => setNames(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                () => request('/api/v1/reserved-names', 'PUT', { names: reserved }),
                'Reserved names saved.'
              )
            }
          >
            Save reserved names
          </Button>
        </>
      )}
    </section>
  );
}
