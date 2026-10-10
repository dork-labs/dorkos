import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { OwnAiChoice, OwnAiKeyService } from '@dorkos/shared/onboarding-schemas';
import { cn } from '@/layers/shared/lib';
import { Button, Label, PasswordInput, Spinner } from '@/layers/shared/ui';
import type { FirstRunSlots } from '../model/first-run-slots';
import { firstRunErrorMessage, useChooseFirstRunPath } from '../model/use-first-run';
import { AiAppSignIn } from './AiAppSignIn';

/** One row of the Own AI list. */
type OwnAiRow = OwnAiKeyService | 'local' | 'agent-app' | 'custom';

/** The rows, DorkOS's own engine first, each with its one-line promise. */
const ROWS: ReadonlyArray<{ id: OwnAiRow; title: string; line: string }> = [
  { id: 'openai', title: 'An OpenAI API key', line: 'Paste a key. DorkOS picks the model.' },
  { id: 'anthropic', title: 'An Anthropic API key', line: 'Paste a key. DorkOS picks the model.' },
  { id: 'openrouter', title: 'An OpenRouter key', line: 'Paste a key. DorkOS picks the model.' },
  { id: 'local', title: 'A model on this computer', line: 'Uses Ollama on this computer. No key.' },
  {
    id: 'agent-app',
    title: 'An AI app you sign in to',
    line: 'Claude Code, Codex or OpenCode, on your own sign-in.',
  },
  { id: 'custom', title: 'Other service', line: 'Set the address, format, model and key.' },
];

/** What each key row calls its key, for the field label. */
const KEY_LABEL: Record<OwnAiKeyService, string> = {
  openai: 'OpenAI API key',
  anthropic: 'Anthropic API key',
  openrouter: 'OpenRouter key',
};

/** Props for {@link OwnAiList}. */
export interface OwnAiListProps {
  /** Called once a choice is saved and the agents can run on it. */
  onSaved: () => void;
  /** The connect flows the AI-app and Other-service rows borrow. */
  slots?: Pick<FirstRunSlots, 'renderRuntimeConnect' | 'renderOtherService'>;
  /** The row open at first — Dev Playground only. */
  initialRow?: OwnAiRow;
  /** Pre-baked AI app scan for the AI-app row — Dev Playground only. */
  simulatedApps?: { requirements: SystemRequirements; defaultRuntime?: string };
}

/**
 * The Own AI list (spec `one-minute-onboarding` §2.3): one row per kind of
 * "own", one open at a time. Saving a row records it as the first-run path and
 * sets it up; the server answers with the sentence to show when a key is
 * refused or a service cannot be reached.
 *
 * Names are allowed here because the person asked for them. "Runtime" never
 * appears: the vendor apps are "AI apps".
 */
