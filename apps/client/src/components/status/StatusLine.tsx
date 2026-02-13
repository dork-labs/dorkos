import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSessionStatus } from '../../hooks/use-session-status';
import { useAppStore } from '../../stores/app-store';
import { CwdItem } from './CwdItem';
import { PermissionModeItem } from './PermissionModeItem';
import { ModelItem } from './ModelItem';
import { CostItem } from './CostItem';
import { ContextItem } from './ContextItem';
import type { SessionStatusEvent } from '@lifeos/shared/types';

interface StatusLineProps {
  sessionId: string;
  sessionStatus: SessionStatusEvent | null;
  isStreaming: boolean;
}

const itemTransition = { duration: 0.2, ease: [0.4, 0, 0.2, 1] } as const;

export function StatusLine({ sessionId, sessionStatus, isStreaming }: StatusLineProps) {
  const status = useSessionStatus(sessionId, sessionStatus, isStreaming);
  const {
    showStatusBarCwd,
    showStatusBarPermission,
    showStatusBarModel,
    showStatusBarCost,
    showStatusBarContext,
  } = useAppStore();

  // Build ordered list of visible item entries with stable keys
  const entries: { key: string; node: React.ReactNode }[] = [];

  if (showStatusBarCwd && status.cwd) {
    entries.push({ key: 'cwd', node: <CwdItem cwd={status.cwd} /> });
  }
  if (showStatusBarPermission) {
    entries.push({
      key: 'permission',
      node: (
        <PermissionModeItem
          mode={status.permissionMode}
          onChangeMode={(mode) => status.updateSession({ permissionMode: mode })}
        />
      ),
    });
  }
  if (showStatusBarModel) {
    entries.push({
      key: 'model',
      node: (
        <ModelItem
          model={status.model}
          onChangeModel={(model) => status.updateSession({ model })}
        />
      ),
    });
  }
  if (showStatusBarCost && status.costUsd !== null) {
    entries.push({ key: 'cost', node: <CostItem costUsd={status.costUsd} /> });
  }
  if (showStatusBarContext && status.contextPercent !== null) {
    entries.push({ key: 'context', node: <ContextItem percent={status.contextPercent} /> });
  }

  const hasItems = entries.length > 0;

  return (
    <AnimatePresence initial={false}>
      {hasItems && (
        <motion.div
          role="toolbar"
          aria-label="Session status"
          aria-live="polite"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 px-1 pt-2 text-xs text-muted-foreground whitespace-nowrap">
            <AnimatePresence initial={false} mode="popLayout">
              {entries.map((entry, i) => (
                <motion.div
                  key={entry.key}
                  layout
                  initial={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, scale: 0.8, filter: 'blur(4px)' }}
                  transition={itemTransition}
                  className="inline-flex items-center gap-2"
                >
                  {i > 0 && <Separator />}
                  {entry.node}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Separator() {
  return (
    <span className="text-muted-foreground/30" aria-hidden="true">
      &middot;
    </span>
  );
}
