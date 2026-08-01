import { useCallback, useState } from 'react';
import type { SessionStatusEvent, ConnectionState, PermissionMode } from '@dorkos/shared/types';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { useAppStore } from '@/layers/shared/model';
import {
  useSessionStatus,
  useSessionChatStore,
  useModels,
  useHasConfirmedAuto,
  useHasConfirmedAutonomy,
  useModeBeforePlan,
} from '@/layers/entities/session';
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
  AutonomyConfirmDialog,
  UsageRevealPopover,
  useGitStatus,
  isGitStatusOk,
  useRuntimeChip,
  useSessionDiagnostics,
  useStatusBarPins,
  useSessionPopoverShortcut,
  useStatusBudget,
  partitionSubagents,
  gitPromotionState,
  selectPromotedItems,
  applyStatusBudget,
  type StatusPromotionContext,
} from '@/layers/features/status';
import { findWorkingMode, isAutonomyStop } from '@/layers/shared/lib';
import { useAutonomyAcknowledgement } from '@/layers/entities/config';
import { compactComposerGate } from '../../model/build-palette-commands';
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

  // The one session snapshot, shared with the right panel's Session tab. Every
  // value the Session panel shows comes from here; the line's own item inputs
  // (below) are read separately because they are item PROPS, not diagnostics —
  // and they resolve to the same values, since both paths read the same stores
  // through the same selectors and the optimistic overrides are now shared.
  const diagnostics = useSessionDiagnostics(sessionId);
  const usage = diagnostics.usage;
  const contextUsage = diagnostics.contextUsage;
  const usageRevealOpen = useUsageReveal((s) => s.open);
  const setUsageRevealOpen = useUsageReveal((s) => s.setOpen);

  const { data: gitStatus } = useGitStatus(status.cwd);
  const workspace = useWorkspaceForSession(status.cwd);
  const { data: runtimeCaps } = useRuntimeCapabilities();

  // Running, not available: the fold keeps a row per subagent for the whole turn,
  // terminal ones included, so "in the list" never means "in flight" (DOR-462).
  const runningSubagents = partitionSubagents(diagnostics.activeSubagents).running;

  // Per-model gating for the 'auto' permission mode, scoped by the chip runtime
  // so a pre-launch Codex session gates on Codex's models.
  const { data: models } = useModels({
    sessionId: sessionId || undefined,
    runtime: runtimeChip.runtime ?? undefined,
  });
  const modelSupportsAutoMode =
    models?.find((m) => m.value === status.model)?.supportsAutoMode ?? false;

  // The active runtime's capability profile drives the honesty gates: a runtime
  // that declares `supportsCostTracking: false` must never show a cost item —
  // and every permission decision below reads what the runtime declared rather
  // than a mode id.
  const activeCaps = useCapabilitiesForRuntime(runtimeChip.runtime);
  const declaredModes = activeCaps?.permissionModes.values ?? [];
  const runtimeDefaultMode = activeCaps?.permissionModes.default;

  // Once-per-session confirmation gates: the `auto` research preview, and the
  // one stop a person cannot walk back.
  const hasConfirmedAuto = useHasConfirmedAuto(sessionId);
  const recordAutoConfirmed = useSessionChatStore((s) => s.recordAutoConfirmed);
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);
  const hasConfirmedAutonomy = useHasConfirmedAutonomy(sessionId);
  const recordAutonomyConfirmed = useSessionChatStore((s) => s.recordAutonomyConfirmed);
  const [pendingAutonomy, setPendingAutonomy] = useState<PermissionModeDescriptor | null>(null);

  // The standing acknowledgement, off the config query the cockpit already
  // subscribes to — no extra request. Present means this person has read what
  // Full autonomy means and asked not to be told again.
  const autonomyAck = useAutonomyAcknowledgement();

  /**
   * Whether this cockpit has an acknowledgement it can honestly assert for the
   * server's autonomy door — the person's standing record, or the confirmation
   * they gave in this session.
   */
  const canAssertAutonomyAck = autonomyAck.acknowledgedAt !== null || hasConfirmedAutonomy;

  /**
   * Write one mode, attaching the autonomy acknowledgement when the mode needs
   * one.
   *
   * Every path that changes the mode goes through here, not just the dial: the
   * Plan toggle restores whatever the session was on before planning, and that
   * can be Full autonomy. A path that forgot the flag would 428 on the one click
   * a person takes to get OUT of planning.
   *
   * A refusal is a question, not a fault. If the server says an acknowledgement
   * is required — another tab cleared the standing record, or this client's copy
   * of it is stale — the dialog opens instead of an error nobody can act on.
   */
  const applyMode = useCallback(
    (nextMode: PermissionMode) => {
      const descriptor = declaredModes.find((d) => d.id === nextMode);
      const needsAck = descriptor !== undefined && isAutonomyStop(descriptor);
      void status.updateSession(
        {
          permissionMode: nextMode,
          ...(needsAck && canAssertAutonomyAck ? { acknowledgedAutonomy: true } : {}),
        },
        {
          onError: (err) => {
            if ((err as { code?: string })?.code !== 'AUTONOMY_ACK_REQUIRED') return;
            if (descriptor) setPendingAutonomy(descriptor);
          },
        }
      );
    },
    [declaredModes, canAssertAutonomyAck, status, setPendingAutonomy]
  );

  const handleChangeMode = useCallback(
    (nextMode: PermissionMode) => {
      if (nextMode === 'auto' && !hasConfirmedAuto) {
        setAutoConfirmOpen(true);
        return;
      }
      // The autonomy stop asks twice. Every other stop is one click and
      // instantly reversible; this one stops the asking, so by the time a person
      // notices they did not mean it, it has already happened. The dial selects
      // on arrow keys as well as clicks, which is the other half of why this
      // cannot be a straight write (`loop={false}` is the first half).
      //
      // Asking here is a courtesy, not the gate — the server refuses the write
      // outright without an acknowledgement, so skipping this branch would land
      // on the same dialog by a worse route.
      const descriptor = declaredModes.find((d) => d.id === nextMode);
      if (descriptor && isAutonomyStop(descriptor) && !canAssertAutonomyAck) {
        setPendingAutonomy(descriptor);
        return;
      }
      applyMode(nextMode);
    },
    [hasConfirmedAuto, canAssertAutonomyAck, declaredModes, applyMode, setPendingAutonomy]
  );

  const handleConfirmAuto = useCallback(() => {
    recordAutoConfirmed(sessionId);
    status.updateSession({ permissionMode: 'auto' });
    setAutoConfirmOpen(false);
  }, [recordAutoConfirmed, sessionId, status, setAutoConfirmOpen]);

  const handleConfirmAutonomy = useCallback(
    (rememberChoice: boolean) => {
      if (!pendingAutonomy) return;
      recordAutonomyConfirmed(sessionId);
      if (rememberChoice) {
        // Recorded first, and not awaited. The mode change carries its own
        // acknowledgement on the request, so it does not wait on this write —
        // and a config write that fails leaves the person exactly where they
        // were, being asked again next time, which is the safe direction.
        autonomyAck.acknowledge();
      }
      // Explicit rather than via `applyMode`: the acknowledgement was given
      // right here, in this click, and must ride this request even though the
      // session-scoped memory that `applyMode` reads has not re-rendered yet.
      void status.updateSession({
        permissionMode: pendingAutonomy.id as PermissionMode,
        acknowledgedAutonomy: true,
      });
      setPendingAutonomy(null);
    },
    [pendingAutonomy, recordAutonomyConfirmed, sessionId, status, autonomyAck, setPendingAutonomy]
  );

  // Plan, where the runtime offers a way of working at all. Which mode that is
  // comes from the profile, never from the id `plan` (spec `trust-dial`).
  const workingMode = findWorkingMode(declaredModes);
  const planActive = workingMode !== undefined && status.permissionMode === workingMode.id;
  const modeBeforePlan = useModeBeforePlan(sessionId);
  const recordModeBeforePlan = useSessionChatStore((s) => s.recordModeBeforePlan);

  const handleTogglePlan = useCallback(
    (next: boolean) => {
      if (!workingMode) return;
      if (next) {
        // Remember where the dial stood, so switching Plan off is a return
        // rather than a guess.
        recordModeBeforePlan(sessionId, status.permissionMode);
        status.updateSession({ permissionMode: workingMode.id as PermissionMode });
        return;
      }
      // A remembered mode is only worth restoring if it still exists. The
      // runtime can change under a session (a switch before the first message),
      // and `auto` can stop being available when the model changes — restoring
      // either would PATCH a mode the server now rejects, on the ONE path a
      // person takes to get out of planning. Anything unviable falls back to
      // what a fresh session on this runtime would have started at.
      const remembered = modeBeforePlan;
      const stillDeclared =
        remembered !== undefined && declaredModes.some((d) => d.id === remembered);
      const viable = stillDeclared && (remembered !== 'auto' || modelSupportsAutoMode);
      const restored = viable ? remembered : runtimeDefaultMode;
      // Through `applyMode`, because the mode being restored can be Full
      // autonomy: a session that was running without asking, went into planning,
      // and is now coming back out. The acknowledgement has to ride that request
      // like any other, or leaving Plan would be the one click that 428s.
      if (restored) applyMode(restored as PermissionMode);
    },
    [
      workingMode,
      recordModeBeforePlan,
      sessionId,
      status,
      applyMode,
      modeBeforePlan,
      declaredModes,
      modelSupportsAutoMode,
      runtimeDefaultMode,
    ]
  );
  const runtimeLabel = runtimeChip.runtime ? getRuntimeDescriptor(runtimeChip.runtime).label : '';
  // Same runtime-support gate the composer's `/compact` dispatch uses — the
  // inline compact action must never disagree with the palette.
  const compactIntent = compactComposerGate(activeCaps?.commandIntents, runtimeLabel);
  const displayContextPercent = diagnostics.contextPercent;
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
    // The same profile the picker renders from, so the line's severity and the
    // picker's tint can never disagree about one mode.
    permissionDescriptor:
      activeCaps?.permissionModes.values.find((d) => d.id === status.permissionMode) ?? null,
    // `null` on a runtime with no way of working to offer, which is most of them.
    plan: workingMode ? { active: planActive } : null,
    // `runtimeCaps === undefined` is "the capability map has not arrived", not
    // "this runtime is not the default": treating it as the latter would promote
    // the item at RUNTIME_NON_DEFAULT for the frames before the query resolves,
    // outranking git, model, and cwd on a narrow bar. Every other item follows
    // the same rule — data hasn't arrived, so no slot.
    runtime:
      runtimeChip.runtime === null || runtimeCaps === undefined
        ? null
        : {
            isDefault: runtimeChip.runtime === runtimeCaps.defaultRuntime,
            canSelect: runtimeChip.canSelect,
          },
    usage,
    subagentsInFlight: runningSubagents.length,
  };

  // The inline Compact action is the one thing the line gives up first: it costs a
  // labelled button, and below the widest tier the Session panel offers it as a
  // full-width button instead, so the fix is never lost — only relocated.
  //
  // Gated on `compaction.visible`, never re-derived: the hook already folds in
  // runtime support, the 85% threshold, AND `isStreaming`. A separately-derived
  // condition drifted from it once already, offering an enabled Compact button
  // mid-turn that could only ever 409 `SESSION_LOCKED` (DOR-112 requirement 1).
  const inlineCompact = compaction.visible && budget.density === 'full';
  const promotedCompactAction = compaction.visible && !inlineCompact;

  const nodes = buildStatusItemNodes({
    sessionId,
    agent: { name: agentName, color: agentColor, emoji: agentEmoji, path: agentPath },
    status,
    onUpdateSession: status.updateSession,
    onChangeMode: handleChangeMode,
    modelSupportsAutoMode,
    plan: workingMode
      ? { descriptor: workingMode, active: planActive, onToggle: handleTogglePlan }
      : null,
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
    runningSubagents,
    connectionState: syncConnectionState,
    density: budget.density,
  });

  const { items, overflow } = applyStatusBudget(
    selectPromotedItems({ ctx: promotionContext, pins, nodes }),
    budget
  );

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
              // The same switch the line's chip carries, so a bar too narrow to
              // hold the chip cannot take planning away.
              plan: workingMode ? { active: planActive, onToggle: handleTogglePlan } : null,
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
      <AutonomyConfirmDialog
        descriptor={pendingAutonomy}
        onCancel={() => setPendingAutonomy(null)}
        onConfirm={handleConfirmAutonomy}
      />
    </div>
  );
}
