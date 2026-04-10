import { useState, useEffect, useCallback } from 'react';
import { useShallow } from 'zustand/shallow';
import { motion, AnimatePresence } from 'motion/react';
import type { PanInfo } from 'motion/react';
import type {
  SessionStatusEvent,
  PresenceUpdateEvent,
  ConnectionState,
} from '@dorkos/shared/types';
import { SlidersHorizontal } from 'lucide-react';
import { useIsMobile, useAppStore } from '@/layers/shared/model';
import { STORAGE_KEYS, TIMING } from '@/layers/shared/lib';
import { useSessionStatus, useSessionChatStore, useSubagents } from '@/layers/entities/session';
import { ShortcutChips } from '../input/ShortcutChips';
import { DragHandle } from './DragHandle';
import {
  StatusLine,
  CwdItem,
  GitStatusItem,
  PermissionModeItem,
  ModelConfigPopover,
  CostItem,
  CacheItem,
  ContextItem,
  UsageItem,
  NotificationSoundItem,
  SyncItem,
  PollingItem,
  ClientsItem,
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
  presenceInfo: PresenceUpdateEvent | null;
  presenceTasks: boolean;
  /** SSE sync connection state for the ConnectionItem indicator. */
  syncConnectionState: ConnectionState;
  /** Number of failed reconnection attempts. */
  syncFailedAttempts: number;
  /** Agent display name for the shortcut chips row. */
  agentName?: string;
  /** Agent color (HSL or hex) for the shortcut chips row. */
  agentColor?: string;
  /** Agent emoji for the shortcut chips row. */
  agentEmoji?: string;
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
  presenceInfo,
  presenceTasks,
  syncConnectionState,
  syncFailedAttempts,
  agentName,
  agentColor,
  agentEmoji,
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
    showStatusBarSync,
    setShowStatusBarSync,
    showStatusBarPolling,
    setShowStatusBarPolling,
    enableNotificationSound,
    setEnableNotificationSound,
    enableCrossClientSync,
    setEnableCrossClientSync,
    enableMessagePolling,
    setEnableMessagePolling,
  } = useAppStore();
  const contextUsage = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.contextUsage ?? null, [sessionId])
  );
  const usageInfo = useSessionChatStore(
    useCallback((s) => s.sessions[sessionId]?.usageInfo ?? null, [sessionId])
  );
  const cacheStatus = useSessionChatStore(
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
  const { data: gitStatus } = useGitStatus(status.cwd);
  const { data: subagents } = useSubagents();

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
                <GitStatusItem data={gitStatus} />
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
                  onChangeMode={(mode) => status.updateSession({ permissionMode: mode })}
                  disabled={!sessionId}
                />
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
                  autoMode={status.autoMode}
                  onChangeAutoMode={(autoMode) => status.updateSession({ autoMode })}
                  disabled={!sessionId}
                />
              </ItemContextMenu>
            </StatusLine.Item>
            <StatusLine.Item itemKey="cost" visible={showStatusBarCost && status.costUsd !== null}>
              <ItemContextMenu
                itemLabel={getItemLabel('cost')}
                onHide={() => setShowStatusBarCost(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {status.costUsd !== null && <CostItem costUsd={status.costUsd} />}
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
              visible={showStatusBarContext && status.contextPercent !== null}
            >
              <ItemContextMenu
                itemLabel={getItemLabel('context')}
                onHide={() => setShowStatusBarContext(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                {status.contextPercent !== null && (
                  <ContextItem percent={status.contextPercent} contextUsage={contextUsage} />
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
            <StatusLine.Item itemKey="sync" visible={showStatusBarSync}>
              <ItemContextMenu
                itemLabel={getItemLabel('sync')}
                onHide={() => setShowStatusBarSync(false)}
                onConfigure={() => setConfigureOpen(true)}
              >
                <SyncItem
                  enabled={enableCrossClientSync}
                  onToggle={() => setEnableCrossClientSync(!enableCrossClientSync)}
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
             * System-managed items: connection and clients are not user-toggleable.
             * They are not wrapped with ItemContextMenu — they will fall through to
             * the background ContextMenu if right-clicked.
             */}
            <ConnectionItem
              connectionState={syncConnectionState}
              failedAttempts={syncFailedAttempts}
            />
            <StatusLine.Item
              itemKey="clients"
              visible={!!presenceInfo && presenceInfo.clientCount > 1}
            >
              {presenceInfo && (
                <ClientsItem
                  clientCount={presenceInfo.clientCount}
                  clients={presenceInfo.clients}
                  lockInfo={presenceInfo.lockInfo}
                  tasks={presenceTasks}
                />
              )}
            </StatusLine.Item>
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
          />
        )}
      </AnimatePresence>
      {statusLineContent}
    </>
  );
}
