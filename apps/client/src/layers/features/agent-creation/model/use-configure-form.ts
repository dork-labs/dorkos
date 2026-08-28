import { useState, useEffect, useMemo, useRef } from 'react';
import { validateAgentName, slugifyAgentName } from '@dorkos/shared/validation';
import type { AgentRuntime } from '@dorkos/shared/mesh-schemas';
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { WizardStep, ConflictStatus } from '../lib/wizard-types';
import { DEFAULT_AGENT_FACE } from '../lib/agent-faces';
import { configKeys } from '@/layers/entities/config';
import type { Transport } from '@dorkos/shared/transport';

/**
 * Ask the filesystem what is already at a directory, as a conflict status.
 *
 * Returns rather than sets, so the caller decides when the answer applies —
 * a probe for a directory the form has since moved on from is discarded.
 *
 * @param transport - The transport to browse through.
 * @param directory - The absolute directory the agent would be created in.
 */
async function probeDirectory(transport: Transport, directory: string): Promise<ConflictStatus> {
  try {
    const result = await transport.browseDirectory(directory);
    return result.entries.some((entry) => entry.name === '.dork')
      ? 'exists-has-dork'
      : 'exists-no-dork';
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return message.includes('EACCES') || message.includes('permission') ? 'error' : 'no-path';
  }
}

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
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });

  // The server reports this already resolved to the absolute directory it will
  // actually create the agent in. There is nothing sensible to substitute while
  // the config loads — a guessed path would name a folder the server does not
  // use — so the preview and the conflict check stay blank until it arrives.
  const defaultDirectory = config?.agents?.defaultDirectory ?? '';

  // Form fields
  const [displayName, setDisplayName] = useState('');
  const [nameAutoFilled, setNameAutoFilled] = useState(false);
  const [directoryOverride, setDirectoryOverride] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  // What the last probe found, stamped with the directory it probed. A stamp
  // rather than a plain status because the answer belongs to ONE path: a
  // directory that has since changed is not "checked", it is being checked.
  const [probe, setProbe] = useState<{ directory: string; status: ConflictStatus } | null>(null);
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
  const resolvedDirectory =
    directoryOverride || (defaultDirectory && slug ? `${defaultDirectory}/${slug}` : '');

  // What the last probe said about the directory on screen right now.
  const conflictStatus: ConflictStatus =
    step !== 'naming' || !resolvedDirectory
      ? 'idle'
      : probe !== null && probe.directory === resolvedDirectory
        ? probe.status
        : 'checking';
  const canSubmit = displayName.length > 0 && slugValidation.valid && conflictStatus !== 'error';

  // Auto-fill name from the selected template on entering the naming step.
  // An auto-filled name follows the selection: switching templates overwrites
  // it, and switching to design-your-own clears it — but a USER-typed name is
  // never clobbered (`nameAutoFilled` is the provenance bit; typing clears it).
  // Deps intentionally exclude `displayName`/`nameAutoFilled` so the effect
  // fires only when the selection changes, never on user edits.
  // The step-and-selection this hook last auto-filled for. The auto-fill is a
  // fact about the SELECTION CHANGING, which a render handed one selection
  // cannot see, so the ref is what says whether this is that moment.
  const filledFor = useRef<string | null>(null);
  useEffect(() => {
    if (step !== 'naming') return;
    // What this selection would put in the field, or `null` for "leave it": a
    // USER-typed name is never clobbered. Design-your-own after a template
    // clears it, because the inherited name was never the user's.
    const nextName = templateName
      ? !displayName || nameAutoFilled
        ? templateName.replace(/^@[^/]+\//, '')
        : null
      : nameAutoFilled
        ? ''
        : null;
    if (nextName === null) return;
    const selection = `${step}|${templateName ?? ''}`;
    if (filledFor.current === selection) return;
    filledFor.current = selection;
    setDisplayName(nextName);
    setNameAutoFilled(Boolean(templateName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, templateName]);

  // Seed the face on entering the naming step, unless the user has picked one.
  // Same shape as the auto-fill above: the seed follows a change of seed, and
  // the ref is what tells this render from the one before it.
  const seededFace = useRef<string | null>(null);
  useEffect(() => {
    if (step !== 'naming' || iconUserSet) return;
    const seed = `${step}|${faceSeed}`;
    if (seededFace.current === seed) return;
    seededFace.current = seed;
    setIconState(faceSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, faceSeed]);

  // Debounced .dork conflict detection. The 'idle' and 'checking' phases are
  // derived above, so the only thing this effect writes is the answer.
  useEffect(() => {
    if (step !== 'naming' || !resolvedDirectory) return;

    const directory = resolvedDirectory;
    const timer = setTimeout(() => {
      void probeDirectory(transport, directory).then((status) => {
        setProbe({ directory, status });
      });
    }, 500);

    return () => clearTimeout(timer);
  }, [step, resolvedDirectory, transport]);

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
    setProbe(null);
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
