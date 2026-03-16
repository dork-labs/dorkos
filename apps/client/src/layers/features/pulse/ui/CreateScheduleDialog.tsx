import { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen, Trash2 } from 'lucide-react';
import { useCreateSchedule, useUpdateSchedule, useDeleteSchedule, usePulsePresetDialog } from '@/layers/entities/pulse';
import type { PulsePreset } from '@/layers/entities/pulse';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  DirectoryPicker,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Switch,
  Label,
  Input,
  Button,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { PulseSchedule } from '@dorkos/shared/types';
import { ScheduleBuilder, DEFAULT_CRON } from './ScheduleBuilder';
import { TimezoneCombobox } from './TimezoneCombobox';
import { AgentPicker } from './AgentPicker';
import { PresetGallery } from './PresetGallery';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editSchedule?: PulseSchedule;
  /** When provided, dialog opens directly at form step with this preset pre-filled. */
  initialPreset?: PulsePreset | null;
  /** Pre-select this agent when creating a new schedule. */
  initialAgentId?: string;
}

type PermissionMode = 'acceptEdits' | 'bypassPermissions';
type ScheduleTarget = 'agent' | 'directory';

const DEFAULT_MAX_RUNTIME_MIN = 10;
const MAX_NAME_LENGTH = 100;
const MAX_RUNTIME_MIN = 720;

function buildInitialState(editSchedule?: PulseSchedule, preset?: PulsePreset | null, initialAgentId?: string) {
  if (editSchedule) {
    return {
      name: editSchedule.name,
      prompt: editSchedule.prompt,
      cron: editSchedule.cron,
      cwd: editSchedule.cwd ?? '',
      agentId: editSchedule.agentId ?? undefined,
      timezone: editSchedule.timezone ?? '',
      permissionMode: (editSchedule.permissionMode === 'bypassPermissions'
        ? 'bypassPermissions'
        : 'acceptEdits') as PermissionMode,
      maxRuntimeMin: editSchedule.maxRuntime ? editSchedule.maxRuntime / 60_000 : DEFAULT_MAX_RUNTIME_MIN,
    };
  }
  if (preset) {
    return {
      name: preset.name,
      prompt: preset.prompt,
      cron: preset.cron,
      cwd: '',
      agentId: initialAgentId ?? (undefined as string | undefined),
      timezone: preset.timezone ?? '',
      permissionMode: 'acceptEdits' as PermissionMode,
      maxRuntimeMin: DEFAULT_MAX_RUNTIME_MIN,
    };
  }
  return {
    name: '',
    prompt: '',
    cron: DEFAULT_CRON,
    cwd: '',
    agentId: initialAgentId ?? (undefined as string | undefined),
    timezone: '',
    permissionMode: 'acceptEdits' as PermissionMode,
    maxRuntimeMin: DEFAULT_MAX_RUNTIME_MIN,
  };
}

interface FormState {
  name: string;
  prompt: string;
  cron: string;
  cwd: string;
  agentId: string | undefined;
  timezone: string;
  permissionMode: PermissionMode;
  maxRuntimeMin: number;
}

type DialogStep = 'preset-picker' | 'form';

