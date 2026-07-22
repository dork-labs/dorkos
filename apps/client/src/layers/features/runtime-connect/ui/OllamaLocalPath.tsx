/**
 * OpenCode Local (Ollama) panel — the zero-auth hero (ADR-0318, T1 task 2.8;
 * opencode-connect-overhaul T2 §7, scope B). Once running, offers a light
 * local-model manager: status line, installed models with tier + fit verdict,
 * a curated "Get" shelf with streamed pull progress, a pull-any-tag input, and
 * a library link (deletion/disk usage stay Ollama's job). Absent, it links to
 * the installer — DorkOS detects, it never manages Ollama.
 *
 * @module features/runtime-connect/ui/OllamaLocalPath
 */
import { useEffect, useState, type FormEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  OllamaFitVerdict,
  OllamaInstalledModel,
  OllamaModelCatalog,
  OllamaPullProgress,
} from '@dorkos/shared/runtime-connect';
import { OLLAMA_TAG_PATTERN } from '@dorkos/shared/runtime-connect';
import type { ModelTier } from '@dorkos/shared/types';
import { Badge, Button, Input, Label } from '@/layers/shared/ui';
import { cn, localDeviceNoun } from '@/layers/shared/lib';
import { RuntimeIdentity, type RuntimeConnectSuccess } from '@/layers/entities/runtime';
import {
  useConnectOllama,
  useOllamaDetection,
  type UseConnectOllama,
} from '../model/use-opencode-provider';
import {
  useGuidedOllamaPull,
  useOllamaModelCatalog,
  type UseGuidedOllamaPull,
} from '../model/use-guided-ollama-pull';
import { LOCAL_CONNECT_SUCCESS } from '../lib/connect-success';
import { ConnectErrorRow, ConnectProgressRow, ConnectedRow } from './connect-feedback';

const OLLAMA_INSTALL_URL = 'https://ollama.com/download';
const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

