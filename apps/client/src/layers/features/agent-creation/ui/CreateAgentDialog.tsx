import { useState, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { playCelebration } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  Button,
  DirectoryPicker,
} from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { DiscoveryView } from '@/layers/features/mesh';
import { useAgentCreationStore } from '../model/store';
import { useCreateAgent } from '../model/use-create-agent';
import { useConfigureForm } from '../model/use-configure-form';
import type { CreationMode, WizardStep } from '../lib/wizard-types';
import { STEP_DESCRIPTIONS, initialStepFromMode } from '../lib/wizard-types';
import { MethodSelection } from './MethodSelection';
import { ConfigureStep } from './ConfigureStep';
import { TemplatePicker } from './TemplatePicker';
import { ArrivalConfirm } from './ArrivalConfirm';

/**
 * Global dialog for creating a new agent. Controlled by useAgentCreationStore.
 *
 * Two entry shapes: opened plainly it renders the method fork (choose → pick
 * template or configure → create); opened from an offer (a seed) it skips the
 * fork and renders the arrival confirm (M1) for that one agent, carrying the
 * seed's persona, runtime, and capabilities through to create.
 */
export function CreateAgentDialog() {
  const { isOpen, initialMode, seed, close } = useAgentCreationStore();
  const createAgent = useCreateAgent();
  const navigate = useNavigate();
  const setSidebarLevel = useAppStore((s) => s.setSidebarLevel);

  // Wizard navigation state
  const [step, setStep] = useState<WizardStep>('choose');
  const [creationMode, setCreationMode] = useState<CreationMode>('new');
  const [template, setTemplate] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);

  // Sync step from store when dialog opens (React "adjusting state on prop change" pattern).
  // A seed skips the fork and lands on the arrival confirm (M1).
  const [prevIsOpen, setPrevIsOpen] = useState(false);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      if (seed) {
        setStep('arrival');
        setCreationMode('new');
      } else {
        setStep(initialStepFromMode(initialMode));
        setCreationMode(
          initialMode === 'import' ? 'import' : initialMode === 'template' ? 'template' : 'new'
        );
      }
    }
  }

  const form = useConfigureForm({
    step,
    creationMode,
    templateName,
    seedDisplayName: seed?.template.displayName ?? null,
  });

  function resetAll() {
    form.reset();
    setTemplate(null);
    setTemplateName(null);
    setStep('choose');
    setCreationMode('new');
  }

  const handleMethodSelect = useCallback((mode: CreationMode) => {
    setCreationMode(mode);
    if (mode === 'template') setStep('pick-template');
    else if (mode === 'import') setStep('import');
    else setStep('configure');
  }, []);

  const handleTemplateSelect = useCallback((source: string | null, name?: string) => {
    if (source) {
      setTemplate(source);
      setTemplateName(name ?? source.split('/').pop() ?? null);
      setStep('configure');
    }
  }, []);

  function handleBack() {
    if (step === 'configure') {
      // A seeded configure came from the arrival confirm — go back there.
      if (seed) setStep('arrival');
      else setStep(creationMode === 'template' ? 'pick-template' : 'choose');
    } else setStep('choose');
  }

  function handleCreate() {
    if (!form.canSubmit || createAgent.isPending) return;
    createAgent.mutate(
      {
        name: form.slug,
        displayName: form.displayName.trim() || undefined,
        ...(form.directoryOverride ? { directory: form.directoryOverride } : {}),
        ...(creationMode === 'template' && template ? { template } : {}),
        // Carry the offer's shape through so the created agent arrives seeded,
        // not blank: its voice (persona), where it runs, and what it can do.
        ...(seed?.template.runtime ? { runtime: seed.template.runtime } : {}),
        ...(seed?.template.persona ? { persona: seed.template.persona } : {}),
        ...(seed?.template.capabilities?.length
          ? { capabilities: seed.template.capabilities }
          : {}),
      },
      {
        onSuccess: (data) => {
          playCelebration();
          close();
          resetAll();
          // Navigate to a new session for the freshly created agent
          navigate({
            to: '/session',
            search: { dir: data._path, session: crypto.randomUUID() },
          });
          setSidebarLevel('session');
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Failed to create agent');
        },
      }
    );
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      close();
      resetAll();
    }
  }

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 p-0">
        {/* The arrival confirm (M1) owns its own title/face — no generic header. */}
        {step !== 'arrival' && (
          <ResponsiveDialogHeader className="shrink-0 border-b px-4 py-3">
            <ResponsiveDialogTitle>Create Agent</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>{STEP_DESCRIPTIONS[step]}</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
        )}

        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {STEP_DESCRIPTIONS[step]}
        </span>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {step === 'choose' && <MethodSelection onSelect={handleMethodSelect} />}
              {step === 'arrival' && seed && (
                <ArrivalConfirm
                  seed={seed}
                  resolvedDirectory={form.resolvedDirectory}
                  canSubmit={form.canSubmit}
                  isCreating={createAgent.isPending}
                  onCreate={handleCreate}
                  onCustomize={() => setStep('configure')}
                  onNotNow={() => handleOpenChange(false)}
                />
              )}
              {step === 'pick-template' && <TemplatePicker onSelect={handleTemplateSelect} />}
              {step === 'configure' && (
                <ConfigureStep
                  form={form}
                  creationMode={creationMode}
                  template={{ source: template, name: templateName }}
                  onChangeTemplate={() => setStep('pick-template')}
                  onImportInstead={() => {
                    setCreationMode('import');
                    setStep('import');
                  }}
                />
              )}
              {step === 'import' && <DiscoveryView />}
            </motion.div>
          </AnimatePresence>
        </div>

        <DirectoryPicker
          open={form.directoryPickerOpen}
          onOpenChange={form.setDirectoryPickerOpen}
          initialPath={form.directoryOverride || form.defaultDirectory}
          onSelect={(path) => {
            form.setDirectoryOverride(path);
            if (!form.directoryOpen) form.setDirectoryOpen(true);
          }}
        />

        {step !== 'choose' && step !== 'arrival' && (
          <ResponsiveDialogFooter className="shrink-0 border-t px-4 py-3">
            <div className="flex w-full items-center justify-between">
              <Button variant="ghost" onClick={handleBack} data-testid="back-button">
                <ArrowLeft className="mr-1 size-4" />
                Back
              </Button>
              {step === 'configure' && (
                <Button
                  onClick={handleCreate}
                  disabled={!form.canSubmit || createAgent.isPending}
                  data-testid="create-button"
                >
                  {createAgent.isPending ? 'Creating...' : 'Create Agent'}
                </Button>
              )}
            </div>
          </ResponsiveDialogFooter>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
