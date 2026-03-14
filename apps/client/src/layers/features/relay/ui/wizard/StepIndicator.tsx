type WizardStep = 'configure' | 'test' | 'confirm' | 'bind';

const STEPS: WizardStep[] = ['configure', 'test', 'confirm', 'bind'];
const STEP_LABELS: Record<WizardStep, string> = {
  configure: 'Configure',
  test: 'Test',
  confirm: 'Confirm',
  bind: 'Bind',
};

/** Visual progress indicator showing the current wizard step. */
export function StepIndicator({ current, showBindStep }: { current: WizardStep; showBindStep: boolean }) {
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
