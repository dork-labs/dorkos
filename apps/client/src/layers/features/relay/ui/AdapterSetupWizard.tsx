import { useState, useMemo, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/layers/shared/ui/dialog';
import { Button } from '@/layers/shared/ui/button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAddAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCreateBinding } from '@/layers/entities/binding';
import type { AdapterManifest, CatalogInstance, SessionStrategy } from '@dorkos/shared/relay-schemas';
import { StepIndicator } from './wizard/StepIndicator';
import { ConfigureStep } from './wizard/ConfigureStep';
import { TestStep } from './wizard/TestStep';
import { ConfirmStep } from './wizard/ConfirmStep';
import { BindStep } from './wizard/BindStep';

type WizardStep = 'configure' | 'test' | 'confirm' | 'bind';

interface AdapterSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: AdapterManifest;
  existingInstance?: CatalogInstance & { config?: Record<string, unknown> };
  /** All adapter IDs currently in use — used to generate a non-colliding default ID for new instances. */
  existingAdapterIds?: string[];
}

/**
 * Converts a flat object with dot-notation keys into a nested object.
 *
 * @param flat - Object with dot-notation keys, e.g. `{'inbound.subject': 'x'}`
 * @returns Nested object, e.g. `{inbound: {subject: 'x'}}`
 */
export function unflattenConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

/** Resolves a dot-notation key from a potentially nested config object. */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Initializes form values from defaults or existing config. */
function initializeValues(
  manifest: AdapterManifest,
  existingConfig?: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of manifest.configFields) {
    const existing = existingConfig ? getNestedValue(existingConfig, field.key) : undefined;
    if (existing !== undefined && field.type !== 'password') {
      values[field.key] = existing;
    } else if (field.type === 'password' && existingConfig &&
               getNestedValue(existingConfig, field.key) !== undefined) {
      // Use sentinel so edit mode shows "Saved" placeholder instead of blank.
      values[field.key] = '***';
    } else if (field.default !== undefined) {
      values[field.key] = field.default;
    } else {
      values[field.key] = field.type === 'boolean' ? false : '';
    }
  }
  return values;
}

/**
 * Generates a non-colliding default adapter ID.
 *
 * Returns `{type}` if unused, otherwise `{type}-2`, `{type}-3`, etc.
 */
