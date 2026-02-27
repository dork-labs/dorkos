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
import { Input } from '@/layers/shared/ui/input';
import { Label } from '@/layers/shared/ui/label';
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { ConfigFieldGroup } from './ConfigFieldInput';
import {
  useAddAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from '@/layers/entities/relay';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

type WizardStep = 'configure' | 'test' | 'confirm';

interface AdapterSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: AdapterManifest;
  existingInstance?: CatalogInstance & { config?: Record<string, unknown> };
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
    } else if (field.default !== undefined) {
      values[field.key] = field.default;
    } else {
      values[field.key] = field.type === 'boolean' ? false : '';
    }
  }
  return values;
}

/** Generates a default adapter ID from the manifest type. */
function generateDefaultId(manifest: AdapterManifest): string {
  return manifest.type;
}

/** AdapterSetupWizard provides a three-step dialog for adding or editing adapter instances. */
export function AdapterSetupWizard({
  open,
  onOpenChange,
  manifest,
  existingInstance,
}: AdapterSetupWizardProps) {
  const isEditMode = Boolean(existingInstance);
  const [step, setStep] = useState<WizardStep>('configure');
  const [adapterId, setAdapterId] = useState(() =>
    existingInstance?.id ?? generateDefaultId(manifest),
  );
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initializeValues(manifest, existingInstance?.config),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [setupStepIndex, setSetupStepIndex] = useState(0);
  const [idError, setIdError] = useState('');

  const addAdapter = useAddAdapter();
  const updateConfig = useUpdateAdapterConfig();
  const testConnection = useTestAdapterConnection();

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
      testConnection.mutate({
        type: manifest.type,
        config: unflattenConfig(values as Record<string, unknown>),
      });
    } else if (step === 'test') {
      setStep('confirm');
    }
  }, [step, hasSetupSteps, manifest, visibleFields, setupStepIndex, validate, values, testConnection]);

  const handleBack = useCallback(() => {
    if (step === 'test') {
      setStep('configure');
      testConnection.reset();
    } else if (step === 'confirm') {
      setStep('test');
    } else if (step === 'configure' && hasSetupSteps && setupStepIndex > 0) {
      setSetupStepIndex((i) => i - 1);
    }
  }, [step, hasSetupSteps, setupStepIndex, testConnection]);

  const handleSave = useCallback(() => {
    const config = unflattenConfig(values as Record<string, unknown>);
    if (isEditMode && existingInstance) {
      updateConfig.mutate(
        { id: existingInstance.id, config },
        {
          onSuccess: () => onOpenChange(false),
        },
      );
    } else {
      addAdapter.mutate(
        { type: manifest.type, id: adapterId, config },
        {
          onSuccess: () => onOpenChange(false),
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
  }, [values, isEditMode, existingInstance, updateConfig, addAdapter, manifest.type, adapterId, onOpenChange]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Reset state when closing.
        setStep('configure');
        setSetupStepIndex(0);
        setErrors({});
        setIdError('');
        testConnection.reset();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, testConnection],
  );

  const isSaving = addAdapter.isPending || updateConfig.isPending;
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
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Step indicator */}
          <StepIndicator current={step} />

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
            </motion.div>
          </AnimatePresence>
        </div>

        <DialogFooter>
          {step !== 'configure' && (
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const STEPS: WizardStep[] = ['configure', 'test', 'confirm'];
const STEP_LABELS: Record<WizardStep, string> = {
  configure: 'Configure',
  test: 'Test',
  confirm: 'Confirm',
};

function StepIndicator({ current }: { current: WizardStep }) {
  const currentIndex = STEPS.indexOf(current);
  return (
    <div className="flex items-center gap-2" role="navigation" aria-label="Wizard steps">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          {i > 0 && <div className="h-px w-4 bg-border" />}
          <span
            className={`text-xs font-medium ${
              i <= currentIndex ? 'text-foreground' : 'text-muted-foreground'
            }`}
            aria-current={s === current ? 'step' : undefined}
          >
            {STEP_LABELS[s]}
          </span>
        </div>
      ))}
    </div>
  );
}

interface ConfigureStepProps {
  manifest: AdapterManifest;
  isEditMode: boolean;
  adapterId: string;
  onAdapterIdChange: (id: string) => void;
  idError: string;
  fields: AdapterManifest['configFields'];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
  currentSetupStep?: { title: string; description?: string };
}

function ConfigureStep({
  manifest,
  isEditMode,
  adapterId,
  onAdapterIdChange,
  idError,
  fields,
  values,
  errors,
  onChange,
  currentSetupStep,
}: ConfigureStepProps) {
  return (
    <div className="space-y-4">
      {manifest.setupInstructions && (
        <div className="flex gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>{manifest.setupInstructions}</p>
        </div>
      )}

      {currentSetupStep && (
        <h4 className="text-sm font-medium">{currentSetupStep.title}</h4>
      )}

      {!isEditMode && (
        <div className="space-y-2">
          <Label htmlFor="adapter-id" className="after:ml-0.5 after:text-red-500 after:content-['*']">
            Adapter ID
          </Label>
          <Input
            id="adapter-id"
            value={adapterId}
            onChange={(e) => onAdapterIdChange(e.target.value)}
            placeholder={manifest.type}
          />
          {idError && <p className="text-xs text-red-500">{idError}</p>}
        </div>
      )}

      <ConfigFieldGroup
        fields={fields}
        values={values}
        onChange={onChange}
        errors={errors}
      />
    </div>
  );
}

interface TestStepProps {
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
}

function TestStep({ isPending, isSuccess, isError, errorMessage, onRetry }: TestStepProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      {isPending && (
        <>
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Testing connection...</p>
        </>
      )}
      {isSuccess && (
        <>
          <CheckCircle2 className="size-8 text-green-500" />
          <p className="text-sm text-green-700 dark:text-green-400">Connection successful</p>
        </>
      )}
      {isError && (
        <>
          <XCircle className="size-8 text-red-500" />
          <p className="text-sm text-red-700 dark:text-red-400">Connection failed</p>
          {errorMessage && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}

interface ConfirmStepProps {
  manifest: AdapterManifest;
  adapterId: string;
  isEditMode: boolean;
  values: Record<string, unknown>;
}

function ConfirmStep({ manifest, adapterId, isEditMode, values }: ConfirmStepProps) {
  return (
    <div className="space-y-3">
      {!isEditMode && (
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Adapter ID</span>
          <span className="font-mono">{adapterId}</span>
        </div>
      )}
      {manifest.configFields.map((field) => {
        // Skip hidden fields in summary.
        if (field.showWhen) {
          const depValue = values[field.showWhen.field];
          if (depValue !== field.showWhen.equals) return null;
        }
        const displayValue = field.type === 'password' ? '***' : String(values[field.key] ?? '');
        return (
          <div key={field.key} className="flex justify-between text-sm">
            <span className="text-muted-foreground">{field.label}</span>
            <span className="max-w-[200px] truncate font-mono">{displayValue}</span>
          </div>
        );
      })}
    </div>
  );
}
