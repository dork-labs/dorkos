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
  useMakeDefaultStop,
  MakeDefaultStopLine,
  type StatusPromotionContext,
} from '@/layers/features/status';
import { findWorkingMode, needsConsentRitual } from '@/layers/shared/lib';
import { useAutonomyAcknowledgement } from '@/layers/entities/config';
import { compactComposerGate } from '../../model/build-palette-commands';
import { useCompactionChip } from '../../model/status/use-compaction-chip';
import { useUsageReveal } from '../../model/use-usage-reveal';
import { buildStatusItemNodes } from './status-item-nodes';

/**
 * The stable stand-in for "this runtime's capability profile has not arrived".
 *
 * Module-level so its identity never changes. See its one use site below.
 */
const NO_DECLARED_MODES: readonly PermissionModeDescriptor[] = [];

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
  // How many there ARE comes from the server's own count, not from the rows: a
  // background task outlives the turn that started it, and the turn's rows are
  // wiped by the history reload seconds after it closes — which is exactly when
  // the session looks finished and is not (DOR-1100). The rows still supply the
  // names, so the tooltip stays specific for as long as it can.
  const liveSubagentCount = diagnostics.runningSubagentCount ?? runningSubagents.length;

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
  // `NO_DECLARED_MODES`, not a fresh `[]`: three of the callbacks below depend on
  // this list, and a new array identity every render would rebuild all three on
  // every render of the status bar — which is also exactly what the compiler
  // warns about when a logical expression feeds a dependency array.
  const declaredModes = activeCaps?.permissionModes.values ?? NO_DECLARED_MODES;
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

  // "Start every new session here?" — offered under the dial after a stop
  // change, and only where it would tell the person something they have not
  // already said (spec `trust-dial`, decision 6C).
  const makeDefault = useMakeDefaultStop({
    sessionId,
    runtime: runtimeChip.runtime,
    declaredModes,
    runtimeDefaultMode,
  });
  /**
   * Whether the permissions picker is open, which decides WHICH of the offer's
   * two homes speaks.
   *
   * Not bookkeeping: entering Full autonomy opens a modal dialog, and the
   * dialog's focus grab closes the popover underneath it — verified in a browser
   * on 2026-08-01, where the offer set on confirming was drawn into an unmounted
   * tree and then reappeared, stale, the next time the popover was opened. So
   * the inline instance is offered only while the popover is up, and the overlay
   * takes over the moment it is not.
   */
  const [pickerOpen, setPickerOpen] = useState(false);

  /**
   * Whether this cockpit has an acknowledgement it can honestly assert for the
   * server's autonomy door — the person's standing record, or the confirmation
   * they gave in this session.
   */
  const canAssertAutonomyAck = autonomyAck.acknowledgedAt !== null || hasConfirmedAutonomy;

  /**
   * Write one mode, attaching the autonomy acknowledgement when the mode needs
   * one and this cockpit has one to assert.
   *
   * The single mode writer for every path on this surface EXCEPT
   * `handleConfirmAutonomy`, which is the one place consent is given rather than
   * recalled — see the note there. Routing the rest through here is not
   * ceremony: the Plan toggle restores whatever the session was on before
   * planning, and that can be Full autonomy, so a path that wrote the mode
   * directly would 428 on the one click a person takes to get OUT of planning.
   *
   * **The flag rides only when there is something to assert** — a standing
   * record, or this page's own memory of confirming. Neither survives a reload,
   * so a person who confirmed once, reloaded, and did not tick "don't show this
   * again" reaches the server without one. That is intended: the 428 comes back,
   * and the bounce below turns it into the question again rather than an error.
   * The bounce is the recovery path, not a corner case.
   */
  const applyMode = useCallback(
    (nextMode: PermissionMode) => {
      const descriptor = declaredModes.find((d) => d.id === nextMode);
      const needsAck = descriptor !== undefined && needsConsentRitual(descriptor);
      // The promise is RETURNED, not swallowed, so a caller can tell a landed
      // write from a refused one: `updateSession` answers with the updated
      // session on success and `undefined` after it has handed the failure to
      // `onError`. Only one caller needs that today — nothing should offer to
      // make a stop the default when the stop itself did not take.
      return status.updateSession(
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
    // The `useState` setters ARE listed, here and in every callback below. They
    // can never change — React guarantees a setter's identity for the life of the
    // component — so this is not about correctness. It is that React Compiler's
    // `preserve-manual-memoization` check does not make that exception: omit them
    // and it reports it cannot preserve the memoization on this callback, which
    // is a real warning about real generated code rather than a style note. All
    // or none, and "all" is the one the toolchain can verify.
    [declaredModes, canAssertAutonomyAck, status, setPendingAutonomy]
  );

  const handleChangeMode = useCallback(
    (nextMode: PermissionMode) => {
      if (nextMode === 'auto' && !hasConfirmedAuto) {
        setAutoConfirmOpen(true);
        return;
      }
      // A stop that never asks asks twice. Every stop that still asks is one
      // click and instantly reversible; these stop the asking, so by the time a
      // person notices they did not mean it, it has already happened. The dial
      // selects on arrow keys as well as clicks, which is the other half of why
      // this cannot be a straight write (`loop={false}` is the first half).
      //
      // WHICH stops is `needsConsentRitual`, not the autonomy position: on a
      // runtime that cannot pause mid-turn, the MIDDLE stop never asks either
      // (DOR-816). Asking here is a courtesy, not the gate — the server refuses
      // the write outright without an acknowledgement, so skipping this branch
      // would land on the same dialog by a worse route.
      const descriptor = declaredModes.find((d) => d.id === nextMode);
      if (descriptor && needsConsentRitual(descriptor) && !canAssertAutonomyAck) {
        setPendingAutonomy(descriptor);
        return;
      }
      // The person just told DorkOS how much they want this agent to do. Noticing
      // that here is the whole of decision 6C — the alternative is a trip to
      // Settings to repeat a choice they have already made ten times.
      //
      // Only once the write LANDS, though: offering to make a stop the standing
      // default while the session itself failed to take it would be the product
      // proposing to spread a change that did not happen.
      void applyMode(nextMode).then((updated) => {
        if (updated) makeDefault.offerFor(nextMode);
      });
    },
    [
      hasConfirmedAuto,
      canAssertAutonomyAck,
      declaredModes,
      applyMode,
      makeDefault,
      setPendingAutonomy,
      setAutoConfirmOpen,
    ]
  );

  const handleConfirmAuto = useCallback(() => {
    recordAutoConfirmed(sessionId);
    // Through `applyMode` like every other recalled write. `auto` is not an
    // autonomy stop on any runtime today, so this adds no flag — it is routed
    // here so the set of writers stays one, and a runtime that later declares
    // its auto-equivalent at the autonomy stop is handled without an edit.
    applyMode('auto');
    setAutoConfirmOpen(false);
  }, [recordAutoConfirmed, sessionId, applyMode, setAutoConfirmOpen]);

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
      // THE ONE WRITER THAT IS NOT `applyMode`, and the reason is the whole
      // difference between the two: `applyMode` RECALLS an acknowledgement from
      // state, and consent was GIVEN here, in this click. The state it would
      // read — the session memory recorded a line above — has not re-rendered
      // yet, so routing through it would send the request without the flag and
      // bounce the person off the dialog they just answered.
      const applied = pendingAutonomy.id;
      void status
        .updateSession({
          permissionMode: applied as PermissionMode,
          acknowledgedAutonomy: true,
        })
        .then((updated) => {
          // Offered here too, and this is the person decision 6C was written
          // for: the operator who chooses Full autonomy every morning. They have
          // just been told exactly what it means, so the offer lands at the one
          // moment it cannot be a surprise. The dialog has closed the dial's
          // popover by now, so this offer is drawn by the overlay instance.
          if (updated) makeDefault.offerFor(applied);
        });
      setPendingAutonomy(null);
    },
    [
      pendingAutonomy,
      recordAutonomyConfirmed,
      sessionId,
      status,
      autonomyAck,
      makeDefault,
      setPendingAutonomy,
    ]
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
        // Through `applyMode` for the same reason as the restore below: a way of
        // working is never an autonomy stop today, so no flag is added, but the
        // writer stays one rather than two that must be kept in step.
        applyMode(workingMode.id as PermissionMode);
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
      // and is now coming back out. Where this page still holds an
      // acknowledgement — standing, or confirmed here — it rides the request and
      // the click just works. Where it does not (a reload, and no standing
      // record), the server answers 428 and `applyMode`'s bounce turns that into
      // the dialog. Both outcomes are fine; writing the mode directly is what is
      // not, because then the refusal has nothing to open.
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
    subagentsInFlight: liveSubagentCount,
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
    makeDefault: pickerOpen ? makeDefault.line : null,
    onPermissionPickerOpenChange: setPickerOpen,
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
    liveSubagentCount,
    waitingOnSubagents: !isStreaming,
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
    // `relative` for the offer overlay below, which floats above this strip
    // rather than taking a row in it — see `MakeDefaultStopLine`'s `placement`.
    <div ref={barRef} className="relative pt-2">
      {/* The offer, when the dial's popover is shut. Floating, so the composer
          never gains a blank line for a remark that is usually not there. */}
      {!pickerOpen && makeDefault.line && (
        <MakeDefaultStopLine {...makeDefault.line} placement="overlay" />
      )}
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
        canRemember={autonomyAck.canRemember}
      />
      {/* The same door, asked about a wider scope: making Full autonomy the
          stop EVERY new session starts at. A separate instance rather than a
          mode on the one above, because the two answer different questions and
          only one of them is about this session — and here the confirmation IS
          the standing record, which is why no checkbox is offered. */}
      <AutonomyConfirmDialog
        descriptor={makeDefault.pendingDescriptor}
        canRemember={false}
        consentNote="Every new session will start here, and DorkOS will remember that you have read this."
        onCancel={makeDefault.cancel}
        onConfirm={makeDefault.confirm}
      />
    </div>
  );
}
