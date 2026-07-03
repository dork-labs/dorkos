import { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/shallow';
import { motion, AnimatePresence } from 'motion/react';
import type { PanInfo } from 'motion/react';
import type { SessionStatusEvent, ConnectionState, PermissionMode } from '@dorkos/shared/types';
import { SlidersHorizontal } from 'lucide-react';
import { useIsMobile, useAppStore } from '@/layers/shared/model';
import { STORAGE_KEYS, TIMING } from '@/layers/shared/lib';
import {
  useSessionStatus,
  useSessionChatStore,
  useSessionStreamStatus,
  useSubagents,
  useModels,
  useHasConfirmedAuto,
} from '@/layers/entities/session';
import { useWorkspaceForSession } from '@/layers/entities/workspace';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { deriveStatusBarValues } from '../../model/stream/derive-status-bar';
import { useRuntimeChip } from '../../model/status/use-runtime-chip';
import { ShortcutChips } from '../input/ShortcutChips';
import { DragHandle } from './DragHandle';
import {
  StatusLine,
  CwdItem,
  GitStatusItem,
  PermissionModeItem,
  RuntimeItem,
  AutoModeConfirmDialog,
  ModelConfigPopover,
  CostItem,
  CacheItem,
  ContextItem,
  UsageItem,
  NotificationSoundItem,
  PollingItem,
  ConnectionItem,
  SubagentsItem,
  useGitStatus,
  StatusBarConfigurePopover,
  STATUS_BAR_REGISTRY,
  resetStatusBarPreferences,
} from '@/layers/features/status';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/layers/shared/ui';

interface ChatStatusSectionProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
  onChipClick: (trigger: string) => void;
  /** Live-sync connection state (from the durable `/events` stream) for the ConnectionItem indicator. */
  syncConnectionState: ConnectionState;
  /** Agent display name for the shortcut chips row. */
  agentName?: string;
  /** Agent color (HSL or hex) for the shortcut chips row. */
  agentColor?: string;
  /** Agent emoji for the shortcut chips row. */
  agentEmoji?: string;
  /** Agent working directory path (used for context menu actions). */
  agentPath?: string;
}

interface ItemContextMenuProps {
  /** The item label from the registry, e.g. "Git Status". Null for non-registry items. */
  itemLabel: string | null;
  /** Callback to hide this specific item. Null for non-registry items. */
  onHide: (() => void) | null;
  /** Callback to open the configure popover. */
  onConfigure: () => void;
  children: React.ReactNode;
}

