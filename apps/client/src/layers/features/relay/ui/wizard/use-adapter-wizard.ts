import { useState, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import {
  useAddAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCreateBinding } from '@/layers/entities/binding';
import type {
  AdapterManifest,
  CatalogInstance,
  SessionStrategy,
} from '@dorkos/shared/relay-schemas';
import { useAppForm } from '@/layers/shared/lib/form';
import { unflattenConfig, initializeValues, generateDefaultId } from './adapter-config-utils';

export type WizardStep = 'configure' | 'test' | 'confirm' | 'bind';

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
  const [step, setStep] = useState<WizardStep>('configure');
  const [guideOpen, setGuideOpen] = useState(false);
  const [adapterId] = useState(
    () => existingInstance?.id ?? generateDefaultId(manifest, existingAdapterIds)
  );
  const [label, setLabel] = useState(
    () => (existingInstance?.config?.label as string | undefined) ?? ''
  );
  const [setupStepIndex, setSetupStepIndex] = useState(0);
  const [botUsername, setBotUsername] = useState('');

  // Bind step state
  const [createdAdapterId, setCreatedAdapterId] = useState('');
  const [bindAgentId, setBindAgentId] = useState('');
  const [bindStrategy, setBindStrategy] = useState<SessionStrategy>('per-chat');

  const addAdapter = useAddAdapter();
  const updateConfig = useUpdateAdapterConfig();
  const testConnection = useTestAdapterConnection();
  const createBinding = useCreateBinding();
  const { data: agentsData } = useRegisteredAgents();

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

  const visibleFields = useMemo(() => {
    if (!hasSetupSteps || !manifest.setupSteps) return manifest.configFields;
    const currentStep = manifest.setupSteps[setupStepIndex];
    if (!currentStep) return manifest.configFields;
    return manifest.configFields.filter((f) => currentStep.fields.includes(f.key));
  }, [manifest.configFields, manifest.setupSteps, hasSetupSteps, setupStepIndex]);

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
    } else if (step === 'bind') {
      onOpenChange(false);
    } else if (step === 'configure' && hasSetupSteps && setupStepIndex > 0) {
      setSetupStepIndex((i) => i - 1);
    }
  }, [step, hasSetupSteps, setupStepIndex, testConnection, onOpenChange]);

  const handleSave = useCallback(() => {
    const values = form.state.values as Record<string, unknown>;
    const adapterConfig = unflattenConfig(values);
    const configWithLabel = label ? { ...adapterConfig, label } : adapterConfig;
    if (isEditMode && existingInstance) {
      updateConfig.mutate(
        { id: existingInstance.id, config: configWithLabel },
        { onSuccess: () => onOpenChange(false) }
      );
    } else {
      addAdapter.mutate(
        { type: manifest.type, id: adapterId, config: configWithLabel },
        {
          onSuccess: () => {
            const displayLabel = label || adapterId;
            toast.success(`${manifest.displayName} adapter added`, {
              description: displayLabel ? `"${displayLabel}" is ready to use.` : undefined,
            });
            setCreatedAdapterId(adapterId);
            setStep('bind');
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
    }
  }, [
    form,
    isEditMode,
    existingInstance,
    updateConfig,
    addAdapter,
    manifest,
    adapterId,
    label,
    onOpenChange,
  ]);

  const handleBind = useCallback(() => {
    if (!bindAgentId) return;
    createBinding.mutate(
      {
        adapterId: createdAdapterId,
        agentId: bindAgentId,
        sessionStrategy: bindStrategy,
        label: '',
      },
      { onSuccess: () => onOpenChange(false) }
    );
  }, [bindAgentId, createdAdapterId, bindStrategy, createBinding, onOpenChange]);

  const handleSkipBind = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setStep('configure');
        setSetupStepIndex(0);
        setLabel('');
        setBotUsername('');
        setCreatedAdapterId('');
        setBindAgentId('');
        setBindStrategy('per-chat');
        setGuideOpen(false);
        form.reset();
        testConnection.reset();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, form, testConnection]
  );

  const handleRetryTest = useCallback(() => {
    testConnection.mutate({
      type: manifest.type,
      config: unflattenConfig(form.state.values as Record<string, unknown>),
    });
  }, [testConnection, manifest.type, form]);

  const isSaving = addAdapter.isPending || updateConfig.isPending;
  const isBinding = createBinding.isPending;
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

    // Bind step state
    bindAgentId,
    setBindAgentId,
    bindStrategy,
    setBindStrategy,
    agentOptions,

    // Derived
    isSaving,
    isBinding,
    hasSetupSteps,
    setupStepIndex,
    currentSetupStep,
    testConnection,

    // Handlers
    handleContinue,
    handleBack,
    handleSave,
    handleBind,
    handleSkipBind,
    handleOpenChange,
    handleRetryTest,
  };
}
