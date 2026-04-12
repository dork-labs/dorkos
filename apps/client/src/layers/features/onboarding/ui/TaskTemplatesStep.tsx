import { useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/layers/shared/ui';
import { useCreateTask, useTaskTemplates } from '@/layers/entities/tasks';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { TaskTemplateCard } from '@/layers/features/tasks';

interface TaskTemplatesStepProps {
  onStepComplete: () => void;
  agents: AgentPathEntry[];
}

/**
 * Onboarding step for selecting recurring Tasks schedule presets.
 * Displays available presets with toggles, a project picker when multiple
 * agents exist, and a confirmation button.
 *
 * @param onStepComplete - Called when the user finishes selecting presets
 * @param agents - Registered agents with project paths from the discovery step
 */
export function TaskTemplatesStep({ onStepComplete, agents }: TaskTemplatesStepProps) {
  const { data: presets, isLoading, isError } = useTaskTemplates();
  const createSchedule = useCreateTask();
  const [enabledPresets, setEnabledPresets] = useState<Set<string> | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  // Auto-resolve when exactly 1 agent
  const resolvedAgent =
    agents.length === 1 ? agents[0] : (agents.find((a) => a.id === selectedAgentId) ?? null);

  // Initialize enabledPresets with all preset IDs once data loads
  const resolvedEnabled = useMemo(
    () => enabledPresets ?? new Set(presets?.map((p) => p.id) ?? []),
    [enabledPresets, presets]
  );

  const handleToggle = useCallback(
    (id: string) => {
      setEnabledPresets((prev) => {
        const current = prev ?? new Set(presets?.map((p) => p.id) ?? []);
        const next = new Set(current);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [presets]
  );

  const selectedCount = resolvedEnabled.size;
  const canCreate = selectedCount > 0 && resolvedAgent !== null;

  const handleCreateSchedules = useCallback(async () => {
    if (!presets || selectedCount === 0 || !resolvedAgent) {
      onStepComplete();
      return;
    }

    setIsCreating(true);
    const selected = presets.filter((p) => resolvedEnabled.has(p.id));
    const results = await Promise.allSettled(
      selected.map((preset) =>
        createSchedule.mutateAsync({
          name: preset.name,
          description: preset.description,
          prompt: preset.prompt,
          cron: preset.cron,
          target: resolvedAgent.id,
        })
      )
    );
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('[TaskTemplatesStep] Schedule creation failures:', failures);
      toast.warning(
        `${failures.length} of ${selected.length} schedule(s) failed to create. You can retry from Tasks later.`
      );
    }
    setIsCreating(false);
    onStepComplete();
  }, [presets, selectedCount, resolvedEnabled, resolvedAgent, createSchedule, onStepComplete]);

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 space-y-4 overflow-y-auto px-4">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">
          Want your agents to work while you sleep?
        </h2>
        <p className="text-muted-foreground text-sm">
          Tasks runs automated tasks on a schedule — like a cron job for your agents.
        </p>
      </div>

      {/* Project picker — single agent shows read-only, 2+ shows Select */}
      {agents.length === 1 && (
        <p className="text-muted-foreground text-center text-sm">
          Scheduling for {agents[0].icon ? `${agents[0].icon} ` : ''}
          {agents[0].name}
        </p>
      )}

      {agents.length >= 2 && (
        <div className="mx-auto max-w-xs">
          <Select value={selectedAgentId ?? ''} onValueChange={setSelectedAgentId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a project..." />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.icon ? `${agent.icon} ` : ''}
                  {getAgentDisplayName(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isLoading && <p className="text-muted-foreground text-center text-sm">Loading presets...</p>}

      {isError && (
        <p className="text-destructive text-center text-sm">
          Failed to load presets. You can skip this step and configure schedules later.
        </p>
      )}

      {presets && presets.length > 0 && (
        <div className="grid gap-3">
          {presets.map((preset) => (
            <TaskTemplateCard
              key={preset.id}
              preset={preset}
              variant="toggle"
              checked={resolvedEnabled.has(preset.id)}
              onCheckedChange={() => handleToggle(preset.id)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col items-center gap-3 pt-2">
        <Button
          onClick={handleCreateSchedules}
          size="lg"
          disabled={isCreating || (selectedCount > 0 && !canCreate)}
        >
          {isCreating
            ? 'Creating...'
            : selectedCount > 0
              ? `Create ${selectedCount} Schedule${selectedCount === 1 ? '' : 's'}`
              : 'Continue Without Schedules'}
        </Button>
        {agents.length >= 2 && (
          <p className="text-muted-foreground text-xs">
            You can put your other agents on autopilot anytime from Tasks.
          </p>
        )}
      </div>
    </div>
  );
}
