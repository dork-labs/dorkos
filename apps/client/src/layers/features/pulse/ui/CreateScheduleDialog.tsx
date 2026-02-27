import { useState, useEffect } from 'react';
import cronstrue from 'cronstrue';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, FolderOpen } from 'lucide-react';
import { useCreateSchedule, useUpdateSchedule } from '@/layers/entities/pulse';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  DirectoryPicker,
  Label,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { PulseSchedule } from '@dorkos/shared/types';
import { CronPresets } from './CronPresets';
import { CronVisualBuilder } from './CronVisualBuilder';
import { TimezoneCombobox } from './TimezoneCombobox';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editSchedule?: PulseSchedule;
}

type PermissionMode = 'acceptEdits' | 'bypassPermissions';

const DEFAULT_MAX_RUNTIME_MIN = 10;
const MAX_NAME_LENGTH = 100;
const MAX_RUNTIME_MIN = 720;

function getCronPreview(cron: string): string {
  if (!cron.trim()) return '';
  try {
    return cronstrue.toString(cron);
  } catch {
    return 'Invalid cron expression';
  }
}

function buildInitialState(editSchedule?: PulseSchedule) {
  if (editSchedule) {
    return {
      name: editSchedule.name,
      prompt: editSchedule.prompt,
      cron: editSchedule.cron,
      cwd: editSchedule.cwd ?? '',
      timezone: editSchedule.timezone ?? '',
      permissionMode: (editSchedule.permissionMode === 'bypassPermissions'
        ? 'bypassPermissions'
        : 'acceptEdits') as PermissionMode,
      maxRuntimeMin: editSchedule.maxRuntime ? editSchedule.maxRuntime / 60_000 : DEFAULT_MAX_RUNTIME_MIN,
    };
  }
  return {
    name: '',
    prompt: '',
    cron: '',
    cwd: '',
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
  timezone: string;
  permissionMode: PermissionMode;
  maxRuntimeMin: number;
}

/** Create or edit a Pulse schedule using ResponsiveDialog with progressive disclosure. */
export function CreateScheduleDialog({ open, onOpenChange, editSchedule }: Props) {
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();

  const [form, setForm] = useState<FormState>(() => buildInitialState(editSchedule));
  const [customBuilderOpen, setCustomBuilderOpen] = useState(false);
  const [cwdPickerOpen, setCwdPickerOpen] = useState(false);

  // Reset form when dialog opens or switches between create/edit
  useEffect(() => {
    setForm(buildInitialState(editSchedule));
  }, [editSchedule, open]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const cronPreview = getCronPreview(form.cron);
  const isValid = form.name.trim() && form.prompt.trim() && form.cron.trim();
  const isPending = createSchedule.isPending || updateSchedule.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || isPending) return;

    const input = {
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      cron: form.cron.trim(),
      ...(form.cwd.trim() && { cwd: form.cwd.trim() }),
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

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] max-w-lg gap-0 p-0">
        <ResponsiveDialogHeader className="border-b px-4 py-3">
          <ResponsiveDialogTitle>
            {editSchedule ? 'Edit Schedule' : 'New Schedule'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="sr-only">
            {editSchedule ? 'Edit an existing Pulse schedule' : 'Create a new Pulse schedule'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <form onSubmit={handleSubmit} id="schedule-form">
          <div className="space-y-5 overflow-y-auto px-4 py-5">
            {/* ── Essential fields ── */}
            <div className="space-y-1.5">
              <Label htmlFor="schedule-name">Name *</Label>
              <input
                id="schedule-name"
                className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
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

            <div className="space-y-2">
              <Label htmlFor="schedule-cron">Schedule *</Label>
              <CronPresets value={form.cron} onChange={(cron) => updateField('cron', cron)} />

              <button
                type="button"
                onClick={() => setCustomBuilderOpen((o) => !o)}
                className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronRight className={cn(
                  'size-3 transition-transform',
                  customBuilderOpen && 'rotate-90'
                )} />
                Custom schedule
              </button>

              <AnimatePresence initial={false}>
                {customBuilderOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="pt-2">
                      <CronVisualBuilder
                        value={form.cron}
                        onChange={(cron) => updateField('cron', cron)}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <input
                id="schedule-cron"
                className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
                value={form.cron}
                onChange={(e) => updateField('cron', e.target.value)}
                placeholder="0 9 * * 1-5"
                required
              />
              {cronPreview && (
                <p
                  className={cn(
                    'text-xs',
                    cronPreview === 'Invalid cron expression'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                  )}
                >
                  {cronPreview}
                </p>
              )}
            </div>

            {/* ── Common fields ── */}
            <div className="border-t pt-4">
              <div className="space-y-4">
                <div className="space-y-1.5">
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
                    <button
                      type="button"
                      onClick={() => setCwdPickerOpen(true)}
                      className="rounded-md border px-2 py-2 text-sm hover:bg-accent transition-colors"
                      aria-label="Browse directories"
                    >
                      <FolderOpen className="size-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label>Timezone</Label>
                  <TimezoneCombobox
                    value={form.timezone}
                    onChange={(tz) => updateField('timezone', tz)}
                  />
                </div>
              </div>
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
                  <input
                    id="schedule-max-runtime"
                    type="number"
                    className="border-input focus-visible:ring-ring w-24 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
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

        <ResponsiveDialogFooter className="border-t px-4 py-3">
          <button
            type="button"
            className="hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="schedule-form"
            disabled={!isValid || isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors disabled:pointer-events-none disabled:opacity-50"
          >
            {isPending ? 'Saving...' : editSchedule ? 'Save' : 'Create'}
          </button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
      <DirectoryPicker
        open={cwdPickerOpen}
        onOpenChange={setCwdPickerOpen}
        onSelect={(path) => updateField('cwd', path)}
      />
    </ResponsiveDialog>
  );
}