function generateDefaultId(manifest: AdapterManifest, existingIds: string[] = []): string {
  const base = manifest.type;
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** AdapterSetupWizard provides a four-step dialog for adding or editing adapter instances. */
export function AdapterSetupWizard({
  open,
  onOpenChange,
  manifest,
  existingInstance,
  existingAdapterIds = [],
}: AdapterSetupWizardProps) {
  const isEditMode = Boolean(existingInstance);
  const [step, setStep] = useState<WizardStep>('configure');
  const [adapterId, setAdapterId] = useState(() =>
    existingInstance?.id ?? generateDefaultId(manifest, existingAdapterIds),
  );
  const [label, setLabel] = useState(() =>
    (existingInstance?.config?.label as string | undefined) ?? '',
  );
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initializeValues(manifest, existingInstance?.config),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [setupStepIndex, setSetupStepIndex] = useState(0);
  const [idError, setIdError] = useState('');
  const [botUsername, setBotUsername] = useState('');

  // Bind step state — tracks the newly created adapter ID and binding config.
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

  // Determine which fields to show based on the current setup step.
  const visibleFields = useMemo(() => {
    if (!hasSetupSteps || !manifest.setupSteps) return manifest.configFields;
    const currentStep = manifest.setupSteps[setupStepIndex];
    if (!currentStep) return manifest.configFields;
    return manifest.configFields.filter((f) => currentStep.fields.includes(f.key));
  }, [manifest.configFields, manifest.setupSteps, hasSetupSteps, setupStepIndex]);

  const handleFieldChange = useCallback((key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  /** Validates required fields, respecting showWhen visibility. */
  const validate = useCallback(
    (fieldsToValidate: typeof manifest.configFields): boolean => {
      const newErrors: Record<string, string> = {};
      for (const field of fieldsToValidate) {
        // Skip fields hidden by showWhen condition.
        if (field.showWhen) {
          const depValue = values[field.showWhen.field];
          if (depValue !== field.showWhen.equals) continue;
        }
        if (field.required) {
          const val = values[field.key];
          if (val === undefined || val === null || val === '') {
            newErrors[field.key] = `${field.label} is required`;
          }
        }
      }

      // Validate adapter ID in add mode.
      if (!isEditMode && step === 'configure' && !adapterId.trim()) {
        setIdError('Adapter ID is required');
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0 && false;
      }
      setIdError('');
      setErrors(newErrors);
      return Object.keys(newErrors).length === 0;
    },
    [values, isEditMode, adapterId, step],
  );

  const handleContinue = useCallback(() => {
    if (step === 'configure') {
      // Multi-step: advance within setup steps first.
      if (hasSetupSteps && manifest.setupSteps) {
        if (!validate(visibleFields)) return;
        if (setupStepIndex < manifest.setupSteps.length - 1) {
          setSetupStepIndex((i) => i + 1);
          return;
        }
      } else {
        if (!validate(manifest.configFields)) return;
      }
      setStep('test');
      // Auto-start the connection test.
      testConnection.mutate(
        {
          type: manifest.type,
          config: unflattenConfig(values as Record<string, unknown>),
        },
        {
          onSuccess: (result) => {
            if (result.botUsername) {
              setBotUsername(result.botUsername);
              // Auto-populate label from bot username when user hasn't set one.
              if (!label) setLabel(`@${result.botUsername}`);
            }
          },
        },
      );
    } else if (step === 'test') {
      setStep('confirm');
    }
  }, [step, hasSetupSteps, manifest, visibleFields, setupStepIndex, validate, values, testConnection, label]);

  const handleBack = useCallback(() => {
    if (step === 'test') {
      setStep('configure');
      testConnection.reset();
    } else if (step === 'confirm') {
      setStep('test');
    } else if (step === 'bind') {
      // Back from bind step closes the wizard — the adapter was already saved.
      onOpenChange(false);
    } else if (step === 'configure' && hasSetupSteps && setupStepIndex > 0) {
      setSetupStepIndex((i) => i - 1);
    }
  }, [step, hasSetupSteps, setupStepIndex, testConnection, onOpenChange]);

  const handleSave = useCallback(() => {
    const adapterConfig = unflattenConfig(values as Record<string, unknown>);
    // Include label in config so the server can extract and store it.
    const configWithLabel = label ? { ...adapterConfig, label } : adapterConfig;
    if (isEditMode && existingInstance) {
      updateConfig.mutate(
        { id: existingInstance.id, config: configWithLabel },
        {
          onSuccess: () => onOpenChange(false),
        },
      );
    } else {
      addAdapter.mutate(
        { type: manifest.type, id: adapterId, config: configWithLabel },
        {
          onSuccess: () => {
            // Fire success toast then advance to the bind step.
            const displayLabel = label || adapterId;
            toast.success(`${manifest.displayName} adapter added`, {
              description: displayLabel ? `"${displayLabel}" is ready to use.` : undefined,
            });
            setCreatedAdapterId(adapterId);
            setStep('bind');
          },
          onError: (error) => {
            // Handle duplicate ID by sending user back to configure step.
            if (error.message?.includes('duplicate') || error.message?.includes('exists')) {
              setIdError('An adapter with this ID already exists');
              setStep('configure');
              setSetupStepIndex(0);
            }
          },
        },
      );
    }
  }, [values, isEditMode, existingInstance, updateConfig, addAdapter, manifest, adapterId, label, onOpenChange]);

  const handleBind = useCallback(() => {
    if (!bindAgentId) return;
    createBinding.mutate(
      {
        adapterId: createdAdapterId,
        agentId: bindAgentId,
        projectPath: '',
        sessionStrategy: bindStrategy,
        label: '',
      },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  }, [bindAgentId, createdAdapterId, bindStrategy, createBinding, onOpenChange]);

  const handleSkipBind = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Reset state when closing.
        setStep('configure');
        setSetupStepIndex(0);
        setErrors({});
        setIdError('');
        setLabel('');
        setBotUsername('');
        setAdapterId(existingInstance?.id ?? generateDefaultId(manifest, existingAdapterIds));
        setCreatedAdapterId('');
        setBindAgentId('');
        setBindStrategy('per-chat');
        testConnection.reset();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, testConnection, existingInstance, manifest, existingAdapterIds],
  );

  const isSaving = addAdapter.isPending || updateConfig.isPending;
  const isBinding = createBinding.isPending;
  const currentSetupStep = hasSetupSteps && manifest.setupSteps
    ? manifest.setupSteps[setupStepIndex]
    : undefined;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? `Edit ${manifest.displayName}` : `Add ${manifest.displayName}`}
          </DialogTitle>
          <DialogDescription>
            {step === 'configure' && (currentSetupStep?.description ?? 'Configure the adapter settings.')}
            {step === 'test' && 'Testing connection to the adapter.'}
            {step === 'confirm' && 'Review your configuration before saving.'}
            {step === 'bind' && 'Optionally bind this adapter to an agent.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Step indicator — edit mode only shows 3 steps (no bind). */}
          <StepIndicator current={step} showBindStep={!isEditMode} />

          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {/* Configure step */}
              {step === 'configure' && (
                <ConfigureStep
                  manifest={manifest}
                  isEditMode={isEditMode}
                  adapterId={adapterId}
                  onAdapterIdChange={setAdapterId}
                  idError={idError}
                  label={label}
                  onLabelChange={setLabel}
                  fields={visibleFields}
                  values={values}
                  errors={errors}
                  onChange={handleFieldChange}
                  currentSetupStep={currentSetupStep}
                />
              )}

              {/* Test step */}
              {step === 'test' && (
                <TestStep
                  isPending={testConnection.isPending}
                  isSuccess={testConnection.isSuccess}
                  isError={testConnection.isError}
                  errorMessage={testConnection.error?.message}
                  botUsername={botUsername}
                  onRetry={() =>
                    testConnection.mutate({
                      type: manifest.type,
                      config: unflattenConfig(values as Record<string, unknown>),
                    })
                  }
                />
              )}

              {/* Confirm step */}
              {step === 'confirm' && (
                <ConfirmStep
                  manifest={manifest}
                  adapterId={adapterId}
                  isEditMode={isEditMode}
                  values={values}
                />
              )}

              {/* Bind step */}
              {step === 'bind' && (
                <BindStep
                  agentOptions={agentOptions}
                  agentId={bindAgentId}
                  onAgentIdChange={setBindAgentId}
                  strategy={bindStrategy}
                  onStrategyChange={setBindStrategy}
                  botUsername={botUsername}
                  adapterType={manifest.type}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <DialogFooter>
          {step !== 'configure' && step !== 'bind' && (
            <Button variant="outline" onClick={handleBack} disabled={isSaving}>
              Back
            </Button>
          )}
          {step === 'configure' && hasSetupSteps && setupStepIndex > 0 && (
            <Button variant="outline" onClick={handleBack}>
              Back
            </Button>
          )}
          {step === 'test' && (
            <Button variant="ghost" onClick={() => setStep('confirm')}>
              Skip
            </Button>
          )}
          {step === 'configure' && (
            <Button onClick={handleContinue}>Continue</Button>
          )}
          {step === 'test' && !testConnection.isPending && (
            <Button onClick={handleContinue}>Continue</Button>
          )}
          {step === 'confirm' && (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isEditMode ? 'Save Changes' : 'Add Adapter'}
            </Button>
          )}
          {step === 'bind' && (
            <>
              <Button variant="ghost" onClick={handleSkipBind} disabled={isBinding}>
                Skip
              </Button>
              <Button onClick={handleBind} disabled={!bindAgentId || isBinding}>
                {isBinding && <Loader2 className="mr-2 size-4 animate-spin" />}
                Bind to Agent
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
