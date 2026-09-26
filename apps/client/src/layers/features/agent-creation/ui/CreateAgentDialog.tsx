import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import { playCelebration, isSingleEmoji, toSession } from '@/layers/shared/lib';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  DirectoryPicker,
} from '@/layers/shared/ui';
import { useImportProjectsStore, useAgentBirthStore } from '@/layers/shared/model';
import { OpenMeshNotice } from '@/layers/entities/mesh';
import { useConfig } from '@/layers/entities/config';
import { useAgentCreationStore } from '../model/store';
import { useCreateAgent } from '../model/use-create-agent';
import { useConfigureForm } from '../model/use-configure-form';
import { useOfferSchedules } from '../model/use-offer-schedules';
import type { WizardStep, SelectedTemplate } from '../lib/wizard-types';
import { STEP_HEADERS } from '../lib/wizard-types';
import { resolveSuggestionPool } from '../lib/name-suggestions';
import { buildKickoffMessage, type KickoffOrigin } from '@dorkos/shared/kickoff-prompts';
import { AgentGallery } from './AgentGallery';
import { NamingStep } from './NamingStep';
import { ArrivalConfirm } from './ArrivalConfirm';
import {
  TemplateReviewNotice,
  templateReviewOf,
  type TemplateBrings,
} from './TemplateReviewNotice';

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
  // `null` when nothing chose a face. It must not fall back to a default emoji:
  // the wizard would then submit that default as though the user had picked it,
  // and every agent made here would wear the same face instead of the one the
  // server seeds from its id (DOR-949).
  const faceSeed =
    template?.icon && isSingleEmoji(template.icon) ? template.icon : (seedIcon ?? null);
  const runtimeSeed = seed?.template.runtime ?? 'claude-code';

  // What the offered package will run on its own. An agent package never sees
  // the install confirmation dialog, so this dialog is where that gets said
  // (DOR-644). Fetched from the moment the dialog opens so the answer is usually
  // already there by the time a person has finished reading the card. The store
  // clears `seed` on both close and generic open, so a non-null seed is always a
  // live offer.
  // A gallery agent from the marketplace is an offer too: it is created
  // through the marketplace installer, held to what its preview showed
  // (DOR-2325), so its preview is asked for as a seeded offer's is.
  const offerPackage =
    seed?.packageName !== undefined
      ? seed
      : template?.packageName !== undefined
        ? { packageName: template.packageName, marketplace: template.marketplace }
        : null;
  const offerSchedules = useOfferSchedules(offerPackage);
  const { data: config } = useConfig();
  // Where a marketplace agent lives: its package's own folder, so updates find
  // it. The person's name for it is its display name.
  const packageDirectory =
    offerPackage && offerSchedules.packageAgentName && config?.dorkHome
      ? `${config.dorkHome}/agents/${offerSchedules.packageAgentName}`
      : undefined;
  // A custom template that brings settings or programs is shown before the
  // agent is created from it (DOR-2325).
  const [templateReview, setTemplateReview] = useState<TemplateBrings | null>(null);

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
      : 'You’ll define the job together in your first conversation.';
  const previewCapabilities = template
    ? (template.tags ?? [])
    : (seed?.template.capabilities ?? []);

  function resetAll() {
    form.reset();
    setTemplateReview(null);
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

  function handleCreate(approvedTemplateHash?: string) {
    if (!form.canSubmit || createAgent.isPending) return;
    // A marketplace agent (a gallery pick or a seeded offer) is created through
    // the marketplace installer, held to what its preview showed (DOR-2325).
    // Anything else with a source is a template: cloned, and shown first when
    // it brings settings or programs. A shape offer has no source.
    const packageOffer =
      offerPackage?.packageName !== undefined && offerSchedules.approval
        ? {
            package: {
              name: offerPackage.packageName,
              ...(offerPackage.marketplace ? { marketplace: offerPackage.marketplace } : {}),
              ...offerSchedules.approval,
            },
          }
        : undefined;
    const templateSource = packageOffer ? undefined : (template?.source ?? seed?.template.source);
    createAgent.mutate(
      {
        name: form.slug,
        displayName: form.displayName.trim() || undefined,
        runtime: form.runtime,
        ...(!packageOffer && form.directoryOverride ? { directory: form.directoryOverride } : {}),
        ...(form.icon ? { icon: form.icon } : {}),
        ...(packageOffer ?? {}),
        ...(templateSource ? { template: templateSource } : {}),
        ...(approvedTemplateHash ? { approvedTemplateHash } : {}),
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
          // action; a blank "Design your own" agent runs the interview — it
          // greets, asks what to take care of, then writes its own SOUL.md live
          // in the conversation before offering a first action.
          const newSessionId = crypto.randomUUID();
          const displayName = data.displayName ?? data.name;
          const origin: KickoffOrigin = template || seed ? 'template' : 'design-your-own';
          useAgentBirthStore.getState().register(newSessionId, {
            name: data.name,
            displayName,
            agentId: data.id,
            icon: data.icon,
            color: data.color,
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
          navigate(toSession({ dir: data._path, session: newSessionId, runtime: data.runtime }));
        },
        // A template that needs reviewing is shown here (`isShownInline` keeps
        // it out of the toast); every other failure is the shared toast's.
        onError: (error) => {
          const review = templateReviewOf(error);
          if (review) setTemplateReview(review);
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
  // Per-step canvas width: the gallery spreads across the fullscreen frame,
  // naming holds a tighter two-column composition, arrival stays narrow.
  const stepMaxWidth =
    step === 'gallery' ? 'max-w-6xl' : step === 'naming' ? 'max-w-5xl' : 'max-w-2xl';

  return (
    <ResponsiveDialog open={isOpen} onOpenChange={handleOpenChange} defaultFullscreen>
      <ResponsiveDialogContent className="flex flex-col gap-0 p-0">
        {/* The arrival confirm (M1) owns its own title/face — it ships no
            header title, so the generic header renders only for the other steps. */}
        {'title' in header && (
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
                    packageSchedules={offerSchedules.schedules}
                    isCheckingOffer={offerSchedules.isChecking}
                    offerCheckFailed={offerSchedules.failed}
                    offerRefusal={offerSchedules.refusal}
                    resolvedDirectory={packageDirectory ?? form.resolvedDirectory}
                    canSubmit={form.canSubmit}
                    isCreating={createAgent.isPending}
                    onCreate={() => handleCreate()}
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
                    onCreate={() => handleCreate()}
                    isCreating={createAgent.isPending}
                    packageSchedules={offerSchedules.schedules}
                    offerCheckFailed={offerSchedules.failed}
                    offerRefusal={offerSchedules.refusal}
                    isCheckingOffer={offerSchedules.isChecking}
                    packageDirectory={packageDirectory}
                    templateReview={
                      templateReview ? (
                        <TemplateReviewNotice
                          template={templateReview}
                          isCreating={createAgent.isPending}
                          onCreateAnyway={() => handleCreate(templateReview.contentHash)}
                          onCancel={() => setTemplateReview(null)}
                        />
                      ) : undefined
                    }
                  />
                )}
              </motion.div>
            </AnimatePresence>

            {/* The wall this agent is about to hit, said before it hits it: a
                new agent lands in its own project and cannot message the ones
                already here. Only on the steps that end in a Create button —
                the gallery is still browsing — and only when there is another
                agent to be cut off from and the switch is off. */}
            {step !== 'gallery' && <OpenMeshNotice className="mt-6" />}
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
