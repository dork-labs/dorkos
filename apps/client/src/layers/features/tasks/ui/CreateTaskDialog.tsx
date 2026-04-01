import { useState, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useTaskTemplateDialog,
} from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
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
import type { Task } from '@dorkos/shared/types';
import { TaskTemplateGallery } from './TaskTemplateGallery';
import {
  ScheduleForm,
  buildFormValues,
  type ScheduleFormValues,
  type DialogStep,
} from './TaskFormInner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTask?: Task;
  /** When provided, dialog opens directly at form step with this preset pre-filled. */
  initialPreset?: TaskTemplate | null;
  /** Pre-select this agent when creating a new schedule. */
  initialAgentId?: string;
}

// ── CreateTaskDialog ──────────────────────────────────────────────────────

/** Create or edit a Tasks schedule using ResponsiveDialog with progressive disclosure. */
export function CreateTaskDialog({
  open,
  onOpenChange,
  editTask,
  initialPreset,
  initialAgentId,
}: Props) {
  const deleteTask = useDeleteTask();
  const updateTask = useUpdateTask();
  const createTask = useCreateTask();
  const { data: agentsData } = useMeshAgentPaths();
  const agents = agentsData?.agents ?? [];

  // ── UI-only state ──
  const [step, setStep] = useState<DialogStep>(() => (editTask ? 'form' : 'preset-picker'));
  const [appliedPreset, setAppliedPreset] = useState<TaskTemplate | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Local shadow of enabled state — allows the Switch to respond immediately
  // while the mutation + refetch catches up.
  const [localEnabled, setLocalEnabled] = useState(editTask?.enabled ?? true);

  // formValues drives ScheduleForm defaultValues. Changing this + incrementing
  // formKey causes ScheduleForm to remount with fresh form state.
  const [formValues, setFormValues] = useState<ScheduleFormValues>(() =>
    buildFormValues(editTask, undefined, initialAgentId)
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
      applyFormValues(buildFormValues(editTask, undefined, initialAgentId));
      setAppliedPreset(null);
      setDeleteConfirmOpen(false);
      setStep(editTask ? 'form' : 'preset-picker');
      return;
    }
    if (editTask) {
      applyFormValues(buildFormValues(editTask));
      setLocalEnabled(editTask.enabled);
      setStep('form');
    } else if (initialPreset) {
      applyFormValues(buildFormValues(undefined, initialPreset, initialAgentId));
      setAppliedPreset(initialPreset);
      setStep('form');
    } else {
      applyFormValues(buildFormValues(undefined, undefined, initialAgentId));
      setStep('preset-picker');
    }
  }, [editTask, open, initialPreset, initialAgentId]);

  // Wire external trigger from useTaskTemplateDialog (e.g. from TasksView sidebar).
  const { pendingTemplate, externalTrigger, clear } = useTaskTemplateDialog();

  useEffect(() => {
    if (externalTrigger && pendingTemplate) {
      applyFormValues(buildFormValues(undefined, pendingTemplate, initialAgentId));
      setAppliedPreset(pendingTemplate);
      setStep('form');
      clear();
    }
  }, [externalTrigger, pendingTemplate, clear, initialAgentId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleSelectPreset(preset: TaskTemplate) {
    applyFormValues(buildFormValues(undefined, preset, initialAgentId));
    setAppliedPreset(preset);
    setStep('form');
  }

  function handleDelete() {
    if (!editTask) return;
    deleteTask.mutate(editTask.id, {
      onSuccess: () => {
        setDeleteConfirmOpen(false);
        onOpenChange(false);
      },
    });
  }

  function handleToggleEnabled(checked: boolean) {
    if (!editTask) return;
    setLocalEnabled(checked);
    updateTask.mutate({ id: editTask.id, enabled: checked });
  }

  const isPending = createTask.isPending || updateTask.isPending;

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 p-0">
        <ResponsiveDialogHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {step === 'form' && !editTask && (
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
              {editTask ? 'Edit Schedule' : 'New Schedule'}
            </ResponsiveDialogTitle>
            {editTask && (
              <Switch
                className="ml-auto"
                checked={localEnabled}
                onCheckedChange={handleToggleEnabled}
                aria-label={localEnabled ? 'Disable schedule' : 'Enable schedule'}
              />
            )}
          </div>
          <ResponsiveDialogDescription className="sr-only">
            {editTask ? 'Edit an existing Tasks schedule' : 'Create a new Tasks schedule'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {/* Step 1: Preset picker */}
        {step === 'preset-picker' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-4 px-4 py-5">
              <p className="text-muted-foreground text-sm">Start from a template</p>
              <TaskTemplateGallery onSelect={handleSelectPreset} selectedId={appliedPreset?.id} />
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
            editTask={editTask}
            onSubmitSuccess={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            onDeleteClick={() => setDeleteConfirmOpen(true)}
            isPending={isPending}
          />
        )}
      </ResponsiveDialogContent>

      {editTask && (
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete schedule</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{editTask.name}&rdquo;? This will also remove all run history. This
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
                disabled={deleteTask.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                {deleteTask.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ResponsiveDialog>
  );
}
