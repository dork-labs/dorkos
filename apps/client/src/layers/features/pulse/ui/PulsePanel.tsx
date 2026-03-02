import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FeatureDisabledState } from '@/layers/shared/ui';
import { icons } from '@dorkos/icons/registry';
import { usePulseEnabled, useSchedules } from '@/layers/entities/pulse';
import { useResolvedAgents } from '@/layers/entities/agent';
import type { PulseSchedule } from '@dorkos/shared/types';
import { CreateScheduleDialog } from './CreateScheduleDialog';
import { PulseEmptyState } from './PulseEmptyState';
import { ScheduleRow } from './ScheduleRow';

/** Main Pulse panel — renders schedule list or empty/loading/disabled states. */
export function PulsePanel() {
  const pulseEnabled = usePulseEnabled();
  const { data: schedules = [], isLoading } = useSchedules(pulseEnabled);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<PulseSchedule | undefined>();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Batch-resolve agents for all schedule CWDs
  const uniquePaths = [...new Set(schedules.map((s) => s.cwd).filter(Boolean) as string[])];
  const { data: resolvedAgents } = useResolvedAgents(uniquePaths);

  if (!pulseEnabled) {
    return (
      <FeatureDisabledState
        icon={icons.pulse}
        name="Pulse"
        description="Pulse runs AI agent tasks on a schedule. Start DorkOS with the --pulse flag to enable it."
        command="dorkos --pulse"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="size-2 animate-pulse rounded-full bg-muted" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-48 animate-pulse rounded bg-muted" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <>
        <PulseEmptyState
          onCreateSchedule={() => {
            setEditSchedule(undefined);
            setDialogOpen(true);
          }}
        />
        <CreateScheduleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editSchedule={editSchedule}
        />
      </>
    );
  }

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Schedules</h3>
        <button
          onClick={() => {
            setEditSchedule(undefined);
            setDialogOpen(true);
          }}
          className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
        >
          New Schedule
        </button>
      </div>
      <AnimatePresence initial={false}>
        {schedules.map((schedule) => (
          <motion.div
            key={schedule.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
          >
            <ScheduleRow
              schedule={schedule}
              agent={resolvedAgents?.[schedule.cwd ?? ''] ?? null}
              expanded={expandedId === schedule.id}
              onToggleExpand={() =>
                setExpandedId(expandedId === schedule.id ? null : schedule.id)
              }
              onEdit={() => {
                setEditSchedule(schedule);
                setDialogOpen(true);
              }}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      <CreateScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editSchedule={editSchedule}
      />
    </div>
  );
}
