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
import type { WizardStep, SelectedTemplate } from '../lib/wizard-types';
import { STEP_HEADERS, initialStepFromMode } from '../lib/wizard-types';
import { isSingleEmoji } from '../lib/humanize-name';
import { DEFAULT_AGENT_FACE } from '../lib/agent-faces';
import { resolveSuggestionPool } from '../lib/name-suggestions';
import { AgentGallery } from './AgentGallery';
import { NamingStep } from './NamingStep';
import { ArrivalConfirm } from './ArrivalConfirm';

/**
 * The global agent-creation dialog. Controlled by `useAgentCreationStore`.
 *
 * Fullscreen on desktop, a drawer on mobile. Two entry shapes:
 * - Generic (⌘K, sidebar +, /agents, session tab +) → the gallery (M2) →
 *   naming (M3): pick "Design your own" or a ready-made agent, then name it.
 * - Seeded from an offer (a Shape's agent) → the arrival confirm (M1) → create
 *   in one click, or "Customize first" to reach the naming step pre-filled.
 */
export function CreateAgentDialog() {
  const { isOpen, initialMode, seed, close } = useAgentCreationStore();
  const createAgent = useCreateAgent();
  const navigate = useNavigate();
  const setSidebarLevel = useAppStore((s) => s.setSidebarLevel);

  // Wizard navigation state.
  const [step, setStep] = useState<WizardStep>('gallery');
  const [template, setTemplate] = useState<SelectedTemplate | null>(null);

  // Sync step from store when the dialog opens (React "adjust state on prop
  // change"). A seed lands on the arrival confirm (M1); otherwise the gallery.
  const [prevIsOpen, setPrevIsOpen] = useState(false);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      setTemplate(null);
      setStep(seed ? 'arrival' : initialStepFromMode(initialMode));
    }
  }

  // Seeds for the naming step, derived from the chosen template or the offer.
  const faceSeed =
    template?.icon && isSingleEmoji(template.icon) ? template.icon : DEFAULT_AGENT_FACE;
  const runtimeSeed = seed?.template.runtime ?? 'claude-code';

  const form = useConfigureForm({
    step,
    templateName: template?.displayName ?? null,
    seedDisplayName: seed?.template.displayName ?? null,
    faceSeed,
    runtimeSeed,
  });

  // Preview + suggestion inputs for the naming step.
  const suggestionPool = resolveSuggestionPool(
    template
      ? {
          name: template.name,
          description: template.description,
          category: template.category,
          tags: template.tags,
        }
      : seed
        ? { name: seed.template.displayName, description: seed.template.persona }
        : undefined
  );
  const jobLine = template
    ? (template.description ?? 'A ready-made agent.')
    : seed?.template.persona
      ? seed.template.persona
      : "You'll define the job together in your first conversation.";
  const previewCapabilities = template
    ? (template.tags ?? [])
    : (seed?.template.capabilities ?? []);

  function resetAll() {
    form.reset();
    setTemplate(null);
    setStep('gallery');
  }

  const handleSelectTemplate = useCallback((next: SelectedTemplate) => {
    setTemplate(next);
    setStep('naming');
  }, []);

  const handleDesignYourOwn = useCallback(() => {
    setTemplate(null);
    setStep('naming');
  }, []);

  function handleBackFromNaming() {
    setStep(seed ? 'arrival' : 'gallery');
  }

  function handleCreate() {
    if (!form.canSubmit || createAgent.isPending) return;
    createAgent.mutate(
      {
        name: form.slug,
        displayName: form.displayName.trim() || undefined,
        runtime: form.runtime,
        ...(form.directoryOverride ? { directory: form.directoryOverride } : {}),
        ...(form.icon ? { icon: form.icon } : {}),
        ...(template ? { template: template.source } : {}),
        // A seeded offer carries its own voice + abilities through to create.
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

  const header = STEP_HEADERS[step];
  const isArrival = step === 'arrival';
  // Per-step canvas width: the gallery spreads across the fullscreen frame,
  // naming holds a tighter two-column composition, arrival/import stay narrow.
  const stepMaxWidth =
    step === 'gallery' ? 'max-w-6xl' : step === 'naming' ? 'max-w-5xl' : 'max-w-2xl';

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={handleOpenChange} defaultFullscreen>
      <ResponsiveDialogContent className="flex flex-col gap-0 p-0">
        {/* The arrival confirm (M1) owns its own title/face — no generic header. */}
        {!isArrival && (
          <ResponsiveDialogHeader className="shrink-0 border-b px-5 py-4">
            <ResponsiveDialogTitle>{header.title}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>{header.description}</ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
        )}

        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {header.description}
        </span>

        {/* Composed fullscreen canvas: the inner wrapper's `my-auto` centers
            every step vertically while it underflows, and collapses to normal
            top-anchored scrolling the moment content exceeds the viewport. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 sm:px-8">
          <div className={`mx-auto my-auto w-full ${stepMaxWidth}`}>
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                {step === 'gallery' && (
                  <AgentGallery
                    onDesignYourOwn={handleDesignYourOwn}
                    onSelectTemplate={handleSelectTemplate}
                    onImport={() => setStep('import')}
                  />
                )}
                {step === 'arrival' && seed && (
                  <ArrivalConfirm
                    seed={seed}
                    resolvedDirectory={form.resolvedDirectory}
                    canSubmit={form.canSubmit}
                    isCreating={createAgent.isPending}
                    onCreate={handleCreate}
                    onCustomize={() => setStep('naming')}
                    onNotNow={() => handleOpenChange(false)}
                  />
                )}
                {step === 'naming' && (
                  <NamingStep
                    form={form}
                    suggestionPool={suggestionPool}
                    jobLine={jobLine}
                    previewCapabilities={previewCapabilities}
                    onBack={handleBackFromNaming}
                    onImportInstead={() => setStep('import')}
                    onCreate={handleCreate}
                    isCreating={createAgent.isPending}
                  />
                )}
                {step === 'import' && <DiscoveryView />}
              </motion.div>
            </AnimatePresence>
          </div>
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

        {step === 'import' && (
          <ResponsiveDialogFooter className="shrink-0 border-t px-5 py-3">
            <div className="flex w-full items-center">
              <Button variant="ghost" onClick={() => setStep('gallery')} data-testid="back-button">
                <ArrowLeft className="mr-1 size-4" />
                Back
              </Button>
            </div>
          </ResponsiveDialogFooter>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
