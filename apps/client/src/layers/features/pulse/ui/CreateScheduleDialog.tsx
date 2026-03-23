import { useState, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  useCreateSchedule,
  useUpdateSchedule,
  useDeleteSchedule,
  usePulsePresetDialog,
} from '@/layers/entities/pulse';
import type { PulsePreset } from '@/layers/entities/pulse';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Switch,
} from '@/layers/shared/ui';
import type { PulseSchedule } from '@dorkos/shared/types';
import { PresetGallery } from './PresetGallery';
import {
  ScheduleForm,
  buildFormValues,
  type ScheduleFormValues,
  type ScheduleTarget,
  type DialogStep,
} from './ScheduleFormInner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editSchedule?: PulseSchedule;
  /** When provided, dialog opens directly at form step with this preset pre-filled. */
  initialPreset?: PulsePreset | null;
  /** Pre-select this agent when creating a new schedule. */
  initialAgentId?: string;
}

// ── CreateScheduleDialog ──────────────────────────────────────────────────────

/** Create or edit a Pulse schedule using ResponsiveDialog with progressive disclosure. */
export function CreateScheduleDialog({
  open,
  onOpenChange,
  editSchedule,
  initialPreset,
  initialAgentId,
}: Props) {
  const deleteSchedule = useDeleteSchedule();
  const updateSchedule = useUpdateSchedule();
  const createSchedule = useCreateSchedule();
  const { data: agentsData } = useMeshAgentPaths();
  const agents = agentsData?.agents ?? [];

  // ── UI-only state ──
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
  const [step, setStep] = useState<DialogStep>(() => (editSchedule ? 'form' : 'preset-picker'));
  const [appliedPreset, setAppliedPreset] = useState<PulsePreset | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Local shadow of enabled state — allows the Switch to respond immediately
  // while the mutation + refetch catches up.
  const [localEnabled, setLocalEnabled] = useState(editSchedule?.enabled ?? true);
  const [scheduleTarget, setScheduleTarget] = useState<ScheduleTarget>(() => {
    if (editSchedule?.agentId) return 'agent';
    if (editSchedule && !editSchedule.agentId && editSchedule.cwd) return 'directory';
    return 'agent';
  });

  // formValues drives ScheduleForm defaultValues. Changing this + incrementing
  // formKey causes ScheduleForm to remount with fresh form state.
  const [formValues, setFormValues] = useState<ScheduleFormValues>(() =>
    buildFormValues(editSchedule, undefined, initialAgentId)
  );
  // Incrementing this key remounts ScheduleForm so useAppForm gets fresh defaultValues.
  const [formKey, setFormKey] = useState(0);

  function applyFormValues(values: ScheduleFormValues) {
    setFormValues(values);
    setFormKey((k) => k + 1);
  }

  // Reset when dialog opens/closes or edit target changes.
  /* eslint-disable react-hooks/set-state-in-effect -- necessary to sync form with external state changes */
  useEffect(() => {
    if (!open) {
      applyFormValues(buildFormValues(editSchedule, undefined, initialAgentId));
      setAppliedPreset(null);
      setDeleteConfirmOpen(false);
      setStep(editSchedule ? 'form' : 'preset-picker');
      return;
    }
    if (editSchedule) {
      applyFormValues(buildFormValues(editSchedule));
      setScheduleTarget(editSchedule.agentId ? 'agent' : editSchedule.cwd ? 'directory' : 'agent');
      setLocalEnabled(editSchedule.enabled);
      setStep('form');
    } else if (initialPreset) {
      applyFormValues(buildFormValues(undefined, initialPreset, initialAgentId));
      setAppliedPreset(initialPreset);
      setStep('form');
    } else {
      applyFormValues(buildFormValues(undefined, undefined, initialAgentId));
      setScheduleTarget('agent');
      setStep('preset-picker');
    }
  }, [editSchedule, open, initialPreset, initialAgentId]);

  // Wire external trigger from usePulsePresetDialog (e.g. from SchedulesView sidebar).
  const { pendingPreset, externalTrigger, clear } = usePulsePresetDialog();

  useEffect(() => {
    if (externalTrigger && pendingPreset) {
      applyFormValues(buildFormValues(undefined, pendingPreset, initialAgentId));
      setAppliedPreset(pendingPreset);
      setStep('form');
      clear();
    }
  }, [externalTrigger, pendingPreset, clear, initialAgentId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleSelectPreset(preset: PulsePreset) {
    applyFormValues(buildFormValues(undefined, preset, initialAgentId));
    setAppliedPreset(preset);
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

  const isPending = createSchedule.isPending || updateSchedule.isPending;

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
              <p className="text-muted-foreground text-sm">Start from a template</p>
              <PresetGallery onSelect={handleSelectPreset} selectedId={appliedPreset?.id} />
              <button
                type="button"
                onClick={() => {
                  setAppliedPreset(null);
                  setStep('form');
                }}
                className="text-muted-foreground hover:text-foreground w-full text-center text-sm transition-colors"
              >
                Start from scratch
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Form — keyed so it remounts with fresh defaultValues on preset change */}
        {step === 'form' && (
          <ScheduleForm
            key={formKey}
            defaultValues={formValues}
            agents={agents}
            editSchedule={editSchedule}
            scheduleTarget={scheduleTarget}
            onScheduleTargetChange={setScheduleTarget}
            onSubmitSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            onDeleteClick={() => setDeleteConfirmOpen(true)}
            isPending={isPending}
            cwdPickerOpen={cwdPickerOpen}
            onCwdPickerOpenChange={setCwdPickerOpen}
          />
        )}
      </ResponsiveDialogContent>

      {editSchedule && (
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete schedule</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{editSchedule.name}&rdquo;? This will also remove all run history.
                This action cannot be undone.
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
