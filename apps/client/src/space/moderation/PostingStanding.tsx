import { Button, Notice } from '@dork-labs/ui';
import { useCallback, useEffect, useState } from 'react';
import type { CommunityWireRules, CommunityWireStanding } from '@dorkos/shared/community-wire';
import { describeError, request } from '../api.js';
import { FocusDialog } from '../components/FocusDialog.js';
import { describeSlowMode } from './SlowModeControl.js';
import { formatUntil } from '../components/members/SpaceMembers.js';

/**
 * What holds this person's posts in a channel, shown above the composer: rules to accept (with
 * the rules to read and accept), a mute and when it ends, and the channel's slow mode. Read
 * again whenever `revision` changes, such as after a post is refused, so a refusal and the
 * reason shown here never disagree.
 */
export function PostingStanding({
  channelId,
  exempt,
  revision,
}: {
  channelId: string;
  /** Owners and admins never wait out slow mode. */
  exempt: boolean;
  revision: unknown;
}) {
  const [rules, setRules] = useState<CommunityWireRules | null>(null);
  const [standing, setStanding] = useState<CommunityWireStanding | null>(null);
  const [slowSeconds, setSlowSeconds] = useState(0);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [nextRules, nextStanding, slow] = await Promise.all([
      request<CommunityWireRules>('/api/v1/rules').catch(() => null),
      request<CommunityWireStanding>('/api/v1/me/standing').catch(() => null),
      request<{ seconds: number }>(`/api/v1/channels/${channelId}/slow-mode`).catch(() => null),
    ]);
    setRules(nextRules);
    setStanding(nextStanding);
    setSlowSeconds(slow?.seconds ?? 0);
  }, [channelId]);
  useEffect(() => {
    void load();
  }, [load, revision]);
  async function accept() {
    if (!rules) return;
    setBusy(true);
    setError('');
    try {
      await request('/api/v1/rules/accept', 'POST', { version: rules.version });
      setReading(false);
      await load();
    } catch (cause) {
      setError(describeError(cause));
      await load();
    } finally {
      setBusy(false);
    }
  }
  const needsAcceptance = Boolean(rules?.text) && rules!.acceptedVersion < rules!.version;
  return (
    <>
      {needsAcceptance && (
        <Notice tone="info" className="row mb-2" role="status">
          Accept this space's rules to post.
          <Button type="button" variant="outline" onClick={() => setReading(true)}>
            Read the rules
          </Button>
        </Notice>
      )}
      {standing?.mutedUntil && (
        <Notice tone="info" className="mb-2" role="status">
          You're muted until {formatUntil(standing.mutedUntil)}.
        </Notice>
      )}
      {!exempt && slowSeconds > 0 && (
        <p className="small muted mb-2">
          Slow mode: one post every {describeSlowMode(slowSeconds).toLowerCase()}.
        </p>
      )}
      {reading && rules?.text && (
        <FocusDialog title="Space rules" error={error} onClose={() => setReading(false)}>
          <p className="whitespace-pre-wrap">{rules.text}</p>
          <div className="row justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setReading(false)}>
              Not now
            </Button>
            <Button type="button" disabled={busy} onClick={() => void accept()}>
              Accept rules
            </Button>
          </div>
        </FocusDialog>
      )}
    </>
  );
}
