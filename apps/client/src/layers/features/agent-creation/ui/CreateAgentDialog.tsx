import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ChevronDown, FileText, FolderOpen, Package, Search, ArrowLeft } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { validateAgentName } from '@dorkos/shared/validation';
import { useQuery } from '@tanstack/react-query';
import { useTransport, type CreationMode as CreationModeType } from '@/layers/shared/model';
import { playCelebration } from '@/layers/shared/lib';
import { cn } from '@/layers/shared/lib';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  Label,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  DirectoryPicker,
} from '@/layers/shared/ui';
import { DiscoveryView } from '@/layers/features/mesh';
import { useAgentCreationStore } from '../model/store';
import { useCreateAgent } from '../model/use-create-agent';
import { TemplatePicker } from './TemplatePicker';

type CreationMode = 'new' | 'template' | 'import';
type WizardStep = 'choose' | 'pick-template' | 'configure' | 'import';
type ConflictStatus =
  | 'idle'
  | 'checking'
  | 'no-path'
  | 'exists-no-dork'
  | 'exists-has-dork'
  | 'error';

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  choose: 'How do you want to start?',
  'pick-template': 'Pick a template',
  configure: 'Name your agent',
  import: 'Scan for existing projects',
};

function initialStepFromMode(mode: CreationModeType): WizardStep {
  switch (mode) {
    case 'template':
      return 'pick-template';
    case 'import':
      return 'import';
    default:
      return 'choose';
  }
}

