import { create } from 'zustand';
import type { TaskTemplate } from '@dorkos/shared/types';

interface TaskTemplateDialogState {
  /** Template to pre-populate when dialog opens externally, or null for blank form. */
  pendingTemplate: TaskTemplate | null;
  /** True when the dialog was triggered externally (e.g., from TasksView sidebar or header). */
  externalTrigger: boolean;
  /**
   * Signal TasksPage to open CreateTaskDialog at form step with this template.
   *
   * @param template - The template to pre-populate the form with
   */
  openWithTemplate: (template: TaskTemplate) => void;
  /** Signal TasksPage to open CreateTaskDialog with a blank form. */
  openBlank: () => void;
  /** Reset after the dialog has consumed the pending state. */
  clear: () => void;
}

export const useTaskTemplateDialog = create<TaskTemplateDialogState>((set) => ({
  pendingTemplate: null,
  externalTrigger: false,
  openWithTemplate: (template) => set({ pendingTemplate: template, externalTrigger: true }),
  openBlank: () => set({ pendingTemplate: null, externalTrigger: true }),
  clear: () => set({ pendingTemplate: null, externalTrigger: false }),
}));
