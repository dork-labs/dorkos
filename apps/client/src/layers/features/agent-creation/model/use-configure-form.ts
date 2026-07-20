import { useState, useEffect, useMemo } from 'react';
import { validateAgentName, slugifyAgentName } from '@dorkos/shared/validation';
import type { AgentRuntime } from '@dorkos/shared/mesh-schemas';
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { WizardStep, ConflictStatus } from '../lib/wizard-types';
import { DEFAULT_AGENT_FACE } from '../lib/agent-faces';

interface UseConfigureFormOptions {
  step: WizardStep;
  /** Selected template's package name, for one-time name pre-fill. */
  templateName: string | null;
  /**
   * Display name to pre-fill when the dialog was opened from an offer (M1). The
   * name is filled once, the moment the seed appears, so the arrival confirm's
   * slug + directory are ready before the user ever reaches the naming step.
   */
  seedDisplayName?: string | null;
  /**
   * Emoji to seed the face picker with on entering the naming step (a
   * template's icon, or the default). Only seeds while the user has not yet
   * chosen a face of their own.
   */
  faceSeed?: string;
  /** Runtime to seed the picker with (a seed's runtime, or `claude-code`). */
  runtimeSeed?: AgentRuntime;
}

/**
 * Encapsulates all naming-step form state: freeform display name, auto-derived
 * slug, directory override, runtime, emoji face, validation, one-time seeding
 * from a template or offer, and `.dork` conflict detection.
 */
export function useConfigureForm({
  step,
  templateName,
  seedDisplayName = null,
  faceSeed = DEFAULT_AGENT_FACE,
  runtimeSeed = 'claude-code',
}: UseConfigureFormOptions) {
  const transport = useTransport();

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  const defaultDirectory = config?.agents?.defaultDirectory ?? '~/.dork/agents';

  // Form fields
  const [displayName, setDisplayName] = useState('');
  const [nameAutoFilled, setNameAutoFilled] = useState(false);
  const [directoryOverride, setDirectoryOverride] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [conflictStatus, setConflictStatus] = useState<ConflictStatus>('idle');
  const [icon, setIconState] = useState('');
  const [iconUserSet, setIconUserSet] = useState(false);
  const [runtime, setRuntime] = useState<AgentRuntime>(runtimeSeed);

  // Pre-fill the name from an offer seed the moment it appears (render-phase
  // "adjust state on prop change"). Fills once per seed — later user edits stick
  // because the seed name itself doesn't change. Clearing the seed (dialog close)
  // doesn't re-fill; `reset()` owns clearing the field.
  const [prevSeedName, setPrevSeedName] = useState<string | null>(seedDisplayName);
  if (seedDisplayName !== prevSeedName) {
    setPrevSeedName(seedDisplayName);
    if (seedDisplayName) {
      setDisplayName(seedDisplayName);
      setNameAutoFilled(false);
    }
  }

  // Adopt the seed's runtime the moment it appears (same one-time pattern).
  const [prevRuntimeSeed, setPrevRuntimeSeed] = useState<AgentRuntime>(runtimeSeed);
  if (runtimeSeed !== prevRuntimeSeed) {
    setPrevRuntimeSeed(runtimeSeed);
    setRuntime(runtimeSeed);
  }

  // Derive kebab-case slug from freeform display name
  const slug = useMemo(() => (displayName ? slugifyAgentName(displayName) : ''), [displayName]);

  // Validate the derived slug (not the raw display name)
  const slugValidation = useMemo(() => {
    if (!slug) return { valid: false, error: undefined };
    return validateAgentName(slug);
  }, [slug]);

  const showSlugError = displayName.length > 0 && slug.length > 0 && !slugValidation.valid;
  const resolvedDirectory = directoryOverride || `${defaultDirectory}/${slug}`;
  const canSubmit = displayName.length > 0 && slugValidation.valid && conflictStatus !== 'error';

  // Auto-fill name from the selected template on entering the naming step.
  // Deps intentionally exclude `displayName` to avoid re-triggering on user edits.
  useEffect(() => {
    if (step === 'naming' && templateName && !displayName) {
      const cleanName = templateName.replace(/^@[^/]+\//, '');
      setDisplayName(cleanName);
      setNameAutoFilled(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, templateName]);

  // Seed the face on entering the naming step, unless the user has picked one.
  useEffect(() => {
    if (step === 'naming' && !iconUserSet) {
      setIconState(faceSeed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, faceSeed]);

  // Debounced .dork conflict detection
  useEffect(() => {
    if (step !== 'naming') return;

    const resolvedPath = directoryOverride || (slug ? `${defaultDirectory}/${slug}` : '');
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
  }, [step, directoryOverride, slug, defaultDirectory, transport]);

  function handleNameChange(value: string) {
    setDisplayName(value);
    if (nameAutoFilled) setNameAutoFilled(false);
  }

  /** Set the emoji face and remember that the user chose it (stops re-seeding). */
  function setIcon(next: string) {
    setIconState(next);
    setIconUserSet(true);
  }

  function reset() {
    setDisplayName('');
    setNameAutoFilled(false);
    setDirectoryOverride('');
    setDirectoryOpen(false);
    setDirectoryPickerOpen(false);
    setConflictStatus('idle');
    setIconState('');
    setIconUserSet(false);
    setRuntime(runtimeSeed);
  }

  return {
    displayName,
    slug,
    handleNameChange,
    nameAutoFilled,
    slugValidation,
    showSlugError,
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
    icon,
    setIcon,
    runtime,
    setRuntime,
    reset,
  };
}
