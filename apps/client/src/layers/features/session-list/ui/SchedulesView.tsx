import {
  useSchedules,
  useActiveRunCount,
  usePulsePresets,
  usePulsePresetDialog,
} from '@/layers/entities/pulse';
import { formatCron } from '@/layers/features/pulse';
import { useAppStore } from '@/layers/shared/model';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  ScrollArea,
} from '@/layers/shared/ui';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import type { ChipState } from '@/layers/entities/agent';

interface SchedulesViewProps {
  /** Per-agent Pulse chip state from useAgentToolStatus */
  toolStatus: ChipState;
  /** When non-null, only show schedules assigned to this agent. */
  agentId: string | null;
}

/** Read-only schedule summary for the sidebar Schedules tab. */
export function SchedulesView({ toolStatus, agentId }: SchedulesViewProps) {
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);
  const openPulseForAgent = useAppStore((s) => s.openPulseForAgent);
  const openPulseToEdit = useAppStore((s) => s.openPulseToEdit);
  const enabled = toolStatus !== 'disabled-by-server';
  const { data: allSchedules = [] } = useSchedules(enabled);
  const { data: activeRunCount = 0 } = useActiveRunCount(enabled);
  const { data: presets = [] } = usePulsePresets();
  const { openWithPreset } = usePulsePresetDialog();

  // Show first and third preset by index to avoid hardcoding IDs
  const featuredPresets = [presets[0], presets[2]].filter(Boolean);

  // Filter to only schedules assigned to the selected agent
  const schedules = agentId ? allSchedules.filter((s) => s.agentId === agentId) : allSchedules;

  if (toolStatus === 'disabled-by-agent') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-8">
        <p className="text-muted-foreground/60 text-sm">Pulse disabled for this agent</p>
        <button
          onClick={() => (agentId ? openPulseForAgent(agentId) : setPulseOpen(true))}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          Open Pulse →
        </button>
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <div className="flex flex-col gap-3 px-3 py-4">
        <p className="text-muted-foreground/70 text-xs">No schedules yet.</p>
        {featuredPresets.length > 0 && (
          <div className="space-y-2">
            {featuredPresets.map((preset) => (
              <div key={preset.id} className="rounded-lg border p-3 text-sm">
                <div className="font-medium">{preset.name}</div>
                <p className="text-muted-foreground text-xs">{formatCron(preset.cron)}</p>
                <button
                  type="button"
                  onClick={() => {
                    openWithPreset(preset);
                    if (agentId) openPulseForAgent(agentId);
                    else setPulseOpen(true);
                  }}
                  className="text-primary mt-2 text-xs hover:underline"
                >
                  + Use preset
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => (agentId ? openPulseForAgent(agentId) : setPulseOpen(true))}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          Open Pulse →
        </button>
      </div>
    );
  }

  // Active schedules: enabled with active status (may have runs in progress)
  const activeSchedules = schedules.filter((s) => s.enabled && s.status === 'active');
  // Other schedules: disabled, paused, or pending approval
  const otherSchedules = schedules.filter((s) => !s.enabled || s.status !== 'active');

  return (
    <ScrollArea type="scroll" className="h-full">
      <div className="pr-1">
        {activeSchedules.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Active
              {activeRunCount > 0 && (
                <span className="text-muted-foreground/50 ml-auto text-xs font-normal normal-case">
                  {activeRunCount} running
                </span>
              )}
            </SidebarGroupLabel>
            <SidebarMenu>
              {activeSchedules.map((schedule) => (
                <SidebarMenuItem key={schedule.id}>
                  <SidebarMenuButton
                    onClick={() => openPulseToEdit(schedule.id)}
                    className="text-sm"
                  >
                    <span className="size-2 shrink-0 animate-pulse rounded-full bg-green-500" />
                    <span className="truncate">{schedule.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        {otherSchedules.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Upcoming
            </SidebarGroupLabel>
            <SidebarMenu>
              {otherSchedules.map((schedule) => (
                <SidebarMenuItem key={schedule.id}>
                  <SidebarMenuButton
                    onClick={() => openPulseToEdit(schedule.id)}
                    className="text-sm"
                  >
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        schedule.enabled ? 'bg-muted-foreground/40' : 'bg-muted-foreground/20'
                      )}
                    />
                    <span className="truncate">{schedule.name}</span>
                    {schedule.nextRun && (
                      <span className="text-muted-foreground/50 ml-auto text-xs">
                        {formatRelativeTime(schedule.nextRun)}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        <div className="px-3 py-2">
          <button
            onClick={() => (agentId ? openPulseForAgent(agentId) : setPulseOpen(true))}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Open Pulse →
          </button>
        </div>
      </div>
    </ScrollArea>
  );
}
