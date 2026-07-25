import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import type { SessionStatusEvent, ConnectionState, PermissionMode } from '@dorkos/shared/types';
import { useAppStore } from '@/layers/shared/model';
import {
  useSessionStatus,
  useSessionChatStore,
  useSessionStreamStatus,
  useSessionLastEventSeq,
  useSessionQueue,
  useSubagents,
  useModels,
  useHasConfirmedAuto,
  resolveDisplayContextPercent,
} from '@/layers/entities/session';
import { useConfig } from '@/layers/entities/config';
import { useWorkspaceForSession } from '@/layers/entities/workspace';
import {
  useCapabilitiesForRuntime,
  useRuntimeCapabilities,
  getRuntimeDescriptor,
} from '@/layers/entities/runtime';
import {
  StatusLine,
  SessionPopover,
  AutoModeConfirmDialog,
  UsageRevealPopover,
  useGitStatus,
  isGitStatusOk,
  useStatusBarPins,
  useSessionPopoverShortcut,
  useStatusBudget,
  gitPromotionState,
  selectPromotedItems,
  applyStatusBudget,
  type SessionDiagnostics,
  type StatusPromotionContext,
} from '@/layers/features/status';
import { deriveStatusBarValues } from '../../model/stream/derive-status-bar';
import { compactComposerGate } from '../../model/build-palette-commands';
import { useRuntimeChip } from '../../model/status/use-runtime-chip';
import { useCompactionChip } from '../../model/status/use-compaction-chip';
import { useUsageReveal } from '../../model/use-usage-reveal';
import { buildStatusItemNodes } from './status-item-nodes';

interface ChatStatusSectionProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
  /** Live-sync connection state (from the durable `/events` stream). */
  syncConnectionState: ConnectionState;
  /** Agent display name for the identity chip. */
  agentName?: string;
  /** Agent color (HSL or hex) for the identity chip. */
  agentColor?: string;
  /** Agent emoji for the identity chip. */
  agentEmoji?: string;
  /** Agent working directory path (used for context menu actions). */
  agentPath?: string;
}

/**
 * The composer's status line and the Session panel behind its `⋯`.
 *
 * Owns every data source the line reads, folds them into one promotion context,
 * and hands the registry an ordered set of promoted items to draw. Nothing here
 * decides visibility inline — that lives in the registry, so the same decision
 * can be measured, tested, and truncated.
 *
 * The bar's own width is measured here and cut to a budget before anything is
 * drawn, because the line never scrolls and never wraps: what the width cannot
 * afford becomes a `+N` on the `⋯` instead of an item nobody can reach.
 *
 * @param props - Session identity, streaming state, and the agent's identity.
 */
