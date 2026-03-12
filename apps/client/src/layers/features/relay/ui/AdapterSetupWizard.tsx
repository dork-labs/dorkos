import { useState, useMemo, useCallback, useEffect } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui/select';
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react';
import { toast } from 'sonner';
import { ConfigFieldGroup } from './ConfigFieldInput';
import {
  useAddAdapter,
  useUpdateAdapterConfig,
  useTestAdapterConnection,
} from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useCreateBinding } from '@/layers/entities/binding';
import type { AdapterManifest, CatalogInstance, SessionStrategy } from '@dorkos/shared/relay-schemas';

type WizardStep = 'configure' | 'test' | 'confirm' | 'bind';

/** Options for the session strategy selector. */
const SESSION_STRATEGIES: { value: SessionStrategy; label: string }[] = [
  { value: 'per-chat', label: 'Per Chat' },
  { value: 'per-user', label: 'Per User' },
  { value: 'stateless', label: 'Stateless' },
];

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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const STEPS: WizardStep[] = ['configure', 'test', 'confirm', 'bind'];
const STEP_LABELS: Record<WizardStep, string> = {
  configure: 'Configure',
  test: 'Test',
  confirm: 'Confirm',
  bind: 'Bind',
};

function StepIndicator({ current, showBindStep }: { current: WizardStep; showBindStep: boolean }) {
  const visibleSteps = showBindStep ? STEPS : STEPS.filter((s) => s !== 'bind');
  const currentIndex = visibleSteps.indexOf(current);
  return (
    <div className="flex items-center gap-2" role="navigation" aria-label="Wizard steps">
      {visibleSteps.map((s, i) => (
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
  label: string;
  onLabelChange: (label: string) => void;
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
  label,
  onLabelChange,
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

      {manifest.actionButton && (
        <div className="flex justify-end">
          <a href={manifest.actionButton.url} target="_blank" rel="noopener noreferrer">
            <Button type="button" variant="outline" size="sm">
              {manifest.actionButton.label}
            </Button>
          </a>
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

      <div className="space-y-2">
        <Label htmlFor="adapter-label">Name (optional)</Label>
        <Input
          id="adapter-label"
          placeholder={manifest.displayName}
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          A friendly name to identify this adapter instance.
        </p>
      </div>

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
  botUsername?: string;
  onRetry: () => void;
}

function TestStep({ isPending, isSuccess, isError, errorMessage, botUsername, onRetry }: TestStepProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-6">
      {isPending && (
        <>
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Testing connection...</p>
        </>
      )}
      {isSuccess && (
        <div className="flex flex-col items-center gap-2">
          <CheckCircle2 className="size-8 text-green-500" />
          <p className="text-sm text-green-700 dark:text-green-400">Connection successful</p>
          {botUsername && (
            <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <span>🤖</span>
              <span className="font-mono">@{botUsername}</span>
            </div>
          )}
        </div>
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

/** Masks a secret value, revealing the last 4 characters to aid verification. */
function maskSecret(value: string): string {
  if (value.length > 8) return '•••• ' + value.slice(-4);
  return '•••';
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
        const rawValue = String(values[field.key] ?? '');
        const displayValue = field.type === 'password' ? maskSecret(rawValue) : rawValue;
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

interface BindStepProps {
  agentOptions: { id: string; name: string }[];
  agentId: string;
  onAgentIdChange: (id: string) => void;
  strategy: SessionStrategy;
  onStrategyChange: (strategy: SessionStrategy) => void;
  botUsername?: string;
  adapterType?: string;
}

function BindStep({
  agentOptions,
  agentId,
  onAgentIdChange,
  strategy,
  onStrategyChange,
  botUsername,
  adapterType,
}: BindStepProps) {
  // Auto-select when there's exactly one agent and none is selected yet.
  useEffect(() => {
    if (agentOptions.length === 1 && !agentId) {
      onAgentIdChange(agentOptions[0]!.id);
    }
  }, [agentOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Bind this adapter to an agent so incoming messages are routed automatically. You can skip
        this and bind later from the Bindings tab.
      </p>

      {agentOptions.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No agents registered yet. You can bind this adapter later from the Adapters tab.
        </div>
      ) : agentOptions.length === 1 ? (
        <div className="rounded-md border bg-accent/30 px-4 py-3 text-sm">
          Will bind to <span className="font-medium">{agentOptions[0]!.name}</span>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="bind-agent">Agent</Label>
          <Select value={agentId} onValueChange={onAgentIdChange}>
            <SelectTrigger id="bind-agent" className="w-full">
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              {agentOptions.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {agentOptions.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor="bind-strategy">Session Strategy</Label>
          <Select value={strategy} onValueChange={(v) => onStrategyChange(v as SessionStrategy)}>
            <SelectTrigger id="bind-strategy" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {botUsername && adapterType === 'telegram' && (
        <a
          href={`https://t.me/${botUsername}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
        >
          Message @{botUsername} in Telegram →
        </a>
      )}
    </div>
  );
}