/** Method selection cards rendered on the choose step. */
function MethodSelection({ onSelect }: { onSelect: (mode: CreationMode) => void }) {
  const methods = [
    {
      mode: 'new' as CreationMode,
      icon: <FileText className="size-5" />,
      iconBg: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
      title: 'Start Blank',
      subtitle: 'Empty agent with a name and directory',
    },
    {
      mode: 'template' as CreationMode,
      icon: <Package className="size-5" />,
      iconBg: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
      title: 'From Template',
      subtitle: 'Pre-configured agent from the marketplace',
    },
    {
      mode: 'import' as CreationMode,
      icon: <Search className="size-5" />,
      iconBg: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      title: 'Import Project',
      subtitle: 'Scan for an existing project on disk',
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {methods.map((m) => (
        <button
          key={m.mode}
          type="button"
          onClick={() => onSelect(m.mode)}
          className={cn(
            'card-interactive flex flex-col items-center gap-3 rounded-xl border p-4 text-center',
            'hover:border-border/80 transition-all duration-200 hover:shadow-md',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2'
          )}
          data-testid={`method-${m.mode}`}
        >
          <div className={cn('flex size-10 items-center justify-center rounded-lg', m.iconBg)}>
            {m.icon}
          </div>
          <div>
            <p className="text-sm font-semibold">{m.title}</p>
            <p className="text-muted-foreground text-[11px]">{m.subtitle}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

/**
 * Global dialog for creating a new agent. Controlled by useAgentCreationStore.
 * Renders a multi-step wizard: choose method → pick template or configure → create.
 */
export function CreateAgentDialog() {
  const { isOpen, initialMode, close } = useAgentCreationStore();
  const createAgent = useCreateAgent();
  const transport = useTransport();
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Wizard step state
  const [step, setStep] = useState<WizardStep>('choose');
  const [creationMode, setCreationMode] = useState<CreationMode>('new');
  const [template, setTemplate] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);

  // Sync step from store when dialog opens (React "adjusting state on prop change" pattern)
  const [prevIsOpen, setPrevIsOpen] = useState(false);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (isOpen) {
      const startStep = initialStepFromMode(initialMode);
      setStep(startStep);
      setCreationMode(
        initialMode === 'import' ? 'import' : initialMode === 'template' ? 'template' : 'new'
      );
    }
  }

  // Focus name input after AnimatePresence transition completes
  useEffect(() => {
    if (isOpen && step === 'configure') {
      const timer = setTimeout(() => nameInputRef.current?.focus(), 160);
      return () => clearTimeout(timer);
    }
  }, [isOpen, step]);

  // Auto-fill name from template when entering configure step with an empty name field.
  // The dependency array intentionally excludes `name` to avoid re-triggering on user edits;
  // the `!name` guard inside prevents overwriting an existing value.
  useEffect(() => {
    if (step === 'configure' && creationMode === 'template' && templateName && !name) {
      // Strip scope prefix: '@dorkos/code-reviewer' -> 'code-reviewer'
      const cleanName = templateName.replace(/^@[^/]+\//, '');
      setName(cleanName);
      setNameAutoFilled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, creationMode, templateName]);

  // Fetch config for default directory
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const defaultDirectory = config?.agents?.defaultDirectory ?? '~/.dork/agents';

  // Form state
  const [name, setName] = useState('');
  const [nameAutoFilled, setNameAutoFilled] = useState(false);
  const [directoryOverride, setDirectoryOverride] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [conflictStatus, setConflictStatus] = useState<ConflictStatus>('idle');

  // Validation
  const nameValidation = useMemo(() => {
    if (!name) return { valid: false, error: undefined };
    return validateAgentName(name);
  }, [name]);

  const showNameError = name.length > 0 && !nameValidation.valid;
  const resolvedDirectory = directoryOverride || `${defaultDirectory}/${name}`;
  const canSubmit =
    name.length > 0 && nameValidation.valid && !createAgent.isPending && conflictStatus !== 'error';

  // Debounced .dork conflict detection: checks the resolved directory for an existing project.
  useEffect(() => {
    if (step !== 'configure') return;

    const resolvedPath = directoryOverride || (name ? `${defaultDirectory}/${name}` : '');
    if (!resolvedPath) {
      setConflictStatus('idle');
      return;
    }

    setConflictStatus('checking');

    const timer = setTimeout(async () => {
      try {
        const result = await transport.browseDirectory(resolvedPath);
        const hasDork = result.entries.some((entry) => entry.name === '.dork');
        setConflictStatus(hasDork ? 'exists-has-dork' : 'exists-no-dork');
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message.includes('EACCES') || message.includes('permission')) {
          setConflictStatus('error');
        } else {
          // Path doesn't exist — will be created
          setConflictStatus('no-path');
        }
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [step, directoryOverride, name, defaultDirectory, transport]);

  function resetForm() {
    setName('');
    setNameAutoFilled(false);
    setDirectoryOverride('');
    setTemplate(null);
    setTemplateName(null);
    setDirectoryOpen(false);
    setDirectoryPickerOpen(false);
    setConflictStatus('idle');
    setStep('choose');
    setCreationMode('new');
  }

  const handleMethodSelect = useCallback((mode: CreationMode) => {
    setCreationMode(mode);
    switch (mode) {
      case 'new':
        setStep('configure');
        break;
      case 'template':
        setStep('pick-template');
        break;
      case 'import':
        setStep('import');
        break;
    }
  }, []);

  const handleTemplateSelect = useCallback((source: string | null, name?: string) => {
    if (source) {
      setTemplate(source);
      setTemplateName(name ?? source.split('/').pop() ?? null);
      setStep('configure');
    }
  }, []);

  const handleBack = useCallback(() => {
    switch (step) {
      case 'pick-template':
        setStep('choose');
        break;
      case 'configure':
        setStep(creationMode === 'template' ? 'pick-template' : 'choose');
        break;
      case 'import':
        setStep('choose');
        break;
    }
  }, [step, creationMode]);

  const handleCreate = useCallback(() => {
    if (!canSubmit) return;

    createAgent.mutate(
      {
        name,
        ...(directoryOverride ? { directory: directoryOverride } : {}),
        ...(creationMode === 'template' && template ? { template } : {}),
      },
      {
        onSuccess: () => {
          playCelebration();
          close();
          resetForm();
        },
        onError: (error) => {
          toast.error(error instanceof Error ? error.message : 'Failed to create agent');
        },
      }
    );
  }, [canSubmit, name, directoryOverride, creationMode, template, createAgent, close]);

  function handleOpenChange(open: boolean) {
    if (!open) {
      close();
      resetForm();
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
        </DialogHeader>

        {/* Accessible live region announces step changes to screen readers */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {STEP_DESCRIPTIONS[step]}
        </span>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {step === 'choose' && <MethodSelection onSelect={handleMethodSelect} />}

            {step === 'pick-template' && (
              <div className="max-h-72 overflow-y-auto">
                <TemplatePicker onSelect={handleTemplateSelect} />
              </div>
            )}

            {step === 'configure' && (
              <div className="space-y-4">
                {/* Template indicator chip */}
                {creationMode === 'template' && template && (
                  <div className="bg-muted/50 flex items-center gap-2 rounded-lg border px-3 py-2">
                    <span className="text-sm">📦</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{templateName ?? template}</p>
                      <p className="text-muted-foreground text-[11px]">Template selected</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setStep('pick-template')}
                      className="text-primary text-xs hover:underline"
                      data-testid="change-template"
                    >
                      Change
                    </button>
                  </div>
                )}

                {/* Name input */}
                <div className="space-y-2">
                  <Label htmlFor="agent-name">Name</Label>
                  <Input
                    ref={nameInputRef}
                    id="agent-name"
                    placeholder="my-agent"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (nameAutoFilled) setNameAutoFilled(false);
                    }}
                    aria-invalid={showNameError}
                    aria-describedby={
                      showNameError
                        ? 'agent-name-error'
                        : nameAutoFilled
                          ? 'agent-name-hint'
                          : undefined
                    }
                  />
                  {showNameError && (
                    <p id="agent-name-error" className="text-destructive text-xs" role="alert">
                      {nameValidation.error}
                    </p>
                  )}
                  {nameAutoFilled && !showNameError && (
                    <p
                      id="agent-name-hint"
                      className="text-muted-foreground text-xs"
                      data-testid="auto-fill-hint"
                    >
                      Pre-filled from template — edit freely
                    </p>
                  )}
                  <p
                    className="text-muted-foreground truncate text-xs"
                    data-testid="directory-preview"
                  >
                    {name ? resolvedDirectory : `${defaultDirectory}/...`}
                  </p>

                  {/* Conflict detection status */}
                  {conflictStatus === 'no-path' && (
                    <p className="text-muted-foreground text-xs" data-testid="conflict-status">
                      Will create new directory
                    </p>
                  )}
                  {conflictStatus === 'exists-no-dork' && (
                    <p className="text-muted-foreground text-xs" data-testid="conflict-status">
                      Directory exists — will create project inside
                    </p>
                  )}
                  {conflictStatus === 'exists-has-dork' && (
                    <div data-testid="conflict-status">
                      <p className="text-warning text-xs font-medium">Existing project detected</p>
                      <button
                        type="button"
                        className="text-primary text-xs hover:underline"
                        onClick={() => {
                          setCreationMode('import');
                          setStep('import');
                        }}
                        data-testid="import-instead-link"
                      >
                        Import instead?
                      </button>
                    </div>
                  )}
                  {conflictStatus === 'error' && (
                    <p className="text-destructive text-xs" data-testid="conflict-status">
                      Cannot access this path
                    </p>
                  )}
                </div>

                {/* Directory override — collapsible Advanced section */}
                <Collapsible open={directoryOpen} onOpenChange={setDirectoryOpen}>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm transition-colors"
                      data-testid="directory-advanced-toggle"
                    >
                      <ChevronDown
                        className={cn('size-4 transition-transform', directoryOpen && 'rotate-180')}
                      />
                      Directory
                      {directoryOverride && (
                        <span className="bg-primary/10 text-primary ml-1 rounded px-1.5 py-0.5 text-xs">
                          custom
                        </span>
                      )}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="flex items-center gap-2 pt-2">
                      <Input
                        id="agent-directory"
                        placeholder="Override directory (optional)"
                        value={directoryOverride}
                        onChange={(e) => setDirectoryOverride(e.target.value)}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setDirectoryPickerOpen(true)}
                        aria-label="Browse directories"
                        data-testid="browse-directory-button"
                      >
                        <FolderOpen className="size-4" />
                      </Button>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            {step === 'import' && (
              <div className="max-h-80 overflow-y-auto">
                <DiscoveryView />
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <DirectoryPicker
          open={directoryPickerOpen}
          onOpenChange={setDirectoryPickerOpen}
          initialPath={directoryOverride || defaultDirectory}
          onSelect={(path) => {
            setDirectoryOverride(path);
            if (!directoryOpen) setDirectoryOpen(true);
          }}
        />

        {step !== 'choose' && (
          <DialogFooter className="flex items-center justify-between sm:justify-between">
            <Button variant="ghost" onClick={handleBack} data-testid="back-button">
              <ArrowLeft className="mr-1 size-4" />
              Back
            </Button>
            {step === 'configure' && (
              <Button onClick={handleCreate} disabled={!canSubmit} data-testid="create-button">
                {createAgent.isPending ? 'Creating...' : 'Create Agent'}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
