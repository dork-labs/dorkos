import type { CreationMode as StoreCreationMode } from '@/layers/shared/model';

export type CreationMode = 'new' | 'template' | 'import';
export type WizardStep = 'choose' | 'pick-template' | 'configure' | 'import';
export type ConflictStatus =
  | 'idle'
  | 'checking'
  | 'no-path'
  | 'exists-no-dork'
  | 'exists-has-dork'
  | 'error';

export const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  choose: 'How do you want to start?',
  'pick-template': 'Pick a template',
  configure: 'Name your agent',
  import: 'Scan for existing projects',
};

/** Map the store's initialMode to the wizard's starting step. */
export function initialStepFromMode(mode: StoreCreationMode): WizardStep {
  switch (mode) {
    case 'template':
      return 'pick-template';
    case 'import':
      return 'import';
    default:
      return 'choose';
  }
}
