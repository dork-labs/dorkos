/**
 * OpenCode power-source picker (spec: opencode-connect-overhaul §5).
 *
 * OpenCode's connect is "choose where the model comes from," presented as a
 * single-column list of three power sources (no tabs): the recommended cloud path
 * (best models, zero setup), the private-and-free local path (models on this
 * computer), and the bring-your-own-key Direct path. Picking one navigates within
 * the dialog to that connect step, each with a Back affordance. Every path reports
 * its landing through `onConnected` so the dialog shows an explicit success moment.
 *
 * @module features/runtime-connect/ui/OpenCodeProviderPicker
 */
import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn, localDeviceNoun } from '@/layers/shared/lib';
import type { RuntimeConnectSuccess } from '@/layers/entities/runtime';
import { describePowerSource } from '../lib/power-source';
import { OllamaLocalPath } from './OllamaLocalPath';
import { OpenRouterGatewayPath } from './OpenRouterGatewayPath';
import { DirectProviderPath } from './DirectProviderPath';

/** The picker's steps: the source list, then one step per connect path. */
type Step = 'choose' | 'cloud' | 'local' | 'direct';

/** Props shared by every connect step so it can report its landing. */
interface PickerProps {
  /**
   * The currently connected provider id, when reopened to CHANGE an already-set
   * source (spec §9). Drives the "Currently: …" label on the choose list.
   * Absent on a first connect.
   */
  currentProvider?: string;
  /** Reports the connect landing so the dialog can show its success moment. */
  onConnected?: (success: RuntimeConnectSuccess) => void;
}

/** The OpenCode power-source picker — one column of choices, in-dialog navigation. */
export function OpenCodeProviderPicker({ currentProvider, onConnected }: PickerProps) {
  const [step, setStep] = useState<Step>('choose');
  const sources = powerSources();

  if (step === 'choose') {
    return (
      <PowerSourceList sources={sources} onChoose={setStep} currentProvider={currentProvider} />
    );
  }

  const back = () => setStep('choose');
  if (step === 'cloud') {
    return (
      <ConnectStep source={sources.cloud} onBack={back}>
        <OpenRouterGatewayPath onConnected={onConnected} />
      </ConnectStep>
    );
  }
  if (step === 'local') {
    return (
      <ConnectStep source={sources.local} onBack={back}>
        <OllamaLocalPath
          active
          onConnected={onConnected}
          onConnectDirectly={() => setStep('direct')}
        />
      </ConnectStep>
    );
  }
  return (
    <ConnectStep source={sources.direct} onBack={back}>
      <DirectProviderPath onConnected={onConnected} />
    </ConnectStep>
  );
}

/** One power source: how it reads in the list, and what its step says at the top. */
interface SourceCard {
  /** The step this card opens. */
  step: Exclude<Step, 'choose'>;
  /** Card headline. */
  title: string;
  /** Heading for this source's step. Only where the step reads differently. */
  stepTitle?: string;
  /** Primary description line — the one line the list shows under the headline. */
  description: string;
  /** Supporting sub-line. Shown at the step, not in the list. */
  sub: string;
  /** Honest one-line trade-off, rendered under a "Trade-off:" label at the step. */
  tradeOff?: string;
  /** The recommended source — featured first and visually emphasized. */
  recommended?: boolean;
  /** A quiet, de-emphasized row (the bring-your-own-key escape hatch). */
  quiet?: boolean;
}

/** The three power sources, keyed by the step each opens, in reading order. */
type PowerSources = Record<Exclude<Step, 'choose'>, SourceCard>;

