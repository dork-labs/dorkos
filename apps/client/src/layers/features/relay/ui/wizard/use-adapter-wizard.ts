import { useState, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  useAddAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCreateBinding } from '@/layers/entities/binding';
import { useTransport } from '@/layers/shared/model';
import type {
  AdapterManifest,
  CatalogInstance,
  SessionStrategy,
} from '@dorkos/shared/relay-schemas';
import { setupStepFields, unclaimedConfigFields } from '@dorkos/shared/relay-schemas';
import { useAppForm } from '@/layers/shared/lib/form';
import {
  unflattenConfig,
  initializeValues,
  generateDefaultId,
  ADVANCED_SECTION,
} from './adapter-config-utils';

/**
 * The wizard's steps, in order. `agent` comes first and only when adding: a
 * new way for people to reach your agents cannot exist without an agent to
 * reach, so the question is asked before any setting rather than offered as a
 * skippable afterthought at the end (connection-scoping plan, Move 2).
 * Editing an existing connection skips it — its bindings already exist and are
 * managed on the page.
 */
export type WizardStep = 'agent' | 'configure' | 'test' | 'confirm';

interface UseAdapterWizardOptions {
  manifest: AdapterManifest;
  existingInstance?: CatalogInstance & { config?: Record<string, unknown> };
  existingAdapterIds?: string[];
  onOpenChange: (open: boolean) => void;
}