/** Static per-verdict presentation — honest, coarse, always framed as an estimate. */
const VERDICT_META: Record<OllamaFitVerdict, { label: string; tone: string }> = {
  'runs-well': {
    label: 'Runs well on your machine',
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  'may-be-slow': {
    label: 'May be slow on your machine',
    tone: 'text-amber-600 dark:text-amber-400',
  },
  'too-large': { label: 'Too large for your machine', tone: 'text-destructive' },
};

/** Short label for a model's coarse capability tier. */
const TIER_LABELS: Record<ModelTier, string> = {
  frontier: 'Frontier',
  'solid-coder': 'Solid coder',
  'quick-helper': 'Quick helper',
};

/** Props for {@link OllamaLocalPath}. Matches the picker's `RuntimeConnectSlot`-style contract. */
export interface OllamaLocalPathProps {
  /** Whether the Local step is the active one — gates detection to when shown. */
  active: boolean;
  /** Reports a successful local connect so the dialog can show its success moment. */
  onConnected?: (success: RuntimeConnectSuccess) => void;
  /** Escape hatch to the Direct (bring-your-own-server) path. */
  onConnectDirectly?: () => void;
}

/**
 * The Local (Ollama) connect path: detect a running Ollama, then present the
 * local-model manager. `active` gates detection to the open tab. Any
 * successful local connect (an installed model, or a completed pull) reports
 * `LOCAL_CONNECT_SUCCESS` via `onConnected`; without one, the existing inline
 * "Connected" confirmation renders instead (standalone use).
 */
export function OllamaLocalPath({ active, onConnected, onConnectDirectly }: OllamaLocalPathProps) {
  const detection = useOllamaDetection(active);
  const connect = useConnectOllama();
  const pull = useGuidedOllamaPull();
  const running = detection.data?.running ?? false;
  const catalogQuery = useOllamaModelCatalog(running);

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [pullingId, setPullingId] = useState<string | null>(null);

  // Report the landing exactly once per success flag, whichever path landed it.
  useEffect(() => {
    if (connect.isSuccess) onConnected?.(LOCAL_CONNECT_SUCCESS);
  }, [connect.isSuccess, onConnected]);
  useEffect(() => {
    if (pull.result?.ok) onConnected?.(LOCAL_CONNECT_SUCCESS);
  }, [pull.result?.ok, onConnected]);

  const handleUse = (id: string) => {
    setConnectingId(id);
    connect.connect(id);
  };
  const handleGet = (id: string) => {
    setPullingId(id);
    pull.pull(id);
  };

  if (detection.isPending) {
    return <ConnectProgressRow message="Looking for Ollama on your machine…" />;
  }

  if (!running) {
    return (
      <div className="space-y-3" data-testid="ollama-absent">
        <p className="text-muted-foreground text-xs">
          Ollama isn’t running. Install it to run models locally — private and free, on your
          machine.
        </p>
        <a
          href={OLLAMA_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex"
        >
          <Button size="sm" variant="outline" className="gap-1.5">
            Install Ollama <ExternalLink className="size-3.5" />
          </Button>
        </a>
      </div>
    );
  }

  // Already-installed connect landed — fallback only when `onConnected` fired above has no watcher.
  if (connect.isSuccess) {
    return onConnected ? null : <ConnectedRow message="Connected to Ollama" />;
  }

  // A completed pull landed — same rule, with the runtime + model identity.
  if (pull.result?.ok) {
    if (onConnected) return null;
    return (
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-emerald-500"
        data-testid="guided-pull-connected"
      >
        <Check className="size-3.5 shrink-0" />
        <span>Connected —</span>
        <RuntimeIdentity runtime="opencode" model={pull.result.model} className="text-xs" />
      </div>
    );
  }

  const status = detection.data;
  const installed = status?.installed ?? [];
  const count = status?.installed?.length ?? status?.models.length ?? 0;
  // A custom pull-by-name tag, not one of the curated shelf's ids — the shelf
  // owns its own rows' progress, so the input only shows progress for THIS.
  const isCurated = catalogQuery.data?.models.some((m) => m.model.id === pullingId) ?? false;
  const pullingByName = pullingId !== null && !isCurated ? pullingId : null;

  return (
    <div className="space-y-4" data-testid="ollama-running">
      <StatusLine count={count} />
      {installed.length > 0 && (
        <InstalledList
          installed={installed}
          connect={connect}
          connectingId={connectingId}
          onUse={handleUse}
        />
      )}
      <CuratedShelf
        catalogQuery={catalogQuery}
        pull={pull}
        pullingId={pullingId}
        onGet={handleGet}
      />
      <PullByNameInput pull={pull} activePull={pullingByName} onSubmit={handleGet} />
      <BrowseLibraryLink />
      {onConnectDirectly && (
        <button
          type="button"
          onClick={onConnectDirectly}
          data-testid="local-connect-directly"
          className="focus-ring text-muted-foreground hover:text-foreground block rounded-md text-left text-xs transition-colors"
        >
          Run local models with LM Studio or another server?{' '}
          <span className="underline">Connect it directly</span>
        </button>
      )}
    </div>
  );
}

/** Honest status line: running, install count, and the zero-auth privacy line. */
function StatusLine({ count }: { count: number }) {
  return (
    <p className="flex items-center gap-1.5 text-xs" data-testid="ollama-status-line">
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
      <span>
        Ollama is running · {count} models installed · nothing you type leaves {localDeviceNoun()}
      </span>
    </p>
  );
}

/** A model's fit verdict + honest one-line explanation, always framed as an estimate. */
function VerdictLine({ verdict, explanation }: { verdict: OllamaFitVerdict; explanation: string }) {
  const meta = VERDICT_META[verdict];
  return (
    <div data-testid="ollama-verdict" data-verdict={verdict}>
      <p className={cn('text-xs font-medium', meta.tone)}>{meta.label}</p>
      <p className="text-muted-foreground/80 text-[11px] leading-snug">{explanation}</p>
    </div>
  );
}

/** Small tier badge — omitted entirely when a model carries no tier. */
function TierBadge({ tier }: { tier: ModelTier }) {
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
      {TIER_LABELS[tier]}
    </Badge>
  );
}

/** The "Installed" section: each pulled model with its tier, fit verdict, and a Use button. */
function InstalledList({
  installed,
  connect,
  connectingId,
  onUse,
}: {
  installed: OllamaInstalledModel[];
  connect: UseConnectOllama;
  connectingId: string | null;
  onUse: (id: string) => void;
}) {
  return (
    <div className="space-y-2" data-testid="ollama-installed">
      <h3 className="text-sm font-medium">Installed</h3>
      <ul className="space-y-1.5">
        {installed.map((entry) => {
          const connecting = connectingId === entry.id && connect.isPending;
          const failed = connectingId === entry.id && connect.isError;
          const handleUse = () => onUse(entry.id);

          // The row's trailing action: idle Use, inline connecting, or a retryable error.
          let action = (
            <Button size="sm" onClick={handleUse}>
              Use
            </Button>
          );
          if (connecting) action = <ConnectProgressRow message="Connecting…" />;
          else if (failed) {
            action = (
              <ConnectErrorRow
                message={connect.errorMessage ?? 'Could not connect to Ollama.'}
                onRetry={handleUse}
              />
            );
          }

          return (
            <li
              key={entry.id}
              className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid="ollama-installed-item"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{entry.id}</span>
                  {entry.assessment.model.tier && <TierBadge tier={entry.assessment.model.tier} />}
                </div>
                <VerdictLine
                  verdict={entry.assessment.verdict}
                  explanation={entry.assessment.explanation}
                />
              </div>
              {action}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The "Add a model" curated shelf: honest sizing + fit verdict per model, one-click Get. */
function CuratedShelf({
  catalogQuery,
  pull,
  pullingId,
  onGet,
}: {
  catalogQuery: UseQueryResult<OllamaModelCatalog>;
  pull: UseGuidedOllamaPull;
  pullingId: string | null;
  onGet: (id: string) => void;
}) {
  if (catalogQuery.isPending) {
    return <ConnectProgressRow message="Checking which models fit your machine…" />;
  }

  const models = catalogQuery.data?.models ?? [];
  // Degrade honestly on a catalog error/empty result — no crash, no shelf.
  if (catalogQuery.isError || models.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="ollama-shelf">
      <h3 className="text-sm font-medium">Add a model</h3>
      <ul className="space-y-1.5">
        {models.map(({ model, verdict, explanation }) => {
          const pulling = pullingId === model.id;
          const handleGet = () => onGet(model.id);

          // Streaming or a failed pull for THIS row shares one `<li>` wrapper.
          if (pulling && (pull.isPending || pull.isError)) {
            return (
              <li
                key={model.id}
                className="border-border rounded-lg border p-3"
                data-testid="shelf-item"
              >
                <p className="mb-2 text-sm font-medium">{model.label}</p>
                {pull.isPending ? (
                  <PullProgress progress={pull.progress} />
                ) : (
                  <ConnectErrorRow
                    message={pull.errorMessage ?? 'The pull could not be completed.'}
                    onRetry={handleGet}
                  />
                )}
              </li>
            );
          }

          return (
            <li
              key={model.id}
              className="border-border flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid="shelf-item"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{model.label}</span>
                  {model.tier && <TierBadge tier={model.tier} />}
                  <span className="text-muted-foreground text-xs">{model.sizeLabel}</span>
                </div>
                <VerdictLine verdict={verdict} explanation={explanation} />
              </div>
              {/* Too-large won't load; another pull in flight keeps this quiet too (one at a time). */}
              <Button
                size="sm"
                variant="outline"
                disabled={verdict === 'too-large' || pull.isPending}
                onClick={handleGet}
              >
                Get
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Pull-any-tag input, validated against Ollama's tag syntax before it can submit. */
function PullByNameInput({
  pull,
  activePull,
  onSubmit,
}: {
  pull: UseGuidedOllamaPull;
  /** The tag currently being pulled via this input, or `null` when idle. */
  activePull: string | null;
  onSubmit: (tag: string) => void;
}) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const valid = OLLAMA_TAG_PATTERN.test(trimmed);

  if (activePull && pull.isPending) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">Pulling {activePull}…</p>
        <PullProgress progress={pull.progress} />
      </div>
    );
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSubmit(trimmed);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-1.5">
      <Label htmlFor="ollama-pull-tag" className="text-xs font-normal">
        Pull any model by name
      </Label>
      <div className="flex gap-2">
        <Input
          id="ollama-pull-tag"
          data-testid="ollama-pull-by-name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="qwen2.5-coder:32b"
          aria-invalid={trimmed.length > 0 && !valid}
        />
        <Button type="submit" size="sm" disabled={!valid || pull.isPending}>
          Pull
        </Button>
      </div>
      {trimmed.length > 0 && !valid && (
        <p className="text-muted-foreground text-[11px]">
          Enter a valid Ollama tag, like <code className="text-2xs">qwen2.5-coder:32b</code>.
        </p>
      )}
      {activePull && pull.isError && (
        <ConnectErrorRow
          message={pull.errorMessage ?? 'The pull could not be completed.'}
          onRetry={() => onSubmit(activePull)}
        />
      )}
    </form>
  );
}

/** Power-user escape hatch — DorkOS never owns Ollama's model library. */
function BrowseLibraryLink() {
  return (
    <a
      href={OLLAMA_LIBRARY_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
    >
      Browse the library <ExternalLink className="size-3" />
    </a>
  );
}

/**
 * Streamed download progress — a determinate `motion` bar driven by the pull's
 * `percent` frames, with the raw status line beneath. Falls back to an
 * indeterminate spinner until the first sized frame arrives.
 */
function PullProgress({ progress }: { progress: OllamaPullProgress | null }) {
  const reducedMotion = useReducedMotion();
  const percent = progress?.percent;
  const status = progress?.status ?? 'Starting download…';

  return (
    <div className="space-y-2" data-testid="guided-pull-progress">
      <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
        {percent === undefined ? (
          // Indeterminate: a soft pulse until the first sized frame arrives.
          <motion.div
            className="bg-primary/70 h-full w-1/3 rounded-full"
            animate={reducedMotion ? {} : { x: ['-100%', '300%'] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
          />
        ) : (
          <motion.div
            className="bg-primary h-full rounded-full"
            initial={false}
            animate={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.3, ease: 'easeOut' }}
            data-testid="guided-pull-bar"
          />
        )}
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <motion.span
          className="inline-flex"
          animate={reducedMotion ? {} : { rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
        >
          <Loader2 className="size-3.5" />
        </motion.span>
        <span className="truncate">
          {status}
          {percent !== undefined ? ` · ${Math.round(percent)}%` : ''}
        </span>
      </div>
    </div>
  );
}
