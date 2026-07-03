/**
 * Guided Ollama pull (ADR-0318, effortless-runtime-switching T2 task 3.6).
 *
 * The delight path inside OpenCode's Local tab: when Ollama is running but no
 * coding model is pulled, DorkOS offers a curated one-click pull of a coding
 * model with HONEST sizing and a static hardware-fit verdict ("~4.7 GB · runs
 * well / may be slow — an estimate, not a benchmark"), streams the download
 * with real progress, then connects OpenCode to it with zero auth and flips it
 * to Ready. A local model is never oversold as frontier — the honest capability
 * caveat rides along (via {@link ModelNatureBadge}).
 *
 * DorkOS detects + triggers a single pull; it never owns or manages Ollama, so
 * a power user can still browse and pull anything with Ollama directly.
 *
 * @module features/runtime-connect/ui/GuidedOllamaPull
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import type { OllamaFitVerdict, OllamaPullProgress } from '@dorkos/shared/runtime-connect';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { ModelNatureBadge, RuntimeIdentity } from '@/layers/entities/runtime';
import { OLLAMA_PROVIDER_ID } from '../model/use-opencode-provider';
import { useGuidedOllamaPull, useOllamaModelCatalog } from '../model/use-guided-ollama-pull';
import { ConnectErrorRow, ConnectProgressRow } from './connect-feedback';

const OLLAMA_MODELS_URL = 'https://ollama.com/search?c=code';

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

/**
 * The guided hardware-aware pull surface. Rendered by {@link OllamaLocalPath}
 * only when Ollama is running with no coding model pulled.
 */
export function GuidedOllamaPull() {
  const catalog = useOllamaModelCatalog(true);
  const pull = useGuidedOllamaPull();

  // Streaming the download — a real progress bar off the pull's status frames.
  if (pull.isPending) {
    return <PullProgress progress={pull.progress} />;
  }

  // Recommend the first curated model (the server orders by preference). Its id
  // carries the model tag actually pulled + connected — the honest identity.
  const recommended = catalog.data?.models[0];

  // Pulled + connected — show the runtime + model identity (3.1). The section
  // itself also flips to Ready via the requirements invalidation in the hook.
  if (pull.result?.ok && recommended) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-emerald-500"
        data-testid="guided-pull-connected"
      >
        <Check className="size-3.5 shrink-0" />
        <span>Connected —</span>
        <RuntimeIdentity runtime="opencode" model={recommended.model.id} className="text-xs" />
      </div>
    );
  }

  // A failed pull — honest, retryable, never a false Ready.
  if (pull.isError && recommended) {
    return (
      <ConnectErrorRow
        message={pull.errorMessage ?? 'The pull could not be completed.'}
        onRetry={() => pull.pull(recommended.model.id)}
      />
    );
  }

  if (catalog.isPending) {
    return <ConnectProgressRow message="Checking which models fit your machine…" />;
  }

  // No curated model to offer (catalog error/empty): degrade honestly to the
  // power-user path — DorkOS never manages Ollama's library.
  if (!recommended) {
    return (
      <div className="space-y-2" data-testid="ollama-no-model">
        <p className="text-muted-foreground text-xs">
          Ollama is running, but no coding model is pulled yet. Browse Ollama’s models to pull one.
        </p>
        <BrowseModelsLink />
      </div>
    );
  }

  const { model, verdict, explanation } = recommended;
  const meta = VERDICT_META[verdict];

  return (
    <div className="space-y-3" data-testid="ollama-no-model">
      <p className="text-muted-foreground text-xs">
        Ollama is running, but no coding model is pulled yet. Pull a curated coding model to connect
        — private and free, on your machine.
      </p>

      <div
        className="border-border space-y-2.5 rounded-lg border p-3"
        data-testid="guided-pull-card"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{model.label}</span>
          <span className="text-muted-foreground text-xs" data-testid="guided-pull-size">
            {model.sizeLabel}
          </span>
        </div>

        {/* Honest hardware-fit verdict — always an estimate, never a benchmark. */}
        <div className="space-y-0.5" data-testid="guided-pull-verdict" data-verdict={verdict}>
          <p className={cn('text-xs font-medium', meta.tone)}>{meta.label}</p>
          <p className="text-muted-foreground/80 text-[11px] leading-snug">
            {explanation} An estimate, not a benchmark.
          </p>
        </div>

        {/* The honest capability caveat — a small local model is never frontier. */}
        <ModelNatureBadge provider={OLLAMA_PROVIDER_ID} modelId={model.id} detail />

        <Button
          size="sm"
          className="w-full"
          onClick={() => pull.pull(model.id)}
          data-testid="guided-pull-start"
        >
          Pull {model.label}
        </Button>
      </div>

      <BrowseModelsLink />
    </div>
  );
}

/** Power-user escape hatch — DorkOS never owns Ollama's model library. */
function BrowseModelsLink() {
  return (
    <a
      href={OLLAMA_MODELS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
    >
      Browse Ollama models <ExternalLink className="size-3" />
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
        <AnimatePresence mode="wait">
          <motion.span
            key={status}
            className="truncate"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reducedMotion ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {status}
            {percent !== undefined ? ` · ${Math.round(percent)}%` : ''}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
