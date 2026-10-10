/**
 * Heartbeat — how this agent wakes on its own, what it watches, and what its
 * last checks found (spec `heartbeats` §7.6).
 *
 * Anyone may read any agent's heartbeat, so this page is pushed from every
 * agent's profile. On someone else's agent it is facts only: how it wakes, its
 * last checks and what is held for people. `HEARTBEAT.md` sits beside SOUL.md
 * and NOPE.md, private to the agent's own people, so its editor is drawn only
 * on your own agents and DorkBot (`deriveRelationship`, as on Commitments).
 *
 * @module features/profile/ui/pages/HeartbeatPage
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import { Button, MoreDetails, Skeleton } from '@/layers/shared/ui';
import { heartbeatKeys, useAgentHeartbeat } from '@/layers/entities/heartbeat';
import { deriveRelationship } from '../../lib/profile-relationship';
import {
  fileProblemWords,
  heldRecipientNames,
  nextCheckWords,
  wakeSentence,
} from '../../lib/heartbeat-words';
import { useProfileAgent } from '../../model/use-profile-agent';
import { HeartbeatBeats } from '../heartbeat/HeartbeatBeats';
import { HeartbeatHeld } from '../heartbeat/HeartbeatHeld';
import { HeartbeatFileEditor } from './ConventionPage';
import type { ProfilePageContentProps } from './types';

/** How the agent wakes, and when it next checks in. */
function WakeSection({ status }: { status: HeartbeatStatus }) {
  const next = status.enabled && status.wake === 'timed' ? nextCheckWords(status.nextBeatAt) : null;
  return (
    <section className="space-y-1" data-slot="heartbeat-wake">
      <h3 className="text-sm font-semibold">How it wakes</h3>
      <p className="text-sm">{wakeSentence(status)}</p>
      {next && <p className="text-muted-foreground text-xs">{next}</p>}
    </section>
  );
}

/** Why the settings at the top of `HEARTBEAT.md` do not read, in plain words. */
function FileProblem({ error }: { error: string }) {
  return (
    <div role="alert" className="space-y-1" data-slot="heartbeat-file-problem">
      <p className="text-destructive text-sm">
        These settings don’t read. The last good ones still apply.
      </p>
      <p className="text-sm">{fileProblemWords(error)}</p>
      <MoreDetails>
        <p className="font-mono break-words">{error}</p>
      </MoreDetails>
    </div>
  );
}

/** `HEARTBEAT.md`: the editor, or one button to start one when there is none. */
function FileSection(props: ProfilePageContentProps & { status: HeartbeatStatus }) {
  const { member, roster, onPush, status } = props;
  const queryClient = useQueryClient();
  const { agent, isPending } = useProfileAgent(member);
  const [writing, setWriting] = useState(false);
  const agentId = member.agent?.manifestId ?? '';

  if (isPending) return <Skeleton className="h-40 w-full" />;
  // No file: the agent wakes on events with the built-in checklist (spec §2).
  // The server ships no templates to the app, so "Write one" opens a blank file.
  if (agent && (agent.heartbeatContent ?? null) === null && !writing) {
    return (
      <section className="space-y-2" data-slot="heartbeat-file-empty">
        <h3 className="text-sm font-semibold">No HEARTBEAT.md yet</h3>
        <p className="text-muted-foreground text-sm">It wakes only when something happens.</p>
        <Button size="sm" variant="outline" onClick={() => setWriting(true)}>
          Write one
        </Button>
      </section>
    );
  }
  return (
    <section className="space-y-2">
      {status.fileError && <FileProblem error={status.fileError} />}
      <HeartbeatFileEditor
        member={member}
        roster={roster}
        onPush={onPush}
        onSaved={() =>
          void queryClient.invalidateQueries({ queryKey: heartbeatKeys.agent(agentId) })
        }
      />
    </section>
  );
}

/** This agent's heartbeat: how it wakes, its file, its last checks, what is held. */
export function HeartbeatPage(props: ProfilePageContentProps) {
  const { member, roster } = props;
  const agentId = member.agent?.manifestId ?? null;
  const query = useAgentHeartbeat(agentId, { live: true });
  const relationship = deriveRelationship(member, roster);
  const yours = relationship === 'managed' || relationship === 'system';
  const nameOf = useMemo(() => heldRecipientNames(roster), [roster]);

  if (!agentId) return null;
  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  if (query.isError || !query.data) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this heartbeat.</p>;
  }
  const status = query.data;

  return (
    <div className="space-y-6" data-slot="profile-heartbeat">
      <WakeSection status={status} />
      {/* With the space switch off there is nothing to tune: no beat reads it. */}
      {yours && status.enabled && <FileSection {...props} status={status} />}
      <HeartbeatHeld held={status.held} nameOf={nameOf} />
      <section className="space-y-2" data-slot="heartbeat-beats">
        <h3 className="text-sm font-semibold">Last checks</h3>
        <HeartbeatBeats beats={status.lastBeats} />
      </section>
    </div>
  );
}
