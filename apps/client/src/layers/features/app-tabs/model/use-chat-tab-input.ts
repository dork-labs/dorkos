/**
 * Everything the stores know about one chat, gathered for its tab.
 *
 * @module features/app-tabs/model/use-chat-tab-input
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PendingInteractionsResponse } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { activityClause, formatResetTime, getAgentDisplayName } from '@/layers/shared/lib';
import { useAgentVisual, useCurrentAgent } from '@/layers/entities/agent';
import { useTransport } from '@/layers/shared/model';
import { pendingInteractionsQueryOptions } from '@/layers/entities/attention';
import {
  sessionDisplayTitle,
  useSessionListLimit,
  useSessionListStore,
  useSessionRouteContext,
  useSessionRow,
  useSessionStatusSignals,
  useSessionStreamStore,
  useSessionToolActivity,
} from '@/layers/entities/session';
import type { ChatTabInput, NeedsYouDetail } from '../lib/tab-identity';
import { projectName, type TabTarget } from '../lib/tab-target';

/** What a pending prompt is waiting for, in the tab's words. */
function needsYouDetail(
  interaction: PendingInteractionDTO | undefined
): NeedsYouDetail | undefined {
  if (!interaction) return undefined;
  if (interaction.type === 'approval') return { kind: 'approval', toolName: interaction.toolName };
  return { kind: 'question' };
}

/**
 * Read a chat tab's agent, title and live status.
 *
 * A chat URL carries no `dir` (#2682), so its folder comes the way
 * `useDirectoryState` finds it: the route context the loader installed, then
 * the legacy `?dir=` hint, then the chat's own row, which the server resolves
 * by id. Reading only `?dir=` named every chat tab "Chat" with a generic icon.
 *
 * Every read is shared with the rest of the app (the agent and row queries,
 * the session stores), so a rename or a status change anywhere shows here too.
 *
 * @param target - The parsed href of a chat tab, or `null` for any other tab
 *   (nothing is read).
 */
export function useChatTabInput(target: TabTarget | null): ChatTabInput | null {
  const sessionId = target?.sessionId ?? null;
  const routeContext = useSessionRouteContext(sessionId);
  const { data: row } = useSessionRow(sessionId, {
    // A draft has no row on the server yet; asking for one only earns a 404.
    // The href says so too, for a tab restored after a reload, when the
    // in-memory route context is gone.
    enabled: target !== null && !(routeContext?.draft ?? target.draft),
    nameOnly: true,
    select: (session) => ({
      cwd: session.cwd ?? null,
      title: session.title,
      updatedAt: session.updatedAt,
      limit: session.status?.limit ?? null,
    }),
  });
  const dir = target ? (routeContext?.cwd ?? target.dir ?? row?.cwd ?? null) : null;
  const { data: agent } = useCurrentAgent(dir);
  const visual = useAgentVisual(agent ?? null, dir ?? '');

  // The usage limit: the last one the global stream reported, which it keeps
  // even after the chat goes idle waiting for its reset. The row's snapshot
  // only counts until the stream has said anything about this chat: the row
  // is read once (`nameOnly`), so its status is frozen at mount.
  const liveLimit = useSessionListLimit(sessionId ?? '');
  const lifecycle = useSessionListStore((s) =>
    sessionId ? s.statuses[sessionId]?.lifecycle : undefined
  );
  const limit = liveLimit !== undefined ? liveLimit : (row?.limit ?? null);
  const limitStatus = useMemo(
    () => (limit ? { lifecycle: lifecycle ?? 'idle', limit } : null),
    [lifecycle, limit]
  );
  const signals = useSessionStatusSignals(sessionId ?? '', limitStatus);
  const activity = useSessionToolActivity(sessionId ?? '');

  // The pending prompt: from the chat's own stream when it is hydrated, else
  // the fleet-wide list another surface keeps fresh. Observed, never fetched.
  const streamPrompt = useSessionStreamStore((s) =>
    sessionId ? s.sessions[sessionId]?.pendingInteractions[0] : undefined
  );
  // The shared options, fetcher included, with fetching switched off: an
  // observer without the real `queryFn` would overwrite the shared query's
  // and break every refetch of it.
  const transport = useTransport();
  const { data: fleetPrompt } = useQuery({
    ...pendingInteractionsQueryOptions(transport),
    enabled: false,
    select: (data: PendingInteractionsResponse) =>
      data.interactions.find((entry) => entry.sessionId === sessionId)?.interaction,
  });

  if (target === null) return null;
  return {
    agentName: agent ? getAgentDisplayName(agent) : null,
    projectName: projectName(dir),
    visual: agent ? visual : null,
    chatTitle: row ? sessionDisplayTitle(row.title) : null,
    agentKey: agent?.id ?? dir,
    signals: {
      needsYou: signals.needsYou,
      failed: signals.failed,
      paused: signals.limited !== null,
      working: signals.working,
      unseen: signals.unseen,
    },
    detail: {
      needsYou: needsYouDetail(streamPrompt ?? fleetPrompt),
      resetsAt: limit ? formatResetTime(limit.resetsAt, new Date()) : null,
      activity: activityClause(activity),
    },
    lastActiveAt: row ? Date.parse(row.updatedAt) : undefined,
  };
}
