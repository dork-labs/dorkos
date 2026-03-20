import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { PanInfo } from 'motion/react';
import type { SessionStatusEvent, PresenceUpdateEvent } from '@dorkos/shared/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIsMobile, useAppStore, useTransport } from '@/layers/shared/model';
import { STORAGE_KEYS, TIMING } from '@/layers/shared/lib';
import { useSessionStatus } from '@/layers/entities/session';
import { ShortcutChips } from './ShortcutChips';
import { DragHandle } from './DragHandle';
import {
  StatusLine,
  CwdItem,
  GitStatusItem,
  PermissionModeItem,
  ModelItem,
  CostItem,
  ContextItem,
  NotificationSoundItem,
  SyncItem,
  PollingItem,
  TunnelItem,
  VersionItem,
  ClientsItem,
  useGitStatus,
} from '@/layers/features/status';

interface ChatStatusSectionProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
  onChipClick: (trigger: string) => void;
  presenceInfo: PresenceUpdateEvent | null;
  presencePulse: boolean;
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
  presencePulse,
}: ChatStatusSectionProps) {
  const isMobile = useIsMobile();

  // All status bar data hooks — moved here from StatusLine
  const status = useSessionStatus(sessionId, sessionStatus, isStreaming);
  const {
    showShortcutChips,
    showStatusBarCwd,
    showStatusBarPermission,
    showStatusBarModel,
    showStatusBarCost,
    showStatusBarContext,
    showStatusBarGit,
    showStatusBarSound,
    showStatusBarSync,
    showStatusBarPolling,
    showStatusBarTunnel,
    showStatusBarVersion,
    enableNotificationSound,
    setEnableNotificationSound,
    enableCrossClientSync,
    setEnableCrossClientSync,
    enableMessagePolling,
    setEnableMessagePolling,
  } = useAppStore();
  const { data: gitStatus } = useGitStatus(status.cwd);
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { data: serverConfig } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const dismissedVersions = useMemo(
    () => serverConfig?.dismissedUpgradeVersions ?? [],
    [serverConfig?.dismissedUpgradeVersions]
  );

  const handleDismissVersion = useCallback(
    async (version: string) => {
      const updated = [...dismissedVersions, version];
      await transport.updateConfig({ ui: { dismissedUpgradeVersions: updated } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    [dismissedVersions, transport, queryClient]
  );

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
  const statusLineContent = (
    <StatusLine sessionId={sessionId} isStreaming={isStreaming}>
      <StatusLine.Item itemKey="cwd" visible={showStatusBarCwd && !!status.cwd}>
        {status.cwd && <CwdItem cwd={status.cwd} />}
      </StatusLine.Item>
      <StatusLine.Item itemKey="git" visible={showStatusBarGit}>
        <GitStatusItem data={gitStatus} />
      </StatusLine.Item>
      <StatusLine.Item itemKey="permission" visible={showStatusBarPermission}>
        <PermissionModeItem
          mode={status.permissionMode}
          onChangeMode={(mode) => status.updateSession({ permissionMode: mode })}
          disabled={!sessionId}
        />
      </StatusLine.Item>
      <StatusLine.Item itemKey="model" visible={showStatusBarModel}>
        <ModelItem
          model={status.model}
          onChangeModel={(model) => status.updateSession({ model })}
          disabled={!sessionId}
        />
      </StatusLine.Item>
      <StatusLine.Item itemKey="cost" visible={showStatusBarCost && status.costUsd !== null}>
        {status.costUsd !== null && <CostItem costUsd={status.costUsd} />}
      </StatusLine.Item>
      <StatusLine.Item
        itemKey="context"
        visible={showStatusBarContext && status.contextPercent !== null}
      >
        {status.contextPercent !== null && <ContextItem percent={status.contextPercent} />}
      </StatusLine.Item>
      <StatusLine.Item itemKey="sound" visible={showStatusBarSound}>
        <NotificationSoundItem
          enabled={enableNotificationSound}
          onToggle={() => setEnableNotificationSound(!enableNotificationSound)}
        />
      </StatusLine.Item>
      <StatusLine.Item itemKey="sync" visible={showStatusBarSync}>
        <SyncItem
          enabled={enableCrossClientSync}
          onToggle={() => setEnableCrossClientSync(!enableCrossClientSync)}
        />
      </StatusLine.Item>
      <StatusLine.Item itemKey="polling" visible={showStatusBarPolling}>
        <PollingItem
          enabled={enableMessagePolling}
          onToggle={() => setEnableMessagePolling(!enableMessagePolling)}
        />
      </StatusLine.Item>
      <StatusLine.Item itemKey="tunnel" visible={showStatusBarTunnel && !!serverConfig?.tunnel}>
        {/*
         * serverConfig?.tunnel is safe here: visible guard ensures this only renders
         * when tunnel exists, but JSX children are evaluated eagerly so we use optional
         * chaining to avoid crashes when serverConfig is undefined during loading.
         */}
        {serverConfig?.tunnel && <TunnelItem tunnel={serverConfig.tunnel} />}
      </StatusLine.Item>
      <StatusLine.Item itemKey="version" visible={showStatusBarVersion && !!serverConfig}>
        {serverConfig && (
          <VersionItem
            version={serverConfig.version}
            latestVersion={serverConfig.latestVersion}
            isDevMode={serverConfig.isDevMode}
            isDismissed={
              serverConfig.latestVersion
                ? dismissedVersions.includes(serverConfig.latestVersion)
                : false
            }
            onDismiss={handleDismissVersion}
          />
        )}
      </StatusLine.Item>
      <StatusLine.Item itemKey="clients" visible={!!presenceInfo && presenceInfo.clientCount > 1}>
        {presenceInfo && (
          <ClientsItem
            clientCount={presenceInfo.clientCount}
            clients={presenceInfo.clients}
            lockInfo={presenceInfo.lockInfo}
            pulse={presencePulse}
          />
        )}
      </StatusLine.Item>
    </StatusLine>
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
              {showShortcutChips && <ShortcutChips onChipClick={onChipClick} />}
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
        {showShortcutChips && <ShortcutChips onChipClick={onChipClick} />}
      </AnimatePresence>
      {statusLineContent}
    </>
  );
}
