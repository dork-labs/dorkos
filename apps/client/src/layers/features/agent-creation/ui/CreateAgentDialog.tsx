import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { playCelebration, isSingleEmoji } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  DirectoryPicker,
} from '@/layers/shared/ui';
import { useAppStore, useImportProjectsStore, useAgentBirthStore } from '@/layers/shared/model';
import { useAgentCreationStore } from '../model/store';
import { useCreateAgent } from '../model/use-create-agent';
import { useConfigureForm } from '../model/use-configure-form';
import type { WizardStep, SelectedTemplate } from '../lib/wizard-types';
import { STEP_HEADERS } from '../lib/wizard-types';
import { DEFAULT_AGENT_FACE } from '../lib/agent-faces';
import { resolveSuggestionPool } from '../lib/name-suggestions';
import { buildKickoffMessage, type KickoffOrigin } from '../lib/kickoff-prompts';
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
  const { isOpen, seed, onCreated, close } = useAgentCreationStore();
  const openImport = useImportProjectsStore((s) => s.open);
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
      setStep(seed ? 'arrival' : 'gallery');
    }
  }

  // Seeds for the naming step, derived from the chosen template or the offer.
  // A gallery template's icon wins; failing that, a seeded offer's icon
  // (e.g. a marketplace agent package) seeds the face.
  const seedIcon =
    seed?.template.icon && isSingleEmoji(seed.template.icon) ? seed.template.icon : undefined;
  const faceSeed =
    template?.icon && isSingleEmoji(template.icon)
      ? template.icon
      : (seedIcon ?? DEFAULT_AGENT_FACE);
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

  /**
   * Leave the creation dialog for the standalone import flow (contract item 8).
   *
   * Known wrinkle: `close()` clears a host's one-shot `onCreated` hook, so a
   * mid-onboarding detour into import does NOT advance onboarding — after Done
   * the user lands back on the discovery step, which is a coherent (if
   * unceremonious) place to continue. Re-arming would mean threading the hook
   * through the import store and defining Done-with-zero-joins semantics;
   * deferred until onboarding needs it.
   */
  function handleImport() {
    close();
    resetAll();
    openImport();
  }

  function handleCreate() {
    if (!form.canSubmit || createAgent.isPending) return;
    // The download source: a gallery template, or a seeded offer that carries one
    // (a marketplace agent package). A shape offer has no source (inline template).
    const templateSource = template?.source ?? seed?.template.source;
    createAgent.mutate(
      {
        name: form.slug,
        displayName: form.displayName.trim() || undefined,
        runtime: form.runtime,
        ...(form.directoryOverride ? { directory: form.directoryOverride } : {}),
        ...(form.icon ? { icon: form.icon } : {}),
        ...(templateSource ? { template: templateSource } : {}),
        // A seeded offer carries its own voice + abilities through to create. For
        // a marketplace agent the persona is the package's own description — an
        // honest starting soul, not the blank default.
        ...(seed?.template.persona ? { persona: seed.template.persona } : {}),
        ...(seed?.template.capabilities?.length
          ? { capabilities: seed.template.capabilities }
          : {}),
      },
      {
        onSuccess: (data) => {
          // Record the birth FIRST — before celebration/close and before any
          // host-specific early return a caller may add ahead of the navigate
          // (e.g. onboarding advancing instead of opening a session). Every
          // create records a birth; the kickoff itself fires on session
          // ARRIVAL (useAutoKickoff), so a create that never navigates simply
          // holds an unfired record until the agent's first session opens —
          // claimed there by directory (see agent-birth-store.claimByPath).
          //
          // The birth drives the certificate line and the agent's
          // auto-first-turn greeting (M4). A persona-bearing agent (a gallery
          // pick or a Shape's offer) introduces itself and offers a first
          // action; a blank "Design your own" agent says hello and asks what
          // to take care of.
          const newSessionId = crypto.randomUUID();
          const displayName = data.displayName ?? data.name;
          const origin: KickoffOrigin = template || seed ? 'template' : 'generic';
          useAgentBirthStore.getState().register(newSessionId, {
            name: data.name,
            displayName,
            bornAt: data.registeredAt,
            path: data._path,
            runtime: data.runtime,
            kickoffMessage: buildKickoffMessage(origin, {
              displayName,
              capabilities: data.capabilities,
            }),
          });

          playCelebration();
          // A host flow (onboarding) may take over on create — it stays mounted
          // underneath and advances itself instead of navigating away.
          const hostOnCreated = onCreated;
          close();
          resetAll();
          if (hostOnCreated) {
            hostOnCreated();
            return;
          }
          navigate({
            to: '/session',
            search: { dir: data._path, session: newSessionId },
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
  // naming holds a tighter two-column composition, arrival stays narrow.
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
                    onImport={handleImport}
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
                    onImportInstead={handleImport}
                    onCreate={handleCreate}
                    isCreating={createAgent.isPending}
                  />
                )}
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
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