/** The three power sources, in reading order (cloud recommended first). */
function powerSources(): PowerSources {
  return {
    cloud: {
      step: 'cloud',
      title: 'Best models, zero setup',
      description:
        "Claude, GPT, Gemini and 300+ more, running in the cloud — your hardware doesn't matter.",
      sub: 'One OpenRouter account covers all of them. Pay only for what you use.',
      tradeOff: "Your prompts and code are sent to the model's provider.",
      recommended: true,
    },
    local: {
      step: 'local',
      title: 'Private and free, on your computer',
      description: `Models run on ${localDeviceNoun()} — nothing you type ever leaves it.`,
      sub: 'Runs Quick helpers and Solid coders. Frontier models stay cloud-only.',
      tradeOff: 'Smaller models — great for edits and quick help, not frontier-level reasoning.',
    },
    direct: {
      step: 'direct',
      title: 'I have my own API key',
      stepTitle: 'Your own API key',
      description:
        'Connect straight to Anthropic, OpenAI, or any OpenAI-compatible server (LM Studio, vLLM…).',
      sub: '',
      quiet: true,
    },
  };
}

/** The single-column list of power sources, with the current source labeled when changing. */
function PowerSourceList({
  sources,
  onChoose,
  currentProvider,
}: {
  sources: PowerSources;
  onChoose: (step: Exclude<Step, 'choose'>) => void;
  currentProvider?: string;
}) {
  return (
    <div className="space-y-2" data-testid="opencode-power-sources">
      {currentProvider && (
        <p className="text-muted-foreground text-xs" data-testid="opencode-current-source">
          Currently: {describePowerSource(currentProvider)}
        </p>
      )}
      {Object.values(sources).map((source) => (
        <PowerSourceButton key={source.step} source={source} onChoose={onChoose} />
      ))}
    </div>
  );
}

/**
 * One selectable power-source card: the headline and the one line under it.
 *
 * Nothing more. Three cards of four lines each was a wall to read before you had
 * chosen anything, so the sub-line and the trade-off wait for the step the card
 * opens (see `ConnectStep`) — which is where they are worth reading, and still
 * before anything is committed, since choosing a card only navigates.
 */
function PowerSourceButton({
  source,
  onChoose,
}: {
  source: SourceCard;
  onChoose: (step: Exclude<Step, 'choose'>) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChoose(source.step)}
      data-testid={`power-source-${source.step}`}
      className={cn(
        'card-interactive focus-ring group flex w-full items-start gap-3 rounded-lg border p-3 text-left',
        source.recommended
          ? 'border-primary/40 bg-card shadow-soft'
          : 'border-border bg-card shadow-soft',
        source.quiet && 'shadow-none'
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{source.title}</span>
          {source.recommended && (
            <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
              Recommended
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground text-xs leading-relaxed">{source.description}</p>
      </div>
      <ChevronRight className="text-muted-foreground/60 mt-0.5 size-4 shrink-0" />
    </button>
  );
}

/**
 * A connect step's chrome: a Back affordance, then this source's own detail,
 * then the injected step body.
 *
 * The sub-line and the trade-off live here rather than in the choose list. They
 * are the honest small print of one path, and a person reads small print about
 * the path they are taking, not about all three at once. Nothing is committed by
 * arriving here — Back returns to the list — so the trade-off is still in front
 * of them before the decision is real.
 */
function ConnectStep({
  source,
  onBack,
  children,
}: {
  source: SourceCard;
  onBack: () => void;
  children: ReactNode;
}) {
  const hasDetail = Boolean(source.sub || source.tradeOff);
  return (
    <div className="space-y-3" data-testid="opencode-connect-step">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className="focus-ring text-muted-foreground hover:text-foreground -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs transition-colors"
          data-testid="connect-step-back"
        >
          <ChevronLeft className="size-3.5" />
          Back
        </button>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-sm font-medium">{source.stepTitle ?? source.title}</span>
      </div>
      {hasDetail && (
        <div className="space-y-1" data-testid="connect-step-details">
          {source.sub && <p className="text-muted-foreground/80 text-xs">{source.sub}</p>}
          {source.tradeOff && (
            <p className="text-muted-foreground/70 text-2xs leading-snug">
              <span className="font-medium">Trade-off:</span> {source.tradeOff}
            </p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