/** Encapsulates all state machine logic for the adapter setup wizard. */
export function useAdapterWizard({
  manifest,
  existingInstance,
  existingAdapterIds = [],
  onOpenChange,
}: UseAdapterWizardOptions) {
  const isEditMode = Boolean(existingInstance);
  const [step, setStep] = useState<WizardStep>(existingInstance ? 'configure' : 'agent');
  const [guideOpen, setGuideOpen] = useState(false);
  const [adapterId] = useState(
    () => existingInstance?.id ?? generateDefaultId(manifest, existingAdapterIds)
  );
  const [label, setLabel] = useState(
    () => (existingInstance?.config?.label as string | undefined) ?? ''
  );
  const [setupStepIndex, setSetupStepIndex] = useState(0);
  const [botUsername, setBotUsername] = useState('');

  // Agent step state
  const [bindAgentId, setBindAgentId] = useState('');
  const [bindStrategy, setBindStrategy] = useState<SessionStrategy>('per-chat');

  const addAdapter = useAddAdapter();
  const updateConfig = useUpdateAdapterConfig();
  const testConnection = useTestAdapterConnection();
  const createBinding = useCreateBinding();
  const { data: agentsData } = useRegisteredAgents();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const agentOptions = agentsData?.agents ?? [];
  const hasSetupSteps = manifest.setupSteps && manifest.setupSteps.length > 0;

  const form = useAppForm({
    defaultValues: initializeValues(manifest, existingInstance?.config),
    validators: {
      onSubmit: ({ value }: { value: Record<string, unknown> }) => {
        const errors: Record<string, string> = {};
        for (const field of manifest.configFields) {
          if (field.showWhen) {
            if (value[field.showWhen.field] !== field.showWhen.equals) continue;
          }
          if (field.required) {
            const val = value[field.key];
            if (val === undefined || val === null || val === '') {
              errors[field.key] = `${field.label} is required`;
            }
          }
        }
        return Object.keys(errors).length > 0 ? { fields: errors } : undefined;
      },
    },
    onSubmit: async () => {
      // Submission is handled imperatively via handleSave — onSubmit is a no-op here.
    },
  });

  /**
   * Fields shown on the current setup step.
   *
   * `setupStepFields` puts every field no step named on the last step, so a
   * setting an adapter declares can never be dropped from the UI. Those strays
   * would otherwise land under the step's own fields with no heading, so the
   * ones that name no section of their own get filed under "Advanced".
   */
  const visibleFields = useMemo(() => {
    const unclaimed = new Set(unclaimedConfigFields(manifest).map((f) => f.key));
    return setupStepFields(manifest, setupStepIndex).map((field) =>
      unclaimed.has(field.key) && !field.section ? { ...field, section: ADVANCED_SECTION } : field
    );
  }, [manifest, setupStepIndex]);

  /**
   * Validates visible fields by checking values directly and touching each
   * field to surface inline errors. Returns whether all required fields pass.
   */
  const validateVisibleFields = useCallback((): boolean => {
    const values = form.state.values as Record<string, unknown>;
    let valid = true;
    for (const field of visibleFields) {
      if (field.showWhen && values[field.showWhen.field] !== field.showWhen.equals) continue;
      if (field.required) {
        const val = values[field.key];
        if (val === undefined || val === null || val === '') {
          // Dynamic field keys from manifest don't satisfy the typed path constraint.
          form.setFieldMeta(field.key as never, (meta) => ({
            ...meta,
            isTouched: true,
            errors: [`${field.label} is required`],
            errorMap: { onSubmit: `${field.label} is required` },
          }));
          valid = false;
        }
      }
    }
    return valid;
  }, [form, visibleFields]);

  const handleContinue = useCallback(() => {
    if (step === 'agent') {
      if (!bindAgentId) return;
      setStep('configure');
      return;
    }
    if (step === 'configure') {
      const isValid = validateVisibleFields();
      if (!isValid) return;

      if (hasSetupSteps && manifest.setupSteps) {
        if (setupStepIndex < manifest.setupSteps.length - 1) {
          setSetupStepIndex((i) => i + 1);
          return;
        }
      }

      const values = form.state.values as Record<string, unknown>;
      setStep('test');
      testConnection.mutate(
        { type: manifest.type, config: unflattenConfig(values) },
        {
          onSuccess: (result) => {
            if (result.botUsername) {
              setBotUsername(result.botUsername);
              if (!label) setLabel(`@${result.botUsername}`);
            }
          },
        }
      );
    } else if (step === 'test') {
      setStep('confirm');
    }
  }, [
    step,
    bindAgentId,
    hasSetupSteps,
    manifest,
    setupStepIndex,
    validateVisibleFields,
    form,
    testConnection,
    label,
  ]);

  const handleBack = useCallback(() => {
    if (step === 'test') {
      setStep('configure');
      testConnection.reset();
    } else if (step === 'confirm') {
      setStep('test');
    } else if (step === 'configure') {
      if (hasSetupSteps && setupStepIndex > 0) setSetupStepIndex((i) => i - 1);
      else if (!isEditMode) setStep('agent');
    }
  }, [step, hasSetupSteps, setupStepIndex, testConnection, isEditMode]);

  /**
   * Undo a just-created connection whose binding could not be saved.
   *
   * Deliberately not `useRemoveAdapter`: that hook toasts "Connection removed" on
   * success, which narrates a deletion the person never asked for on top of the
   * failure they need to read. The coarse `['relay']` invalidation covers the
   * catalog and adapter lists without reaching into the entity's key internals.
   *
   * Returns whether the undo actually happened. The whole atomicity promise is
   * that a save either lands both halves or leaves nothing behind — but the
   * undo is itself a network call that can fail, and when it does the adapter
   * survives with no binding, which is the exact silent-shadow state this
   * feature exists to prevent. The caller must know, so it can stop claiming
   * "nothing was set up" and tell the person what is actually still there.
   */
  const rollbackAdapter = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        await transport.removeRelayAdapter(id);
        return true;
      } catch {
        return false;
      } finally {
        void queryClient.invalidateQueries({ queryKey: ['relay'] });
      }
    },
    [transport, queryClient]
  );

  /**
   * Save the connection and the agent that answers it as one act.
   *
   * The server has no single endpoint for both, so this is two calls; what
   * makes it atomic for the person is that a failed binding takes the adapter
   * back out. A connection nobody answers is the silent shadow state this
   * whole change exists to remove, so it is never what a failure leaves behind.
   */
  const handleSave = useCallback(() => {
    const values = form.state.values as Record<string, unknown>;
    const adapterConfig = unflattenConfig(values);
    const configWithLabel = label ? { ...adapterConfig, label } : adapterConfig;
    if (isEditMode && existingInstance) {
      updateConfig.mutate(
        { id: existingInstance.id, config: configWithLabel },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }
    if (!bindAgentId) {
      setStep('agent');
      return;
    }
    addAdapter.mutate(
      { type: manifest.type, id: adapterId, config: configWithLabel },
      {
        onSuccess: () => {
          createBinding.mutate(
            {
              adapterId,
              agentId: bindAgentId,
              sessionStrategy: bindStrategy,
              label: '',
            },
            {
              onSuccess: () => {
                const agentName =
                  agentOptions.find((a) => a.id === bindAgentId)?.name ?? bindAgentId;
                toast.success(`${manifest.displayName} is connected`, {
                  description: `Messages that arrive here go to ${agentName}.`,
                });
                onOpenChange(false);
              },
              onError: (error) => {
                setStep('agent');
                // The undo is a network call of its own. Wait for it before
                // choosing what to tell the person: "nothing was set up" is
                // only true if the undo succeeded, and a rejected undo leaves
                // an agent-less connection live on the server that they now
                // have to remove by hand.
                void rollbackAdapter(adapterId).then((undone) => {
                  if (undone) {
                    toast.error('Nothing was set up', {
                      description: `${manifest.displayName} could not be pointed at an agent, so it was not saved. ${error.message}`,
                    });
                  } else {
                    toast.error("Couldn't finish undoing", {
                      description: `${manifest.displayName} was added but has no agent to answer it, and it could not be removed automatically. Remove it from Messaging by hand. ${error.message}`,
                    });
                  }
                });
              },
            }
          );
        },
        onError: (error) => {
          if (error.message?.includes('timed out')) {
            toast.error('Request timed out', {
              description: 'Check your token and network connectivity, then try again.',
            });
          } else if (error.message?.includes('duplicate') || error.message?.includes('exists')) {
            setStep('configure');
            setSetupStepIndex(0);
          }
        },
      }
    );
  }, [
    form,
    isEditMode,
    existingInstance,
    updateConfig,
    addAdapter,
    createBinding,
    manifest,
    adapterId,
    label,
    bindAgentId,
    bindStrategy,
    agentOptions,
    rollbackAdapter,
    onOpenChange,
  ]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setStep(isEditMode ? 'configure' : 'agent');
        setSetupStepIndex(0);
        setLabel('');
        setBotUsername('');
        setBindAgentId('');
        setBindStrategy('per-chat');
        setGuideOpen(false);
        form.reset();
        testConnection.reset();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, form, testConnection, isEditMode]
  );

  const handleRetryTest = useCallback(() => {
    testConnection.mutate({
      type: manifest.type,
      config: unflattenConfig(form.state.values as Record<string, unknown>),
    });
  }, [testConnection, manifest.type, form]);

  const isSaving = addAdapter.isPending || updateConfig.isPending || createBinding.isPending;
  const currentSetupStep =
    hasSetupSteps && manifest.setupSteps ? manifest.setupSteps[setupStepIndex] : undefined;

  return {
    // State
    step,
    isEditMode,
    adapterId,
    label,
    setLabel,
    botUsername,
    guideOpen,
    setGuideOpen,
    form,
    visibleFields,

    // Agent step state
    bindAgentId,
    setBindAgentId,
    bindStrategy,
    setBindStrategy,
    agentOptions,

    // Derived
    isSaving,
    hasSetupSteps,
    setupStepIndex,
    currentSetupStep,
    testConnection,

    // Handlers
    handleContinue,
    handleBack,
    handleSave,
    handleOpenChange,
    handleRetryTest,
  };
}
