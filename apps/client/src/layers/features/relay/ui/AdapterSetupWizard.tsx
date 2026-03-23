import { Fragment } from 'react';
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
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';
import { StepIndicator } from './wizard/StepIndicator';
import { ConfigureStep } from './wizard/ConfigureStep';
import { TestStep } from './wizard/TestStep';
import { ConfirmStep } from './wizard/ConfirmStep';
import { BindStep } from './wizard/BindStep';
import { SetupGuideSheet } from './SetupGuideSheet';
import { useAdapterWizard } from './wizard/use-adapter-wizard';

// Re-export for backward compatibility (used by tests and other consumers).
export { unflattenConfig } from './wizard/adapter-config-utils';

interface AdapterSetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manifest: AdapterManifest;
  existingInstance?: CatalogInstance & { config?: Record<string, unknown> };
  /** All adapter IDs currently in use — used to generate a non-colliding default ID for new instances. */
  existingAdapterIds?: string[];
}

/** Four-step dialog for adding or editing adapter instances. */
export function AdapterSetupWizard({
  open,
  onOpenChange,
  manifest,
  existingInstance,
  existingAdapterIds = [],
}: AdapterSetupWizardProps) {
  const wizard = useAdapterWizard({
    manifest,
    existingInstance,
    existingAdapterIds,
    onOpenChange,
  });

  const {
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
    bindAgentId,
    setBindAgentId,
    bindStrategy,
    setBindStrategy,
    agentOptions,
    isSaving,
    isBinding,
    hasSetupSteps,
    setupStepIndex,
    currentSetupStep,
    testConnection,
    handleContinue,
    handleBack,
    handleSave,
    handleBind,
    handleSkipBind,
    handleOpenChange,
    handleRetryTest,
  } = wizard;

  return (
    <Fragment>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
          <DialogHeader>
            <DialogTitle>
              {isEditMode ? `Edit ${manifest.displayName}` : `Add ${manifest.displayName}`}
            </DialogTitle>
            <DialogDescription>
              {step === 'configure' &&
                (currentSetupStep?.description ?? 'Configure the adapter settings.')}
              {step === 'test' && 'Testing connection to the adapter.'}
              {step === 'confirm' && 'Review your configuration before saving.'}
              {step === 'bind' && 'Optionally bind this adapter to an agent.'}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto py-2">
            <StepIndicator current={step} showBindStep={!isEditMode} />

            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              >
                {step === 'configure' && (
                  <ConfigureStep
                    manifest={manifest}
                    label={label}
                    onLabelChange={setLabel}
                    fields={visibleFields}
                    form={form}
                    currentSetupStep={currentSetupStep}
                    hasSetupGuide={Boolean(manifest.setupGuide)}
                    onOpenGuide={() => setGuideOpen(true)}
                  />
                )}

                {step === 'test' && (
                  <TestStep
                    isPending={testConnection.isPending}
                    isSuccess={testConnection.isSuccess}
                    isError={testConnection.isError}
                    errorMessage={testConnection.error?.message}
                    botUsername={botUsername}
                    onRetry={handleRetryTest}
                  />
                )}

                {step === 'confirm' && (
                  <form.Subscribe selector={(s: { values: Record<string, unknown> }) => s.values}>
                    {(values: Record<string, unknown>) => (
                      <ConfirmStep
                        manifest={manifest}
                        adapterId={adapterId}
                        isEditMode={isEditMode}
                        values={values}
                      />
                    )}
                  </form.Subscribe>
                )}

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

          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <div>
              {(step === 'test' || step === 'confirm') && (
                <Button variant="ghost" onClick={handleBack} disabled={isSaving}>
                  <ArrowLeft className="mr-1 size-4" />
                  Back
                </Button>
              )}
              {step === 'configure' && hasSetupSteps && setupStepIndex > 0 && (
                <Button variant="ghost" onClick={handleBack}>
                  <ArrowLeft className="mr-1 size-4" />
                  Back
                </Button>
              )}
            </div>

            <div className="flex gap-2">
              {step !== 'bind' && (
                <Button variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
              )}
              {step === 'test' && (
                <Button variant="ghost" onClick={handleContinue}>
                  Skip
                </Button>
              )}
              {step === 'configure' && (
                <Button onClick={handleContinue}>
                  Continue
                  <ArrowRight className="ml-1 size-4" />
                </Button>
              )}
              {step === 'test' && !testConnection.isPending && (
                <Button onClick={handleContinue}>
                  Continue
                  <ArrowRight className="ml-1 size-4" />
                </Button>
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
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {manifest.setupGuide && (
        <SetupGuideSheet
          open={guideOpen}
          onOpenChange={setGuideOpen}
          title={manifest.displayName}
          content={manifest.setupGuide}
        />
      )}
    </Fragment>
  );
}