function ItemContextMenu({ itemLabel, onHide, onConfigure, children }: ItemContextMenuProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="inline-flex items-center">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {itemLabel && onHide && (
          <>
            <ContextMenuItem onClick={onHide}>Hide &ldquo;{itemLabel}&rdquo;</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={onConfigure}>Configure status bar...</ContextMenuItem>
        <ContextMenuItem onClick={resetStatusBarPreferences}>Reset to defaults</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Look up the human-readable label for a registry item key. */
function getItemLabel(key: string): string | null {
  return STATUS_BAR_REGISTRY.find((r) => r.key === key)?.label ?? null;
}

const SWIPE_THRESHOLD = 80;
const VELOCITY_THRESHOLD = 500;

/**
 * Mobile gesture UI (drag handle, swipe hint, collapsible status) and
 * desktop status bar (shortcut chips + status line).
 *
 * Owns all data fetching for the status bar and composes the compound
 * StatusLine API. The StatusLine component itself is presentation-only.
 */
export function ChatStatusSection({
  sessionId,
  sessionStatus,
  isStreaming,
  onChipClick,
  syncConnectionState,
  agentName,
  agentColor,
  agentEmoji,
  agentPath,
}: ChatStatusSectionProps) {
  const isMobile = useIsMobile();

  // All status bar data hooks — moved here from StatusLine
  const status = useSessionStatus(sessionId, sessionStatus, isStreaming);
  const {
    showShortcutChips,
    showStatusBarCwd,
    setShowStatusBarCwd,
    showStatusBarPermission,
    setShowStatusBarPermission,
    showStatusBarRuntime,
    setShowStatusBarRuntime,
    showStatusBarModel,
    setShowStatusBarModel,
    showStatusBarCost,
    setShowStatusBarCost,
    showStatusBarContext,
    setShowStatusBarContext,
    showStatusBarCache,
    setShowStatusBarCache,
    showStatusBarUsage,
    setShowStatusBarUsage,
    showStatusBarGit,
    setShowStatusBarGit,
    showStatusBarSound,
    setShowStatusBarSound,
    showStatusBarPolling,
    setShowStatusBarPolling,
    enableNotificationSound,
    setEnableNotificationSound,
    enableMessagePolling,
    setEnableMessagePolling,
  } = useAppStore();
  // Snapshot-backed status (spec chat-stream-reconnection): populated immediately
  // on cold mount / refresh from the `/events` snapshot, so the server-derived
  // items (context %, cost, model, cache) no longer wait for the first live event.
  const streamStatus = useSessionStreamStatus(sessionId);
  const streamValues = deriveStatusBarValues(streamStatus);
  // Rich context breakdown (categories) is not carried by the snapshot — its
  // tooltip stays sourced from the legacy store and fills in on the first live
  // event; the percent badge below renders from the snapshot immediately.
  const contextUsage = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.contextUsage ?? null, [sessionId])
  );
  // Subscription utilization is not part of the session-status projection; keep
  // it sourced from the legacy store (populated by the rate-limit stream event).
  const usageInfo = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.usageInfo ?? null, [sessionId])
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
  // Prefer the snapshot-backed values where they overlap with the derived status
  // (cold-mount population); fall back to `use-session-status` otherwise.
  const contextPercent = streamValues.contextPercent ?? status.contextPercent;
  const costUsd = streamValues.costUsd ?? status.costUsd;
  // NOTE: `model` is intentionally NOT overridden from the snapshot. The snapshot
  // carries the SDK-resolved model id (e.g. "claude-opus-4-6"), whereas the model
  // picker + auto-mode gating key off the user-selectable option VALUE (e.g.
  // "default") that `use-session-status` already populates on cold mount from the
  // persisted session query. Overriding here would break those lookups.
  const { data: gitStatus } = useGitStatus(status.cwd);
  const workspace = useWorkspaceForSession(status.cwd);
  const { data: subagents } = useSubagents(sessionId);

  // Per-model gating for the 'auto' permission mode: only the active model's
  // `supportsAutoMode` flag decides whether 'auto' is offered in the dropdown.
  const { data: models } = useModels(sessionId || undefined);
  const modelSupportsAutoMode =
    models?.find((m) => m.value === status.model)?.supportsAutoMode ?? false;

  // Once-per-session confirmation gate for entering 'auto' mode.
  const hasConfirmedAuto = useHasConfirmedAuto(sessionId);
  const recordAutoConfirmed = useSessionChatStore((s) => s.recordAutoConfirmed);
  const [autoConfirmOpen, setAutoConfirmOpen] = useState(false);

  // Intercept selection of 'auto': the first time per session we open a
  // confirmation modal instead of applying. All other modes (and subsequent
  // 'auto' selections in the same session) apply directly.
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

  // Runtime chip: display runtime, selectability (read-only once the session
  // has started), and the ?runtime= selection channel. See use-runtime-chip.
  const runtimeChip = useRuntimeChip(sessionId);

  // The active runtime's declared capability profile (nullish chip runtime —
  // still resolving — falls back to the server default). Drives the honesty
  // gates below: a runtime that declares `supportsCostTracking: false` (e.g.
  // Codex reports tokens but no dollar cost) must never show a cost item,
  // even if a stray value reaches the stores.
  const activeCaps = useCapabilitiesForRuntime(runtimeChip.runtime);
  const supportsCostTracking = activeCaps?.supportsCostTracking ?? true;

  // Configure popover state — opened by icon click or from context menus
  const [configureOpen, setConfigureOpen] = useState(false);

  // Mobile-only gesture state
  const [collapsed, setCollapsed] = useState(false);
  const [showHint, setShowHint] = useState(() => {
    if (!isMobile) return false;
    const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
    return count < 3;
  });

  useEffect(() => {
    if (!showHint) return;
    const timer = setTimeout(() => {
      setShowHint(false);
      const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
      localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, String(count + 1));
    }, TIMING.GESTURE_HINT_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [showHint]);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    const count = parseInt(localStorage.getItem(STORAGE_KEYS.GESTURE_HINT_COUNT) || '0', 10);
    localStorage.setItem(STORAGE_KEYS.GESTURE_HINT_COUNT, String(count + 1));
  }, []);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const { offset, velocity } = info;
    if (offset.y > SWIPE_THRESHOLD || velocity.y > VELOCITY_THRESHOLD) {
      setCollapsed(true);
    } else if (offset.y < -SWIPE_THRESHOLD || velocity.y < -VELOCITY_THRESHOLD) {
      setCollapsed(false);
    }
  };

  // Extracted to avoid duplicating the full JSX tree across mobile/desktop branches
  const configureIcon = (
    <TooltipProvider>
      <Tooltip>
        <StatusBarConfigurePopover open={configureOpen} onOpenChange={setConfigureOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Configure status bar"
              className="text-muted-foreground/50 hover:text-muted-foreground inline-flex shrink-0 items-center transition-colors duration-150"
            >
              <SlidersHorizontal className="size-3" />
            </button>
          </TooltipTrigger>
        </StatusBarConfigurePopover>
        <TooltipContent side="top">
          <p>Configure status bar</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  const statusLineContent = (
    <div className="flex items-center gap-2 pt-2">
      <ContextMenu>
        <ContextMenuTrigger className="min-w-0 flex-1">
          <StatusLine sessionId={sessionId} isStreaming={isStreaming}>
            <StatusLine.Item itemKey="cwd" visible={showStatusBarCwd && !!status.cwd}>
              <ItemContextMenu
                itemLabel={getItemLabel('cwd')}
                onHide={() => setShowStatusBarCwd(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {status.cwd && <CwdItem cwd={status.cwd} />}
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="git" visible={showStatusBarGit}>
              <ItemContextMenu
                itemLabel={getItemLabel('git')}
                onHide={() => setShowStatusBarGit(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                <GitStatusItem data={gitStatus} workspace={workspace} />
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="permission" visible={showStatusBarPermission}>
              <ItemContextMenu
                itemLabel={getItemLabel('permission')}
                onHide={() => setShowStatusBarPermission(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                <PermissionModeItem
                  mode={status.permissionMode}
                  onChangeMode={handleChangeMode}
                  disabled={!sessionId}
                  runtime={runtimeChip.runtime}
                  modelSupportsAutoMode={modelSupportsAutoMode}
                />
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item
              itemKey="runtime"
              visible={showStatusBarRuntime && runtimeChip.runtime !== null}
            >
              <ItemContextMenu
                itemLabel={getItemLabel('runtime')}
                onHide={() => setShowStatusBarRuntime(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {runtimeChip.runtime !== null && (
                  <RuntimeItem
                    runtime={runtimeChip.runtime}
                    onChangeRuntime={runtimeChip.onChangeRuntime}
                    canSelect={runtimeChip.canSelect}
                  />
                )}
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="model" visible={showStatusBarModel}>
              <ItemContextMenu
                itemLabel={getItemLabel('model')}
                onHide={() => setShowStatusBarModel(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                <ModelConfigPopover
                  model={status.model}
                  onChangeModel={(model) => status.updateSession({ model })}
                  effort={status.effort}
                  onChangeEffort={(effort) => status.updateSession({ effort: effort ?? undefined })}
                  fastMode={status.fastMode}
                  onChangeFastMode={(fastMode) => status.updateSession({ fastMode })}
                  disabled={!sessionId}
                  sessionId={sessionId || undefined}
                />
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item
              itemKey="cost"
              visible={showStatusBarCost && costUsd !== null && supportsCostTracking}
            >
              <ItemContextMenu
                itemLabel={getItemLabel('cost')}
                onHide={() => setShowStatusBarCost(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {costUsd !== null && <CostItem costUsd={costUsd} />}
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="cache" visible={showStatusBarCache && cacheStatus !== null}>
              <ItemContextMenu
                itemLabel={getItemLabel('cache')}
                onHide={() => setShowStatusBarCache(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {cacheStatus && (
                  <CacheItem
                    cacheReadTokens={cacheStatus.cacheReadTokens}
                    cacheCreationTokens={cacheStatus.cacheCreationTokens}
                    contextTokens={cacheStatus.contextTokens}
                  />
                )}
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item
              itemKey="context"
              visible={showStatusBarContext && contextPercent !== null}
            >
              <ItemContextMenu
                itemLabel={getItemLabel('context')}
                onHide={() => setShowStatusBarContext(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {contextPercent !== null && (
                  <ContextItem percent={contextPercent} contextUsage={contextUsage} />
                )}
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="usage" visible={showStatusBarUsage && usageInfo !== null}>
              <ItemContextMenu
                itemLabel={getItemLabel('usage')}
                onHide={() => setShowStatusBarUsage(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {usageInfo && <UsageItem usageInfo={usageInfo} />}
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="sound" visible={showStatusBarSound}>
              <ItemContextMenu
                itemLabel={getItemLabel('sound')}
                onHide={() => setShowStatusBarSound(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                <NotificationSoundItem
                  enabled={enableNotificationSound}
                  onToggle={() => setEnableNotificationSound(!enableNotificationSound)}
                />
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="polling" visible={showStatusBarPolling}>
              <ItemContextMenu
                itemLabel={getItemLabel('polling')}
                onHide={() => setShowStatusBarPolling(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                <PollingItem
                  enabled={enableMessagePolling}
                  onToggle={() => setEnableMessagePolling(!enableMessagePolling)}
                />
              </ItemContextMenu>
            </StatusLine.Item>
            {/*
             * System-managed item: connection is not user-toggleable. It is not
             * wrapped with ItemContextMenu — it falls through to the background
             * ContextMenu if right-clicked.
             */}
            <ConnectionItem connectionState={syncConnectionState} />
            <StatusLine.Item itemKey="subagents" visible={!!subagents && subagents.length > 0}>
              {subagents && subagents.length > 0 && <SubagentsItem subagents={subagents} />}
            </StatusLine.Item>
          </StatusLine>
        </ContextMenuTrigger>
        {/* Background context menu — fires when right-clicking the status bar but not on a specific item */}
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setConfigureOpen(true)}>
            Configure status bar...
          </ContextMenuItem>
          <ContextMenuItem onClick={resetStatusBarPreferences}>Reset to defaults</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {/* Configure icon — right-aligned, stable position independent of item changes */}
      {configureIcon}
      {/* Portal-based — render once; placement is layout-independent */}
      <AutoModeConfirmDialog
        open={autoConfirmOpen}
        onOpenChange={setAutoConfirmOpen}
        onConfirm={handleConfirmAuto}
      />
    </div>
  );

  if (isMobile) {
    return (
      <>
        <motion.div
          animate={showHint ? { y: [0, 8, 0] } : undefined}
          transition={showHint ? { duration: 1.2, repeat: 2 } : undefined}
        >
          <DragHandle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
        </motion.div>
        <AnimatePresence>
          {showHint && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={dismissHint}
              className="text-muted-foreground cursor-pointer text-center text-xs"
            >
              Swipe to collapse
            </motion.p>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="overflow-hidden"
              drag="y"
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={0.2}
              onDragEnd={handleDragEnd}
              style={{ touchAction: 'pan-y' }}
            >
              {showShortcutChips && (
                <ShortcutChips
                  onChipClick={onChipClick}
                  agentName={agentName}
                  agentColor={agentColor}
                  agentEmoji={agentEmoji}
                  agentPath={agentPath}
                />
              )}
              {statusLineContent}
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }

  return (
    <>
      <AnimatePresence>
        {showShortcutChips && (
          <ShortcutChips
            onChipClick={onChipClick}
            agentName={agentName}
            agentColor={agentColor}
            agentEmoji={agentEmoji}
            agentPath={agentPath}
          />
        )}
      </AnimatePresence>
      {statusLineContent}
    </>
  );
}