export function ChatStatusSection({
  sessionId,
  sessionStatus,
  isStreaming,
  syncConnectionState,
  agentName,
  agentColor,
  agentEmoji,
  agentPath,
}: ChatStatusSectionProps) {
  // The real width of the bar, not a viewport breakpoint — see `useStatusBudget`.
  const { ref: barRef, budget } = useStatusBudget();
  // Resolved first so the client-known runtime can scope every runtime-aware
  // query below (status/model/auto-mode), even before the session has a
  // server-side row to resolve `sessionId` against.
  const runtimeChip = useRuntimeChip(sessionId);
  const status = useSessionStatus(sessionId, sessionStatus, isStreaming, runtimeChip.runtime);

  // Per-field selectors, never a bare `useAppStore()`: the status bar and its
  // ~11 children would otherwise re-render on every unrelated store write.
  const enableNotificationSound = useAppStore((s) => s.enableNotificationSound);
  const setEnableNotificationSound = useAppStore((s) => s.setEnableNotificationSound);
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const setEnableMessagePolling = useAppStore((s) => s.setEnableMessagePolling);
  const { pins } = useStatusBarPins();

  // Snapshot-backed status (spec chat-stream-reconnection): populated immediately
  // on cold mount / refresh from the `/events` snapshot, so the server-derived
  // items (context %, cost, model, cache) no longer wait for the first live event.
  const streamValues = deriveStatusBarValues(useSessionStreamStatus(sessionId));
  // Rich context breakdown (categories) is not carried by the snapshot — its
  // tooltip fills in on the first live event; the percent renders immediately.
  const contextUsage = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.contextUsage ?? null, [sessionId])
  );
  const legacyCacheStatus = useSessionChatStore(
    useShallow((s) => {
      const ss = s.sessions[sessionId]?.sessionStatus;
      if (!ss?.cacheReadTokens && !ss?.cacheCreationTokens) return null;
      return {
        cacheReadTokens: ss.cacheReadTokens ?? 0,
        cacheCreationTokens: ss.cacheCreationTokens ?? 0,
        contextTokens: ss.contextTokens,
      };
    })
  );
  const cacheStatus = streamValues.cacheStatus ?? legacyCacheStatus;
  // NOTE: `model` is intentionally NOT overridden from the snapshot. The snapshot
  // carries the SDK-resolved model id, whereas the model picker + auto-mode gating
  // key off the user-selectable option VALUE that `use-session-status` populates.
  const usage = streamValues.usage;
  const usageRevealOpen = useUsageReveal((s) => s.open);
  const setUsageRevealOpen = useUsageReveal((s) => s.setOpen);

  const { data: gitStatus } = useGitStatus(status.cwd);
  const workspace = useWorkspaceForSession(status.cwd);
  const { data: subagents } = useSubagents(sessionId);
  const { data: runtimeCaps } = useRuntimeCapabilities();
  const { data: serverConfig } = useConfig();
  const lastEventSeq = useSessionLastEventSeq(sessionId);
  const queueDepth = useSessionQueue(sessionId).length;

  // Per-model gating for the 'auto' permission mode, scoped by the chip runtime
  // so a pre-launch Codex session gates on Codex's models.
  const { data: models } = useModels({
    sessionId: sessionId || undefined,
    runtime: runtimeChip.runtime ?? undefined,
  });
  const modelSupportsAutoMode =
    models?.find((m) => m.value === status.model)?.supportsAutoMode ?? false;

  // Once-per-session confirmation gate for entering 'auto' mode.
  const hasConfirmedAuto = useHasConfirmedAuto(sessionId);
  const recordAutoConfirmed = useSessionChatStore((s) => s.recordAutoConfirmed);
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);

  const handleChangeMode = useCallback(
    (nextMode: PermissionMode) => {
      if (nextMode === 'auto' && !hasConfirmedAuto) {
        setAutoConfirmOpen(true);
        return;
      }
      status.updateSession({ permissionMode: nextMode });
    },
    [hasConfirmedAuto, status]
  );

  const handleConfirmAuto = useCallback(() => {
    recordAutoConfirmed(sessionId);
    status.updateSession({ permissionMode: 'auto' });
    setAutoConfirmOpen(false);
  }, [recordAutoConfirmed, sessionId, status]);

  // The active runtime's capability profile drives the honesty gates: a runtime
  // that declares `supportsCostTracking: false` must never show a cost item.
  const activeCaps = useCapabilitiesForRuntime(runtimeChip.runtime);
  const runtimeLabel = runtimeChip.runtime ? getRuntimeDescriptor(runtimeChip.runtime).label : '';
  // Same runtime-support gate the composer's `/compact` dispatch uses — the
  // inline compact action must never disagree with the palette.
  const compactIntent = compactComposerGate(activeCaps?.commandIntents, runtimeLabel);
  const displayContextPercent = resolveDisplayContextPercent(
    streamValues.contextPercent ?? status.contextPercent,
    contextUsage
  );
  const compaction = useCompactionChip({
    sessionId,
    percent: displayContextPercent,
    compactSupported: compactIntent.supported,
    isStreaming,
  });

  const [sessionOpen, setSessionOpen] = useState(false);
  useSessionPopoverShortcut(() => setSessionOpen((o) => !o));

  const promotionContext: StatusPromotionContext = {
    cwd: status.cwd,
    git: isGitStatusOk(gitStatus)
      ? gitPromotionState(gitStatus.branch, gitStatus.clean, gitStatus.detached)
      : null,
    contextPercent: displayContextPercent,
    connectionState: syncConnectionState,
    permissionMode: status.permissionMode,
    runtime:
      runtimeChip.runtime === null
        ? null
        : {
            isDefault: runtimeChip.runtime === runtimeCaps?.defaultRuntime,
            canSelect: runtimeChip.canSelect,
          },
    usage,
    subagentCount: subagents?.length ?? 0,
  };

  // The inline Compact action is the one thing the line gives up first: it costs a
  // labelled button, and below the widest tier the Session panel offers it as a
  // full-width button instead, so the fix is never lost — only relocated.
  const inlineCompact = compactIntent.supported && budget.density === 'full';
  const promotedCompactAction = compaction.visible && !inlineCompact;

  const nodes = buildStatusItemNodes({
    sessionId,
    agent: { name: agentName, color: agentColor, emoji: agentEmoji, path: agentPath },
    status,
    onUpdateSession: status.updateSession,
    onChangeMode: handleChangeMode,
    modelSupportsAutoMode,
    gitStatus,
    workspace,
    runtimeChip,
    contextPercent: displayContextPercent,
    contextUsage,
    compact: inlineCompact
      ? { pending: compaction.pending, onCompact: compaction.onCompact }
      : null,
    usage,
    supportsCostTracking: activeCaps?.supportsCostTracking ?? true,
    subagents,
    connectionState: syncConnectionState,
    density: budget.density,
  });

  const { items, overflow } = applyStatusBudget(
    selectPromotedItems({ ctx: promotionContext, pins, nodes }),
    budget
  );

  const diagnostics: SessionDiagnostics = {
    sessionId,
    cwd: status.cwd,
    gitBranch: isGitStatusOk(gitStatus) ? gitStatus.branch : null,
    gitDirty: isGitStatusOk(gitStatus) ? !gitStatus.clean : null,
    runtime: runtimeChip.runtime,
    model: runtimeChip.model ?? streamValues.model ?? status.model,
    effort: status.effort ?? null,
    permissionMode: status.permissionMode,
    contextPercent: displayContextPercent,
    cache: cacheStatus
      ? {
          readTokens: cacheStatus.cacheReadTokens,
          creationTokens: cacheStatus.cacheCreationTokens,
          contextTokens: cacheStatus.contextTokens,
        }
      : null,
    usage,
    connectionState: syncConnectionState,
    lastEventSeq,
    queueDepth,
    clientVersion: serverConfig?.version ?? null,
  };

  return (
    // `barRef` measures this block, whose width comes from the composer around it
    // and never from the line's own content — otherwise trimming the line would
    // shrink the box that decides how much the line may hold.
    <div ref={barRef} className="pt-2">
      <StatusLine
        items={items}
        trailing={
          <SessionPopover
            open={sessionOpen}
            onOpenChange={setSessionOpen}
            diagnostics={diagnostics}
            controls={{
              sound: enableNotificationSound,
              onToggleSound: () => setEnableNotificationSound(!enableNotificationSound),
              refresh: enableMessagePolling,
              onToggleRefresh: () => setEnableMessagePolling(!enableMessagePolling),
            }}
            promotionContext={promotionContext}
            overflowCount={overflow}
            urgentAction={
              promotedCompactAction
                ? {
                    label: `Compact conversation — ${compaction.percent}% full`,
                    onAction: compaction.onCompact,
                    pending: compaction.pending,
                  }
                : null
            }
          />
        }
      />
      {/* Usage & cost reveal — pinned open by the /context intent (DOR-109). */}
      <UsageRevealPopover
        usage={usage ?? null}
        open={usageRevealOpen}
        onOpenChange={setUsageRevealOpen}
      />
      {/* Portal-based — render once; placement is layout-independent */}
      <AutoModeConfirmDialog
        open={autoConfirmOpen}
        onOpenChange={setAutoConfirmOpen}
        onConfirm={handleConfirmAuto}
      />
    </div>
  );
}
