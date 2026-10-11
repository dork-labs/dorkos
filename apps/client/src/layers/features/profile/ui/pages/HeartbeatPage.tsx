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
import { useNow } from '@/layers/shared/model';
import { heartbeatKeys, useAgentHeartbeat } from '@/layers/entities/heartbeat';
import { deriveRelationship } from '../../lib/profile-relationship';
import {
  fileProblemWords,
  heldRecipientNames,
  nextCheckWords,
  wakeSentence,
} from '../../lib/heartbeat-words';
import { reportReaderNames, reportSentence } from '../../lib/report-words';
import { useProfileAgent } from '../../model/use-profile-agent';
import { HeartbeatBeats } from '../heartbeat/HeartbeatBeats';
import { HeartbeatChecks } from '../heartbeat/HeartbeatChecks';
import { HeartbeatHeld } from '../heartbeat/HeartbeatHeld';
import { HeartbeatFileEditor } from './ConventionPage';
import type { ProfilePageContentProps } from './types';

/** How the agent wakes, when it next checks in, and its next report. */
function WakeSection({
  status,
  now,
  readerName,
}: {
  status: HeartbeatStatus;
  now: number;
  readerName: (accountId: string) => string;
}) {
  const next =
    status.enabled && status.wake === 'timed'
      ? nextCheckWords(status.nextBeatAt, new Date(now))
      : null;
  // A report runs only where beats run, and never with `wake: off`.
  const reports = status.enabled && status.skippedReason === null;
  return (
    <section className="space-y-1" data-slot="heartbeat-wake">
      <h3 className="text-sm font-semibold">How it wakes</h3>
      <p className="text-sm">{wakeSentence(status)}</p>
      {next && <p className="text-muted-foreground text-xs">{next}</p>}
      {reports && (
        <p className="text-muted-foreground text-xs" data-slot="heartbeat-next-report">
          {reportSentence(status.report, readerName(status.report.to))}
        </p>
      )}
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
  const isNew = Boolean(agent) && (agent?.heartbeatContent ?? null) === null;
  if (isNew && !writing) {
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
        {...(isNew ? { onCancel: () => setWriting(false) } : {})}
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
  const nameOf = useMemo(() => heldRecipientNames(roster, member), [roster, member]);
  const readerName = useMemo(() => reportReaderNames(roster, member), [roster, member]);
  // Ticks the "in 12 min" and "5m ago" lines, which move with no new data.
  const now = useNow(30_000);
  // Once the editor has been drawn it stays, even if the space switch goes off
  // under it: unmounting it would throw away a draft nobody saved. Adjusted
  // during render, like the editor's own draft sync, so it never lags a frame.
  const [fileShown, setFileShown] = useState(false);
  if (yours && query.data?.enabled && !fileShown) setFileShown(true);

  if (!agentId) return null;
  if (query.isPending) return <Skeleton className="h-24 w-full" />;
  // A failed refetch keeps the last good answer on screen (and the editor with
  // it); the error line is only for a page that never read one.
  if (!query.data) {
    return <p className="text-muted-foreground text-sm">Couldn’t read this heartbeat.</p>;
  }
  const status = query.data;

  return (
    <div className="space-y-6" data-slot="profile-heartbeat">
      <WakeSection status={status} now={now} readerName={readerName} />
      {status.enabled && <HeartbeatChecks checks={status.checks} />}
      {/* With the space switch off from the start there is nothing to tune. */}
      {yours && fileShown && <FileSection {...props} status={status} />}
      <HeartbeatHeld held={status.held} nameOf={nameOf} now={now} />
      <section className="space-y-2" data-slot="heartbeat-beats">
        <h3 className="text-sm font-semibold">Last checks</h3>
        <HeartbeatBeats beats={status.lastBeats} now={now} canOpenChat={status.enabled} />
      </section>
    </div>
  );
}