export function OwnAiList({ onSaved, slots, initialRow, simulatedApps }: OwnAiListProps) {
  const [open, setOpen] = useState<OwnAiRow | null>(initialRow ?? null);
  const choose = useChooseFirstRunPath();
  const [error, setError] = useState<string | null>(null);

  const save = async (choice: OwnAiChoice): Promise<boolean> => {
    setError(null);
    try {
      await choose.mutateAsync({ path: 'own', choice });
      return true;
    } catch (err) {
      setError(firstRunErrorMessage(err));
      return false;
    }
  };

  const toggle = (row: OwnAiRow) => {
    setError(null);
    const next = open === row ? null : row;
    setOpen(next);
    // The AI apps pick the default from what signs in, and only while no
    // first-run pick has stamped one; recording the row first clears the stamp
    // an earlier pick left. A simulated scan writes nothing.
    if (next === 'agent-app' && !simulatedApps) void save({ kind: 'agent-app' });
  };

  return (
    <div className="divide-border border-border w-full divide-y rounded-lg border text-left">
      {ROWS.map((row) => (
        <section key={row.id} data-testid={`own-ai-row-${row.id}`}>
          <button
            type="button"
            aria-expanded={open === row.id}
            onClick={() => toggle(row.id)}
            className="hover:bg-muted/60 focus-visible:ring-ring flex w-full items-center gap-3 px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{row.title}</span>
              <span className="text-muted-foreground block text-xs">{row.line}</span>
            </span>
            <ChevronRight
              aria-hidden
              className={cn(
                'text-muted-foreground size-4 shrink-0 transition-transform',
                open === row.id && 'rotate-90'
              )}
            />
          </button>
          {open === row.id && (
            <div className="px-4 pt-1 pb-4">
              <RowBody
                row={row.id}
                busy={choose.isPending}
                save={save}
                onSaved={onSaved}
                slots={slots}
                simulatedApps={simulatedApps}
              />
              {error && (
                <p className="text-destructive mt-3 text-sm" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** What an open row asks for. */
function RowBody({
  row,
  busy,
  save,
  onSaved,
  slots,
  simulatedApps,
}: {
  row: OwnAiRow;
  busy: boolean;
  save: (choice: OwnAiChoice) => Promise<boolean>;
  onSaved: () => void;
  slots: OwnAiListProps['slots'];
  simulatedApps: OwnAiListProps['simulatedApps'];
}): ReactNode {
  switch (row) {
    case 'local':
      return (
        <Button
          onClick={async () => {
            if (await save({ kind: 'local' })) onSaved();
          }}
          disabled={busy}
        >
          {busy && <Spinner size="xs" />}
          Use this computer’s model
        </Button>
      );
    case 'agent-app':
      return (
        <AiAppSignIn
          onContinue={onSaved}
          renderConnect={slots?.renderRuntimeConnect}
          simulated={simulatedApps}
        />
      );
    case 'custom':
      return slots?.renderOtherService ? (
        slots.renderOtherService({
          onSave: async (inference, apiKey) => {
            const saved = await save({
              kind: 'custom',
              inference: inference as Extract<OwnAiChoice, { kind: 'custom' }>['inference'],
              ...(apiKey ? { apiKey } : {}),
            });
            if (saved) onSaved();
          },
        })
      ) : (
        <p className="text-muted-foreground text-sm">Set this up later in Settings.</p>
      );
    default:
      return <KeyForm service={row} busy={busy} save={save} onSaved={onSaved} />;
  }
}

/** One key, saved; DorkOS reads the service's models and picks one. */
function KeyForm({
  service,
  busy,
  save,
  onSaved,
}: {
  service: OwnAiKeyService;
  busy: boolean;
  save: (choice: OwnAiChoice) => Promise<boolean>;
  onSaved: () => void;
}) {
  const id = useId();
  const [key, setKey] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const apiKey = key.trim();
    setLocal(null);
    if (!apiKey) {
      setLocal('Enter a key.');
      return;
    }
    // The same refusal the DorkOS model form gives: a subscription token is
    // not an API key and cannot run agents.
    if (service === 'anthropic' && apiKey.startsWith('sk-ant-oat')) {
      setLocal('Subscription tokens can’t run agents. Use an API key.');
      return;
    }
    if (await save({ kind: service, apiKey })) {
      setKey('');
      onSaved();
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-key`}>{KEY_LABEL[service]}</Label>
        <PasswordInput
          id={`${id}-key`}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
        />
      </div>
      {local && (
        <p className="text-destructive text-sm" role="alert">
          {local}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy && <Spinner size="xs" />}
        Save
      </Button>
    </form>
  );
}

interface OwnAiStepProps extends OwnAiListProps {
  /** Back to Welcome. */
  onBack: () => void;
}

/** The Own AI screen in the first-run overlay: the list, with a way back. */
export function OwnAiStep({ onBack, ...list }: OwnAiStepProps) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4" data-testid="onboarding-own-ai">
      <h1 className="text-2xl font-semibold tracking-tight">Use my own AI</h1>
      <p className="text-muted-foreground mt-2 mb-6 text-sm">
        Your agents run on a key, a local model or an AI app.
      </p>
      <OwnAiList {...list} />
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground mt-6 self-start"
        onClick={onBack}
      >
        Back
      </Button>
    </div>
  );
}
