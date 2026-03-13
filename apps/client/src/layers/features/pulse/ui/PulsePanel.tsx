import { useState, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { FeatureDisabledState } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { icons } from '@dorkos/icons/registry';
import { usePulseEnabled, useSchedules, usePulsePresetDialog } from '@/layers/entities/pulse';
import type { PulsePreset } from '@/layers/entities/pulse';
import { useResolvedAgents } from '@/layers/entities/agent';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import type { PulseSchedule } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { CreateScheduleDialog } from './CreateScheduleDialog';
import { PulseEmptyState } from './PulseEmptyState';
import { ScheduleRow } from './ScheduleRow';

/** Main Pulse panel — renders schedule list or empty/loading/disabled states. */
export function PulsePanel() {
  const pulseEnabled = usePulseEnabled();
  const { data: allSchedules = [], isLoading } = useSchedules(pulseEnabled);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<PulseSchedule | undefined>();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [appliedPresetForDialog, setAppliedPresetForDialog] = useState<PulsePreset | null>(null);

  const pulseAgentFilter = useAppStore((s) => s.pulseAgentFilter);
  const setPulseAgentFilter = useAppStore((s) => s.setPulseAgentFilter);
  const pulseEditScheduleId = useAppStore((s) => s.pulseEditScheduleId);
  const setPulseEditScheduleId = useAppStore((s) => s.setPulseEditScheduleId);

  // Filter schedules by agent when filter is active
  const schedules = pulseAgentFilter
    ? allSchedules.filter((s) => s.agentId === pulseAgentFilter)
    : allSchedules;

  // Batch-resolve agents for all schedule CWDs
  const uniquePaths = [...new Set(allSchedules.map((s) => s.cwd).filter(Boolean) as string[])];
  const { data: resolvedAgents } = useResolvedAgents(uniquePaths);

  // Also fetch registered mesh agents for agentId-based schedules
  const hasAgentIdSchedules = allSchedules.some((s) => s.agentId && !s.cwd);
  const { data: meshAgentsData } = useRegisteredAgents(undefined, hasAgentIdSchedules);
  const meshAgentsById = useMemo(() => {
    const map = new Map<string, AgentManifest>();
    for (const agent of meshAgentsData?.agents ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [meshAgentsData]);

  // Open edit dialog for a specific schedule via store
  useEffect(() => {
    if (!pulseEditScheduleId || isLoading) return;
    const target = allSchedules.find((s) => s.id === pulseEditScheduleId);
    if (target) {
      setEditSchedule(target);
      setDialogOpen(true);
    }
    setPulseEditScheduleId(null);
  }, [pulseEditScheduleId, allSchedules, isLoading, setPulseEditScheduleId]);

  // Resolve filtered agent name for the filter chip
  const filterAgentName = useMemo(() => {
    if (!pulseAgentFilter) return null;
    return meshAgentsById.get(pulseAgentFilter)?.name ?? pulseAgentFilter;
  }, [pulseAgentFilter, meshAgentsById]);

  const { externalTrigger } = usePulsePresetDialog();

  useEffect(() => {
    if (externalTrigger) {
      setEditSchedule(undefined);
      setDialogOpen(true);
    }
  }, [externalTrigger]);

  const handleCreateWithPreset = (preset: PulsePreset) => {
    setAppliedPresetForDialog(preset);
    setEditSchedule(undefined);
    setDialogOpen(true);
  };

  const handleCreateBlank = () => {
    setAppliedPresetForDialog(null);
    setEditSchedule(undefined);
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) setAppliedPresetForDialog(null);
  };

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
        {pulseAgentFilter ? (
          <div className="flex flex-col items-center gap-3 p-8">
            <AgentFilterChip name={filterAgentName} onClear={() => setPulseAgentFilter(null)} />
            <p className="text-sm text-muted-foreground">No schedules for this agent.</p>
            <button
              onClick={handleCreateBlank}
              className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
            >
              New Schedule
            </button>
          </div>
        ) : (
          <PulseEmptyState
            onCreateWithPreset={handleCreateWithPreset}
            onCreateBlank={handleCreateBlank}
          />
        )}
        <CreateScheduleDialog
          open={dialogOpen}
          onOpenChange={handleDialogOpenChange}
          editSchedule={editSchedule}
          initialPreset={appliedPresetForDialog}
          initialAgentId={pulseAgentFilter ?? undefined}
        />
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Schedules</h3>
            {pulseAgentFilter && (
              <AgentFilterChip name={filterAgentName} onClear={() => setPulseAgentFilter(null)} />
            )}
          </div>
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
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <AnimatePresence initial={false}>
          {schedules.map((schedule) => (
            <motion.div
              key={schedule.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="mb-2"
            >
              <ScheduleRow
                schedule={schedule}
                agent={resolvedAgents?.[schedule.cwd ?? ''] ?? (schedule.agentId ? meshAgentsById.get(schedule.agentId) : null) ?? null}
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
      </div>
      <CreateScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editSchedule={editSchedule}
        initialPreset={appliedPresetForDialog}
        initialAgentId={pulseAgentFilter ?? undefined}
      />
    </div>
  );
}

/** Compact chip showing the active agent filter with a clear button. */
function AgentFilterChip({ name, onClear }: { name: string | null; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
      {name ?? 'Agent'}
      <button
        type="button"
        onClick={onClear}
        className="hover:text-foreground -mr-0.5 rounded-full p-0.5 transition-colors"
        aria-label="Clear agent filter"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
