import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { validateAgentName } from '@dorkos/shared/validation';
import { useTransport } from '@/layers/shared/model';
import type { WizardStep, CreationMode, ConflictStatus } from '../lib/wizard-types';

interface UseConfigureFormOptions {
  step: WizardStep;
  creationMode: CreationMode;
  templateName: string | null;
}

/**
 * Encapsulates all form state for the configure step: name input, directory
 * override, validation, auto-fill from template, and .dork conflict detection.
 */
export function useConfigureForm({ step, creationMode, templateName }: UseConfigureFormOptions) {
  const transport = useTransport();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const defaultDirectory = config?.agents?.defaultDirectory ?? '~/.dork/agents';

  // Form fields
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
  const canSubmit = name.length > 0 && nameValidation.valid && conflictStatus !== 'error';

  // Auto-fill name from template when entering configure step.
  // Deps intentionally exclude `name` to avoid re-triggering on user edits.
  useEffect(() => {
    if (step === 'configure' && creationMode === 'template' && templateName && !name) {
      const cleanName = templateName.replace(/^@[^/]+\//, '');
      setName(cleanName);
      setNameAutoFilled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, creationMode, templateName]);

  // Debounced .dork conflict detection
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
          setConflictStatus('no-path');
        }
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [step, directoryOverride, name, defaultDirectory, transport]);

  function handleNameChange(value: string) {
    setName(value);
    if (nameAutoFilled) setNameAutoFilled(false);
  }

  function reset() {
    setName('');
    setNameAutoFilled(false);
    setDirectoryOverride('');
    setDirectoryOpen(false);
    setDirectoryPickerOpen(false);
    setConflictStatus('idle');
  }

  return {
    name,
    handleNameChange,
    nameAutoFilled,
    nameValidation,
    showNameError,
    defaultDirectory,
    resolvedDirectory,
    directoryOverride,
    setDirectoryOverride,
    directoryOpen,
    setDirectoryOpen,
    directoryPickerOpen,
    setDirectoryPickerOpen,
    conflictStatus,
    canSubmit,
    reset,
  };
}