/** Create or edit a Pulse schedule using ResponsiveDialog with progressive disclosure. */
export function CreateScheduleDialog({ open, onOpenChange, editSchedule, initialPreset, initialAgentId }: Props) {
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const { data: agentsData } = useMeshAgentPaths();
  const agents = agentsData?.agents ?? [];

  const [form, setForm] = useState<FormState>(() => buildInitialState(editSchedule, undefined, initialAgentId));
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [step, setStep] = useState<DialogStep>(() => (editSchedule ? 'form' : 'preset-picker'));
  const [appliedPreset, setAppliedPreset] = useState<PulsePreset | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Local shadow of enabled state — allows the Switch to respond immediately
  // while the mutation + refetch catches up.
  const [localEnabled, setLocalEnabled] = useState(editSchedule?.enabled ?? true);

  // Determine initial schedule target: 'agent' if editing an agent-linked schedule,
  // or if no edit and agents exist; otherwise 'directory'.
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget>(() => {
    if (editSchedule?.agentId) return 'agent';
    if (editSchedule && !editSchedule.agentId && editSchedule.cwd) return 'directory';
    return 'agent';
  });

  // Reset form when dialog opens or switches between create/edit
  useEffect(() => {
    if (!open) {
      // Reset on close
      setForm(buildInitialState(editSchedule, undefined, initialAgentId));
      setAppliedPreset(null);
      setDeleteConfirmOpen(false);
      setStep(editSchedule ? 'form' : 'preset-picker');
      return;
    }
    if (editSchedule) {
      setForm(buildInitialState(editSchedule));
      setScheduleTarget(editSchedule.agentId ? 'agent' : (editSchedule.cwd ? 'directory' : 'agent'));
      setLocalEnabled(editSchedule.enabled);
      setStep('form');
    } else if (initialPreset) {
      setForm(buildInitialState(undefined, initialPreset, initialAgentId));
      setAppliedPreset(initialPreset);
      setStep('form');
    } else {
      setForm(buildInitialState(undefined, undefined, initialAgentId));
      setScheduleTarget('agent');
      setStep('preset-picker');
    }
   
  }, [editSchedule, open, initialPreset, initialAgentId]);

  // Wire external trigger from usePulsePresetDialog (e.g. from SchedulesView sidebar)
  const { pendingPreset, externalTrigger, clear } = usePulsePresetDialog();

  useEffect(() => {
    if (externalTrigger && pendingPreset) {
      setAppliedPreset(pendingPreset);
      setForm(buildInitialState(undefined, pendingPreset, initialAgentId));
      setStep('form');
      clear();
    }
  }, [externalTrigger, pendingPreset, clear, initialAgentId]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const isValid = form.name.trim() && form.prompt.trim() && form.cron.trim();
  const isPending = createSchedule.isPending || updateSchedule.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || isPending) return;

    const input = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cron: form.cron.trim(),
      ...(scheduleTarget === 'agent' && form.agentId ? { agentId: form.agentId } : {}),
      ...(scheduleTarget === 'directory' && form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      ...(form.timezone && { timezone: form.timezone }),
      permissionMode: form.permissionMode,
      maxRuntime: form.maxRuntimeMin * 60_000,
    };

    if (editSchedule) {
      updateSchedule.mutate(
        { id: editSchedule.id, ...input },
        { onSuccess: () => onOpenChange(false) }
      );
    } else {
      createSchedule.mutate(input, { onSuccess: () => onOpenChange(false) });
    }
  }

  function handleSelectPreset(preset: PulsePreset) {
    setAppliedPreset(preset);
    setForm(buildInitialState(undefined, preset, initialAgentId));
    setStep('form');
  }

  function handleDelete() {
    if (!editSchedule) return;
    deleteSchedule.mutate(editSchedule.id, {
      onSuccess: () => {
        setDeleteConfirmOpen(false);
        onOpenChange(false);
      },
    });
  }

  function handleToggleEnabled(checked: boolean) {
    if (!editSchedule) return;
    setLocalEnabled(checked);
    updateSchedule.mutate({ id: editSchedule.id, enabled: checked });
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 p-0">
        <ResponsiveDialogHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {step === 'form' && !editSchedule && (
              <button
                type="button"
                onClick={() => setStep('preset-picker')}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm"
                aria-label="Back to preset picker"
              >
                <ChevronLeft className="size-4" />
                Back
              </button>
            )}
            <ResponsiveDialogTitle>
              {editSchedule ? 'Edit Schedule' : 'New Schedule'}
            </ResponsiveDialogTitle>
            {editSchedule && (
              <Switch
                className="ml-auto"
                checked={localEnabled}
                onCheckedChange={handleToggleEnabled}
                aria-label={localEnabled ? 'Disable schedule' : 'Enable schedule'}
              />
            )}
          </div>
          <ResponsiveDialogDescription className="sr-only">
            {editSchedule ? 'Edit an existing Pulse schedule' : 'Create a new Pulse schedule'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {/* Step 1: Preset picker */}
        {step === 'preset-picker' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-4 px-4 py-5">
              <p className="text-sm text-muted-foreground">Start from a template</p>
              <PresetGallery onSelect={handleSelectPreset} selectedId={appliedPreset?.id} />
              <button
                type="button"
                onClick={() => { setAppliedPreset(null); setStep('form'); }}
                className="text-muted-foreground hover:text-foreground w-full text-center text-sm transition-colors"
              >
                Start from scratch
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Form (existing) */}
        {step === 'form' && (
          <form onSubmit={handleSubmit} id="schedule-form" className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-5 px-4 py-5">
              {/* ── Agent ── */}
              {scheduleTarget === 'agent' ? (
                <div className="space-y-2">
                  <Label>Agent</Label>
                  <AgentPicker
                    agents={agents}
                    value={form.agentId}
                    onValueChange={(id) => updateField('agentId', id)}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setScheduleTarget('directory');
                      updateField('agentId', undefined);
                    }}
                    className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
                  >
                    Run in a specific directory instead...
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setScheduleTarget('agent')}
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                  >
                    <ChevronLeft className="size-3" />
                    Back to agent selection
                  </button>
                  <Label htmlFor="schedule-cwd">Working Directory</Label>
                  <div className="flex gap-2">
                    <div
                      className={cn(
                        'flex-1 truncate rounded-md border px-3 py-2 text-sm font-mono',
                        form.cwd ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      {form.cwd || 'Default (server working directory)'}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      onClick={() => setCwdPickerOpen(true)}
                      aria-label="Browse directories"
                    >
                      <FolderOpen className="size-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* ── Essential fields ── */}
              <div className="space-y-1.5">
                <Label htmlFor="schedule-name">Name *</Label>
                <Input
                  id="schedule-name"
                  value={form.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  maxLength={MAX_NAME_LENGTH}
                  placeholder="Daily code review"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="schedule-prompt">Prompt *</Label>
                <textarea
                  id="schedule-prompt"
                  className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                  value={form.prompt}
                  onChange={(e) => updateField('prompt', e.target.value)}
                  rows={4}
                  placeholder="Review all pending PRs and summarize findings..."
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label>Schedule *</Label>
                <ScheduleBuilder
                  value={form.cron}
                  onChange={(cron) => updateField('cron', cron)}
                />
              </div>

              {/* ── Timezone ── */}
              <div className="space-y-1.5">
                <Label>Timezone</Label>
                <TimezoneCombobox
                  value={form.timezone}
                  onChange={(tz) => updateField('timezone', tz)}
                />
              </div>

              {/* ── Advanced settings (collapsed by default) ── */}
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
                  <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
                  Advanced settings
                </summary>

                <div className="mt-3 space-y-4 pl-6">
                  <fieldset className="space-y-2">
                    <legend className="mb-1.5 text-sm font-medium">Permission Mode</legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="permissionMode"
                        checked={form.permissionMode === 'acceptEdits'}
                        onChange={() => updateField('permissionMode', 'acceptEdits')}
                      />
                      Allow file edits
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="permissionMode"
                        checked={form.permissionMode === 'bypassPermissions'}
                        onChange={() => updateField('permissionMode', 'bypassPermissions')}
                      />
                      Full autonomy
                    </label>
                    {form.permissionMode === 'bypassPermissions' && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400">
                        Warning: This allows the agent to execute any tool without approval.
                      </p>
                    )}
                  </fieldset>

                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-max-runtime">Max Runtime (minutes)</Label>
                    <Input
                      id="schedule-max-runtime"
                      type="number"
                      className="w-24"
                      value={form.maxRuntimeMin}
                      onChange={(e) => updateField('maxRuntimeMin', Number(e.target.value))}
                      min={1}
                      max={MAX_RUNTIME_MIN}
                    />
                  </div>
                </div>
              </details>
            </div>
          </form>
        )}

        {step === 'form' && (
          <ResponsiveDialogFooter className="shrink-0 border-t px-4 py-3">
            {editSchedule && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto text-destructive hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="mr-1.5 size-4" />
                Delete
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              form="schedule-form"
              disabled={!isValid || isPending}
            >
              {isPending ? 'Saving...' : editSchedule ? 'Save' : 'Create'}
            </Button>
          </ResponsiveDialogFooter>
        )}
      </ResponsiveDialogContent>
      <DirectoryPicker
        open={cwdPickerOpen}
        onOpenChange={setCwdPickerOpen}
        onSelect={(path) => updateField('cwd', path)}
      />
      {editSchedule && (
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete schedule</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{editSchedule.name}&rdquo;? This will also remove all run history. This
                action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteSchedule.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                {deleteSchedule.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ResponsiveDialog>
  );
}
